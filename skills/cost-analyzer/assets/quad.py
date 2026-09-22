#!/usr/bin/env python3
"""Compatibility S1-S4 report over the canonical Pi ledger."""
import argparse
import datetime
import json
from pathlib import Path

from dataset import load_ledger

BASE = str(Path.home() / '.pi/agent/sessions')

SCENARIO_LABELS = {
    'S1': 'S1: solo (un agente, todo)',
    'S2': 'S2: solo + subagentes',
    'S3': 'S3: orquestador + minions (sin subagentes)',
    'S4': 'S4: orquestador + minions con subagentes',
}


def count_legacy_spawn_tool_calls(record: dict) -> int:
    message = record.get('message') if record.get('type') == 'message' else None
    if not isinstance(message, dict) or message.get('role') != 'assistant':
        return 0
    return sum(
        isinstance(block, dict) and block.get('type') == 'toolCall' and block.get('name') in {'subagent', 'subagent_run'}
        for block in (message.get('content') or [])
    )


def classify(dirn: str, intercom: int, fm: int, subn: int, spawned_tool_calls: int = 0) -> str:
    """Legacy classifier retained for callers and regression fixtures."""
    lower = dirn.lower()
    coordinated = intercom > 0 or fm > 0 or any(token in lower for token in ('a4s', 'bead-hs', 'review', 'worktrees'))
    delegated = subn > 0 or spawned_tool_calls > 0
    if coordinated and delegated:
        return 'S4'
    if coordinated:
        return 'S3'
    if delegated:
        return 'S2'
    return 'S1'


def scan_sessions(since: str, until: str | None = None, base: str = BASE):
    """Return legacy cells, built from canonical Pi `SessionRecord` values."""
    roots = {'pi': Path(base)}
    records = load_ledger(datetime.date.fromisoformat(since), datetime.date.fromisoformat(until) if until else None, roots=roots)
    cells = {key: dict(n=0, cost=0.0, tok=0, msgs=0, files=[]) for key in SCENARIO_LABELS}
    for record in records:
        scenario = record.observed_topology
        if scenario not in SCENARIO_LABELS:
            continue
        cell = cells[scenario]
        cell['n'] += 1
        cell['cost'] += record.cost_native_usd or 0.0
        cell['tok'] += record.input_tokens + record.output_tokens + record.cache_read_tokens + record.cache_write_tokens
        cell['files'].append(record.source_path)
    return {key: value for key, value in cells.items() if value['n']}


def format_table(cells: dict, total_label: str = 'TOTAL') -> str:
    total = sum(value['cost'] for value in cells.values())
    out = [f'=== 4 ESCENARIOS (Pi) === {total_label} ${total:.0f}', '', f"{'escenario':46s} {'sess':>5s} {'costo':>10s} {'%':>6s} {'$/sess':>8s} {'tok/sess':>9s}"]
    for key in ('S1', 'S2', 'S3', 'S4'):
        value = cells.get(key)
        if not value:
            continue
        per_session = value['cost'] / value['n']
        token_per_session = value['tok'] / value['n'] / 1_000_000
        percent = value['cost'] / total * 100 if total else 0
        out.append(f"{SCENARIO_LABELS[key]:46s} {value['n']:5d} ${value['cost']:8.0f} {percent:5.1f}% ${per_session:7.0f} {token_per_session:7.1f}M")
    return '\n'.join(out)


def main():
    parser = argparse.ArgumentParser(description='Clasificador S1-S4 de sesiones Pi')
    parser.add_argument('--since', required=True)
    parser.add_argument('--until')
    parser.add_argument('--base', default=BASE)
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--files', action='store_true')
    args = parser.parse_args()
    cells = scan_sessions(args.since, args.until, args.base)
    if args.json:
        output = {key: ({**value, 'files': value['files']} if args.files else {field: value[field] for field in ('n', 'cost', 'tok', 'msgs')}) for key, value in cells.items()}
        print(json.dumps(output, indent=2))
    else:
        label = f'desde {args.since}' + (f' hasta {args.until}' if args.until else '')
        print(format_table(cells, label))


if __name__ == '__main__':
    main()
