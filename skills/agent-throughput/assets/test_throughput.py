#!/usr/bin/env python3
import contextlib
from collections import defaultdict
import datetime as dt
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from throughput import (ASK_TOOLS, Gap, Session, Token, attribution_weights,
                        build_report, classify_timeline, codex_token_delta,
                        collect_sessions, extract_refs, fetch_prs, assign_workspaces,
                        declared_workspaces, find_workspace_members, workspace_attribution_weights,
                        remote_identity, repository_names, filter_azure_prs,
                        git_common_directory, origin_remote, local_project_roots, resolve_workspaces,
                        issue_pr_mapping, main, markdown, parse_claude,
                        parse_codex, parse_pi, project_location, resolve_project_root, union_seconds)


EMPTY = frozenset()


def assistant(timestamp, stop='toolUse', questions=0, refs=EMPTY):
    return timestamp, 'A', (stop, questions, refs)


def active_seconds(events, cap=1800):
    return sum(gap.end - gap.start for gap in classify_timeline(events, 0, 10000, cap)
               if gap.kind == 'active')


class TimelineTests(unittest.TestCase):
    def test_finished_turn_excludes_idle_until_user(self):
        events = [(0, 'U', None), assistant(10, 'stop'), (100, 'U', None), assistant(110, 'stop')]
        self.assertEqual(active_seconds(events), 20)
        self.assertEqual([g.kind for g in classify_timeline(events, 0, 200)], ['active', 'idle', 'active'])

    def test_each_question_tool_excludes_pending_time(self):
        for tool in ('ask', 'ask_user_question', 'AskUserQuestion', 'request_user_input'):
            with self.subTest(tool=tool):
                events = [(0, 'U', None), assistant(10, questions=1), (1000, 'R', tool), assistant(1010, 'stop')]
                gaps = classify_timeline(events, 0, 2000)
                self.assertEqual([g.kind for g in gaps], ['active', 'ask', 'active'])
                self.assertEqual(active_seconds(events), 20)

    def test_passive_notice_after_aborted_turn_preserves_idle(self):
        events = [(0, 'U', None), assistant(10, 'aborted'), (2000, 'X', None),
                  (4000, 'X', None), (5000, 'U', None), assistant(5010, 'stop')]
        self.assertEqual(active_seconds(events), 20)

    def test_assistant_can_resume_after_final(self):
        events = [(0, 'U', None), assistant(10, 'stop'), assistant(100), assistant(110, 'stop')]
        self.assertEqual(active_seconds(events), 20)

    def test_active_gap_cap(self):
        events = [(0, 'U', None), assistant(7200, 'stop')]
        gaps = classify_timeline(events, 0, 8000, 1800)
        self.assertEqual([(g.start, g.end, g.kind) for g in gaps], [(0, 1800, 'active')])

    def test_out_of_order_timestamps_are_sorted(self):
        events = [assistant(110, 'stop'), assistant(10, 'stop'), (100, 'U', None), (0, 'U', None)]
        self.assertEqual(active_seconds(events), 20)

    def test_window_is_clipped_after_cap(self):
        events = [(0, 'U', None), assistant(7200, 'stop')]
        self.assertEqual(classify_timeline(events, 2000, 8000, 1800), [])
        gaps = classify_timeline(events, 100, 200, 1800)
        self.assertEqual((gaps[0].start, gaps[0].end), (100, 200))

    def test_time_refs_carry_forward(self):
        refs = extract_refs('issue-5')
        events = [(0, 'U', None), assistant(10, refs=refs), (20, 'R', 'bash'),
                  assistant(30), assistant(40, 'stop')]
        gaps = classify_timeline(events, 0, 100)
        self.assertEqual([g.refs for g in gaps], [EMPTY, refs, refs, refs])


class AttributionTests(unittest.TestCase):
    def setUp(self):
        self.prs = [{'number': 10, 'headRefName': 'feature', 'closingIssuesReferences': [{'number': 5}]},
                    {'number': 11, 'headRefName': 'pablo/issue-6-change', 'closingIssuesReferences': []},
                    {'number': 12, 'headRefName': 'issue-5', 'closingIssuesReferences': []}]
        self.mapping = issue_pr_mapping(self.prs)
        self.numbers = {10, 11, 12}

    def weights(self, direct='', file='', main=''):
        return attribution_weights(extract_refs(direct), extract_refs(file), extract_refs(main),
                                   self.mapping, self.numbers)

    def test_issue_mapping_closing_references_and_branch(self):
        self.assertEqual(self.mapping, {5: {10, 12}, 6: {11}, ('branch', 'feature'): {10},
                                       ('branch', 'pablo/issue-6-change'): {11},
                                       ('branch', 'issue-5'): {12}})
        self.assertEqual(self.weights('issue-6'), {11: 1})
        self.assertEqual(self.weights('issue-5'), {10: .5, 12: .5})

    def test_all_reference_spellings(self):
        issue = ['issue-6', 'issue://6', 'issue://owner/repo/6', 'gh issue view 6',
                 'https://github.com/owner/repo/issues/6']
        pr = ['gh pr view 11', 'pr://11', 'pr://owner/repo/11', 'https://github.com/owner/repo/pull/11']
        for text in issue + pr:
            with self.subTest(text=text):
                self.assertEqual(self.weights(text), {11: 1})

    def test_direct_multiple_prs_evenly_split_and_deduplicated(self):
        self.assertEqual(self.weights('pr://10 gh pr view 11 /pull/10'), {10: .5, 11: .5})
        self.assertEqual(self.weights('issue-5 pr://11'), {10: 1 / 3, 11: 1 / 3, 12: 1 / 3})

    def test_file_fallback_requires_exactly_one_mapped_pr(self):
        self.assertEqual(self.weights(file='issue-6 issue-999'), {11: 1})
        self.assertEqual(self.weights(file='issue-5'), {})
        self.assertEqual(self.weights(file='pr://10 pr://11'), {})
        self.assertEqual(self.weights(file='issue-5', main='pr://12'), {12: 1})

    def test_direct_refs_take_precedence(self):
        self.assertEqual(self.weights('pr://10', 'issue-6', 'pr://12'), {10: 1})
        self.assertEqual(self.weights('pr://999', 'issue-6'), {11: 1})


class ParserTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.warnings = defaultdict(int)
        self.start = dt.datetime(2026, 10, 15, tzinfo=dt.timezone.utc).timestamp()
        self.end = self.start + 86400

    def write(self, name, records):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(''.join(json.dumps(record) + '\n' for record in records))
        return path

    def stamp(self, seconds):
        return dt.datetime.fromtimestamp(self.start + seconds, dt.timezone.utc).isoformat()

    def pi_message(self, seconds, message):
        return {'type': 'message', 'timestamp': self.stamp(seconds), 'message': message}

    def test_claude_usage_dedupes_message_id_and_unions_refs(self):
        usage = {'input_tokens': 10, 'output_tokens': 5, 'cache_read_input_tokens': 20,
                 'cache_creation_input_tokens': 3}
        records = [{'type': 'user', 'timestamp': self.stamp(0), 'cwd': '/repo',
                    'message': {'content': 'start'}}]
        for seconds, number in [(10, 1), (11, 2)]:
            records.append({'type': 'assistant', 'timestamp': self.stamp(seconds),
                            'message': {'id': 'same-id', 'usage': usage, 'content': [
                                {'type': 'tool_use', 'name': 'bash', 'input': {'command': f'pr://{number}'}}]}})
        path = self.write('project/main.jsonl', records)
        session = parse_claude(path, self.root, self.start, self.end, 1800, self.warnings)
        self.assertEqual(len(session.tokens), 1)
        self.assertEqual(session.tokens[0].total, 38)
        self.assertEqual(session.tokens[0].refs, extract_refs('pr://1 pr://2'))

    def test_claude_tool_results_and_sidechains_are_not_user_turns(self):
        records = [
            {'type': 'user', 'timestamp': self.stamp(0), 'message': {'content': 'start'}},
            {'type': 'assistant', 'timestamp': self.stamp(10), 'message': {'id': 'a', 'content': [
                {'type': 'tool_use', 'id': 'ask1', 'name': 'AskUserQuestion', 'input': {}}]}},
            {'type': 'assistant', 'timestamp': self.stamp(100), 'isSidechain': True,
             'message': {'id': 'side', 'content': [], 'usage': {'input_tokens': 1}}},
            {'type': 'user', 'timestamp': self.stamp(1000), 'message': {'content': [
                {'type': 'tool_result', 'tool_use_id': 'ask1', 'content': 'answer'}]}},
            {'type': 'assistant', 'timestamp': self.stamp(1010), 'message': {'id': 'b', 'content': []}},
        ]
        path = self.write('project/main.jsonl', records)
        session = parse_claude(path, self.root, self.start, self.end, 1800, self.warnings)
        self.assertEqual(sum(g.end - g.start for g in session.gaps), 20)
        self.assertEqual(sum(t.total for t in session.tokens), 1)

    def test_pi_auxiliary_usage_faux_and_subagent_time(self):
        records = [{'type': 'session', 'cwd': '/repo'},
                   self.pi_message(0, {'role': 'user'}),
                   self.pi_message(10, {'role': 'assistant', 'provider': 'real', 'stopReason': 'stop',
                                        'usage': {'input': 10, 'output': 2, 'cacheRead': 20, 'cacheWrite': 3}}),
                   {'type': 'model_usage', 'timestamp': self.stamp(11), 'provider': 'aux',
                    'usage': {'input': 7, 'output': 1}},
                   self.pi_message(12, {'role': 'assistant', 'provider': 'faux', 'usage': {'input': 999}})]
        path = self.write('project/main.jsonl', records)
        session = parse_pi(path, self.root, 'omp', self.start, self.end, 1800, self.warnings)
        self.assertEqual(sum(t.total for t in session.tokens), 43)
        self.assertEqual(sum(g.end - g.start for g in session.gaps), 10)
        sub_path = self.write('project/main/worker/nested.jsonl', [
            {'type': 'session_init', 'task': 'handle issue-6'}, *records])
        sub = parse_pi(sub_path, self.root, 'pi', self.start, self.end, 1800, self.warnings)
        self.assertEqual(sub.main_path, str(path))
        self.assertEqual(sub.gaps, [])
        self.assertIn(('issue', 6), sub.refs)
        faux = self.write('project/faux.jsonl', [self.pi_message(0, {'role': 'user'}),
            self.pi_message(20, {'role': 'assistant', 'provider': 'faux', 'usage': {'input': 100}})])
        self.assertIsNone(parse_pi(faux, self.root, 'pi', self.start, self.end, 1800, self.warnings))

    def test_pi_passive_custom_and_developer_messages_preserve_idle(self):
        records = [self.pi_message(0, {'role': 'user'}),
                   self.pi_message(10, {'role': 'assistant', 'stopReason': 'aborted'}),
                   {'type': 'custom_message', 'timestamp': self.stamp(1000), 'customType': 'dagu-state'},
                   self.pi_message(2000, {'role': 'developer'}),
                   self.pi_message(3000, {'role': 'custom'}),
                   self.pi_message(4000, {'role': 'user'}),
                   self.pi_message(4010, {'role': 'assistant', 'stopReason': 'stop'})]
        path = self.write('project/main.jsonl', records)
        session = parse_pi(path, self.root, 'omp', self.start, self.end, 1800, self.warnings)
        self.assertEqual(sum(g.end - g.start for g in session.gaps), 20)

    def codex_record(self, seconds, kind, payload):
        return {'timestamp': self.stamp(seconds), 'type': kind, 'payload': payload}

    def token_count(self, seconds, input_tokens, cached, output):
        return self.codex_record(seconds, 'event_msg', {'type': 'token_count', 'info': {
            'total_token_usage': {'input_tokens': input_tokens, 'cached_input_tokens': cached, 'output_tokens': output}}})

    def test_codex_cumulative_deltas_reset_and_cached_split(self):
        delta, baseline = codex_token_delta({'input_tokens': 100, 'cached_input_tokens': 80,
                                            'output_tokens': 10, 'cache_write_input_tokens': 5})
        self.assertEqual(delta, (20, 10, 80, 5))
        delta, baseline = codex_token_delta({'input_tokens': 150, 'cached_input_tokens': 100,
                                            'output_tokens': 15, 'cache_write_input_tokens': 7}, baseline)
        self.assertEqual(delta, (30, 5, 20, 2))
        delta, baseline = codex_token_delta({'input_tokens': 20, 'cached_input_tokens': 5, 'output_tokens': 2}, baseline)
        self.assertEqual(delta, (15, 2, 5, 0))

    def test_codex_imports_skipped_but_baseline_preserved(self):
        records = [self.codex_record(0, 'session_meta', {'id': 'id', 'cwd': '/repo', 'source': 'cli'}),
                   self.codex_record(0, 'event_msg', {'type': 'task_started', 'turn_id': 'external-import-1'}),
                   self.codex_record(1, 'response_item', {'type': 'function_call', 'name': 'shell', 'arguments': 'issue-999'}),
                   self.token_count(2, 100, 80, 10),
                   self.codex_record(3, 'event_msg', {'type': 'task_complete'}),
                   self.codex_record(10, 'event_msg', {'type': 'task_started', 'turn_id': 'real'}),
                   self.codex_record(11, 'response_item', {'type': 'function_call', 'name': 'shell',
                                                        'arguments': 'gh pr view 6', 'call_id': 'c'}),
                   self.codex_record(12, 'response_item', {'type': 'function_call_output', 'call_id': 'c'}),
                   self.token_count(20, 150, 100, 15), self.token_count(21, 150, 100, 15),
                   self.codex_record(30, 'event_msg', {'type': 'task_complete'}),
                   self.token_count(31, 20, 5, 2)]
        path = self.write('rollout.jsonl', records)
        session = parse_codex(path, self.start, self.end, 1800, self.warnings)
        self.assertEqual([(t.input, t.output, t.cache_read) for t in session.tokens], [(30, 5, 20), (15, 2, 5)])
        self.assertNotIn(('issue', 999), session.refs)
        self.assertEqual(session.tokens[0].refs, extract_refs('pr://6'))
        self.assertEqual(sum(g.end - g.start for g in session.gaps), 20)

    def test_codex_question_output_matches_call_id(self):
        records = [self.codex_record(0, 'event_msg', {'type': 'task_started'}),
                   self.codex_record(10, 'response_item', {'type': 'function_call', 'name': 'request_user_input', 'call_id': 'q'}),
                   self.codex_record(1000, 'response_item', {'type': 'function_call_output', 'call_id': 'q'}),
                   self.codex_record(1010, 'event_msg', {'type': 'task_complete'})]
        path = self.write('rollout.jsonl', records)
        session = parse_codex(path, self.start, self.end, 1800, self.warnings)
        self.assertEqual(sum(g.end - g.start for g in session.gaps), 20)

    def test_codex_largest_duplicate_selected_and_subagent_has_no_time(self):
        name = 'rollout-00000000-0000-0000-0000-000000000001.jsonl'
        records = [self.codex_record(0, 'session_meta', {'source': {'subagent': 'worker'}, 'cwd': '/repo'}),
                   self.codex_record(0, 'event_msg', {'type': 'task_started'}),
                   self.token_count(10, 100, 50, 10),
                   self.codex_record(20, 'event_msg', {'type': 'task_complete'})]
        self.write('.codex/sessions/' + name, records[:2])
        self.write('.codex/archived_sessions/' + name, records)
        sessions = collect_sessions(self.root, self.start, self.end, 1800, self.warnings)
        self.assertEqual(len(sessions), 1)
        self.assertEqual(sum(t.total for t in sessions[0].tokens), 110)
        self.assertEqual(sessions[0].gaps, [])

    def test_parallel_collection_preserves_usage_warnings_and_parent_cwd(self):
        main = self.write('.omp/agent/sessions/project/main.jsonl', [
            {'type': 'session', 'cwd': '/repo'},
            self.pi_message(0, {'role': 'user'}),
            self.pi_message(10, {'role': 'assistant', 'stopReason': 'stop',
                                 'usage': {'input': 10}})])
        child = self.write('.omp/agent/sessions/project/main/worker.jsonl', [
            self.pi_message(5, {'role': 'assistant', 'stopReason': 'stop',
                                'usage': {'output': 5}})])
        for path in (main, child):
            with path.open('a') as stream:
                stream.write('malformed JSON\n')
        sessions = collect_sessions(self.root, self.start, self.end, 1800, self.warnings)
        self.assertEqual(len(sessions), 2)
        self.assertEqual(sum(token.total for session in sessions for token in session.tokens), 15)
        self.assertEqual(self.warnings['malformed JSONL lines'], 2)
        worker = next(session for session in sessions if session.is_subagent)
        self.assertEqual(worker.cwd, '/repo')
        self.assertEqual(worker.main_path, str(main))
        self.assertEqual(worker.gaps, [])

    def test_claude_subagent_links_to_main(self):
        path = self.write('project/main/subagents/worker.jsonl', [
            {'type': 'assistant', 'timestamp': self.stamp(0), 'message': {
                'id': 'worker', 'usage': {'input_tokens': 5}}}])
        session = parse_claude(path, self.root, self.start, self.end, 1800, self.warnings)
        self.assertEqual(session.main_path, str(self.root / 'project/main.jsonl'))
        self.assertTrue(session.is_subagent)
        self.assertEqual(session.gaps, [])


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.start = dt.datetime(2026, 10, 15).timestamp()
        self.prs = {'owner/repo': [{'number': 1, 'title': 'First', 'mergedAt':
            dt.datetime.fromtimestamp(self.start + 100, dt.timezone.utc).isoformat(),
            'headRefName': 'issue-5', 'closingIssuesReferences': []}]}

    def test_project_denominator_coverage_days_and_main_time(self):
        refs = extract_refs('issue-5')
        main_session = Session('omp', 'main', 'main', '/repo', refs=set(refs),
                               tokens=[Token(self.start + 10, 20, 10, 70, 0, refs)],
                               gaps=[Gap(self.start, self.start + 3600, 'active', refs)])
        worker = Session('pi', 'worker', 'main', '/repo', True,
                         tokens=[Token(self.start + 20, 10, 0, 0, 0)])
        other = Session('claude', 'other', 'other', '/repo',
                        tokens=[Token(self.start + 30, 90, 0, 0, 0)],
                        gaps=[Gap(self.start + 1800, self.start + 5400, 'active')])
        report = build_report([main_session, worker, other], {'/repo': 'owner/repo'},
                              self.prs, self.start, self.start + 86400)
        p, c, d = report['projects'][0], report['attribution'][0], report['days'][0]
        self.assertEqual(p['tokens'], 200)
        self.assertEqual(p['tokens_excluding_cache_read'], 130)
        self.assertEqual(p['agent_hours'], 2)
        self.assertEqual(p['tokens_per_pr'], 200)
        self.assertEqual(c['tokens_attributed_percent'], 55)
        self.assertEqual(c['hours_attributed_percent'], 50)
        self.assertEqual(d['wall_hours'], 1.5)
        self.assertEqual(d['merged_prs'], 1)
        self.assertEqual(c['median_tokens_per_pr'], 110)

    def rendered(self, report):
        report.update(window={'since': '2026-10-15T00:00:00+00:00',
                              'until': '2026-10-16T00:00:00+00:00',
                              'timezone': 'UTC', 'cap_minutes': 30},
                      parse_warnings={}, runtime_seconds=0, session_count=1)
        return markdown(report)

    def test_non_repo_source_is_na_with_complete_daily_counts(self):
        names = ('/Users/Shared/dsprima', '(tmp/poc)', '(no repo)',
                 '(chat without repo)', '(unknown cwd)')
        sessions = [Session('omp', name, name, name,
                            tokens=[Token(self.start, 1, 0, 0, 0)]) for name in names]
        report = build_report(sessions, dict(zip(names, names)), {}, self.start,
                              self.start + 86400, non_repos=set(names))
        self.assertTrue(report['prs_complete'])
        self.assertEqual(report['pr_unavailable'], {})
        self.assertEqual({row['pr_source'] for row in report['projects']}, {'not_applicable'})
        rendered = self.rendered(report)
        for name in names:
            self.assertIn(f'| {name} | n/a | 0.00 | 0.00 | 0.00 | n/a | — | — |', rendered)
            self.assertIn(f'- No supported PR source: {name}', rendered)
        self.assertIn('| 2026-10-15 | 0.00 | 0.00 | 0.00 | 0.00 | 0 |', rendered)

    def test_failed_repo_source_is_unavailable_with_partial_daily_counts(self):
        session = Session('omp', 'main', 'main', '/repo',
                          tokens=[Token(self.start, 1, 0, 0, 0)])
        report = build_report([session], {'/repo': 'owner/repo'}, {},
                              self.start, self.start + 86400,
                              pr_unavailable={'owner/repo': 'network unavailable'})
        self.assertFalse(report['prs_complete'])
        self.assertEqual(report['projects'][0]['pr_source'], 'unavailable')
        rendered = self.rendered(report)
        self.assertIn('| owner/repo | owner/repo | 0.00 | 0.00 | 0.00 | unavailable | — | — |', rendered)
        self.assertIn('| 2026-10-15 | 0.00 | 0.00 | 0.00 | 0.00 | 0 known |', rendered)
        self.assertIn('- PRs unavailable for owner/repo: network unavailable', rendered)

    def test_coverage_rows_are_repositories_with_merged_prs(self):
        sessions = [Session('omp', name, name, name,
                            tokens=[Token(self.start, 1, 0, 0, 0)])
                    for name in ('owner/repo', 'vendor/repo')]
        report = build_report(sessions, {s.cwd: s.cwd for s in sessions},
                              dict(self.prs, **{'vendor/repo': []}),
                              self.start, self.start + 86400)
        self.assertEqual([row['repo'] for row in report['attribution']], ['owner/repo'])
        self.assertEqual({row['project']: row['merged_prs'] for row in report['projects']},
                         {'owner/repo': 1, 'vendor/repo': 0})
        self.assertTrue(report['prs_complete'])

    def test_wall_clock_union(self):
        self.assertEqual(union_seconds([(0, 10), (5, 15), (20, 30), (0, 4)]), 25)

    def test_only_window_activity_creates_project_rows_but_parent_refs_remain(self):
        parent = Session('omp', 'parent', 'parent', '/old', refs=set(extract_refs('pr://1')))
        worker = Session('omp', 'worker', 'parent', '/repo', True,
                         tokens=[Token(self.start + 10, 10, 0, 0, 0)])
        report = build_report([parent, worker], {'/repo': 'owner/repo'}, self.prs,
                              self.start, self.start + 86400)
        self.assertEqual([row['project'] for row in report['projects']], ['owner/repo'])
        self.assertEqual(report['attribution'][0]['tokens_attributed_percent'], 100)

    def test_missing_gh_reports_unavailable(self):
        with patch('throughput.command', return_value=(None, 'gh not found')):
            rows, errors = fetch_prs({'github:owner/repo'}, self.start, self.start + 86400)
        self.assertEqual(rows, {})
        self.assertIn('gh not found', errors['github:owner/repo'])
        report = build_report([Session('omp', 'main', 'main', '/repo', tokens=[Token(self.start, 1, 0, 0, 0)])],
                              {'/repo': 'owner/repo'}, {}, self.start, self.start + 86400)
        self.assertIsNone(report['projects'][0]['merged_prs'])

    def test_fetch_filters_author_and_exact_window(self):
        rows = [dict(self.prs['owner/repo'][0], author={'login': 'operator'}),
                dict(self.prs['owner/repo'][0], number=2, author={'login': 'vendor'}),
                dict(self.prs['owner/repo'][0], number=3, author={'login': 'operator'},
                     mergedAt=dt.datetime.fromtimestamp(self.start - 1, dt.timezone.utc).isoformat())]
        with patch('throughput.command', side_effect=[('operator', None), (json.dumps(rows), None)]) as command:
            result, errors = fetch_prs({'github:owner/repo'}, self.start, self.start + 86400)
        self.assertEqual(errors, {})
        self.assertEqual([r['number'] for r in result['github:owner/repo']], [1])
        self.assertIn('author:operator', command.call_args.args[0][8])

    def test_no_prs_never_calls_gh_and_json_is_machine_readable(self):
        with patch('throughput.collect_sessions', return_value=[]), \
                patch('throughput.orca_registrations', return_value=([], None)), \
                patch('throughput.command') as command:
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(main(['--since', '2026-10-15', '--until', '2026-10-16', '--no-prs', '--json']), 0)
        command.assert_not_called()
        report = json.loads(output.getvalue())
        self.assertEqual(len(report['days']), 1)
        self.assertEqual(report['days'][0]['day'], '2026-10-15')
        self.assertTrue(report['prs_complete'])

    def test_pr_search_dates_cover_local_midnight_offsets(self):
        start = dt.datetime.fromisoformat('2026-10-15T00:00:00+02:00').timestamp()
        end = start + 86400
        with patch('throughput.command', side_effect=[('operator', None), ('[]', None)]) as command:
            fetch_prs({'github:owner/repo'}, start, end)
        search = command.call_args.args[0][8]
        self.assertIn('merged:>=2026-10-14', search)
        self.assertIn('merged:<=2026-10-15', search)

    def test_deleted_worktree_preserves_path_when_git_recovery_fails(self):
        root, is_git = resolve_project_root('/gone/repo/.workspace/worktrees/repo/issue-5')
        self.assertEqual(root, '/gone/repo')
        self.assertFalse(is_git)


class ProjectMappingTests(unittest.TestCase):
    def setUp(self):
        self.home = '/Users/operator'
        self.known = {'/work/a4s', '/work/rootline'}
        self.existing = {'/', '/work', '/work/a4s', '/work/rootline', self.home}

    def location(self, cwd):
        return project_location(cwd, self.known, self.existing.__contains__, self.home)

    def test_shared_and_home_ancestor_git_roots_keep_no_repo_category(self):
        for parent in ('/Users/Shared', self.home):
            with self.subTest(parent=parent), \
                    patch('throughput.Path.home', return_value=Path(self.home)), \
                    patch('throughput.project_location', return_value='/gone/parent'), \
                    patch('throughput.git_common_directory', return_value=parent + '/.git'):
                self.assertEqual(resolve_project_root('/gone/child'), ('(no repo)', False))

    def test_deleted_sibling_recovery_runs_after_special_ancestor_classification(self):
        cwd, root = '/Users/Shared/harness/a4s-main', '/Users/Shared/harness/a4s'
        session = Session('omp', 'file', 'file', cwd, tokens=[Token(0, 1, 0, 0, 0)])
        def resolve(path, known=()):
            return (root, True) if root in known else ('(no repo)', False)
        with patch('throughput.resolve_project_root', side_effect=resolve):
            roots, git_roots = local_project_roots([session], {root})
        self.assertEqual(roots, {cwd: root})
        self.assertEqual(git_roots, {root})

    def test_deleted_nested_cwd_uses_nearest_existing_ancestor(self):
        self.assertEqual(self.location('/work/a4s/skills/roadmap/references'), '/work/a4s')
        self.existing.add('/work/a4s/skills')
        self.assertEqual(self.location('/work/a4s/skills/roadmap/references'), '/work/a4s/skills')

    def test_deleted_sibling_clones_use_same_parent_known_root(self):
        for cwd in ('/work/a4s-main', '/work/a4s-mechanical-routing-read'):
            with self.subTest(cwd=cwd):
                self.assertEqual(self.location(cwd), '/work/a4s')
        self.assertEqual(self.location('/work/a4strong'), '/work')
        self.existing.add('/work/a4s-live')
        self.assertEqual(self.location('/work/a4s-live'), '/work/a4s-live')
        self.known.add('/elsewhere/another')
        self.assertEqual(self.location('/work/another-main'), '/work')

    def test_deleted_sibling_prefers_most_specific_known_basename(self):
        self.known.add('/work/a4s-v1')
        self.assertEqual(self.location('/work/a4s-v1-review'), '/work/a4s-v1')

    def test_local_share_worktrees_use_unique_named_known_repo(self):
        for issue in ('issue-296', 'issue-297'):
            self.assertEqual(self.location(f'{self.home}/.local/share/rootline/worktrees/{issue}'),
                             '/work/rootline')
        self.known.add('/elsewhere/rootline')
        self.assertEqual(self.location(f'{self.home}/.local/share/rootline/worktrees/issue-296'),
                         self.home)

    def test_dagu_home_data_is_temporary(self):
        self.assertEqual(self.location(f'{self.home}/.dagu/data/poc-evidence/run/scratch'), '(tmp/poc)')
        self.assertEqual(self.location(f'{self.home}/.dagu/data'), '(tmp/poc)')
        self.assertEqual(self.location('/work/a4s/.dagu-data/jobs'), '(tmp/poc)')

    def test_home_and_shared_parent_are_no_repo(self):
        self.assertEqual(self.location(self.home), '(no repo)')
        self.assertEqual(self.location('/Users/Shared'), '(no repo)')

    def test_existing_special_categories(self):
        self.assertEqual(self.location('/private/tmp/poc'), '(tmp/poc)')
        self.assertEqual(self.location('/Users/me/Documents/Codex/chat'), '(chat without repo)')

    def test_worktree_suffix_is_stripped_before_recovery(self):
        for suffix in ('.workspace/worktrees/a4s/issue-5', '.claude/worktrees/worker',
                       '.orca/workspaces/task'):
            self.assertEqual(self.location('/work/a4s/' + suffix), '/work/a4s')


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.folder = '/work/team'
        self.roots = {self.folder: self.folder, '/work/team/a/src': '/work/team/a',
                      '/outside/worktree-b': '/work/team/b'}
        self.names = {'/work/team/a': 'owner/a', '/work/team/b': 'owner/b'}
        self.folder_members = {self.folder: set(self.names)}
        self.projects, self.session_repos, self.members = assign_workspaces(
            self.roots, self.names, self.folder_members)
        self.start = dt.datetime(2026, 10, 15).timestamp()
        merged = dt.datetime.fromtimestamp(self.start + 100, dt.timezone.utc).isoformat()
        self.prs = {repo: [{'number': 1, 'title': repo, 'mergedAt': merged,
                           'headRefName': 'issue-5', 'closingIssuesReferences': []}]
                    for repo in self.names.values()}

    def report(self, prs=None, errors=None):
        sessions = [Session('omp', cwd, cwd, cwd, tokens=[Token(self.start, 100, 0, 0, 0)])
                    for cwd in self.roots]
        return build_report(sessions, self.projects, self.prs if prs is None else prs,
                            self.start, self.start + 86400, pr_unavailable=errors,
                            workspace_repos=self.members, session_repos=self.session_repos)

    def test_orca_and_explicit_folder_declarations_are_merged(self):
        registrations = [{'kind': 'folder', 'path': self.folder},
                         {'kind': 'git', 'path': '/work/standalone'}]
        folders, repos = declared_workspaces(registrations, ['/work/explicit', self.folder])
        self.assertEqual(folders, {self.folder, '/work/explicit'})
        self.assertEqual(repos, {'/work/standalone'})
        self.assertEqual(declared_workspaces([], ['/work/explicit']), ({'/work/explicit'}, set()))

    def test_member_discovery_uses_git_markers_through_depth_two(self):
        children = {self.folder: ['/work/team/a', '/work/team/group'],
                    '/work/team/a': ['/work/team/a/src'],
                    '/work/team/group': ['/work/team/group/b']}
        markers = {'/work/team/a/.git', '/work/team/group/b/.git',
                   '/work/team/a/src/too-deep/.git'}
        found = find_workspace_members({self.folder}, lambda path: children.get(path, []),
                                       markers.__contains__)
        self.assertEqual(found, {self.folder: {'/work/team/a', '/work/team/group/b'}})

    def test_folder_and_member_worktrees_roll_up_into_one_workspace(self):
        self.assertEqual(set(self.projects.values()), {self.folder})
        self.assertEqual(self.session_repos, {self.folder: None,
                         '/work/team/a/src': 'owner/a', '/outside/worktree-b': 'owner/b'})
        report = self.report()
        self.assertEqual(len(report['projects']), 1)
        self.assertEqual(report['projects'][0]['tokens'], 300)
        self.assertEqual(report['projects'][0]['repos'], ['owner/a', 'owner/b'])

    def test_folder_cwd_in_shared_ancestor_git_repo_uses_member_attribution(self):
        folder = '/Users/Shared/dsprima'
        member = folder + '/DSPRIMA.PlatformNG'
        repo = 'ado:ds-prima/DSPRIMA.PlatformNG/DSPRIMA.PlatformNG'
        session = Session('omp', 'file', 'file', folder, tokens=[
            Token(self.start, 100, 0, 0, 0, extract_refs('az repos pr show --id 213'))])
        def common(path):
            return member + '/.git' if path == member else '/Users/Shared/.git'
        with patch('throughput.find_workspace_members', return_value={folder: {member}}), \
                patch('throughput.project_location', side_effect=lambda cwd, *args: cwd), \
                patch('throughput.git_common_directory', side_effect=common), \
                patch('throughput.origin_remote', return_value=
                      'https://dev.azure.com/ds-prima/DSPRIMA.PlatformNG/_git/DSPRIMA.PlatformNG'):
            sources = resolve_workspaces([session], registration_result=([
                {'kind': 'folder', 'path': folder}, {'kind': 'git', 'path': member}], None))
        self.assertEqual(sources.projects, {folder: folder})
        self.assertEqual(sources.session_repos, {folder: None})
        self.assertEqual(sources.members, {folder: {repo}})
        prs = {repo: [{'number': 213, 'title': 'Real shape', 'headRefName': 'feature/final',
                      'mergedAt': dt.datetime.fromtimestamp(self.start + 1, dt.timezone.utc).isoformat()}]}
        report = build_report([session], sources.projects, prs, self.start, self.start + 86400,
                              workspace_repos=sources.members, session_repos=sources.session_repos,
                              pr_sources=sources.repos)
        self.assertEqual([row['project'] for row in report['projects']], [folder])
        self.assertEqual(report['attribution'][0]['prs_with_tokens'], 1)
        self.assertEqual(report['attribution'][0]['tokens_attributed_percent'], 100)

    def test_pr_union_uses_repo_and_number_and_counts_each_merge_once(self):
        report = self.report()
        row = report['projects'][0]
        self.assertEqual(row['merged_prs'], 2)
        self.assertEqual(row['tokens_per_pr'], 150)
        self.assertEqual(report['days'][0]['merged_prs'], 2)
        self.assertEqual([row['repo'] for row in report['attribution']], ['owner/a', 'owner/b'])

    def weights(self, text):
        maps = {repo: issue_pr_mapping(rows) for repo, rows in self.prs.items()}
        numbers = {repo: {row['number'] for row in rows} for repo, rows in self.prs.items()}
        return workspace_attribution_weights(extract_refs(text), EMPTY, EMPTY,
                                             {'owner/a', 'owner/b'}, maps, numbers)

    def test_ambiguous_unqualified_reference_stays_unattributed(self):
        self.assertEqual(self.weights('pr://1 issue-5'), {})
        self.prs['owner/b'] = []
        self.assertEqual(self.weights('pr://1'), {('owner/a', 1): 1})

    def test_qualified_reference_forms_resolve_to_member_repo(self):
        for text in ('gh pr view 1 -R owner/a', 'gh pr view -R owner/a 1',
                     'gh issue view 5 --repo owner/a', 'owner/a#1',
                     'https://github.com/owner/a/pull/1',
                     'https://github.com/owner/a/issues/5',
                     'issue://owner/a/5', 'pr://owner/a/1'):
            with self.subTest(text=text):
                self.assertEqual(self.weights(text), {('owner/a', 1): 1})
        self.assertEqual(self.weights('owner/a#1 owner/b#1'),
                         {('owner/a', 1): .5, ('owner/b', 1): .5})

    def test_folder_without_member_repos_has_na_source(self):
        projects, session_repos, members = assign_workspaces(
            {self.folder: self.folder}, {}, {self.folder: set()})
        session = Session('omp', 'main', 'main', self.folder,
                          tokens=[Token(self.start, 1, 0, 0, 0)])
        report = build_report([session], projects, {}, self.start, self.start + 86400,
                              workspace_repos=members, session_repos=session_repos)
        self.assertEqual(report['projects'][0]['pr_source'], 'not_applicable')
        self.assertTrue(report['prs_complete'])

    def test_one_failed_member_makes_folder_source_unavailable(self):
        report = self.report({'owner/a': self.prs['owner/a']}, {'owner/b': 'offline'})
        row = report['projects'][0]
        self.assertEqual(row['pr_source'], 'unavailable')
        self.assertEqual(row['known_merged_prs'], 1)
        self.assertIsNone(row['merged_prs'])
        self.assertFalse(report['prs_complete'])

    def test_undeclared_parent_keeps_no_repo_mapping(self):
        mapped = project_location('/Users/Shared', set(), lambda path: True, '/Users/operator')
        projects, session_repos, members = assign_workspaces(
            {'/Users/Shared': mapped}, self.names, {})
        self.assertEqual(projects, {'/Users/Shared': '(no repo)'})
        self.assertEqual(members, {'(no repo)': set()})
        self.assertEqual(session_repos, {'/Users/Shared': None})


    def test_ambiguous_turn_cannot_borrow_unique_file_reference(self):
        maps = {repo: issue_pr_mapping(rows) for repo, rows in self.prs.items()}
        numbers = {repo: {1} for repo in self.prs}
        result = workspace_attribution_weights(extract_refs('pr://1'),
                                              extract_refs('pr://owner/a/1'), EMPTY,
                                              set(self.prs), maps, numbers)
        self.assertEqual(result, {})

    def test_repository_cwd_rejects_other_repository_qualification(self):
        result = workspace_attribution_weights(extract_refs('pr://owner/b/1'), EMPTY, EMPTY,
                                              {'owner/a'}, {'owner/a': {}}, {'owner/a': {1}})
        self.assertEqual(result, {})

    def test_folder_attribution_preserves_unassigned_workspace_usage(self):
        qualified, ambiguous = extract_refs('owner/a#1'), extract_refs('pr://1')
        folder = Session('omp', 'folder', 'folder', self.folder,
                         tokens=[Token(self.start, 100, 0, 0, 0, qualified),
                                 Token(self.start, 200, 0, 0, 0, ambiguous)],
                         gaps=[Gap(self.start, self.start + 3600, 'active', qualified),
                               Gap(self.start + 3600, self.start + 10800, 'active', ambiguous)])
        repo = Session('omp', 'repo', 'repo', '/work/team/a/src',
                       tokens=[Token(self.start, 100, 0, 0, 0)],
                       gaps=[Gap(self.start, self.start + 3600, 'active', EMPTY)])
        report = build_report([folder, repo], self.projects, self.prs, self.start,
                              self.start + 86400, workspace_repos=self.members,
                              session_repos=self.session_repos)
        self.assertEqual(report['projects'][0]['tokens'], 400)
        self.assertEqual(report['projects'][0]['agent_hours'], 4)
        self.assertEqual(report['days'][0]['tokens'], 400)
        self.assertEqual(report['harnesses'][0]['tokens'], 400)
        coverage = next(row for row in report['attribution'] if row['repo'] == 'owner/a')
        self.assertEqual(coverage['tokens_attributed_percent'], 50)
        self.assertEqual(coverage['hours_attributed_percent'], 50)


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.start = dt.datetime(2026, 10, 15).timestamp()
        self.repo = 'ado:ds-prima/DSPRIMA.PlatformNG/DSPRIMA.PlatformNG'
        self.closed = dt.datetime.fromtimestamp(self.start + 100, dt.timezone.utc).isoformat()
        self.row = {'pullRequestId': 213, 'status': 'completed', 'title': 'Deliver',
                    'closedDate': self.closed, 'createdBy': {'uniqueName': 'Operator@Example.COM'},
                    'sourceRefName': 'refs/heads/feature/783-poster'}

    def test_azure_remote_variants_decode_and_strip_userinfo(self):
        variants = ('https://user:secret@dev.azure.com/ds-prima/DS-PRIMA%20Wiki/_git/DS-PRIMA%20Wiki',
                    'https://ds-prima.visualstudio.com/DS-PRIMA%20Wiki/_git/DS-PRIMA%20Wiki',
                    'https://ds-prima.visualstudio.com/DefaultCollection/DS-PRIMA%20Wiki/_git/DS-PRIMA%20Wiki',
                    'git@ssh.dev.azure.com:v3/ds-prima/DS-PRIMA%20Wiki/DS-PRIMA%20Wiki',
                    'ssh://git@ssh.dev.azure.com/v3/ds-prima/DS-PRIMA%20Wiki/DS-PRIMA%20Wiki')
        for remote in variants:
            with self.subTest(remote=remote):
                self.assertEqual(remote_identity(remote), 'ado:ds-prima/DS-PRIMA Wiki/DS-PRIMA Wiki')

    def test_github_remote_variants(self):
        for remote in ('https://token@github.com/Owner/Repo.git', 'git@github.com:Owner/Repo.git',
                       'ssh://git@github.com/Owner/Repo'):
            self.assertEqual(remote_identity(remote), 'github:owner/repo')

    def test_same_remote_clones_merge_including_case_variants(self):
        names = repository_names({
            '/work/DSPRIMA.PlatformNG': 'https://dev.azure.com/ds-prima/DSPRIMA.PlatformNG/_git/DSPRIMA.PlatformNG',
            '/work/DSPRIMA.PlatformNG-feature': 'git@ssh.dev.azure.com:v3/ds-prima/dsprima.platformng/dsprima.platformng'})
        self.assertEqual(set(names.values()), {self.repo})
        projects, _, _ = assign_workspaces({root: root for root in names}, names, {})
        self.assertEqual(set(projects.values()), {self.repo})

    def test_unsupported_and_missing_origin_have_na_source(self):
        for remote in ('', 'https://gitlab.com/owner/repo.git', '/work/local.git'):
            self.assertIsNone(remote_identity(remote))
        names = repository_names({'/work/private': 'https://gitlab.com/owner/repo.git'})
        session = Session('omp', 'main', 'main', '/work/private',
                          tokens=[Token(self.start, 100, 0, 0, 0)])
        report = build_report([session], {'/work/private': names['/work/private']}, {},
                              self.start, self.start + 86400, pr_sources=set())
        self.assertEqual(report['projects'][0]['pr_source'], 'not_applicable')
        self.assertTrue(report['prs_complete'])
        self.assertEqual(report['repositories'], [{'repo': '/work/private', 'merged_prs': None,
                                                  'pr_source': 'not_applicable'}])

    def test_completed_author_window_filter_is_case_insensitive_and_exact(self):
        rows = [self.row,
                dict(self.row, pullRequestId=214, status='active'),
                dict(self.row, pullRequestId=215, createdBy={'uniqueName': 'other@example.com'}),
                dict(self.row, pullRequestId=216, closedDate=dt.datetime.fromtimestamp(
                    self.start - 1, dt.timezone.utc).isoformat()),
                dict(self.row, pullRequestId=217, closedDate=dt.datetime.fromtimestamp(
                    self.start + 86400, dt.timezone.utc).isoformat())]
        selected = filter_azure_prs(rows, 'operator@example.com', self.start, self.start + 86400)
        self.assertEqual([row['number'] for row in selected], [213])
        self.assertEqual(selected[0]['mergedAt'], self.closed)
        self.assertEqual(selected[0]['provider'], 'ado')

    def test_azure_fetch_links_work_items_and_branch_numbers(self):
        def command(args, **kwargs):
            if args[:3] == ['az', 'account', 'show']:
                return 'operator@example.com', None
            if args[:4] == ['az', 'repos', 'pr', 'list']:
                return json.dumps([self.row, dict(self.row, pullRequestId=214,
                                       sourceRefName='refs/heads/issue-784-fix')]), None
            if args[:5] == ['az', 'repos', 'pr', 'work-item', 'list']:
                return '[781, 782]', None
            self.fail(args)
        with patch('throughput.command', side_effect=command):
            prs, errors = fetch_prs({self.repo}, self.start, self.start + 86400)
        self.assertEqual(errors, {})
        mapping = issue_pr_mapping(prs[self.repo])
        self.assertEqual(mapping[781], {213, 214})
        self.assertEqual(mapping[782], {213, 214})
        self.assertEqual(mapping[783], {213})
        self.assertEqual(mapping[784], {214})

    def test_azure_failure_is_isolated_from_github(self):
        def command(args, **kwargs):
            if args[0] == 'az':
                return None, 'az not logged in'
            return ('operator' if args[1] == 'api' else '[]'), None
        with patch('throughput.command', side_effect=command):
            prs, errors = fetch_prs({self.repo, 'github:owner/repo'}, self.start, self.start + 86400)
        self.assertEqual(prs, {'github:owner/repo': []})
        self.assertEqual(set(errors), {self.repo})
        self.assertIn('az not logged in', errors[self.repo])

    def test_azure_list_and_link_failures_are_unavailable(self):
        for failed in ('list', 'work-item'):
            def command(args, **kwargs):
                if args[:3] == ['az', 'account', 'show']:
                    return 'operator@example.com', None
                if args[3] == failed:
                    return None, 'network unavailable'
                return json.dumps([self.row]), None
            with self.subTest(failed=failed), patch('throughput.command', side_effect=command):
                prs, errors = fetch_prs({self.repo}, self.start, self.start + 86400)
                self.assertEqual(prs, {})
                self.assertIn('network unavailable', errors[self.repo])

    def test_azure_reference_spellings_and_qualified_urls(self):
        refs = ('/pullrequest/213', 'az repos pr show --id 213',
                'AB#783', '/_workitems/edit/783', 'az boards work-item show --id 783',
                'https://dev.azure.com/ds-prima/DSPRIMA.PlatformNG/_git/DSPRIMA.PlatformNG/pullrequest/213',
                'https://ds-prima.visualstudio.com/DSPRIMA.PlatformNG/_git/DSPRIMA.PlatformNG/pullrequest/213',
                'https://dev.azure.com/ds-prima/DSPRIMA.PlatformNG/_workitems/edit/783')
        for text in refs:
            with self.subTest(text=text):
                weights = workspace_attribution_weights(extract_refs(json.dumps({'command': text})),
                    EMPTY, EMPTY, {self.repo}, {self.repo: {783: {213}}}, {self.repo: {213}})
                self.assertEqual(weights, {(self.repo, 213): 1})

    def test_azure_folder_reference_ambiguity_and_qualification(self):
        other = 'ado:ds-prima/Other/Other'
        maps = {repo: {783: {213}} for repo in (self.repo, other)}
        numbers = {repo: {213} for repo in maps}
        def weights(text):
            return workspace_attribution_weights(extract_refs(text), EMPTY, EMPTY, set(maps), maps, numbers)
        self.assertEqual(weights('AB#783'), {})
        self.assertEqual(weights('https://dev.azure.com/ds-prima/DSPRIMA.PlatformNG/_git/DSPRIMA.PlatformNG/pullrequest/213'),
                         {(self.repo, 213): 1})
        self.assertEqual(weights('https://dev.azure.com/ds-prima/DSPRIMA.PlatformNG/_workitems/edit/783'),
                         {(self.repo, 213): 1})
        self.assertEqual(weights('az repos pr show --id 213 --org https://dev.azure.com/ds-prima '
                                 '--project DSPRIMA.PlatformNG --repository DSPRIMA.PlatformNG'),
                         {(self.repo, 213): 1})

    def test_real_source_branches_prefer_exact_pr_then_work_item_fallback(self):
        rows = [dict(self.row, number=212, headRefName='refs/heads/feature/783-opcposter',
                     closingIssuesReferences=[{'number': 783}], provider='ado'),
                dict(self.row, number=213, headRefName='refs/heads/feature/scan-confirm-final-delivery',
                     closingIssuesReferences=[{'number': 783}], provider='ado')]
        maps = {self.repo: issue_pr_mapping(rows)}
        numbers = {self.repo: {212, 213}}
        def weights(text):
            return workspace_attribution_weights(extract_refs(json.dumps({'command': text})),
                                                 EMPTY, EMPTY, {self.repo}, maps, numbers)
        for text in ('git checkout feature/783-opcposter',
                     'git checkout refs/heads/feature/783-opcposter',
                     'az repos pr create --repository "DSPRIMA.PlatformNG" '
                     '--source-branch "feature/783-opcposter"',
                     'az repos pr create --source-branch refs/heads/feature/783-opcposter'):
            with self.subTest(text=text):
                self.assertEqual(weights(text), {(self.repo, 212): 1})
        self.assertEqual(weights('git checkout feature/783-another-slice'),
                         {(self.repo, 212): .5, (self.repo, 213): .5})

    def test_real_pr_clone_and_repository_flags_resolve_overlapping_numbers(self):
        other = 'ado:ds-prima/Other/Other'
        maps = {repo: {} for repo in (self.repo, other)}
        numbers = {repo: {213} for repo in maps}
        for text in (
                'git -C /Users/Shared/dsprima/DSPRIMA.PlatformNG-pr213-host-qa status',
                'az repos pr show --id 213 --repository DSPRIMA.PlatformNG',
                'az repos   pr update --id=213 --project DSPRIMA.PlatformNG',
                'az repos pr show --id 213 --org https://dev.azure.com/ds-prima '
                '--repository DSPRIMA.PlatformNG'):
            with self.subTest(text=text):
                refs = extract_refs(json.dumps({'command': text}))
                weights = workspace_attribution_weights(refs, EMPTY, EMPTY, set(maps), maps, numbers)
                self.assertEqual(weights, {(self.repo, 213): 1})

    def test_source_branch_qualification_preserves_member_ambiguity(self):
        other = 'ado:other/Other/Other'
        branch = 'docs/scan-confirm-api-spec'
        maps = {repo: {('branch', branch): {213}} for repo in (self.repo, other)}
        numbers = {repo: {213} for repo in maps}
        def weights(text):
            return workspace_attribution_weights(extract_refs(text), EMPTY, EMPTY, set(maps), maps, numbers)
        self.assertEqual(weights('git checkout ' + branch), {})
        self.assertEqual(weights('az repos pr create --repository DSPRIMA.PlatformNG '
                                 '--source-branch ' + branch), {(self.repo, 213): 1})

    def test_git_markers_and_linked_worktrees_share_cached_common_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'repo'
            common = root / '.git'
            common.mkdir(parents=True)
            nested = root / 'src'
            nested.mkdir()
            linked = Path(directory) / 'linked'
            linked.mkdir()
            gitdir = common / 'worktrees' / 'linked'
            gitdir.mkdir(parents=True)
            (gitdir / 'commondir').write_text('../..')
            (linked / '.git').write_text(f'gitdir: {gitdir}')
            self.assertEqual(git_common_directory(str(nested)), str(common.resolve()))
            self.assertEqual(git_common_directory(str(linked)), str(common.resolve()))
            with patch('throughput.command', return_value=('https://github.com/owner/repo', None)) as command:
                origin_remote(git_common_directory(str(nested)))
                origin_remote(git_common_directory(str(linked)))
            self.assertEqual(command.call_count, 1)


if __name__ == '__main__':
    unittest.main()
