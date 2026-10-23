"""Synthetic local session trees; no real transcripts, CLI inference or network."""

from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import tempfile
import time
import unittest

import role_scorecard as scorecard


BASE = datetime(2026, 10, 20, tzinfo=timezone.utc)


def record(seconds, kind='message', **fields):
    return {'type': kind, 'timestamp': (BASE + timedelta(seconds=seconds)).isoformat(), **fields}


def assistant(seconds, model='primary', tokens=100, **fields):
    return record(seconds, message={'role': 'assistant', 'provider': 'provider', 'model': model,
                                   'usage': {'totalTokens': tokens, 'input': 50000},
                                   'stopReason': 'stop', 'content': [], **fields})


def delivery(name, agent='task', status='completed', body='Delivered report'):
    return f'<task-result id="{name}" agent="{agent}" status="{status}">{body}</task-result>'


class ScorecardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'sessions'
        self.project = self.root / '--project'
        self.parent = self.project / 'main.with.dots.jsonl'
        self.child_dir = self.parent.with_suffix('')
        self.project.mkdir(parents=True)

    def write(self, path, records, age_days=0):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(''.join(json.dumps(item) + '\n' for item in records), encoding='utf-8')
        modified = time.time() - age_days * 86400
        os.utime(path, (modified, modified))
        return path

    def child(self, name='Implement67v3', agent='task', records=None, age_days=0):
        init = record(0, 'session_init', agent=agent, modelRole='task',
                      resolvedModel='provider/primary', task='PRIVATE ASSIGNMENT',
                      retryFallback={'primary': 'provider/primary', 'chain': ['provider/backup']})
        return self.write(self.child_dir / (name + '.jsonl'),
                          [init] + (records if records is not None else [assistant(10)]), age_days)

    def joined(self, paths):
        parsed = {str(path): scorecard.parse_transcript(str(path)) for path in paths}
        return scorecard.join_episodes(parsed, set(parsed))

    def test_first_parent_delivery_wins_over_steered_child_text(self):
        child = self.child(records=[assistant(10, content=[{'type': 'text', 'text': 'draft'}]),
                                    assistant(20, content=[{'type': 'text', 'text': 'Acknowledged FAIL'}])])
        first = delivery(child.stem, body='PRIVATE REPORT {"verdict":"PASS"}')
        later = delivery(child.stem, status='cancelled', body='{"verdict":"FAIL"}')
        self.write(self.parent, [record(12, 'snapshot', nested={'arbitrary': [first]}),
                                 record(22, message={'role': 'user', 'content': later})])
        episodes = self.joined([self.parent, child])
        self.assertEqual(len(episodes), 1)
        ep = episodes[0]
        self.assertTrue(ep['joined'])
        self.assertEqual(ep['status'], 'completed')
        self.assertEqual(ep['verdict'], 'PASS')
        self.assertEqual(ep['delivered_report_excerpt'], 'PRIVATE REPORT {"verdict":"PASS"}')

    def test_nested_parent_join(self):
        parent = self.child('Coordinator')
        nested = self.write(parent.with_suffix('') / 'Review.jsonl', [
            record(1, 'session_init', agent='reviewer', resolvedModel='provider/review'), assistant(4)])
        with parent.open('a') as stream:
            stream.write(json.dumps(record(5, payload=delivery('Review', 'reviewer', body='{"verdict":"FAIL"}'))) + '\n')
        ep = next(ep for ep in self.joined([parent, nested]) if ep['agent'] == 'reviewer')
        self.assertTrue(ep['joined'])
        self.assertEqual(ep['verdict'], 'FAIL')

    def test_rework_versions_and_issue_digits(self):
        names = ['Implement67v3', 'Implement67v5', 'Triage71', 'Triage72',
                 'Build', 'Build-retry', 'Other', 'Other_REDO2']
        paths = [self.child(name) for name in names]
        episodes = {ep['name']: ep for ep in self.joined(paths)}
        self.assertTrue(episodes['Implement67v3']['rework'])
        self.assertFalse(episodes['Implement67v5']['rework'])
        self.assertFalse(episodes['Triage71']['rework'])
        self.assertFalse(episodes['Triage72']['rework'])
        self.assertTrue(episodes['Build']['rework'])
        self.assertTrue(episodes['Other']['rework'])
        self.assertEqual(scorecard.base_name('Implement67-V3'), 'Implement67')
        self.assertEqual(scorecard.base_name('Triage72'), 'Triage72')

    def test_infra_delivered_prefix_and_stream_error(self):
        paths = []
        delivered = []
        for index, error in enumerate(['ENOTFOUND', 'timed out', '502', '503', 'socket connection',
                                       'operation was aborted', '(no output)', 'rate limit', 'usage limit', 'quota']):
            name = f'Infra{index}'
            paths.append(self.child(name))
            delivered.append(delivery(name, status='failed (exit 1)', body=error))
        paths.append(self.child('Stream', records=[assistant(10, stopReason='error', errorMessage='quota reached')]))
        paths.append(self.child('Capability'))
        paths.append(self.child('LateMention'))
        delivered.extend([delivery('Capability', status='cancelled', body='Could not complete assignment'),
                          delivery('LateMention', body='x' * 601 + ' quota')])
        self.write(self.parent, [record(30, payload=delivered)])
        episodes = {ep['name']: ep for ep in self.joined([self.parent] + paths)}
        self.assertTrue(all(episodes[f'Infra{i}']['infra'] for i in range(10)))
        self.assertTrue(episodes['Stream']['infra'])
        self.assertFalse(episodes['Capability']['infra'])
        self.assertFalse(episodes['LateMention']['infra'])

    def test_fallback_effective_model_and_active_cap(self):
        child = self.child(records=[assistant(5, tokens=50),
                                    record(6, 'model_change', resolvedModelIsFallback=True),
                                    assistant(1206, model='backup', tokens=300),
                                    record(1207, message={'role': 'toolResult', 'toolName': 'bash',
                                                          'isError': True, 'content': 'Tool "bash" not available'}),
                                    record(1208, message={'role': 'toolResult', 'toolName': 'read',
                                                          'isError': True, 'content': 'File not found: a.txt'}),
                                    assistant(1210, model='backup', tokens=200,
                                              content=[{'type': 'toolCall', 'name': 'x'}])])
        ep = self.joined([child])[0]
        self.assertEqual(ep['primary_model'], 'provider/primary')
        self.assertEqual(ep['effective_model'], 'provider/backup')
        self.assertTrue(ep['fallback'])
        self.assertEqual(ep['tokens'], 550)
        self.assertAlmostEqual(ep['active_minutes'], (5 + 600 + 2) / 60)
        self.assertAlmostEqual(ep['wall_minutes'], 1210 / 60)
        self.assertEqual(ep['tool_calls'], 1)
        self.assertEqual(ep['tool_errors'], 2)
        self.assertEqual(ep['unavailable_tool_errors'], 1)
        self.assertIsNone(ep['status'])

    def test_verdict_fail_is_not_delivery_failure_and_missing_is(self):
        review = self.child('Review', agent='reviewer')
        missing = self.child('Missing', agent='reviewer')
        infra = self.child('Infra', agent='reviewer')
        self.write(self.parent, [record(20, payload=[
            delivery('Review', 'reviewer', body='{"verdict": "FAIL"}'),
            delivery('Infra', 'reviewer', 'failed (exit 1)', '(no output)')])])
        paths = [self.parent, review, missing, infra]
        parsed = {str(path): scorecard.parse_transcript(str(path)) for path in paths}
        selected = set(parsed)
        report = scorecard.summarize(scorecard.join_episodes(parsed, selected), parsed, selected, 0)
        row = report['role_models'][0]
        self.assertEqual(row['verdict_n'], 1)
        self.assertEqual(row['pass_pct'], 0)
        self.assertEqual(row['delivered_failure_pct'], 50)
        self.assertEqual(row['non_infra_n'], 2)
        self.assertAlmostEqual(row['infra_pct'], 100 / 3)
        self.assertEqual(report['join_coverage']['joined'], 2)

    def test_days_filters_modified_files_but_loads_old_parent_for_join(self):
        child = self.child('Recent')
        self.child('Old', age_days=8)
        self.write(self.parent, [record(20, payload=delivery('Recent'))], age_days=10)
        output = io.StringIO()
        with redirect_stdout(output):
            status = scorecard.main(['--sessions', str(self.root), '--days', '7', '--min-n', '1', '--json'])
        self.assertEqual(status, 0)
        report = json.loads(output.getvalue())
        self.assertEqual(report['files'], 1)
        self.assertEqual(report['join_coverage'], {'joined': 1, 'total': 1, 'pct': 100})
        self.assertEqual(report['main_models'], [])
        self.assertTrue(child.exists())

    def test_since_main_stream_health_and_private_episode_export(self):
        child = self.child()
        self.write(self.parent, [record(0, 'session'),
                                 assistant(4, tokens=300, stopReason='error', errorMessage='502 /Users/private/secret.txt'),
                                 assistant(8, tokens=200, stopReason='aborted'),
                                 record(10, payload=delivery(child.stem, body='PRIVATE REPORT {"verdict":"PASS"}'))])
        destination = Path(self.temp.name) / 'episodes.jsonl'
        output = io.StringIO()
        with redirect_stdout(output):
            status = scorecard.main(['--sessions', str(self.root), '--since', '2000-01-01',
                                     '--min-n', '1', '--episodes-out', str(destination)])
        self.assertEqual(status, 0)
        markdown = output.getvalue()
        self.assertIn('Join coverage: 1/1 (100.00%)', markdown)
        self.assertNotIn('PRIVATE', markdown)
        self.assertNotIn('/Users/private', markdown)
        episode = json.loads(destination.read_text())
        self.assertEqual(episode['assignment_excerpt'], 'PRIVATE ASSIGNMENT')
        self.assertIn('PRIVATE REPORT', episode['delivered_report_excerpt'])
        self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
        parsed = {str(path): scorecard.parse_transcript(str(path)) for path in (child, self.parent)}
        report = scorecard.summarize([episode], parsed, set(parsed), 0)
        self.assertEqual(report['main_models'][0]['tokens'], 500)
        self.assertEqual(report['main_models'][0]['turns'], 2)
        health = report['stream_health'][0]
        self.assertEqual(health['turns'], 3)
        self.assertAlmostEqual(health['error_pct'], 100 / 3)
        self.assertAlmostEqual(health['aborted_pct'], 100 / 3)
        self.assertEqual(health['median_context_latency_seconds'], 4)
        self.assertEqual(health['context_latency_n'], 3)

    def test_empty_tree_and_argument_errors(self):
        with redirect_stdout(io.StringIO()) as output:
            self.assertEqual(scorecard.main(['--sessions', str(self.root), '--json']), 0)
        self.assertEqual(json.loads(output.getvalue())['join_coverage']['total'], 0)
        for arguments in (['--days', '0'], ['--days', 'nan'], ['--since', 'yesterday'],
                          ['--days', '1', '--since', '2020-01-01'], ['--min-n', '0'],
                          ['--episodes-out', str(self.root / 'output.jsonl')]):
            with self.subTest(arguments=arguments), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
                scorecard.main(['--sessions', str(self.root)] + arguments)
            self.assertEqual(error.exception.code, 2)


if __name__ == '__main__':
    unittest.main()
