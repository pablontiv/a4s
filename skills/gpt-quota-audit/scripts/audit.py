#!/usr/bin/env python3
"""Read-only omp provider quota audit; Python standard library only."""

import argparse
from bisect import bisect_right
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
import glob
import json
import math
from pathlib import Path
import re
import sqlite3


@dataclass
class Turn:
    file: str
    timestamp: datetime
    model: str
    agent: str | None
    model_role: str | None
    tokens: int
    total_tokens: int
    category: str
    stop_reason: str
    error: str


@dataclass
class Dataset:
    turns: list = field(default_factory=list)
    inits: dict = field(default_factory=dict)
    selected_files: int = 0
    skipped_lines: int = 0


def parse_time(value):
    """Interpret naive ISO timestamps in the host's local timezone."""
    return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(timezone.utc)


def tool_calls(message):
    result = []
    for content in message.get('content') or []:
        if not isinstance(content, dict) or content.get('type') not in ('toolCall', 'tool_use'):
            continue
        args = content.get('arguments') or content.get('input') or {}
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except (ValueError, TypeError):
                # Keep raw arguments for URI classification even when not JSON.
                args = {'raw': args}
        result.append((content.get('name') or '', args))
    return result


def classify(calls):
    if not calls:
        return 'text-only'
    names = [name for name, _ in calls]
    if all(name == 'wait' for name in names):
        return 'wait-only'
    arguments = ' ; '.join(json.dumps(args, ensure_ascii=False) for _, args in calls)
    if 'history://' in arguments:
        return 'read history://'
    if 'agent://' in arguments and not any(name in ('edit', 'write', 'bash') for name in names):
        return 'agent:// messaging'
    commands = ' ; '.join(str(args.get('command') or '') for name, args in calls
                          if name == 'bash' and isinstance(args, dict))
    if re.search(r'\bsleep\b|until |while ', commands):
        return 'bash sleep/poll'
    if re.search(r'xcodebuild|xcrun|e2e|devicectl|simctl', arguments):
        return 'ios build/e2e'
    return names[0]


def load_sessions(root, provider, days, now):
    root = Path(root).expanduser()
    cutoff = (now - timedelta(days=days)).timestamp()
    dataset = Dataset()
    for filename in sorted(glob.iglob(str(root / '**' / '*.jsonl'), recursive=True)):
        path = Path(filename)
        if path.stat().st_mtime < cutoff:
            continue
        dataset.selected_files += 1
        relative = path.relative_to(root).as_posix()
        agent = role = None
        with path.open(encoding='utf-8') as stream:
            for line in stream:
                try:
                    record = json.loads(line)
                except (ValueError, UnicodeError):
                    dataset.skipped_lines += 1
                    continue
                if record.get('type') == 'session_init':
                    agent, role = record.get('agent'), record.get('modelRole')
                    dataset.inits[relative] = record
                    continue
                if record.get('type') != 'message':
                    continue
                message = record.get('message') or {}
                if message.get('role') != 'assistant' or message.get('provider') != provider:
                    continue
                try:
                    timestamp = parse_time(record['timestamp'])
                except (KeyError, ValueError, TypeError):
                    dataset.skipped_lines += 1
                    continue
                if timestamp > now:
                    continue
                usage = message.get('usage') or {}
                tokens = sum(usage.get(key, 0) or 0 for key in ('input', 'cacheRead', 'cacheWrite'))
                dataset.turns.append(Turn(relative, timestamp, message.get('model') or '(unknown)',
                                          agent, role, tokens, usage.get('totalTokens', 0) or 0,
                                          classify(tool_calls(message)),
                                          message.get('stopReason') or '(unset)',
                                          message.get('errorMessage') or ''))
    return dataset


def main_session(filename):
    parts = filename.split('/')
    return '/'.join(parts[:1] + [Path(parts[1]).stem]) if len(parts) > 1 else Path(filename).stem


def is_child(filename):
    return len(filename.split('/')) > 2


def aggregate(turns, key):
    groups = defaultdict(lambda: [0, 0])
    for turn in turns:
        row = groups[key(turn)]
        row[0] += 1
        row[1] += turn.tokens
    return dict(groups)


def quota_readings(db, provider, limit_id, now, since=None):
    """Open the source database in read-only mode, including when it is missing."""
    uri = Path(db).expanduser().resolve().as_uri() + '?mode=ro'
    with sqlite3.connect(uri, uri=True) as connection:
        rows = connection.execute(
            'SELECT recorded_at, used_fraction, resets_at FROM usage_history '
            'WHERE provider=? AND limit_id=? AND recorded_at<=? '
            'AND used_fraction IS NOT NULL ORDER BY recorded_at, rowid',
            (provider, limit_id, int(now.timestamp() * 1000))).fetchall()
    # Keep the reading immediately before the earliest included turn so the
    # first interval is visible, but calibration excludes that partial interval.
    if since is not None and rows:
        index = max(0, bisect_right([row[0] for row in rows], since.timestamp() * 1000) - 1)
        rows = rows[index:]
    return rows


def normalise_windows(readings):
    """Group provider reset timestamp jitter within 120 seconds."""
    canonical = []
    mapping = {}
    for reset in sorted({row[2] for row in readings if row[2] is not None}):
        if canonical and reset - canonical[-1] <= 120_000:
            mapping[reset] = canonical[-1]
        else:
            canonical.append(reset)
            mapping[reset] = reset
    return [(recorded, fraction, mapping.get(reset, reset))
            for recorded, fraction, reset in readings]


def quota_windows(readings):
    groups = defaultdict(list)
    for row in normalise_windows(readings):
        groups[row[2]].append(row)
    return [(reset, rows[0], rows[-1], max(row[1] for row in rows), len(rows))
            for reset, rows in groups.items()]


def burn_rate(first, last):
    """Observed percentage points/hour and linear hours from 0% to 100%."""
    hours = (last[0] - first[0]) / 3_600_000
    rate = (last[1] - first[1]) * 100 / hours if hours > 0 else 0
    return (f'{rate:.4f}', f'{100 / rate:.2f}') if rate > 0 else ('n/a', 'n/a')


def invert(matrix):
    """Gauss-Jordan inverse with partial pivoting for a small model matrix."""
    size = len(matrix)
    augmented = [list(row) + [float(i == j) for j in range(size)]
                 for i, row in enumerate(matrix)]
    scale = max((abs(value) for row in matrix for value in row), default=0)
    for column in range(size):
        pivot = max(range(column, size), key=lambda i: abs(augmented[i][column]))
        if abs(augmented[pivot][column]) <= scale * 1e-12:
            raise ValueError('Singular model matrix: model effects cannot be separated')
        augmented[column], augmented[pivot] = augmented[pivot], augmented[column]
        divisor = augmented[column][column]
        augmented[column] = [value / divisor for value in augmented[column]]
        for row in range(size):
            if row != column:
                factor = augmented[row][column]
                augmented[row] = [a - factor * b for a, b in zip(augmented[row], augmented[column])]
    return [row[size:] for row in augmented]


def ols(x, y):
    """No-intercept OLS; coefficients use x units, R² is uncentered."""
    n = len(y)
    p = len(x[0]) if x else 0
    if not p or n <= p:
        raise ValueError('Insufficient intervals for OLS and confidence intervals')
    xtx = [[sum(row[i] * row[j] for row in x) for j in range(p)] for i in range(p)]
    inverse = invert(xtx)
    xty = [sum(row[i] * target for row, target in zip(x, y)) for i in range(p)]
    beta = [sum(inverse[i][j] * xty[j] for j in range(p)) for i in range(p)]
    residual = sum((target - sum(a * b for a, b in zip(row, beta))) ** 2
                   for row, target in zip(x, y))
    variance = residual / (n - p)
    ci = [(value - 1.96 * math.sqrt(max(0, variance * inverse[i][i])),
           value + 1.96 * math.sqrt(max(0, variance * inverse[i][i])))
          for i, value in enumerate(beta)]
    denominator = sum(value * value for value in y)
    return {'coefficients': beta, 'ci': ci, 'n': n,
            'r_squared': 1 - residual / denominator if denominator else None}


def calibrate(turns, readings, cutoff=None):
    """Join exact consecutive hourly poll intervals, never across a reset.

    Token timestamps belong to (previous reading, current reading]. Polls need
    not land on the clock hour: exact boundaries avoid assigning later traffic
    to an earlier quota reading. Zero-token intervals remain observations.
    """
    ordered = sorted(turns, key=lambda turn: turn.timestamp)
    models = sorted({turn.model for turn in turns})
    times = [turn.timestamp.timestamp() * 1000 for turn in ordered]
    x, y, intervals = [], [], []
    earliest = times[0] if times else float('inf')
    if cutoff is not None:
        earliest = max(earliest, cutoff.timestamp() * 1000)
    readings = normalise_windows(readings)
    for previous, current in zip(readings, readings[1:]):
        if previous[2] != current[2] or current[0] <= previous[0] or previous[0] < earliest:
            continue
        totals = Counter()
        for turn in ordered[bisect_right(times, previous[0]):bisect_right(times, current[0])]:
            totals[turn.model] += turn.tokens / 1_000_000
        x.append([totals[model] for model in models])
        y.append(current[1] - previous[1])
        intervals.append((previous[0], current[0], current[2]))
    active = [index for index in range(len(models)) if any(row[index] for row in x)]
    models = [models[index] for index in active]
    x = [[row[index] for index in active] for row in x]
    result = ols(x, y)
    result.update(models=models, intervals=intervals, mtok=[sum(row[i] for row in x)
                                                         for i in range(len(models))])
    return result


def cell(value):
    return str(value).replace('|', '\\|').replace('\n', ' ').replace('\r', ' ')


def table(headers, rows):
    return '\n'.join(['| ' + ' | '.join(headers) + ' |',
                      '| ' + ' | '.join('---' for _ in headers) + ' |'] +
                     ['| ' + ' | '.join(cell(value) for value in row) + ' |' for row in rows])


def utc_ms(value):
    return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat() if value is not None else '(unset)'


def render(dataset, readings, provider, now, days, limit_id):
    turns = dataset.turns
    total = sum(turn.tokens for turn in turns)
    sections = [f'# omp quota audit: {provider}',
                f'As of {now.isoformat()}; file mtime lookback: {days:g} days; local-day timezone: host local.',
                f'**{len(turns):,} turns / {total / 1e6:,.3f} Mtok**; '
                f'{dataset.selected_files:,} selected files; {len(dataset.inits):,} session_init files; '
                f'{dataset.skipped_lines:,} malformed lines/timestamps skipped.',
                'Tokens = input + cacheRead + cacheWrite (output excluded). File selection is by mtime; '
                'all historical turns in selected files are included through --now.']
    daily = aggregate(turns, lambda turn: (turn.timestamp.astimezone().date().isoformat(), turn.model))
    sections += ['## Local day × model', table(['Local day', 'Model', 'Turns', 'Mtok'],
                 [(day, model, count, f'{tokens / 1e6:.6f}')
                  for (day, model), (count, tokens) in sorted(daily.items())])]
    mains = aggregate(turns, lambda turn: main_session(turn.file))
    children = defaultdict(set)
    for turn in turns:
        if is_child(turn.file):
            children[main_session(turn.file)].add(turn.file)
    sections += ['## Main sessions (top 15)', table(['Main session', 'Turns', 'Mtok', 'Provider subagent files'],
                 [(name, count, f'{tokens / 1e6:.6f}', len(children[name]))
                  for name, (count, tokens) in sorted(mains.items(), key=lambda item: -item[1][1])[:15]])]
    files = defaultdict(list)
    for turn in turns:
        if is_child(turn.file):
            files[turn.file].append(turn)
    top = sorted(files.items(), key=lambda item: -sum(turn.tokens for turn in item[1]))[:30]
    sections += ['## Subagent files (top 30)', table(
        ['File', 'Turns', 'Mtok', 'Max totalTokens', 'First UTC', 'Last UTC', 'Task'],
        [(name, len(items), f'{sum(turn.tokens for turn in items) / 1e6:.6f}',
          max(turn.total_tokens for turn in items), min(turn.timestamp for turn in items).isoformat(),
          max(turn.timestamp for turn in items).isoformat(),
          str(dataset.inits.get(name, {}).get('task') or '')[:90]) for name, items in top])]
    categories = aggregate(turns, lambda turn: turn.category)
    sections += ['## Turn categories', table(['Category', 'Turns', 'Mtok'],
                 [(name, count, f'{tokens / 1e6:.6f}') for name, (count, tokens)
                  in sorted(categories.items(), key=lambda item: -item[1][1])]),
                 'Category labels are heuristic [INFERENCE]; they describe tool calls, not delivered outcomes.']
    stops = Counter(turn.stop_reason for turn in turns)
    errors = Counter(turn.error for turn in turns if turn.error)
    sections += ['## Stop reasons', table(['stopReason', 'Turns'], stops.most_common()),
                 '## Error messages', table(['errorMessage', 'Turns'], errors.most_common())]
    roles = aggregate(turns, lambda turn: (turn.agent or '(main/unset)', turn.model_role or '(unset)'))
    sections += ['## Agent × modelRole', table(['Agent', 'modelRole', 'Turns', 'Mtok'],
                 [(agent, role, count, f'{tokens / 1e6:.6f}') for (agent, role), (count, tokens)
                  in sorted(roles.items(), key=lambda item: -item[1][1])])]
    sections += [f'## Quota windows: {limit_id}', table(
        ['Resets UTC (±120s)', 'First UTC', 'First fraction', 'Last UTC', 'Last fraction',
         'Peak fraction', 'Readings', 'Burn pts/h', 'Hours 0→100%'],
        [(utc_ms(reset), utc_ms(first[0]), f'{first[1]:.4f}', utc_ms(last[0]),
          f'{last[1]:.4f}', f'{peak:.4f}', count, *burn_rate(first, last))
         for reset, first, last, peak, count in quota_windows(readings)]),
        'Quota source: usage_history (read-only). Reset timestamps within 120 seconds are one window. '
        'Windows may be renewed/replaced early; a real window change is not proof that the previous '
        'window reached 100%. Burn rate is the first-to-last change divided by elapsed hours; '
        'hours 0→100% is a linear projection at that average rate [INFERENCE], not time remaining. '
        'omp polls approximately hourly; its recorded Codex primary series does not expose a Codex 5-hour window.']
    sections += ['## Calibration',
                 'No-intercept OLS on consecutive hourly poll intervals (exact timestamps), one regressor per model. '
                 'Tokens are assigned to (previous reading, current reading]; real reset-spanning and initial partial '
                 'intervals are excluded. Interval starts must be >= now-days (the file-mtime cutoff) to avoid '
                 'fitting earlier, token-incomplete history. Reset jitter within 120 seconds is one window. '
                 'R² is uncentered; 95% CIs use 1.96. '
                 'Observed quota attribution is confounded by concurrent clients, project mix, '
                 'polling lag, and cache/output pricing; coefficients are observational [INFERENCE].']
    try:
        fit = calibrate(turns, readings, now - timedelta(days=days))
        r2 = f'{fit["r_squared"]:.6f}' if fit['r_squared'] is not None else 'undefined'
        sections += [f'n = {fit["n"]}; R² = {r2}', table(
            ['Model', 'Interval Mtok', 'Quota-% per 100 Mtok', '95% CI'],
            [(model, f'{mtok:.6f}', f'{coefficient * 10000:.6f}',
              f'[{ci[0] * 10000:.6f}, {ci[1] * 10000:.6f}]')
             for model, mtok, coefficient, ci in zip(fit['models'], fit['mtok'],
                                                    fit['coefficients'], fit['ci'])])]
    except ValueError as error:
        sections += [f'Calibration unavailable: {error}.']
    sections += ['## Options matrix (propose only)', table(
        ['Lever', 'Current', 'Candidate', 'Measured basis', 'Side effect', 'Estimated saving', 'Advisor verdict'],
        [(key, 'Measure', 'Propose', 'Attach evidence', 'Assess', 'Not estimated', 'Pending')
         for key in ('modelRoles.task', 'task.agentCompactionThresholdOverrides.task',
                     'task.maxConcurrency', 'retry.fallbackChains.*', 'retry.usageReservePct')]),
        '## Advisor panel template', table(['Decision', 'Opus verdict', 'Grok verdict'],
                                           [('Evidence-backed decision', 'Pending', 'Pending')]),
        "Use completion(model='slow') and a reviewer agent with independently verified resolved models. "
        'Both must be outside the provider under audit; if a route resolves to that provider, '
        'select an explicitly authorised independent route before calling it. Record model IDs, '
        'verdict, strongest counterargument, risk, and confidence. This script makes no advisor calls '
        'and changes no configuration.']
    return '\n\n'.join(sections) + '\n'


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--provider', default='openai-codex')
    parser.add_argument('--days', type=float, default=3.5)
    parser.add_argument('--now', type=parse_time, default=None, help='ISO local or Z timestamp; default now')
    parser.add_argument('--sessions-root', default='~/.omp/agent/sessions')
    parser.add_argument('--db', default='~/.omp/agent/agent.db')
    parser.add_argument('--limit-id', default=None)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args(argv)
    if args.days <= 0 or not math.isfinite(args.days):
        parser.error('--days must be positive and finite')
    now = args.now or datetime.now(timezone.utc)
    limit_id = args.limit_id or f'{args.provider}:primary'
    dataset = load_sessions(args.sessions_root, args.provider, args.days, now)
    since = min((turn.timestamp for turn in dataset.turns), default=now - timedelta(days=args.days))
    readings = quota_readings(args.db, args.provider, limit_id, now, since)
    args.out.expanduser().write_text(render(dataset, readings, args.provider, now, args.days, limit_id),
                                     encoding='utf-8')
    print(f'{args.provider}: {len(dataset.turns):,} turns / '
          f'{sum(turn.tokens for turn in dataset.turns) / 1e6:,.6f} Mtok; '
          f'{dataset.selected_files:,} selected files; report: {args.out}')


if __name__ == '__main__':
    main()
