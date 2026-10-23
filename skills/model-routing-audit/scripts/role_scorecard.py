#!/usr/bin/env python3
"""Local OMP transcript scorecards; Python 3.10+, standard library only."""

import argparse
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone
import html
import json
import os
from pathlib import Path
import re
from statistics import median
import sys
import time


TASK_RESULT = re.compile(r'<task-result\b([^>]*)>(.*?)</task-result>', re.S)
ATTRIBUTE = re.compile(r'([\w-]+)="([^"]*)"')
INFRA = re.compile(
    r'ENOTFOUND|timed?\s*out|\b50[23]\b|socket connection|operation was aborted|'
    r'\(no output\)|rate[ -]?limit|usage[ -]?limit|quota', re.I)
VERSION = re.compile(r'(?:[-_ ]?v\d+|[-_ ]?(?:retry|redo)(?:[-_ ]?\d+)?)$', re.I)
VERDICT = re.compile(r'"verdict"\s*:\s*"(PASS|FAIL)"', re.I)


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)


def timestamp(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.replace(tzinfo=timezone.utc).timestamp() if parsed.tzinfo is None else parsed.timestamp()
    except ValueError:
        return None


def text_of(message):
    content = message.get('content') or []
    if isinstance(content, str):
        return content
    return '\n'.join(item.get('text', '') for item in content
                     if isinstance(item, dict) and item.get('type') == 'text')


def number(value):
    return value if isinstance(value, (int, float)) and value >= 0 else 0


def model_stats():
    return {'tokens': 0, 'turns': 0, 'errors': 0, 'aborted': 0,
            'error_messages': Counter(), 'context_latencies': []}


def safe_error(message):
    """Retain bounded diagnostics, redacting paths and common sensitive identifiers."""
    message = re.sub(r'https?://\S+|[\w.+-]+@[\w.-]+', '[redacted]', message)
    message = re.sub(r'(?:[A-Za-z]:[\\/]|(?<!\w)/|\.{1,2}/|~/)[^\s\"\'<>]+', '[path]', message)
    message = re.sub(r'\b(?:[\w.-]+[/\\])+[\w.\\/-]+', '[path]', message)
    message = re.sub(r'(?i)(bearer\s+|(?:api[_-]?key|token|password)\s*[:=]\s*)\S+', r'\1[redacted]', message)
    return ' '.join(message.split())[:160]


def parse_transcript(filename):
    """Parse once per file; workers return compact aggregates, not message histories."""
    path = Path(filename)
    init = None
    deliveries = {}
    models = defaultdict(model_stats)
    model_tokens = Counter()
    first = last = previous = None
    active = 0.0
    fallback = False
    stream_infra = False
    tool_calls = tool_results = tool_errors = unavailable = malformed = 0
    with path.open(encoding='utf-8', errors='replace') as stream:
        for line in stream:
            try:
                record = json.loads(line)
            except (ValueError, TypeError):
                malformed += 1
                continue
            if not isinstance(record, dict):
                malformed += 1
                continue
            ts = timestamp(record.get('timestamp'))
            if ts is not None:
                first = ts if first is None else min(first, ts)
                last = ts if last is None else max(last, ts)
            if '<task-result' in line:
                for value in strings(record):
                    for match in TASK_RESULT.finditer(value):
                        attrs = dict(ATTRIBUTE.findall(match[1]))
                        if all(key in attrs for key in ('id', 'agent', 'status')):
                            deliveries.setdefault(attrs['id'], {
                                'agent': html.unescape(attrs['agent']),
                                'status': html.unescape(attrs['status']),
                                'body': match[2].strip(), 'timestamp': ts})
            kind = record.get('type')
            if kind == 'session_init' and record.get('agent') and init is None:
                init = record
            if kind == 'model_change' and record.get('resolvedModelIsFallback'):
                fallback = True
            message = record.get('message') or {}
            if kind == 'message' and message.get('role') == 'assistant':
                model = f"{message.get('provider', 'unknown')}/{message.get('model', 'unknown')}"
                usage = message.get('usage') or {}
                tokens = number(usage.get('totalTokens'))
                stats = models[model]
                stats['tokens'] += tokens
                stats['turns'] += 1
                model_tokens[model] += tokens
                reason = message.get('stopReason')
                stats['errors'] += reason == 'error'
                stats['aborted'] += reason == 'aborted'
                error = message.get('errorMessage') or ''
                if error:
                    stats['error_messages'][safe_error(error)] += 1
                    stream_infra = stream_infra or bool(INFRA.search(error))
                gap = max(0, ts - previous) if ts is not None and previous is not None else None
                if gap is not None:
                    active += min(gap, 600)
                    context = number(usage.get('input')) + number(usage.get('cacheRead'))
                    if 40000 <= context <= 120000:
                        stats['context_latencies'].append(gap)
                content = message.get('content') or []
                if isinstance(content, list):
                    tool_calls += sum(isinstance(item, dict) and item.get('type') in ('toolCall', 'tool_use')
                                      for item in content)
            elif kind == 'message' and message.get('role') == 'toolResult':
                tool_results += 1
                if message.get('isError'):
                    tool_errors += 1
                    unavailable += bool(re.search(r'\bTool\s+"?[\w.-]+"?\s+(?:is\s+)?not\s+(?:available|found)', text_of(message), re.I))
            if ts is not None:
                previous = ts
    episode = None
    if init is not None:
        primary = init.get('resolvedModel') or 'unknown'
        episode = {
            'agent': init['agent'], 'model_role': init.get('modelRole'),
            'name': path.stem, 'primary_model': primary,
            'effective_model': max(model_tokens, key=model_tokens.get) if model_tokens else primary,
            'model_tokens': dict(model_tokens), 'retry_fallback': init.get('retryFallback'),
            'fallback': fallback, 'tokens': sum(model_tokens.values()),
            'wall_minutes': (last - first) / 60 if first is not None else 0,
            'active_minutes': active / 60, 'tool_calls': tool_calls,
            'tool_results': tool_results, 'tool_errors': tool_errors,
            'unavailable_tool_errors': unavailable,
            'assignment_excerpt': str(init.get('task') or '')[:4000],
            'started_at': timestamp(init.get('timestamp')) or first,
            'stream_infra': stream_infra,
        }
    return {'file': str(path), 'episode': episode, 'deliveries': deliveries,
            'models': dict(models), 'malformed_lines': malformed}


def base_name(name):
    previous = None
    while previous != name:
        previous, name = name, VERSION.sub('', name)
    return name


def join_episodes(parsed, selected):
    episodes = []
    siblings = defaultdict(list)
    for filename in sorted(selected):
        item = parsed[filename]
        if item['episode'] is None:
            continue
        episode = dict(item['episode'])
        path = Path(filename)
        parent = str(path.parent) + '.jsonl'
        delivery = parsed.get(parent, {}).get('deliveries', {}).get(path.stem)
        if delivery is not None and delivery['agent'] != episode['agent']:
            delivery = None
        body = delivery['body'] if delivery else ''
        verdict = VERDICT.search(body)
        episode.update({
            'status': delivery['status'] if delivery else None,
            'joined': delivery is not None,
            'infra': episode.pop('stream_infra') or bool(INFRA.search(body[:600])),
            'verdict': verdict[1].upper() if verdict else None,
            'rework': False, 'delivered_report_excerpt': body[:6000],
        })
        episodes.append(episode)
        siblings[(parent, episode['agent'], base_name(path.stem).casefold())].append(episode)
    for group in siblings.values():
        group.sort(key=lambda ep: (ep['started_at'] or 0, ep['name']))
        for episode in group[:-1]:
            episode['rework'] = True
    return episodes


def percent(numerator, denominator):
    return 100 * numerator / denominator if denominator else None


def summarize(episodes, parsed, selected, since):
    groups = defaultdict(list)
    agents = defaultdict(lambda: {'tokens': 0, 'active_minutes': 0.0, 'n': 0})
    main = defaultdict(lambda: {'tokens': 0, 'turns': 0})
    health = defaultdict(model_stats)
    for ep in episodes:
        groups[(ep['agent'], ep['effective_model'])].append(ep)
        totals = agents[ep['agent']]
        totals['tokens'] += ep['tokens']
        totals['active_minutes'] += ep['active_minutes']
        totals['n'] += 1
    rows = []
    for (agent, model), group in sorted(groups.items()):
        clean = [ep for ep in group if not ep['infra']]
        verdicts = [ep['verdict'] for ep in group if ep['verdict']]
        tokens = sum(ep['tokens'] for ep in group)
        hours = sum(ep['active_minutes'] for ep in group) / 60
        results = sum(ep['tool_results'] for ep in group)
        rows.append({
            'agent': agent, 'model': model, 'n': len(group),
            'delivered_failure_pct': percent(sum(ep['status'] != 'completed' for ep in clean), len(clean)),
            'non_infra_n': len(clean), 'infra_pct': percent(sum(ep['infra'] for ep in group), len(group)),
            'fallback_pct': percent(sum(ep['fallback'] for ep in group), len(group)),
            'rework_pct': percent(sum(ep['rework'] for ep in group), len(group)),
            'pass_pct': percent(verdicts.count('PASS'), len(verdicts)), 'verdict_n': len(verdicts),
            'tool_error_pct': percent(sum(ep['tool_errors'] for ep in group), results),
            'unavailable_tool_errors': sum(ep['unavailable_tool_errors'] for ep in group),
            'median_mtok': median(ep['tokens'] for ep in group) / 1e6,
            'median_active_minutes': median(ep['active_minutes'] for ep in group),
            'total_mtok': tokens / 1e6, 'total_active_hours': hours,
            'mtok_per_active_hour': tokens / 1e6 / hours if hours else None,
        })
    for filename in selected:
        item = parsed[filename]
        for model, stats in item['models'].items():
            total = health[model]
            for key in ('tokens', 'turns', 'errors', 'aborted'):
                total[key] += stats[key]
            total['error_messages'].update(stats['error_messages'])
            total['context_latencies'].extend(stats['context_latencies'])
            if item['episode'] is None:
                main[model]['tokens'] += stats['tokens']
                main[model]['turns'] += stats['turns']
    agent_rows = []
    for agent, stats in sorted(agents.items(), key=lambda pair: (-pair[1]['tokens'], pair[0])):
        hours = stats['active_minutes'] / 60
        agent_rows.append({'agent': agent, 'n': stats['n'], 'total_mtok': stats['tokens'] / 1e6,
                           'total_active_hours': hours,
                           'mtok_per_active_hour': stats['tokens'] / 1e6 / hours if hours else None})
    health_rows = []
    for model, stats in sorted(health.items()):
        latencies = stats['context_latencies']
        health_rows.append({'model': model, 'turns': stats['turns'],
                            'error_pct': percent(stats['errors'], stats['turns']),
                            'aborted_pct': percent(stats['aborted'], stats['turns']),
                            'top_errors': [{'message': message, 'count': count}
                                           for message, count in stats['error_messages'].most_common(3)],
                            'median_context_latency_seconds': median(latencies) if latencies else None,
                            'context_latency_n': len(latencies)})
    joined = sum(ep['joined'] for ep in episodes)
    return {'schema_version': 1, 'since': datetime.fromtimestamp(since, timezone.utc).isoformat(),
            'files': len(selected), 'malformed_lines': sum(parsed[f]['malformed_lines'] for f in selected),
            'join_coverage': {'joined': joined, 'total': len(episodes), 'pct': percent(joined, len(episodes))},
            'role_models': rows, 'agents': agent_rows,
            'main_models': [{'model': model, **stats, 'mtok': stats['tokens'] / 1e6}
                            for model, stats in sorted(main.items(), key=lambda pair: -pair[1]['tokens'])],
            'stream_health': health_rows}


def collect(sessions, since):
    selected = {str(path) for path in Path(sessions).expanduser().glob('**/*.jsonl')
                if path.is_file() and path.stat().st_mtime >= since}
    needed = set(selected)
    for filename in selected:
        parent = Path(str(Path(filename).parent) + '.jsonl')
        if parent.is_file():
            needed.add(str(parent))
    if not needed:
        return summarize([], {}, selected, since), []
    with ProcessPoolExecutor(max_workers=min(8, os.cpu_count() or 1)) as pool:
        parsed = {item['file']: item for item in pool.map(parse_transcript, sorted(needed), chunksize=8)}
    episodes = join_episodes(parsed, selected)
    return summarize(episodes, parsed, selected, since), episodes


def cell(value):
    if value is None:
        return '—'
    if isinstance(value, float):
        return f'{value:.2f}'
    return str(value).replace('|', '\\|').replace('\n', ' ').replace('<', '&lt;').replace('>', '&gt;')


def table(headers, rows):
    return '\n'.join(['| ' + ' | '.join(headers) + ' |',
                      '| ' + ' | '.join('---' for _ in headers) + ' |'] +
                     ['| ' + ' | '.join(cell(v) for v in row) + ' |' for row in rows])


def markdown(report, min_n):
    coverage = report['join_coverage']
    lines = ['# OMP transcript role scorecard', '',
             f"Files modified since {report['since']}: {report['files']}; malformed lines: {report['malformed_lines']}.",
             f"Join coverage: {coverage['joined']}/{coverage['total']} ({cell(coverage['pct'])}%).", '',
             f'## Role / effective model (n ≥ {min_n})', '',
             'Failure % excludes infra episodes from numerator and denominator; missing delivery counts as failure.',
             'PASS % describes delivered verdicts, not model success. Tool error % uses tool results. — means no denominator.', '',
             table(['Agent', 'Effective model', 'n', 'Failure %', 'Infra %', 'Fallback %', 'Rework %',
                    'PASS %', 'Verdicts', 'Tool error %', 'Unavailable', 'Median Mtok', 'Median active min',
                    'Total Mtok', 'Active h', 'Mtok/h'],
                   [[row[key] for key in ('agent', 'model', 'n', 'delivered_failure_pct', 'infra_pct',
                     'fallback_pct', 'rework_pct', 'pass_pct', 'verdict_n', 'tool_error_pct',
                     'unavailable_tool_errors', 'median_mtok', 'median_active_minutes', 'total_mtok',
                     'total_active_hours', 'mtok_per_active_hour')]
                    for row in report['role_models'] if row['n'] >= min_n]), '',
             '## Agent totals (all episodes)', '',
             table(['Agent', 'n', 'Total Mtok', 'Active h', 'Mtok/h'],
                   [[row[k] for k in ('agent', 'n', 'total_mtok', 'total_active_hours', 'mtok_per_active_hour')]
                    for row in report['agents']]), '', '## Main-session model usage', '',
             table(['Model', 'Tokens', 'Mtok', 'Turns'],
                   [[row[k] for k in ('model', 'tokens', 'mtok', 'turns')] for row in report['main_models']]), '',
             '## Model stream health (main and subagent)', '',
             table(['Model', 'Turns', 'Error %', 'Aborted %', 'Median latency s (40k–120k)', 'Latency n', 'Top errors'],
                   [[row[k] for k in ('model', 'turns', 'error_pct', 'aborted_pct',
                                     'median_context_latency_seconds', 'context_latency_n')] +
                    ['; '.join(f"{error['count']}× {error['message']}" for error in row['top_errors'])]
                    for row in report['stream_health']]), '',
             'Effective model owns most episode tokens; mixed/fallback episodes are not clean A/B comparisons.',
             'Rework flags an earlier same-role sibling with a later version/retry name; only implementer rework is a quality signal.',
             'Active time caps each assistant/previous-record gap at 600 s; wall time can include idle, especially seance.',
             'Triage cancellations can reflect missing brief context, not model capability.', '']
    return '\n'.join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sessions', default='~/.omp/agent/sessions', help='local transcript tree')
    window = parser.add_mutually_exclusive_group()
    window.add_argument('--days', type=float, default=None, help='file modification window in days (default: 7)')
    window.add_argument('--since', help='ISO datetime/date; naive values use UTC (file modification cutoff)')
    parser.add_argument('--min-n', type=int, default=5, help='minimum role/model sample size shown')
    parser.add_argument('--episodes-out', type=Path, help='private episode excerpts as JSONL')
    parser.add_argument('--json', action='store_true', help='machine-readable aggregate report')
    args = parser.parse_args(argv)
    if args.min_n < 1:
        parser.error('--min-n must be positive')
    if args.since:
        since = timestamp(args.since)
        if since is None:
            parser.error('--since must be an ISO datetime or date')
    else:
        days = 7 if args.days is None else args.days
        if not 0 < days < float('inf'):
            parser.error('--days must be positive and finite')
        since = time.time() - days * 86400
    sessions = Path(args.sessions).expanduser().resolve()
    if not sessions.is_dir():
        parser.error('--sessions must be an existing directory')
    if args.episodes_out:
        destination = args.episodes_out.expanduser().resolve()
        if destination.is_relative_to(sessions):
            parser.error('--episodes-out must be outside the sessions tree')
    try:
        report, episodes = collect(sessions, since)
        if args.episodes_out:
            # Excerpts are intentionally private; a newly created file is owner-only.
            fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                for episode in episodes:
                    stream.write(json.dumps(episode, ensure_ascii=False) + '\n')
    except (OSError, ValueError) as error:
        print(f'role_scorecard: collection/output failed ({type(error).__name__})', file=sys.stderr)
        return 1
    report['min_n'] = args.min_n
    report['role_models'] = [row for row in report['role_models'] if row['n'] >= args.min_n]
    print(json.dumps(report, ensure_ascii=False, indent=2) if args.json else markdown(report, args.min_n))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
