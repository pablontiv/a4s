#!/usr/bin/env python3
"""Comparación observacional: pi-subagents-j0k3r vs pi-subagents.

Frontera verificada: 2026-09-04T04:43:09Z. Una advertencia intercom
registró que el runtime global cambió de j0k3r a pi-subagents 0.64.0
mientras una sesión seguía abierta. Las sesiones que cruzan esa frontera
se etiquetan mixed/unknown y se excluyen de la comparación principal.

Rango: conserva la regla del skill, mtime de archivo. Variante: timestamp
interno de inicio/fin de sesión, pues representa el runtime que la ejecutó.
"""
import argparse
import collections
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import outcomes
import quad
from dataset import load_ledger

UTC = datetime.timezone.utc
CUTOVER = datetime.datetime(2026, 9, 4, 4, 43, 9, tzinfo=UTC)
VARIANTS = ('pi-subagents-j0k3r', 'pi-subagents', 'mixed/unknown')


def variant_for_window(t_start, t_end):
    """Devuelve la extensión activa; una ventana que cruza el cutover es unknown."""
    if not t_start or not t_end:
        return 'mixed/unknown'
    if t_end < CUTOVER:
        return 'pi-subagents-j0k3r'
    if t_start > CUTOVER:
        return 'pi-subagents'
    return 'mixed/unknown'


def scan_extension_sessions(since, until=None, base=quad.BASE):
    """Devuelve metadata de extensión desde el ledger Pi canónico."""
    records = load_ledger(
        datetime.date.fromisoformat(since),
        datetime.date.fromisoformat(until) if until else None,
        roots={'pi': __import__('pathlib').Path(base)},
    )
    return [{
        'path': record.source_path,
        'scenario': record.observed_topology,
        'variant': record.pi_extension,
        'cost': record.cost_native_usd or 0.0,
        'tok': record.input_tokens + record.output_tokens + record.cache_read_tokens + record.cache_write_tokens,
        't_start': record.started_at,
        't_end': record.ended_at,
        'record': record,
    } for record in records]

    since_d = datetime.date.fromisoformat(since)
    until_d = datetime.date.fromisoformat(until) if until else None
    records = []

    for root, _, filenames in os.walk(base):
        for filename in filenames:
            if not filename.endswith('.jsonl'):
                continue
            path = os.path.join(root, filename)
            mtime = datetime.date.fromtimestamp(os.path.getmtime(path))
            if mtime < since_d or (until_d and mtime > until_d):
                continue

            dirn = os.path.basename(os.path.dirname(path))
            t_start = t_end = None
            intercom = fm = subn = spawned_tool_calls = 0
            cost = 0.0
            tok = 0

            with open(path, errors='ignore') as source:
                for line in source:
                    try:
                        record = json.loads(line)
                    except Exception:
                        continue
                    kind = record.get('type')
                    if kind == 'session':
                        timestamp = record.get('timestamp')
                        if timestamp and t_start is None:
                            try:
                                t_start = datetime.datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
                            except ValueError:
                                pass
                    if kind in ('message', 'tool'):
                        timestamp = record.get('timestamp')
                        if timestamp:
                            try:
                                t_end = datetime.datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
                            except ValueError:
                                pass

                    spawned_tool_calls += quad.count_legacy_spawn_tool_calls(record)
                    if kind in ('custom', 'custom_message'):
                        custom_type = record.get('customType', '')
                        if custom_type == 'subagent-notify':
                            subn += 1
                        elif custom_type.startswith('intercom'):
                            intercom += 1
                        elif custom_type.startswith('fm-') or 'firstmate' in custom_type:
                            fm += 1
                    elif kind in ('message', 'compaction'):
                        message = record.get('message') if kind == 'message' else record
                        usage = message.get('usage') if isinstance(message, dict) else None
                        if kind == 'compaction':
                            usage = record.get('usage')
                        if isinstance(usage, dict):
                            cost += usage.get('cost', {}).get('total', 0) or 0
                            tok += usage.get('totalTokens', 0) or 0

            if t_end is None:
                t_end = t_start
            records.append({
                'path': path,
                'scenario': quad.classify(dirn, intercom, fm, subn, spawned_tool_calls),
                'variant': variant_for_window(t_start, t_end),
                'cost': cost,
                'tok': tok,
                't_start': t_start,
                't_end': t_end,
            })
    return records


def aggregate(records, with_commits=True, progress=True):
    """Agrega costo, escenarios y SHAs únicos por variante."""
    data = collections.defaultdict(lambda: {
        'sessions': 0, 'cost': 0.0, 'tok': 0,
        'scenario_n': collections.Counter(), 'scenario_cost': collections.Counter(),
        'scenario_tok': collections.Counter(), 'scenario_shas': collections.defaultdict(set),
        'commit_shas': set(),
    })
    total = len(records)
    for index, record in enumerate(records):
        if progress and (index % 100 == 0 or index == total - 1):
            print(f'  extension outcomes: {index + 1}/{total}', file=sys.stderr)
        target = data[record['variant']]
        target['sessions'] += 1
        target['cost'] += record['cost']
        target['tok'] += record['tok']
        target['scenario_n'][record['scenario']] += 1
        target['scenario_cost'][record['scenario']] += record['cost']
        target['scenario_tok'][record['scenario']] += record['tok']
        if record.get('record'):
            target['scenario_shas'][record['scenario']].update(record['record'].commits)
        if with_commits:
            outcome = outcomes.compute_outcome_for_session(
                record['path'], with_prs=False, with_beads=False,
            )
            target['commit_shas'].update(outcome['commit_shas'])
            target['scenario_shas'][record['scenario']].update(outcome['commit_shas'])
    return data


def format_report(data):
    out = []
    out.append('=== EXTENSIONES PI: EFICIENCIA OBSERVACIONAL ===\n')
    out.append(f'Cutover: {CUTOVER.isoformat().replace("+00:00", "Z")}  (sesiones que lo cruzan: mixed/unknown)\n')
    out.append(f"{'extensión':24s} {'sesiones':>9s} {'costo':>10s} {'commits únicos':>17s} {'$/commit':>11s} {'S1':>5s} {'S2':>5s} {'S3':>5s} {'S4':>5s}")
    for variant in VARIANTS:
        entry = data.get(variant)
        if not entry or entry['sessions'] == 0:
            continue
        commits = len(entry['commit_shas'])
        per_commit = entry['cost'] / commits if commits else None
        per_commit_text = f'${per_commit:>10.2f}' if per_commit is not None else f"{'-':>11s}"
        n = entry['scenario_n']
        out.append(
            f"{variant:24s} {entry['sessions']:>9d} ${entry['cost']:>9.0f} {commits:>17d} {per_commit_text}"
            f" {n['S1']:>5d} {n['S2']:>5d} {n['S3']:>5d} {n['S4']:>5d}"
        )

    out.append('\n=== CRUCE EXTENSIÓN × ESCENARIO ===\n')
    out.append(f"{'extensión':24s} {'escenario':10s} {'sesiones':>9s} {'costo':>10s} {'tok/SHA':>12s} {'$/sess':>10s}")
    for variant in VARIANTS:
        entry = data.get(variant)
        if not entry:
            continue
        for scenario in ('S1', 'S2', 'S3', 'S4'):
            n = entry['scenario_n'][scenario]
            if not n:
                continue
            cost = entry['scenario_cost'][scenario]
            shas = entry['scenario_shas'][scenario]
            per_tokens = f"{entry['scenario_tok'][scenario] / len(shas):.0f}" if shas else '—'
            out.append(f"{variant:24s} {scenario:10s} {n:>9d} ${cost:>9.0f} {per_tokens:>12s} ${cost/n:>9.2f}")

    out.append('\n=== LÍMITES ===')
    out.append('Comparación observacional: cambian tareas, repos y fechas; no es A/B.')
    out.append('Costo usa usage.cost.total; commits se deduplican por SHA dentro de cada extensión.')
    out.append('mixed/unknown se informa pero no debe usarse para declarar ganador.')
    return '\n'.join(out)


def main():
    parser = argparse.ArgumentParser(description='Compara pi-subagents-j0k3r contra pi-subagents')
    parser.add_argument('--since', required=True, help='Fecha ISO (filtro mtime)')
    parser.add_argument('--until', default=None, help='Fecha ISO (filtro mtime)')
    parser.add_argument('--no-commits', action='store_true', help='Saltar git log; deja $/commit vacío')
    args = parser.parse_args()

    records = scan_extension_sessions(args.since, args.until)
    data = aggregate(records, with_commits=not args.no_commits)
    print(format_report(data))


if __name__ == '__main__':
    main()
