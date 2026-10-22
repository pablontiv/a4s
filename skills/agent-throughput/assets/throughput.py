#!/usr/bin/env python3
"""Local, subscription-only agent throughput accounting (Python standard library)."""

import argparse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
import datetime as dt
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import time

ASK_TOOLS = {'ask', 'ask_user_question', 'AskUserQuestion', 'request_user_input',
             'question', 'ask_user'}
TOOL_STOPS = {'toolUse', 'tool_use'}
REF_PATTERNS = {
    'issue': [r'issue-(\d+)', r'issue://(?:[\w.-]+/[\w.-]+/)?(\d+)',
              r'gh issue \w+ (\d+)', r'/issues/(\d+)'],
    'pr': [r'gh pr \w+ (\d+)', r'pr://(?:[\w.-]+/[\w.-]+/)?(\d+)', r'/pull/(\d+)'],
}
REF_PATTERNS = {kind: [re.compile(p) for p in patterns]
                for kind, patterns in REF_PATTERNS.items()}


def extract_refs(text):
    """Extract repository-local issue/PR numbers from tool arguments or tasks."""
    return frozenset((kind, int(n)) for kind, patterns in REF_PATTERNS.items()
                     for pattern in patterns for n in pattern.findall(text))


def epoch(value):
    try:
        if isinstance(value, (int, float)):
            return value / 1000 if value > 100_000_000_000 else value
        return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except (ValueError, TypeError, AttributeError, OverflowError):
        return None


@dataclass
class Token:
    timestamp: float
    input: int
    output: int
    cache_read: int
    cache_write: int
    refs: frozenset = frozenset()

    @property
    def total(self):
        return self.input + self.output + self.cache_read + self.cache_write


@dataclass
class Gap:
    start: float
    end: float
    kind: str
    refs: frozenset = frozenset()


@dataclass
class Session:
    harness: str
    path: str
    main_path: str
    cwd: str = ''
    is_subagent: bool = False
    refs: set = field(default_factory=set)
    tokens: list = field(default_factory=list)
    gaps: list = field(default_factory=list)
    session_id: str = ''
    parent_id: str = ''


def classify_timeline(events, since, until, cap_seconds=1800):
    """Pure timeline: (timestamp, U|A|R|X, payload); A=(stop, ask_count, refs).

    Classify each gap from the preceding event's state. Passive X events never
    change state. Cap active gaps before clipping to the reporting window.
    """
    idle, pending, current, previous = True, 0, frozenset(), None
    result = []
    for timestamp, kind, payload in sorted(events, key=lambda event: event[0]):
        if previous is not None and timestamp > previous:
            state = 'idle' if idle else ('ask' if pending else 'active')
            end = min(timestamp, previous + cap_seconds) if state == 'active' else timestamp
            start, end = max(previous, since), min(end, until)
            if end > start:
                result.append(Gap(start, end, state, current))
        previous = timestamp
        if kind == 'A':
            stop, questions, refs = payload
            idle = stop not in TOOL_STOPS
            pending += questions
            if refs:
                current = refs
        elif kind == 'R' and payload in ASK_TOOLS:
            pending = max(0, pending - 1)
        elif kind == 'U':
            idle = False
    return result


def codex_token_delta(current, previous=None):
    """Return (uncached input, output, cacheRead, cacheWrite), plus new baseline.

    Codex input includes cached input. Counters reset when input decreases.
    Reasoning output is already included in output_tokens, not added again.
    """
    keys = ('input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens')
    values = tuple(current.get(key, 0) or 0 for key in keys)
    delta = values if previous is None or values[0] < previous[0] else tuple(
        max(0, a - b) for a, b in zip(values, previous))
    return (max(0, delta[0] - delta[1]), delta[3], delta[1], delta[2]), values


def jsonl(path, warnings):
    with path.open(errors='replace') as source:
        for line_number, line in enumerate(source, 1):
            try:
                record = json.loads(line)
                if isinstance(record, dict):
                    yield record
            except ValueError:
                warnings['malformed JSONL lines'] += 1


def content_calls(message, types):
    content = message.get('content')
    return [c for c in content if isinstance(c, dict) and c.get('type') in types] if isinstance(content, list) else []


def call_refs(calls):
    return extract_refs(' '.join(json.dumps(c.get('arguments') or c.get('input') or {}) for c in calls))


def parse_pi(path, root, harness, since, until, cap_seconds, warnings):
    parts = path.relative_to(root).parts
    sub = len(parts) > 2
    main = root / parts[0] / (parts[1] + '.jsonl') if sub else path
    session = Session(harness, str(path), str(main), is_subagent=sub)
    events, providers = [], set()
    for record in jsonl(path, warnings):
        kind = record.get('type')
        if kind == 'session':
            session.cwd = session.cwd or record.get('cwd', '')
            continue
        if kind == 'session_init':
            session.refs.update(extract_refs(str(record.get('task', ''))))
            continue
        timestamp = epoch(record.get('timestamp'))
        if timestamp is None:
            continue
        if kind == 'custom_message':
            events.append((timestamp, 'X', None))
        elif kind in ('message', 'model_usage'):
            message = record.get('message') or {} if kind == 'message' else record
            role = message.get('role')
            refs = frozenset()
            if role == 'assistant':
                calls = content_calls(message, {'toolCall', 'tool_use'})
                refs = call_refs(calls)
                session.refs.update(refs)
                events.append((timestamp, 'A', (message.get('stopReason'),
                                               sum(c.get('name') in ASK_TOOLS for c in calls), refs)))
            elif role == 'toolResult':
                events.append((timestamp, 'R', message.get('toolName')))
            elif role == 'user':
                events.append((timestamp, 'U', None))
            elif role in ('developer', 'custom'):
                events.append((timestamp, 'X', None))
            if role == 'assistant' or kind == 'model_usage':
                provider = message.get('provider')
                if provider:
                    providers.add(provider)
                usage = message.get('usage')
                if usage and provider != 'faux' and since <= timestamp < until:
                    session.tokens.append(Token(timestamp, *(usage.get(k, 0) or 0 for k in
                                                             ('input', 'output', 'cacheRead', 'cacheWrite')), refs))
    if providers == {'faux'}:
        return None
    if not sub:
        session.gaps = [gap for gap in classify_timeline(events, since, until, cap_seconds) if gap.kind == 'active']
    return session


def parse_claude(path, root, since, until, cap_seconds, warnings):
    parts = path.relative_to(root).parts
    sub = 'subagents' in parts
    main = root / parts[0] / (parts[1] + '.jsonl') if sub else path
    session = Session('claude', str(path), str(main), is_subagent=sub)
    events, usage_by_id, names = [], {}, {}
    for record in jsonl(path, warnings):
        session.cwd = session.cwd or record.get('cwd', '')
        timestamp = epoch(record.get('timestamp'))
        kind = record.get('type')
        if timestamp is None or kind not in ('assistant', 'user'):
            continue
        message = record.get('message') or {}
        sidechain = record.get('isSidechain') and not sub
        if kind == 'assistant':
            calls = content_calls(message, {'tool_use'})
            names.update((c.get('id'), c.get('name')) for c in calls)
            refs = call_refs(calls)
            session.refs.update(refs)
            mid = message.get('id') or record.get('uuid')
            usage = message.get('usage')
            if usage:
                old = usage_by_id.get(mid)
                usage_by_id[mid] = (timestamp, usage, refs | (old[2] if old else frozenset()))
            if not sidechain:
                stop = 'tool_use' if calls else message.get('stop_reason') or 'end_turn'
                events.append((timestamp, 'A', (stop, sum(c.get('name') in ASK_TOOLS for c in calls), refs)))
        elif not sidechain:
            results = content_calls(message, {'tool_result'})
            if results:
                events.extend((timestamp, 'R', names.get(c.get('tool_use_id'))) for c in results)
            else:
                events.append((timestamp, 'U', None))
    for timestamp, usage, refs in usage_by_id.values():
        if since <= timestamp < until:
            session.tokens.append(Token(timestamp, *(usage.get(k, 0) or 0 for k in
                                                     ('input_tokens', 'output_tokens', 'cache_read_input_tokens',
                                                      'cache_creation_input_tokens')), refs))
    if not sub:
        session.gaps = [gap for gap in classify_timeline(events, since, until, cap_seconds) if gap.kind == 'active']
    return session


def parse_codex(path, since, until, cap_seconds, warnings):
    session = Session('codex', str(path), str(path))
    events, names, previous, imported, current_refs = [], {}, None, False, frozenset()
    for record in jsonl(path, warnings):
        kind, payload = record.get('type'), record.get('payload') or {}
        timestamp = epoch(record.get('timestamp'))
        if kind == 'session_meta':
            session.cwd = payload.get('cwd', '')
            session.session_id = payload.get('id', '')
            source = payload.get('source')
            session.is_subagent = isinstance(source, dict) and 'subagent' in source
            if session.is_subagent:
                sub = source['subagent']
                if isinstance(sub, dict):
                    spawn = sub.get('thread_spawn', sub)
                    if isinstance(spawn, dict):
                        session.parent_id = spawn.get('parent_thread_id', '')
            continue
        if timestamp is None:
            continue
        event_type = payload.get('type')
        if kind == 'turn_context' and 'turn_id' in payload:
            imported = str(payload['turn_id']).startswith('external-import')
        if kind == 'event_msg':
            if event_type == 'task_started':
                imported = str(payload.get('turn_id', '')).startswith('external-import')
                current_refs = frozenset()
                if not imported:
                    events.append((timestamp, 'U', None))
            elif event_type in ('task_complete', 'turn_aborted'):
                if not imported:
                    events.append((timestamp, 'A', ('stop', 0, frozenset())))
                imported = False
            elif event_type == 'token_count':
                usage = (payload.get('info') or {}).get('total_token_usage')
                if usage:
                    delta, previous = codex_token_delta(usage, previous)
                    if not imported and since <= timestamp < until and any(delta):
                        session.tokens.append(Token(timestamp, *delta, current_refs))
        elif kind == 'response_item' and not imported:
            if event_type in ('function_call', 'custom_tool_call', 'local_shell_call'):
                refs = extract_refs(str(payload.get('arguments') or payload.get('input') or payload.get('action') or ''))
                session.refs.update(refs)
                if refs:
                    current_refs = refs
                names[payload.get('call_id')] = payload.get('name')
                events.append((timestamp, 'A', ('toolUse', int(payload.get('name') in ASK_TOOLS), refs)))
            elif event_type in ('function_call_output', 'custom_tool_call_output', 'local_shell_call_output'):
                events.append((timestamp, 'R', names.get(payload.get('call_id'))))
    if not session.is_subagent:
        session.gaps = [gap for gap in classify_timeline(events, since, until, cap_seconds) if gap.kind == 'active']
    return session


def collect_sessions(home, since, until, cap_seconds, warnings):
    sessions = []
    for harness, suffix in [('omp', '.omp/agent/sessions'), ('pi', '.pi/agent/sessions'),
                            ('claude', '.claude/projects')]:
        root = home / suffix
        parser = parse_claude if harness == 'claude' else parse_pi
        for path in root.rglob('*.jsonl'):
            try:
                if path.stat().st_mtime < since:
                    continue
                args = (path, root) if harness == 'claude' else (path, root, harness)
                session = parser(*args, since, until, cap_seconds, warnings)
                if session:
                    sessions.append(session)
            except OSError:
                warnings['unreadable or vanished session files'] += 1
    # Rollout filenames end with a UUID. Archived/live copies share that ID.
    best = {}
    for suffix in ('.codex/sessions', '.codex/archived_sessions'):
        for path in (home / suffix).rglob('*.jsonl'):
            try:
                stat = path.stat()
                if stat.st_mtime >= since:
                    match = re.search(r'([0-9a-fA-F-]{36})\.jsonl$', path.name)
                    key = match[1] if match else path.name
                    if key not in best or stat.st_size > best[key][0]:
                        best[key] = (stat.st_size, path)
            except OSError:
                warnings['unreadable or vanished session files'] += 1
    for _, path in best.values():
        try:
            sessions.append(parse_codex(path, since, until, cap_seconds, warnings))
        except OSError:
            warnings['unreadable or vanished session files'] += 1
    by_id = {s.session_id: s for s in sessions if s.session_id}
    by_path = {s.path: s for s in sessions}
    for session in sessions:
        parent, seen = by_id.get(session.parent_id), set()
        while parent and parent.path not in seen:
            seen.add(parent.path)
            session.main_path = parent.path
            parent = by_id.get(parent.parent_id)
        if not session.cwd and session.main_path in by_path:
            session.cwd = by_path[session.main_path].cwd
    return sessions


def issue_pr_mapping(prs):
    """Map each issue to all merged PRs that close it or name it in a branch."""
    mapping = defaultdict(set)
    for pr in prs:
        issues = {item['number'] for item in pr.get('closingIssuesReferences', [])}
        issues.update(int(n) for n in re.findall(r'issue-(\d+)', pr.get('headRefName', '')))
        for issue in issues:
            mapping[issue].add(pr['number'])
    return dict(mapping)


def referenced_prs(refs, mapping, merged_numbers):
    result = set()
    for kind, number in refs:
        if kind == 'pr' and number in merged_numbers:
            result.add(number)
        elif kind == 'issue':
            result.update(mapping.get(number, set()))
    return result


def attribution_weights(refs, file_refs, main_refs, mapping, merged_numbers):
    """Direct references split evenly; file/main fallbacks require one PR."""
    selected = referenced_prs(refs, mapping, merged_numbers)
    if not selected:
        for fallback in (file_refs, main_refs):
            candidates = referenced_prs(fallback, mapping, merged_numbers)
            if len(candidates) == 1:
                selected = candidates
                break
    return {number: 1 / len(selected) for number in selected}


def command(args, cwd=None, timeout=30):
    try:
        result = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        if result.returncode:
            return None, (result.stderr.strip() or f'exit {result.returncode}')[:300]
        return result.stdout.strip(), None
    except (OSError, subprocess.TimeoutExpired) as error:
        return None, str(error)[:300]


def strip_worktrees(cwd):
    return re.split(r'/\.(?:workspace/worktrees|claude/worktrees|orca/workspaces)(?:/|$)', cwd)[0]


def project_location(cwd, known_roots, exists, home):
    """Pure cwd recovery using known repository roots and injected existence."""
    if not cwd:
        return '(unknown cwd)'
    path, home = Path(cwd), Path(home)
    temporary = ('/tmp', '/private/tmp', '/var/folders', '/private/var/folders',
                 str(home / '.dagu/data'))
    if any(cwd == p or cwd.startswith(p + '/') for p in temporary) or '.dagu-data' in cwd:
        return '(tmp/poc)'
    if path in (home, Path('/Users/Shared')):
        return '(no repo)'
    if any(part in cwd for part in ('/Documents/Codex/', '.chatgpt-projects', 'Application Support/Claude')):
        return '(chat without repo)'
    path = Path(strip_worktrees(cwd))
    roots = [Path(root) for root in known_roots]
    try:
        local = path.relative_to(home / '.local/share').parts
    except ValueError:
        local = ()
    if len(local) >= 2 and local[1] == 'worktrees':
        matches = [root for root in roots if root.name == local[0]]
        if len(matches) == 1:
            return str(matches[0])
    if not exists(str(path)):
        siblings = [root for root in roots if root.parent == path.parent
                    and path.name.startswith(root.name + '-')]
        if siblings:
            return str(max(siblings, key=lambda root: len(root.name)))
        ancestor = path.parent
        while not exists(str(ancestor)):
            if ancestor.parent == ancestor:
                return str(path)
            ancestor = ancestor.parent
        return str(ancestor)
    return str(path)


def resolve_project_root(cwd, known_roots=()):
    location = project_location(cwd, known_roots, lambda path: Path(path).exists(), Path.home())
    if location.startswith('('):
        return location, False
    common, error = command(['git', '-C', location, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
    if not error and common.endswith('/.git'):
        return common[:-5], True
    return strip_worktrees(cwd), False


def local_project_roots(sessions):
    cwds = sorted({s.cwd for s in sessions if s.tokens or s.gaps})
    with ThreadPoolExecutor(max_workers=8) as pool:
        resolved = dict(zip(cwds, pool.map(resolve_project_root, cwds)))
        known_roots = {root for root, is_git in resolved.values() if is_git}
        pending = [cwd for cwd, (root, is_git) in resolved.items()
                   if not is_git and not root.startswith('(')]
        recovered = pool.map(lambda cwd: resolve_project_root(cwd, known_roots), pending)
        resolved.update(zip(pending, recovered))
    return {cwd: root for cwd, (root, _) in resolved.items()}


def resolve_projects(sessions):
    roots = local_project_roots(sessions)
    def github(root):
        if root.startswith('('):
            return root, None
        value, error = command(['gh', 'repo', 'view', '--json', 'nameWithOwner'], cwd=root)
        if not error:
            try:
                return json.loads(value)['nameWithOwner'], None
            except (ValueError, KeyError):
                error = 'invalid gh repo response'
        return root, error
    unique_roots = sorted(set(roots.values()))
    with ThreadPoolExecutor(max_workers=8) as pool:
        resolved = dict(zip(unique_roots, pool.map(github, unique_roots)))
    projects = {cwd: resolved[root][0] for cwd, root in roots.items()}
    repos = {name for name, error in resolved.values() if not error and not name.startswith('(')}
    errors = {root: error for root, (_, error) in resolved.items() if error}
    return projects, repos, errors


def fetch_prs(repos, since, until, skip=False):
    if skip:
        return {}, {repo: 'skipped (--no-prs)' for repo in repos}
    author, error = command(['gh', 'api', 'user', '-q', '.login'])
    if error:
        return {}, {repo: 'gh author unavailable: ' + error for repo in repos}
    since_date = dt.datetime.fromtimestamp(since, dt.timezone.utc).date().isoformat()
    until_date = dt.datetime.fromtimestamp(until, dt.timezone.utc).date().isoformat()
    def fetch(repo):
        raw, error = command(['gh', 'pr', 'list', '-R', repo, '--state', 'merged',
                              '--search', f'merged:>={since_date} merged:<={until_date} author:{author}',
                              '--limit', '1000', '--json',
                              'number,title,author,createdAt,mergedAt,headRefName,closingIssuesReferences'], timeout=90)
        if error:
            return repo, None, error
        try:
            prs = json.loads(raw)
            # A full page is an incomplete count, not an exact throughput result.
            if len(prs) >= 1000:
                return repo, None, '1000-result limit reached; narrow the date window'
            return repo, [pr for pr in prs if (pr.get('author') or {}).get('login', '').lower() == author.lower()
                          and epoch(pr.get('mergedAt')) is not None and since <= epoch(pr['mergedAt']) < until], None
        except (ValueError, TypeError, KeyError) as error:
            return repo, None, 'invalid gh PR response: ' + str(error)
    prs, errors = {}, {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        for repo, rows, error in pool.map(fetch, sorted(repos)):
            if error:
                errors[repo] = error
            else:
                prs[repo] = rows
    return prs, errors


def day_parts(start, end):
    """Split intervals at local midnights (including timezone DST changes)."""
    while start < end:
        date = dt.datetime.fromtimestamp(start).date()
        midnight = dt.datetime.combine(date + dt.timedelta(days=1), dt.time()).timestamp()
        stop = min(end, midnight)
        yield date.isoformat(), start, stop
        start = stop


def union_seconds(intervals):
    total, end = 0, -math.inf
    for start, stop in sorted(intervals):
        total += max(0, stop - max(start, end))
        end = max(end, stop)
    return total


def percentile(values, fraction):
    if not values:
        return None
    values = sorted(values)
    position = (len(values) - 1) * fraction
    lower = int(position)
    upper = min(lower + 1, len(values) - 1)
    return values[lower] + (values[upper] - values[lower]) * (position - lower)


def empty_metrics():
    return {'tokens': 0, 'tokens_excluding_cache_read': 0, 'agent_hours': 0}


def build_report(sessions, projects, prs, since, until):
    project_rows, harness_rows, days = {}, {}, {}
    intervals = defaultdict(list)
    by_path = {s.path: s for s in sessions}
    pr_metrics, maps = {}, {}
    for repo, rows in prs.items():
        maps[repo] = issue_pr_mapping(rows)
        pr_metrics[repo] = {p['number']: dict(p, tokens=0, agent_hours=0) for p in rows}
    date = dt.datetime.fromtimestamp(since).date()
    while dt.datetime.combine(date, dt.time()).timestamp() < until:
        days[date.isoformat()] = dict(empty_metrics(), merged_prs=0)
        date += dt.timedelta(days=1)
    for session in sessions:
        if not session.tokens and not session.gaps:
            continue
        project = projects[session.cwd]
        p = project_rows.setdefault(project, empty_metrics())
        h = harness_rows.setdefault(session.harness, empty_metrics())
        main = by_path.get(session.main_path)
        mapping, numbers = maps.get(project, {}), set(pr_metrics.get(project, {}))
        for token in session.tokens:
            d = days[dt.datetime.fromtimestamp(token.timestamp).date().isoformat()]
            for target in (p, h, d):
                target['tokens'] += token.total
                target['tokens_excluding_cache_read'] += token.total - token.cache_read
            weights = attribution_weights(token.refs, session.refs, main.refs if main else (), mapping, numbers)
            for number, weight in weights.items():
                pr_metrics[project][number]['tokens'] += token.total * weight
        for gap in session.gaps:
            hours = (gap.end - gap.start) / 3600
            p['agent_hours'] += hours
            h['agent_hours'] += hours
            for day, start, stop in day_parts(gap.start, gap.end):
                days[day]['agent_hours'] += (stop - start) / 3600
                intervals[day].append((start, stop))
            weights = attribution_weights(gap.refs, session.refs, main.refs if main else (), mapping, numbers)
            for number, weight in weights.items():
                pr_metrics[project][number]['agent_hours'] += hours * weight
    for day, d in days.items():
        d['wall_hours'] = union_seconds(intervals[day]) / 3600
    coverage, top = [], []
    for project, p in project_rows.items():
        rows = list(pr_metrics.get(project, {}).values())
        p['merged_prs'] = len(rows) if project in prs else None
        p['tokens_per_pr'] = p['tokens'] / len(rows) if rows else None
        p['hours_per_pr'] = p['agent_hours'] / len(rows) if rows else None
        if project not in prs:
            continue
        token_rows = [r for r in rows if r['tokens'] > 0]
        time_rows = [r for r in rows if r['agent_hours'] > 0]
        coverage.append({'repo': project, 'prs': len(rows), 'prs_with_tokens': len(token_rows),
                         'tokens_attributed_percent': 100 * sum(r['tokens'] for r in rows) / p['tokens'] if p['tokens'] else None,
                         'hours_attributed_percent': 100 * sum(r['agent_hours'] for r in rows) / p['agent_hours'] if p['agent_hours'] else None,
                         'median_tokens_per_pr': percentile([r['tokens'] for r in token_rows], .5),
                         'p90_tokens_per_pr': percentile([r['tokens'] for r in token_rows], .9),
                         'median_hours_per_pr': percentile([r['agent_hours'] for r in time_rows], .5),
                         'p90_hours_per_pr': percentile([r['agent_hours'] for r in time_rows], .9)})
        for row in rows:
            days[dt.datetime.fromtimestamp(epoch(row['mergedAt'])).date().isoformat()]['merged_prs'] += 1
            top.append({'repo': project, 'number': row['number'], 'title': row['title'],
                        'tokens': row['tokens'], 'agent_hours': row['agent_hours']})
    return {'projects': [dict(project=name, **row) for name, row in sorted(project_rows.items(), key=lambda pair: -pair[1]['tokens'])],
            'attribution': sorted(coverage, key=lambda row: row['repo']),
            'top_prs': sorted(top, key=lambda row: -row['tokens'])[:20],
            'days': [dict(day=day, **row) for day, row in sorted(days.items())],
            'harnesses': [dict(harness=name, **row) for name, row in sorted(harness_rows.items())]}


def format_number(value, scale=1):
    return '—' if value is None else f'{value / scale:,.2f}'


def table(headers, rows):
    def escape(value):
        return str(value).replace('|', '\\|').replace('\n', ' ')
    return '\n'.join('| ' + ' | '.join(map(escape, row)) + ' |' for row in [headers, ['---'] * len(headers), *rows])


def markdown(report):
    meta = report['window']
    lines = ['# Agent throughput', '', f"Range: **{meta['since']} ≤ event < {meta['until']}**.",
             f"Timezone: **{meta['timezone']}** (local event-day bucketing). Active gap cap: **{meta['cap_minutes']:g} min**.",
             'Tokens include all retained main/subagent usage; time includes main sessions only. No dollar costs.', '',
             '## Per project', '', table(['Project', 'Mtok', 'Mtok excl. cacheRead', 'Agent-h', 'Merged PRs', 'Mtok/PR', 'h/PR'],
             [[r['project'], format_number(r['tokens'], 1e6), format_number(r['tokens_excluding_cache_read'], 1e6),
               format_number(r['agent_hours']), 'unavailable' if r['merged_prs'] is None else r['merged_prs'],
               format_number(r['tokens_per_pr'], 1e6), format_number(r['hours_per_pr'])] for r in report['projects']]), '',
             '## PR attribution coverage', '',
             'Percentiles use PRs with positive attributed tokens / hours respectively; other PRs are not zero-cost observations.', '',
             table(['Repo', 'PRs', 'PRs with tokens', '% tokens attributed', '% hours attributed', 'Median Mtok/PR', 'p90 Mtok/PR', 'Median h/PR', 'p90 h/PR'],
                   [[r['repo'], r['prs'], r['prs_with_tokens'], format_number(r['tokens_attributed_percent']),
                     format_number(r['hours_attributed_percent']), format_number(r['median_tokens_per_pr'], 1e6),
                     format_number(r['p90_tokens_per_pr'], 1e6), format_number(r['median_hours_per_pr']),
                     format_number(r['p90_hours_per_pr'])] for r in report['attribution']]), '',
             '## Top PRs by attributed tokens', '', table(['Repo', 'PR', 'Title', 'Mtok', 'h'],
                   [[r['repo'], r['number'], r['title'], format_number(r['tokens'], 1e6), format_number(r['agent_hours'])]
                    for r in report['top_prs'] if r['tokens']]), '',
             '## Per day', '', table(['Day', 'Mtok', 'Mtok excl. cacheRead', 'Agent-h', 'Wall-h', 'Merged PRs'],
                   [[r['day'], format_number(r['tokens'], 1e6), format_number(r['tokens_excluding_cache_read'], 1e6),
                     format_number(r['agent_hours']), format_number(r['wall_hours']), r['merged_prs'] if report['prs_complete'] else f"{r['merged_prs']} known"]
                    for r in report['days']]), '',
             '## Per harness', '', table(['Harness', 'Mtok', 'Mtok excl. cacheRead', 'Agent-h'],
                   [[r['harness'], format_number(r['tokens'], 1e6), format_number(r['tokens_excluding_cache_read'], 1e6),
                     format_number(r['agent_hours'])] for r in report['harnesses']]), '',
             '## Coverage and limitations', '',
             'Regex PR attribution is approximate. Project tokens/PR divides all observed project usage by merged PRs, not just attributed usage.',
             'Raw JSONL retention bounds token coverage; Backscroll keeps text/timestamps but no usage columns. Codex raw files expire sooner.',
             'Merged PRs are restricted to the authenticated gh author and this window; sessions can span other PR lifetimes.']
    for name, reason in sorted(report['pr_unavailable'].items()):
        lines.append(f'- PRs unavailable for {name}: {reason}')
    for name, count in sorted(report['parse_warnings'].items()):
        lines.append(f'- {name}: {count}')
    lines.append(f"\nRuntime: {report['runtime_seconds']:.2f} s; parsed sessions: {report['session_count']}.")
    return '\n'.join(lines) + '\n'


def positive(value):
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError('must be a positive finite number')
    return number


def date_argument(value):
    try:
        return dt.date.fromisoformat(value)
    except ValueError:
        raise argparse.ArgumentTypeError('expected YYYY-MM-DD') from None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    window = parser.add_mutually_exclusive_group()
    window.add_argument('--days', type=positive, help='rolling days before now (default: 30)')
    window.add_argument('--since', type=date_argument, help='inclusive local date')
    parser.add_argument('--until', type=date_argument, help='exclusive local date; requires --since')
    parser.add_argument('--cap-minutes', type=positive, default=30)
    parser.add_argument('--no-prs', action='store_true', help='skip gh entirely, including repository resolution')
    parser.add_argument('--json', action='store_true', help='emit structured JSON instead of Markdown')
    parser.add_argument('--out', type=Path, help='write output to this file instead of stdout')
    args = parser.parse_args(argv)
    if args.until and not args.since:
        parser.error('--until requires --since')
    until = dt.datetime.combine(args.until, dt.time()).timestamp() if args.until else time.time()
    since = dt.datetime.combine(args.since, dt.time()).timestamp() if args.since else until - (args.days or 30) * 86400
    if until <= since:
        parser.error('window end must be after its start')
    started = time.monotonic()
    warnings = defaultdict(int)
    sessions = collect_sessions(Path.home(), since, until, args.cap_minutes * 60, warnings)
    if args.no_prs:
        roots = local_project_roots(sessions)
        projects, repos, unavailable = roots, set(), {root: 'skipped (--no-prs)' for root in set(roots.values())}
        prs = {}
    else:
        projects, repos, unavailable = resolve_projects(sessions)
        prs, errors = fetch_prs(repos, since, until)
        unavailable.update(errors)
    report = build_report(sessions, projects, prs, since, until)
    report.update(window={'since': dt.datetime.fromtimestamp(since).astimezone().isoformat(),
                          'until': dt.datetime.fromtimestamp(until).astimezone().isoformat(),
                          'timezone': '/'.join(time.tzname), 'cap_minutes': args.cap_minutes},
                  prs_complete=not args.no_prs and not unavailable, pr_unavailable=unavailable, parse_warnings=dict(warnings),
                  session_count=len(sessions), runtime_seconds=time.monotonic() - started)
    output = json.dumps(report, indent=2, ensure_ascii=False) + '\n' if args.json else markdown(report)
    if args.out:
        args.out.write_text(output)
    else:
        sys.stdout.write(output)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
