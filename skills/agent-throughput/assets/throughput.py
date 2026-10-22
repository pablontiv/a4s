#!/usr/bin/env python3
"""Local, subscription-only agent throughput accounting (Python standard library)."""

import argparse
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from dataclasses import dataclass, field
import datetime as dt
from functools import lru_cache
import json
import math
from multiprocessing import get_context
import os
from pathlib import Path
import re
import subprocess
import shlex
import sys
import time
from urllib.parse import unquote, urlsplit

ASK_TOOLS = {'ask', 'ask_user_question', 'AskUserQuestion', 'request_user_input',
             'question', 'ask_user'}
TOOL_STOPS = {'toolUse', 'tool_use'}
REF_PATTERNS = {
    'issue': [r'issue-(\d+)', r'issue://(?:[\w.-]+/[\w.-]+/)?(\d+)',
              r'gh issue \w+ (\d+)', r'/issues/(\d+)', r'AB#(\d+)', r'/_workitems/edit/(\d+)'],
    'pr': [r'gh pr \w+ (\d+)', r'pr://(?:[\w.-]+/[\w.-]+/)?(\d+)',
           r'/pull/(\d+)', r'/pullrequest/(\d+)'],
}
REF_PATTERNS = {kind: [re.compile(p) for p in patterns]
                for kind, patterns in REF_PATTERNS.items()}


QUALIFIED_REFS = re.compile(
    r'(?P<uri>issue|pr)://(?P<uri_repo>[\w.-]+/[\w.-]+)/(?P<uri_n>\d+)'
    r'|https?://github\.com/(?P<url_repo>[\w.-]+/[\w.-]+)/(?P<url_kind>issues|pull)/(?P<url_n>\d+)'
    r'|(?<![\w./-])(?P<hash_repo>[\w.-]+/[\w.-]+)#(?P<hash_n>\d+)')
GH_COMMAND = re.compile(r'\bgh\s+(issue|pr)\s+([^\n;|&]+)')
GH_REPO = re.compile(r'(?:-R|--repo)(?:\s+|=)([\w.-]+/[\w.-]+)')
AZURE_URL = re.compile(r'https?://(?:[^/\s"<>]+@)?(?:dev\.azure\.com/[^/\s"<>]+|'
                       r'[^/\s"<>]+\.visualstudio\.com)/[^\s"<>\\]+')
AZ_COMMAND = re.compile(r'\baz\s+(repos\s+pr|boards\s+work-item)\s+([^\n;|&]+)')
BRANCH_REFS = re.compile(r'(?<![\w./-])(?:refs/heads/)?'
                         r'((?:feature|feat|fix|hotfix|docs|ci)/[\w][\w./-]*)')
BRANCH_ISSUES = re.compile(r'(?:^|/)(\d+)(?=[-_/]|$)')
CLONE_REFS = re.compile(r"""(?<![\w.-])([\w.-]+)-pr(\d+)(?=[-./\\\s"']|$)""")
REFERENCE_MARKERS = ('issue-', 'issue://', 'pr://', 'gh ', '/issues/', '/pull/',
                     '#', '/pullrequest/', 'az ', '/_workitems/', '-pr',
                     'feature/', 'feat/', 'fix/', 'hotfix/', 'docs/', 'ci/')


def remote_identity(remote):
    """Pure origin normalization; credentials are never part of an identity."""
    remote = remote.strip()
    if re.match(r'^[^/@]+@[^/:]+:', remote):
        remote = 'ssh://' + remote.replace(':', '/', 1)
    try:
        parsed = urlsplit(remote)
        host = (parsed.hostname or '').lower()
        parts = unquote(parsed.path).strip('/').split('/')
    except ValueError:
        return None
    if parts and parts[-1].endswith('.git'):
        parts[-1] = parts[-1][:-4]
    if host == 'github.com' and len(parts) == 2 and all(parts):
        return 'github:' + '/'.join(parts).lower()
    if host == 'ssh.dev.azure.com' and parts[:1] == ['v3'] and len(parts) == 4:
        return 'ado:' + '/'.join([parts[1].lower(), *parts[2:]])
    if host == 'dev.azure.com' and len(parts) == 4 and parts[2] == '_git':
        return 'ado:' + '/'.join([parts[0].lower(), parts[1], parts[3]])
    if host.endswith('.visualstudio.com'):
        if parts[:1] == ['DefaultCollection']:
            parts = parts[1:]
        if len(parts) == 3 and parts[1] == '_git':
            return 'ado:' + '/'.join([host[:-len('.visualstudio.com')], parts[0], parts[2]])
    return None


def azure_url_reference(match):
    """Return a repo-qualified PR or project/repo-qualified work item."""
    url = match[0]
    parsed = urlsplit(url)
    path = unquote(parsed.path)
    pr = re.search(r'/pullrequest/(\d+)', path, re.IGNORECASE)
    if pr:
        identity = remote_identity(url[:url.lower().index('/pullrequest/')])
        return ('pr', int(pr[1]), identity) if identity else None
    issue = re.search(r'/_workitems/edit/(\d+)', path, re.IGNORECASE)
    if issue:
        prefix = url[:url.lower().index('/_workitems/edit/')]
        identity = remote_identity(prefix)
        if not identity:
            parsed = urlsplit(prefix)
            parts = unquote(parsed.path).strip('/').split('/')
            if parsed.hostname == 'dev.azure.com' and len(parts) == 2:
                identity = f'ado:{parts[0].lower()}/{parts[1]}/'
            elif parsed.hostname and parsed.hostname.endswith('.visualstudio.com') and len(parts) == 1:
                identity = f'ado:{parsed.hostname.split(".")[0].lower()}/{parts[0]}/'
        return ('issue', int(issue[1]), identity) if identity else None
    return None


def command_arguments(text):
    text = re.split(r'(?<!\\)"', text.split(r'\n')[0], maxsplit=1)[0].replace(r'\"', '"')
    try:
        return shlex.split(text)
    except ValueError:
        return []


def extract_refs(text):
    """Extract (kind, number-or-branch[, repository]) references."""
    if not any(marker in text for marker in REFERENCE_MARKERS):
        return frozenset()
    refs = set()
    if 'dev.azure.com' in text or '.visualstudio.com' in text:
        def azure_reference(match):
            ref = azure_url_reference(match)
            if ref:
                refs.add(ref)
                return ' '
            return match[0]
        text = AZURE_URL.sub(azure_reference, text)
    if 'az ' in text:
        def azure_command(match):
            args = command_arguments(match[2])
            flags = {}
            for index, arg in enumerate(args):
                if arg.startswith('--'):
                    key, separator, value = arg.partition('=')
                    flags[key] = value if separator else (args[index + 1] if index + 1 < len(args) else '')
            number = flags.get('--id', '')
            is_pr = match[1].split()[0] == 'repos'
            branch = flags.get('--source-branch', '').removeprefix('refs/heads/')
            if number.isdigit():
                ref = ('pr' if is_pr else 'issue', int(number))
            elif is_pr and branch and not branch.startswith('$'):
                ref = ('branch', branch)
            else:
                return match[0]
            org = flags.get('--org', flags.get('--organization', ''))
            project, repo = flags.get('--project', ''), flags.get('--repository', '')
            organization = ''
            if org:
                parsed = urlsplit(org)
                organization = (parsed.path.strip('/') if parsed.hostname == 'dev.azure.com'
                                else (parsed.hostname or '').split('.')[0])
            if organization or project or repo:
                ref += (f'ado:{organization.lower()}/{unquote(project)}/{unquote(repo)}',)
            refs.add(ref)
            return ' '
        text = AZ_COMMAND.sub(azure_command, text)
    def qualified(match):
        if match['uri']:
            refs.add(('issue' if match['uri'] == 'issue' else 'pr',
                      int(match['uri_n']), match['uri_repo'].lower()))
        elif match['url_repo']:
            refs.add(('issue' if match['url_kind'] == 'issues' else 'pr',
                      int(match['url_n']), match['url_repo'].lower()))
        else:
            refs.add(('number', int(match['hash_n']), match['hash_repo'].lower()))
        return ' '
    text = QUALIFIED_REFS.sub(qualified, text)
    def gh_reference(match):
        arguments = match[2].split(r'\n')[0].split('"')[0]
        repo = GH_REPO.search(arguments)
        if repo:
            positional = GH_REPO.sub('', arguments)
            number = re.match(r'\w+\s+(\d+)\b', positional)
            if number:
                refs.add((match[1], int(number[1]), repo[1].lower()))
                return ' '
        return match[0]
    text = GH_COMMAND.sub(gh_reference, text)
    if '-pr' in text:
        def clone_reference(match):
            refs.add(('pr', int(match[2]), 'repo:' + match[1]))
            return ' '
        text = CLONE_REFS.sub(clone_reference, text)
    refs.update(('branch', branch) for branch in BRANCH_REFS.findall(text))
    refs.update((kind, int(n)) for kind, patterns in REF_PATTERNS.items()
                for pattern in patterns for n in pattern.findall(text))
    return frozenset(refs)


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


def parse_session_file(job):
    """One file per task in a fixed, reusable parser pool; warnings return with it."""
    harness, path, root, since, until, cap_seconds = job
    warnings = defaultdict(int)
    try:
        if harness == 'codex':
            session = parse_codex(path, since, until, cap_seconds, warnings)
        elif harness == 'claude':
            session = parse_claude(path, root, since, until, cap_seconds, warnings)
        else:
            session = parse_pi(path, root, harness, since, until, cap_seconds, warnings)
        return session, dict(warnings)
    except OSError:
        warnings['unreadable or vanished session files'] += 1
        return None, dict(warnings)


def collect_sessions(home, since, until, cap_seconds, warnings):
    sessions, jobs = [], []
    for harness, suffix in [('omp', '.omp/agent/sessions'), ('pi', '.pi/agent/sessions'),
                            ('claude', '.claude/projects')]:
        root = home / suffix
        for path in root.rglob('*.jsonl'):
            try:
                if path.stat().st_mtime >= since:
                    jobs.append((harness, path, root, since, until, cap_seconds))
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
    jobs.extend(('codex', path, None, since, until, cap_seconds) for _, path in best.values())
    def collect(results):
        for session, counts in results:
            if session:
                sessions.append(session)
            for name, count in counts.items():
                warnings[name] += count
    if len(jobs) > 1:
        with ProcessPoolExecutor(max_workers=min(4, os.cpu_count() or 1),
                                 mp_context=get_context('spawn')) as pool:
            collect(pool.map(parse_session_file, jobs, chunksize=16))
    else:
        collect(map(parse_session_file, jobs))
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
    """Map linked issues and exact source branches to their merged PRs."""
    mapping = defaultdict(set)
    for pr in prs:
        branch = pr.get('headRefName', '').removeprefix('refs/heads/')
        if branch:
            mapping[('branch', branch)].add(pr['number'])
        issues = {item['number'] for item in pr.get('closingIssuesReferences', [])}
        issues.update(int(n) for n in re.findall(r'issue-(\d+)', pr.get('headRefName', '')))
        if pr.get('provider') == 'ado':
            issues.update(int(n) for n in BRANCH_ISSUES.findall(branch))
        for issue in issues:
            mapping[issue].add(pr['number'])
    return dict(mapping)


def reference_matches(reference, repo):
    reference, repo = reference.casefold(), repo.casefold()
    if reference.startswith('repo:'):
        return reference[5:] == repo.rsplit('/', 1)[-1]
    if reference.startswith('ado:'):
        if not repo.startswith('ado:'):
            return False
        scope, target = reference[4:].split('/'), repo[4:].split('/')
        return len(scope) <= len(target) and all(
            not part or part == target[index] for index, part in enumerate(scope))
    return reference.removeprefix('github:') == repo.removeprefix('github:')


def referenced_prs(refs, mapping, merged_numbers, repo=None):
    result = set()
    for ref in refs:
        kind, number = ref[:2]
        if len(ref) == 3 and repo is not None and not reference_matches(ref[2], repo):
            continue
        if kind in ('pr', 'number') and number in merged_numbers:
            result.add(number)
        if kind in ('issue', 'number'):
            result.update(mapping.get(number, set()))
        if kind == 'branch':
            exact = mapping.get(('branch', number), set())
            if exact:
                result.update(exact)
            else:
                for issue in BRANCH_ISSUES.findall(number):
                    result.update(mapping.get(int(issue), set()))
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


def workspace_reference_prs(refs, members, maps, numbers):
    """Pure reference selection, retaining ambiguity across member repositories."""
    if not members:
        return set(), False
    if len(members) == 1:
        repo = next(iter(members))
        return {(repo, number) for number in referenced_prs(
            refs, maps.get(repo, {}), numbers.get(repo, set()), repo)}, False
    selected, ambiguous = set(), False
    for ref in refs:
        matches = {repo: referenced_prs((ref,), maps.get(repo, {}), numbers.get(repo, set()), repo)
                   for repo in members}
        matches = {repo: rows for repo, rows in matches.items() if rows}
        if len(matches) == 1:
            selected.update((repo, number) for repo, rows in matches.items() for number in rows)
        else:
            ambiguous = ambiguous or len(matches) > 1
    return selected, ambiguous


def workspace_attribution_weights(refs, file_refs, main_refs, members, maps, numbers):
    """Direct references split evenly; fallback candidates must identify one PR."""
    selected, ambiguous = workspace_reference_prs(refs, members, maps, numbers)
    if not selected and not ambiguous:
        for fallback in (file_refs, main_refs):
            candidates, ambiguous = workspace_reference_prs(fallback, members, maps, numbers)
            if len(candidates) == 1 and not ambiguous:
                selected = candidates
                break
    return {key: 1 / len(selected) for key in selected}


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


@lru_cache(maxsize=None)
def git_common_directory(location):
    """Resolve git markers/commondir locally once per directory, without spawning git."""
    path = Path(location)
    marker = path / '.git'
    try:
        if marker.is_dir():
            return str(marker.resolve())
        if marker.is_file():
            declaration = marker.read_text().strip()
            if not declaration.startswith('gitdir:'):
                return None
            gitdir = (path / declaration.split(':', 1)[1].strip()).resolve()
            common = gitdir / 'commondir'
            return str((gitdir / common.read_text().strip()).resolve()) if common.is_file() else str(gitdir)
    except OSError:
        return None
    return git_common_directory(str(path.parent)) if path.parent != path else None


@lru_cache(maxsize=None)
def origin_remote(common):
    value, _ = command(['git', '--git-dir', common, 'config', '--get', 'remote.origin.url'])
    return value or ''


def repository_names(remotes):
    """Pure same-origin clone merging, with stable casing and unsupported local roots."""
    identities, names = {}, {}
    for root, remote in sorted(remotes.items()):
        identity = remote_identity(remote)
        names[root] = identities.setdefault(identity.casefold(), identity) if identity else root
    return names


def resolve_project_root(cwd, known_roots=()):
    location = project_location(cwd, known_roots, lambda path: Path(path).exists(), Path.home())
    if location.startswith('('):
        return location, False
    common = git_common_directory(location)
    if common and common.endswith('/.git'):
        root = common[:-5]
        if Path(root) in (Path.home(), Path('/Users/Shared')):
            return '(no repo)', False
        return root, True
    return strip_worktrees(cwd), False


def local_project_roots(sessions, registered_roots=()):
    cwds = sorted({s.cwd for s in sessions if s.tokens or s.gaps})
    with ThreadPoolExecutor(max_workers=8) as pool:
        resolved = dict(zip(cwds, pool.map(resolve_project_root, cwds)))
        known_roots = {root for root, is_git in resolved.values() if is_git} | set(registered_roots)
        pending = [cwd for cwd, (_, is_git) in resolved.items() if not is_git]
        recovered = pool.map(lambda cwd: resolve_project_root(cwd, known_roots), pending)
        resolved.update(zip(pending, recovered))
    return ({cwd: root for cwd, (root, _) in resolved.items()},
            {root for root, is_git in resolved.values() if is_git})


def declared_workspaces(registrations, explicit=()):
    """Pure declaration parsing: only folder registrations/flags declare folders."""
    folders = {str(Path(item['path'])) for item in registrations
               if item.get('kind') == 'folder' and item.get('path')}
    folders.update(str(Path(path)) for path in explicit)
    repos = {str(Path(item['path'])) for item in registrations
             if item.get('kind') == 'git' and item.get('path')}
    return folders, repos


def find_workspace_members(folders, children, exists):
    """Pure, injected directory traversal: git markers at depths one and two."""
    members = {}
    for folder in folders:
        found, level = set(), [folder]
        for _ in range(2):
            level = [child for parent in level for child in children(parent)
                     if not Path(child).name.startswith('.')]
            found.update(path for path in level if exists(str(Path(path) / '.git')))
        members[folder] = found
    return members


def assign_workspaces(roots, repo_names, folder_members):
    """Pure mapping of session cwd/common root to workspace and member identity."""
    member_names = {folder: {repo_names[root] for root in members if root in repo_names}
                    for folder, members in folder_members.items()}
    projects, session_repos, workspace_repos = {}, {}, {}
    for cwd, root in roots.items():
        repo = repo_names.get(root)
        owners = [folder for folder, members in folder_members.items()
                  if cwd == folder or root == folder or root in members
                  or (repo is not None and repo in member_names[folder])]
        if owners:
            containing = [folder for folder in owners
                          if Path(cwd).is_relative_to(folder) or Path(root).is_relative_to(folder)]
            project = max(containing or owners, key=lambda path: (len(Path(path).parts), path))
            members = member_names[project]
        else:
            project, members = repo or root, {repo} if repo else set()
        projects[cwd], session_repos[cwd] = project, repo
        workspace_repos[project] = set(members)
    return projects, session_repos, workspace_repos


def orca_registrations():
    executable = os.environ.get('ORCA_CLI_COMMAND')
    executable = shlex.split(executable) if executable else [
        'orca-dev' if os.environ.get('ORCA_DEV_REPO_ROOT') else (
            'orca-ide' if sys.platform.startswith('linux') else 'orca')]
    raw, error = command([*executable, 'repo', 'list', '--json'])
    if error:
        return [], 'Orca registrations unavailable; using explicit folders and git repositories: ' + error
    try:
        records = json.loads(raw)['result']['repos']
        if not isinstance(records, list):
            raise ValueError('expected repos array')
        return records, None
    except (ValueError, TypeError, KeyError) as error:
        return [], 'Orca registrations unavailable: ' + str(error)


@dataclass
class WorkspaceSources:
    projects: dict
    session_repos: dict
    members: dict
    repos: set
    warnings: list


def resolve_workspaces(sessions, explicit=(), registration_result=None):
    registrations, registration_error = registration_result if registration_result is not None else orca_registrations()
    folders, registered = declared_workspaces(registrations, explicit)
    warnings = [registration_error] if registration_error else []
    def children(parent):
        try:
            return [str(path) for path in Path(parent).iterdir() if path.is_dir() and not path.is_symlink()]
        except OSError as error:
            warnings.append(f'Workspace member discovery unavailable for {parent}: {error}')
            return []
    discovered = find_workspace_members(folders, children, lambda path: Path(path).exists())
    candidates = registered | {path for members in discovered.values() for path in members}
    common = {path: resolve_project_root(path) for path in candidates}
    folder_members = {folder: {common[path][0] for path in members}
                      for folder, members in discovered.items()}
    roots, git_roots = local_project_roots(sessions, {root for root, valid in common.values() if valid})
    git_roots.update(root for members in folder_members.values() for root in members)
    def origin(root):
        common_dir = git_common_directory(root)
        return origin_remote(common_dir) if common_dir else ''
    with ThreadPoolExecutor(max_workers=8) as pool:
        remotes = dict(zip(sorted(git_roots), pool.map(origin, sorted(git_roots))))
    names = repository_names(remotes)
    projects, session_repos, members = assign_workspaces(roots, names, folder_members)
    needed = {repo for rows in members.values() for repo in rows}
    repos = {name for name in names.values() if name.startswith(('github:', 'ado:')) and name in needed}
    return WorkspaceSources(projects, session_repos, members, repos, warnings)


def filter_azure_prs(rows, author, since, until):
    """Pure completed/author/window filter and provider-neutral PR normalization."""
    selected = []
    for row in rows:
        closed = epoch(row.get('closedDate'))
        if (row.get('status') == 'completed' and closed is not None and since <= closed < until
                and (row.get('createdBy') or {}).get('uniqueName', '').casefold() == author.casefold()):
            selected.append({'number': row['pullRequestId'], 'title': row['title'],
                             'mergedAt': row['closedDate'], 'createdAt': row.get('creationDate'),
                             'headRefName': row.get('sourceRefName', ''),
                             'closingIssuesReferences': [], 'provider': 'ado'})
    return selected


def fetch_prs(repos, since, until, skip=False):
    if not repos:
        return {}, {}
    if skip:
        return {}, {repo: 'skipped (--no-prs)' for repo in repos}
    providers = {repo.split(':', 1)[0] for repo in repos}
    def identity(provider):
        args = (['gh', 'api', 'user', '-q', '.login'] if provider == 'github'
                else ['az', 'account', 'show', '--query', 'user.name', '-o', 'tsv'])
        author, error = command(args)
        return author, error or (None if author else 'empty authenticated author')
    with ThreadPoolExecutor(max_workers=8) as pool:
        authors = dict(zip(sorted(providers), pool.map(identity, sorted(providers))))
        since_date = dt.datetime.fromtimestamp(since, dt.timezone.utc).date().isoformat()
        until_date = dt.datetime.fromtimestamp(until, dt.timezone.utc).date().isoformat()
        def fetch(repo):
            provider, name = repo.split(':', 1)
            author, error = authors[provider]
            if error:
                return repo, None, f'{provider} author unavailable: {error}'
            if provider == 'github':
                args = ['gh', 'pr', 'list', '-R', name, '--state', 'merged',
                        '--search', f'merged:>={since_date} merged:<={until_date} author:{author}',
                        '--limit', '1000', '--json',
                        'number,title,author,createdAt,mergedAt,headRefName,closingIssuesReferences']
            else:
                org, project, repository = name.split('/', 2)
                args = ['az', 'repos', 'pr', 'list', '--org', f'https://dev.azure.com/{org}',
                        '--project', project, '--repository', repository, '--status', 'completed',
                        '--top', '1000', '--query',
                        '[].{pullRequestId:pullRequestId,status:status,closedDate:closedDate,'
                        'createdBy:{uniqueName:createdBy.uniqueName},creationDate:creationDate,'
                        'title:title,sourceRefName:sourceRefName}', '-o', 'json']
            raw, error = command(args, timeout=90)
            if error:
                return repo, None, error
            try:
                rows = json.loads(raw)
                if len(rows) >= 1000:
                    return repo, None, '1000-result limit reached; narrow the date window'
                if provider == 'ado':
                    return repo, filter_azure_prs(rows, author, since, until), None
                return repo, [pr for pr in rows if (pr.get('author') or {}).get('login', '').casefold() == author.casefold()
                              and epoch(pr.get('mergedAt')) is not None and since <= epoch(pr['mergedAt']) < until], None
            except (ValueError, TypeError, KeyError) as error:
                return repo, None, f'invalid {provider} PR response: {error}'
        prs, errors = {}, {}
        for repo, rows, error in pool.map(fetch, sorted(repos)):
            if error:
                errors[repo] = error
            else:
                prs[repo] = rows
        def work_items(item):
            repo, row = item
            org = repo[4:].split('/', 1)[0]
            raw, error = command(['az', 'repos', 'pr', 'work-item', 'list', '--id', str(row['number']),
                                  '--org', f'https://dev.azure.com/{org}', '--query', '[].id', '-o', 'json'],
                                 timeout=60)
            if not error:
                try:
                    row['closingIssuesReferences'] = [{'number': int(number)} for number in json.loads(raw)]
                except (TypeError, ValueError) as invalid:
                    error = 'invalid work-item response: ' + str(invalid)
            return repo, error
        items = [(repo, row) for repo, rows in prs.items() if repo.startswith('ado:') for row in rows]
        for repo, error in pool.map(work_items, items):
            if error:
                errors[repo] = 'Azure linked work items unavailable: ' + error
        for repo in errors:
            prs.pop(repo, None)
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


def build_report(sessions, projects, prs, since, until, non_repos=(), pr_unavailable=None,
                 workspace_repos=None, session_repos=None, pr_sources=None):
    project_rows, harness_rows, days = {}, {}, {}
    workspace_repos = workspace_repos if workspace_repos is not None else {
        project: set() if project in non_repos else {project} for project in projects.values()}
    session_repos = session_repos if session_repos is not None else {
        cwd: project if project not in non_repos else None for cwd, project in projects.items()}
    intervals = defaultdict(list)
    repo_totals = defaultdict(empty_metrics)
    by_path = {s.path: s for s in sessions}
    pr_metrics, maps = {}, {}
    for repo, rows in prs.items():
        maps[repo] = issue_pr_mapping(rows)
        pr_metrics[repo] = {p['number']: dict(p, tokens=0, agent_hours=0) for p in rows}
    numbers = {repo: set(rows) for repo, rows in pr_metrics.items()}
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
        repo = session_repos.get(session.cwd)
        members = {repo} if repo else workspace_repos.get(project, set())
        fallback = workspace_attribution_weights((), session.refs, main.refs if main else (),
                                                 members, maps, numbers)
        @lru_cache(maxsize=None)
        def weights_for(refs):
            selected, ambiguous = workspace_reference_prs(refs, members, maps, numbers)
            if selected:
                return {key: 1 / len(selected) for key in selected}
            return {} if ambiguous else fallback
        def attribute(refs, field, value):
            weights = weights_for(frozenset(refs))
            if len(members) == 1:
                repo_totals[next(iter(members))][field] += value
            else:
                for (target, _), weight in weights.items():
                    repo_totals[target][field] += value * weight
            for (target, number), weight in weights.items():
                pr_metrics[target][number][field] += value * weight
        for token in session.tokens:
            d = days[dt.datetime.fromtimestamp(token.timestamp).date().isoformat()]
            for target in (p, h, d):
                target['tokens'] += token.total
                target['tokens_excluding_cache_read'] += token.total - token.cache_read
            attribute(token.refs, 'tokens', token.total)
        for gap in session.gaps:
            hours = (gap.end - gap.start) / 3600
            p['agent_hours'] += hours
            h['agent_hours'] += hours
            for day, start, stop in day_parts(gap.start, gap.end):
                days[day]['agent_hours'] += (stop - start) / 3600
                intervals[day].append((start, stop))
            attribute(gap.refs, 'agent_hours', hours)
    for day, d in days.items():
        d['wall_hours'] = union_seconds(intervals[day]) / 3600
    needed = {repo for project in project_rows for repo in workspace_repos.get(project, ())}
    pr_sources = set(needed if pr_sources is None else pr_sources)
    needed.intersection_update(pr_sources)
    unavailable = dict(pr_unavailable or {})
    unavailable.update({repo: 'PR source unavailable' for repo in needed
                        if repo not in prs and repo not in unavailable})
    for project, p in project_rows.items():
        members = workspace_repos.get(project, set())
        rows = {(repo, number) for repo in members for number in pr_metrics.get(repo, {})}
        sources = members & pr_sources
        complete = all(repo in prs for repo in sources)
        p['repos'] = sorted(members)
        p['pr_source'] = 'not_applicable' if not sources else ('available' if complete else 'unavailable')
        p['known_merged_prs'] = len(rows)
        p['merged_prs'] = len(rows) if sources and complete else None
        p['tokens_per_pr'] = p['tokens'] / len(rows) if rows and complete else None
        p['hours_per_pr'] = p['agent_hours'] / len(rows) if rows and complete else None
    coverage, top = [], []
    for repo, metrics in pr_metrics.items():
        rows, totals = list(metrics.values()), repo_totals[repo]
        if not rows:
            continue
        token_rows = [r for r in rows if r['tokens'] > 0]
        time_rows = [r for r in rows if r['agent_hours'] > 0]
        coverage.append({'repo': repo, 'prs': len(rows), 'prs_with_tokens': len(token_rows),
                         'tokens_attributed_percent': 100 * sum(r['tokens'] for r in rows) / totals['tokens'] if totals['tokens'] else None,
                         'hours_attributed_percent': 100 * sum(r['agent_hours'] for r in rows) / totals['agent_hours'] if totals['agent_hours'] else None,
                         'median_tokens_per_pr': percentile([r['tokens'] for r in token_rows], .5),
                         'p90_tokens_per_pr': percentile([r['tokens'] for r in token_rows], .9),
                         'median_hours_per_pr': percentile([r['agent_hours'] for r in time_rows], .5),
                         'p90_hours_per_pr': percentile([r['agent_hours'] for r in time_rows], .9)})
        for row in rows:
            days[dt.datetime.fromtimestamp(epoch(row['mergedAt'])).date().isoformat()]['merged_prs'] += 1
            top.append({'repo': repo, 'number': row['number'], 'title': row['title'],
                        'tokens': row['tokens'], 'agent_hours': row['agent_hours']})
    return {'projects': [dict(project=name, **row) for name, row in sorted(project_rows.items(), key=lambda pair: -pair[1]['tokens'])],
            'attribution': sorted(coverage, key=lambda row: row['repo']),
            'top_prs': sorted(top, key=lambda row: -row['tokens'])[:20],
            'days': [dict(day=day, **row) for day, row in sorted(days.items())],
            'harnesses': [dict(harness=name, **row) for name, row in sorted(harness_rows.items())],
            'prs_complete': not unavailable, 'pr_unavailable': unavailable,
            'repositories': [{'repo': repo, 'merged_prs': len(prs[repo]) if repo in prs else None,
                              'pr_source': 'not_applicable' if repo not in pr_sources else (
                                  'available' if repo in prs else 'unavailable')}
                             for repo in sorted({repo for project in project_rows
                                                 for repo in workspace_repos.get(project, ())})],
            'no_pr_source_projects': sorted(project for project, row in project_rows.items()
                                           if row['pr_source'] == 'not_applicable'),
            'workspace_warnings': []}


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
             '## Per workspace', '', table(['Workspace', 'Repos', 'Mtok', 'Mtok excl. cacheRead', 'Agent-h', 'Merged PRs', 'Mtok/PR', 'h/PR'],
             [[r['project'], ', '.join(r['repos']) or 'n/a', format_number(r['tokens'], 1e6), format_number(r['tokens_excluding_cache_read'], 1e6),
               format_number(r['agent_hours']), 'n/a' if r['pr_source'] == 'not_applicable' else (
                   'unavailable' if r['merged_prs'] is None else r['merged_prs']),
               format_number(r['tokens_per_pr'], 1e6), format_number(r['hours_per_pr'])] for r in report['projects']]), '',
             '## PR attribution coverage', '',
             'Percentiles use PRs with positive attributed tokens / hours respectively; other PRs are not zero-cost observations.', '',
             'For multi-repository folder-cwd sessions, repository coverage includes only repository-resolvable usage; workspace totals retain all unassigned usage.', '',
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
             'Merged PRs are restricted to each provider’s authenticated author and this window; sessions can span other PR lifetimes.']
    for name, reason in sorted(report['pr_unavailable'].items()):
        lines.append(f'- PRs unavailable for {name}: {reason}')
    for name in report['no_pr_source_projects']:
        lines.append(f'- No supported PR source: {name}')
    for warning in report['workspace_warnings']:
        lines.append(f'- {warning}')
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
    parser.add_argument('--workspace', type=Path, action='append', default=[],
                        help='declare a folder workspace (repeatable; merged with Orca registrations)')
    parser.add_argument('--no-prs', action='store_true', help='skip all gh/az calls; resolve origins locally')
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
    with ThreadPoolExecutor(max_workers=1) as pool:
        registration = pool.submit(orca_registrations)
        sessions = collect_sessions(Path.home(), since, until, args.cap_minutes * 60, warnings)
        sources = resolve_workspaces(sessions, [str(path.expanduser().absolute()) for path in args.workspace],
                                     registration.result())
    prs, errors = fetch_prs(sources.repos, since, until, skip=args.no_prs)
    report = build_report(sessions, sources.projects, prs, since, until, pr_unavailable=errors,
                          workspace_repos=sources.members, session_repos=sources.session_repos,
                          pr_sources=sources.repos)
    report['workspace_warnings'] = sources.warnings
    report.update(window={'since': dt.datetime.fromtimestamp(since).astimezone().isoformat(),
                          'until': dt.datetime.fromtimestamp(until).astimezone().isoformat(),
                          'timezone': '/'.join(time.tzname), 'cap_minutes': args.cap_minutes},
                  parse_warnings=dict(warnings),
                  session_count=len(sessions), runtime_seconds=time.monotonic() - started)
    output = json.dumps(report, indent=2, ensure_ascii=False) + '\n' if args.json else markdown(report)
    if args.out:
        args.out.write_text(output)
    else:
        sys.stdout.write(output)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
