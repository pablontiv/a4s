#!/usr/bin/env python3
"""
cost-analyzer / assets / report.py

Orquesta quad.py + outcomes.py y produce el reporte completo:

  1. Cuadro S1–S4 clásico (costos, sesiones, tokens)
  2. Distribución por día (para ver picos)
  3. Outcomes reales (commits, PRs merged, beads cerradas, subagentes)
  4. Costo por outcome ($/commit, $/PR, $/bead)

Uso:
    python3 report.py --since 2026-09-18 [--until 2026-09-21] [--no-prs] [--no-beads]
"""
import sys
import os
import datetime
import argparse

# Permitir imports cuando se ejecuta desde assets/
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import quad
import outcomes
import attribution
from dataset import load_ledger
from views import aggregate_harness, aggregate_topology, aggregate_form, render_harness_overview, render_topology_overview, render_form_overview
from enrich import enrich_records
from delivery_efficiency import analyze_delivery_efficiency, render_delivery_efficiency


def scan_by_day(since: str, until: str | None = None):
    """Itera día por día y devuelve dict {YYYY-MM-DD: cells}."""
    d0 = datetime.date.fromisoformat(since)
    d1 = datetime.date.fromisoformat(until) if until else datetime.date.today()
    out = {}
    cur = d0
    while cur <= d1:
        ds = cur.isoformat()
        cells = quad.scan_sessions(ds, ds)
        # Solo guardar días con datos
        if any(c['n'] > 0 for c in cells.values()):
            out[ds] = cells
        cur += datetime.timedelta(days=1)
    return out


def format_daily_table(daily: dict) -> str:
    """Tabla de S1-S4 por día."""
    out = []
    out.append('=== POR DÍA ===\n')
    out.append(f"{'fecha':<12s}{'S1':>5s}{'S2':>5s}{'S3':>5s}{'S4':>5s}{'total':>10s}{'S1$':>9s}{'S2$':>9s}{'S3$':>9s}{'S4$':>9s}{'S4%':>6s}")
    for day in sorted(daily.keys()):
        cells = daily[day]
        counts = {k: cells.get(k, {'n': 0})['n'] for k in ['S1', 'S2', 'S3', 'S4']}
        costs = {k: cells.get(k, {'cost': 0})['cost'] for k in ['S1', 'S2', 'S3', 'S4']}
        total = sum(costs.values())
        s4_pct = (costs['S4'] / total * 100) if total > 0 else 0
        marker = ' ← ADR0015' if day == '2026-09-18' else ''
        out.append(
            f"{day:<12s}{counts['S1']:>5d}{counts['S2']:>5d}{counts['S3']:>5d}{counts['S4']:>5d}"
            f"${total:>9.0f}${costs['S1']:>8.0f}${costs['S2']:>8.0f}"
            f"${costs['S3']:>8.0f}${costs['S4']:>8.0f}{s4_pct:>5.0f}%{marker}"
        )
    return '\n'.join(out)


def format_cost_per_outcome(cells: dict, outcomes_agg: dict) -> str:
    """Tabla cruzada: $/outcome por escenario."""
    out = []
    out.append('=== COSTO POR OUTCOME ===\n')
    out.append(f"{'escenario':10s} {'$':>9s} {'$/commit':>11s} {'$/PR':>9s} {'$/bead':>9s} {'$/sub_n':>10s}")
    for k in ['S1', 'S2', 'S3', 'S4']:
        c = cells.get(k, {'cost': 0})
        o = outcomes_agg.get(k, {})
        if c['cost'] == 0:
            continue
        cost = c['cost']
        commits = o.get('total_commits', 0)
        prs = o.get('total_prs', 0)
        beads = o.get('total_beads', 0)
        subn = o.get('total_subagent_notifies', 0)
        # $/outcome: si el outcome es 0, mostramos "-" en vez de inf
        def fmt(n, d):
            return f"{n:>10.2f}" if d > 0 else f"{'-':>10}"
        per_commit = cost / max(1, commits) if commits > 0 else 0
        per_pr = cost / max(1, prs) if prs > 0 else 0
        per_bead = cost / max(1, beads) if beads > 0 else 0
        per_sub = cost / max(1, subn) if subn > 0 else 0
        labels = {
            'S1': 'S1 solo',
            'S2': 'S2 subags',
            'S3': 'S3 orq',
            'S4': 'S4 orq+sub',
        }
        out.append(
            f"{labels[k]:10s} ${cost:>7.0f}"
            f"{fmt(per_commit, commits):>11s}"
            f"{fmt(per_pr, prs):>9s}"
            f"{fmt(per_bead, beads):>9s}"
            f"{fmt(per_sub, subn):>10s}"
        )
    return '\n'.join(out)


def main():
    ap = argparse.ArgumentParser(description='Reporte S1–S4 con outcomes')
    ap.add_argument('--since', required=True, help='Fecha ISO YYYY-MM-DD')
    ap.add_argument('--until', default=None, help='Fecha ISO YYYY-MM-DD (default: hoy)')
    ap.add_argument('--no-prs', action='store_true')
    ap.add_argument('--no-beads', action='store_true')
    ap.add_argument('--out', default=None, help='Escribir a archivo en vez de stdout')
    ap.add_argument('--view', choices=('topology', 'harness', 'delivery-efficiency'), default='topology', help='Vista: topology (Pi S1-S4), harness (Pi/Claude/Codex) o delivery-efficiency')
    ap.add_argument('--evaluation-date', default=None, help='Fecha ISO para madurez de commits (default: hoy UTC)')
    ap.add_argument('--with-commits', action='store_true', help='En harness, consulta git log por sesión para poblar SHAs únicos (lento).')
    args = ap.parse_args()

    if args.view in {'harness', 'topology'}:
        records = load_ledger(datetime.date.fromisoformat(args.since), datetime.date.fromisoformat(args.until) if args.until else None)
        if args.with_commits:
            records = enrich_records(records)
        text = render_harness_overview(aggregate_harness(records)) if args.view == 'harness' else render_topology_overview(aggregate_topology(records))
        if args.out:
            with open(args.out, 'w') as f:
                f.write(text)
            print(f'Reporte escrito a {args.out}', file=sys.stderr)
        else:
            print(text)
        return

    if args.view == 'delivery-efficiency':
        since = datetime.date.fromisoformat(args.since)
        until = datetime.date.fromisoformat(args.until) if args.until else None
        evaluation_date = datetime.date.fromisoformat(args.evaluation_date) if args.evaluation_date else datetime.datetime.now(datetime.UTC).date()
        records = enrich_records(load_ledger(since, until, roots={'pi': quad.Path(quad.BASE)}))
        rows = analyze_delivery_efficiency(records, evaluation_date)
        text = render_delivery_efficiency(rows, since, until, evaluation_date)
        if args.out:
            with open(args.out, 'w') as f:
                f.write(text)
            print(f'Reporte escrito a {args.out}', file=sys.stderr)
        else:
            print(text)
        return

    out = []
    label = f"desde {args.since}"
    if args.until:
        label += f" hasta {args.until}"

    # 1. Cuadro global
    cells = quad.scan_sessions(args.since, args.until)
    out.append(quad.format_table(cells, total_label=label))
    out.append('')

    # 2. Por día
    out.append('Generando datos por día...')
    daily = scan_by_day(args.since, args.until)
    out.append(format_daily_table(daily))
    out.append('')

    # 3. Outcomes
    out.append('Calculando outcomes (commits via git log)...')
    out_agg = outcomes.compute_outcomes(
        cells,
        with_prs=not args.no_prs,
        with_beads=not args.no_beads,
        progress=False,
    )
    out.append('')
    out.append(outcomes.format_outcomes_table(out_agg))
    out.append('')

    # 4. Costo por outcome
    out.append(format_cost_per_outcome(cells, out_agg))
    out.append('')

    # D4 FIX: 4.5. Taxonomía de formas
    out.append('Clasificando sesiones por taxonomía de 4 formas...')
    records = load_ledger(datetime.date.fromisoformat(args.since), datetime.date.fromisoformat(args.until) if args.until else None)
    form_summary = aggregate_form(records)
    out.append(render_form_overview(form_summary))
    out.append('')

    # 5. Attribution S3/S4 -> S1 spawneadas
    out.append('Calculando attribution S3/S4 -> S1 spawneadas...')
    attr = attribution.build_attribution(cells)  # type: ignore
    out.append(attribution.format_attribution_report(cells, attr))
    out.append('')

    # Caveats
    out.append('=== CAVEATS ===')
    out.append('1. Clasificador: script original del 18-sept (customType=subagent-notify/intercom/fm-*).')
    out.append('2. Costos: usa `usage.cost.total` del JSONL (no estimación).')
    out.append('3. Filtro: mtime del archivo, no timestamp interno.')
    out.append('4. Commits: `git log` en cwd de la sesión durante su ventana temporal.')
    out.append('5. PRs: `gh pr list --search <sha>` por cada commit (puede ser lento).')
    out.append('6. Beads: `bd list --status=closed` con metadata.worktree matching.')
    out.append('7. PRs/beads son proxies; pueden no ser exhaustivos si el cwd no es repo.')

    text = '\n'.join(out)
    if args.out:
        with open(args.out, 'w') as f:
            f.write(text)
        print(f'Reporte escrito a {args.out}', file=sys.stderr)
    else:
        print(text)


if __name__ == '__main__':
    main()
