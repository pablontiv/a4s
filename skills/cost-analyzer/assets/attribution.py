#!/usr/bin/env python3
"""
cost-analyzer / assets / attribution.py

Construye el grafo de atribución: qué sesiones S1 fueron lanzadas por qué S3/S4.

Heurística (proximidad + cwd en worktree):

Para cada sesión S3 o S4 (orquestador) con ventana [t_start, t_end]:
  Buscar sesiones S1 tales que:
    1. t1_S1 >= t_start (el S1 se abrió durante o después del orquestador)
    2. t1_S1 <= t_end + 1h buffer (el S1 se abrió mientras el orquestador estaba vivo)
    3. cwd_S1 está relacionado con cwd_S34:
       - comparte el segmento `worktrees/<nombre>`
       - o cwd_S1 está en el repo principal que el S34 está orquestando

Salida: dict {orchestrator_id: [spawned_s1_ids]} + stats de fan-out.
"""
import json
import os
import sys
import glob
import datetime
import collections
import argparse
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import quad
from dataset import load_ledger


def _session_window_and_cwd(jsonl_path: str):
    """Lee ts_first, ts_last, cwd, cost, tok de un JSONL."""
    ts_first = ts_last = cwd = None
    cost = 0.0
    tok = 0
    try:
        source = open(jsonl_path, 'rb')
    except OSError:
        return (None, None, None, cost, tok)
    with source as f:
        for line in f:
            try:
                o = json.loads(line.decode('utf-8', errors='ignore').strip())
            except Exception:
                continue
            t = o.get('type', '')
            if t == 'session':
                if cwd is None:
                    cwd = o.get('cwd')
                ts = o.get('timestamp')
                if ts and ts_first is None:
                    ts_first = ts
            if t in ('message', 'tool'):
                ts = o.get('timestamp')
                if ts:
                    ts_last = ts
            if t in ('message', 'compaction'):
                m = o.get('message') if t == 'message' else o
                u = (m or {}).get('usage') if isinstance(m, dict) else None
                if t == 'compaction':
                    u = o.get('usage')
                if u and isinstance(u, dict):
                    cost += u.get('cost', {}).get('total', 0) or 0
                    tok += u.get('totalTokens', 0) or 0
    try:
        t1 = datetime.datetime.fromisoformat(ts_first.replace('Z', '+00:00')) if ts_first else None
        t2 = datetime.datetime.fromisoformat(ts_last.replace('Z', '+00:00')) if ts_last else t1
    except Exception:
        t1 = t2 = None
    return (t1, t2, cwd, cost, tok)


def _path_parts(cwd: str) -> list[str]:
    """Return portable path components for POSIX or Windows session paths."""
    return [part for part in cwd.replace('\\', '/').split('/') if part and part != '.']


def _worktree_identity(cwd: str) -> tuple[str, str] | None:
    """Return ``(repository, worktree)`` without assuming a local home prefix."""
    parts = _path_parts(cwd)
    for index, part in enumerate(parts):
        if part.endswith('-worktrees') and index + 1 < len(parts):
            return part.removesuffix('-worktrees'), parts[index + 1]
        if part == 'worktrees' and index + 1 < len(parts):
            if index == 0:
                return '', parts[index + 1]
            repository_index = index - 1
            if parts[repository_index] == '.workspace' and repository_index > 0:
                repository_index -= 1
            return parts[repository_index], parts[index + 1]
    return None


def _repository_key(cwd: str) -> str:
    worktree = _worktree_identity(cwd)
    if worktree:
        return worktree[0]
    parts = _path_parts(cwd)
    return parts[-1] if parts else ''


def _worktree_key(cwd: str) -> str:
    """Return a root-independent key for a repository or named worktree."""
    worktree = _worktree_identity(cwd)
    if worktree:
        repository, name = worktree
        return f"{repository}/worktrees/{name}" if repository else f"worktrees/{name}"
    return _repository_key(cwd)


def _cwds_related(cwd_a: str | None, cwd_b: str | None) -> bool:
    """Determine whether two cwd values belong to the same orchestration scope."""
    if not cwd_a or not cwd_b:
        return False
    a = cwd_a.rstrip('/\\')
    b = cwd_b.rstrip('/\\')
    if a == b:
        return True

    a_worktree = _worktree_identity(a)
    b_worktree = _worktree_identity(b)
    if a_worktree and a_worktree == b_worktree:
        return True

    if bool(a_worktree) != bool(b_worktree):
        return _repository_key(a) == _repository_key(b)
    return False


def build_attribution_from_records(records: list[Any], buffer_minutes: int = 60) -> dict[str, dict[str, Any]]:
    """Atribuye S1 a S3/S4 sin reabrir JSONL; consume SessionRecord canónicos."""
    sessions: list[dict[str, Any]] = [dict(
        scenario=record.observed_topology, path=record.source_path,
        t_start=record.started_at, t_end=record.ended_at, cwd=record.cwd,
        cost=record.cost_native_usd or 0.0,
        tok=record.input_tokens + record.output_tokens + record.cache_read_tokens + record.cache_write_tokens,
    ) for record in records]
    orchestrators = [session for session in sessions if session['scenario'] in ('S3', 'S4') and session['t_start']]
    workers = [session for session in sessions if session['scenario'] == 'S1' and session['t_start']]
    result: dict[str, dict[str, Any]] = {}
    for orchestrator in orchestrators:
        key = orchestrator['path']
        entry = dict(orchestrator=orchestrator, scenario=orchestrator['scenario'], t_start=orchestrator['t_start'], t_end=orchestrator['t_end'], cost_orch=orchestrator['cost'], tok_orch=orchestrator['tok'], spawned_s1=[], spawned_paths=set(), n_spawned=0, cost_s1_spawned=0.0, tok_s1_spawned=0)
        limit = (orchestrator['t_end'] or orchestrator['t_start']) + datetime.timedelta(minutes=buffer_minutes)
        for worker in workers:
            if not (orchestrator['t_start'] <= worker['t_start'] <= limit):
                continue
            if not _cwds_related(orchestrator['cwd'], worker['cwd']):
                continue
            entry['spawned_s1'].append(worker)
            entry['spawned_paths'].add(worker['path'])
            entry['cost_s1_spawned'] += worker['cost']
            entry['tok_s1_spawned'] += worker['tok']
        entry['n_spawned'] = len(entry['spawned_s1'])
        result[key] = entry
    return result


def build_attribution(cells: dict[str, dict[str, Any]], buffer_minutes: int = 60) -> dict[str, dict[str, Any]]:
    """Devuelve dict {orchestrator_path: {spawned_s1: [paths], n_spawned: int, cost_orch, cost_s1, ...}}.

    Solo cuenta S1 que se inician dentro de la ventana del S3/S4 + buffer.
    """
    # Cargar todas las sesiones con metadata
    sessions: list[dict[str, Any]] = []
    for scenario, cell in cells.items():
        for f in cell.get('files', []):
            t1, t2, cwd, cost, tok = _session_window_and_cwd(f)
            sessions.append(dict(
                scenario=scenario, path=f,
                t_start=t1, t_end=t2, cwd=cwd, cost=cost, tok=tok,
                t1_iso=t1.isoformat() if t1 else None,
            ))

    orchestrators = [s for s in sessions if s['scenario'] in ('S3', 'S4') and s['t_start']]
    workers_s1 = [s for s in sessions if s['scenario'] == 'S1' and s['t_start']]

    attribution: collections.defaultdict[str, dict[str, Any]] = collections.defaultdict(lambda: dict(
        orchestrator=None, scenario=None, t_start=None, t_end=None,
        cost_orch=0.0, tok_orch=0,
        spawned_s1=[], spawned_paths=set(), n_spawned=0,
        cost_s1_spawned=0.0, tok_s1_spawned=0,
    ))

    for orch in orchestrators:
        key = orch['path']
        a = attribution[key]
        a['orchestrator'] = orch
        a['scenario'] = orch['scenario']
        a['t_start'] = orch['t_start']
        a['t_end'] = orch['t_end']
        a['cost_orch'] = orch['cost']
        a['tok_orch'] = orch['tok']

        # Buffer al final
        orch_end_buf = orch['t_end'] + datetime.timedelta(minutes=buffer_minutes) if orch['t_end'] else orch['t_start']

        for w in workers_s1:
            # ¿w se inicia durante la ventana del orquestador?
            if w['t_start'] < orch['t_start']:
                continue
            if w['t_start'] > orch_end_buf:
                continue
            # ¿Sus cwds están relacionados?
            if not _cwds_related(orch['cwd'], w['cwd']):
                continue
            a['spawned_s1'].append(w)
            a['spawned_paths'].add(w['path'])
            a['cost_s1_spawned'] += w['cost']
            a['tok_s1_spawned'] += w['tok']

        a['n_spawned'] = len(a['spawned_s1'])

    return dict(attribution)


def format_attribution_report(cells: dict, attribution: dict) -> str:
    """Reporte de attribution: por orquestador, cuántos S1 spawneó, con outcomes agregados."""
    out = []
    out.append('=== ATTRIBUTION S3/S4 → S1 SPAWNEADAS ===\n')

    # Stats globales
    total_orch = len(attribution)
    with_spawned = sum(1 for a in attribution.values() if a['n_spawned'] > 0)
    total_s1_spawned = sum(a['n_spawned'] for a in attribution.values())
    out.append(f'Total orquestadores (S3+S4): {total_orch}')
    out.append(f'Orquestadores que spawnearon ≥1 S1: {with_spawned} ({100*with_spawned/max(1,total_orch):.0f}%)')
    out.append(f'Total S1 spawneadas: {total_s1_spawned}')

    # Stats por escenario (costos individuales)
    out.append('')
    by_scenario = collections.defaultdict(lambda: dict(
        n_orch=0, n_with_spawned=0, total_s1_spawned=0,
        cost_orch=0.0, cost_s1_spawned=0.0, tok_orch=0, tok_s1_spawned=0,
    ))
    for a in attribution.values():
        s = a['scenario']
        d = by_scenario[s]
        d['n_orch'] += 1
        if a['n_spawned'] > 0:
            d['n_with_spawned'] += 1
        d['total_s1_spawned'] += a['n_spawned']
        d['cost_orch'] += a['cost_orch']
        d['cost_s1_spawned'] += a['cost_s1_spawned']
        d['tok_orch'] += a['tok_orch']
        d['tok_s1_spawned'] += a['tok_s1_spawned']

    out.append(f"{'escenario':10s} {'N_orch':>7s} {'con_spawn':>10s} {'S1_spawn':>10s} {'$orch':>10s} {'$S1_spawn':>11s} {'$total':>10s}")
    for s in ['S3', 'S4']:
        d = by_scenario[s]
        if d['n_orch'] == 0:
            continue
        total = d['cost_orch'] + d['cost_s1_spawned']
        out.append(
            f"{s:10s} {d['n_orch']:>7d} {d['n_with_spawned']:>10d} "
            f"{d['total_s1_spawned']:>10d} ${d['cost_orch']:>9.0f} "
            f"${d['cost_s1_spawned']:>10.0f} ${total:>9.0f}"
        )

    # Top orquestadores por fan-out (con costo real individual)
    out.append('')
    out.append('=== TOP 15 ORQUESTADORES POR FAN-OUT ===\n')
    out.append(f"{'esc':4s}{'cwd':52s}{'S1_spawn':>10s}{'$orch':>9s}{'$S1':>9s}{'$total':>9s}{'t_window':>22s}")

    sorted_orch = sorted(
        attribution.values(),
        key=lambda a: (-a['n_spawned'], -a['orchestrator']['t_start'].timestamp() if a['orchestrator']['t_start'] else 0)
    )
    for a in sorted_orch[:15]:
        o = a['orchestrator']
        ts = f"{o['t_start'].strftime('%m-%d %H:%M')}-{o['t_end'].strftime('%H:%M') if o['t_end'] else '?'}"
        total = a['cost_orch'] + a['cost_s1_spawned']
        cwd_short = (o['cwd'] or '?')[-52:]
        out.append(
            f"{a['scenario']:4s}{cwd_short:52s}{a['n_spawned']:>10d}"
            f"${a['cost_orch']:>8.0f}${a['cost_s1_spawned']:>8.0f}${total:>8.0f}{ts:>22s}"
        )

    # Ratio orquestador/trabajo entregado
    out.append('')
    out.append('=== RATIO ORQUESTADOR / TRABAJO ENTREGADO ===\n')
    out.append('(Si $orch >> $S1_spawned, el orquestador está quemando contexto sin entregar.)')
    out.append('')
    for s in ['S3', 'S4']:
        d = by_scenario[s]
        if d['n_orch'] == 0:
            continue
        if d['cost_s1_spawned'] > 0:
            ratio = d['cost_orch'] / d['cost_s1_spawned']
            out.append(
                f"  {s}: $orch=${d['cost_orch']:.0f}, $S1_spawned=${d['cost_s1_spawned']:.0f}  "
                f"→  ratio={ratio:.2f}x (orquestador cuesta {ratio:.1f}× lo que entrega via S1 spawneadas)"
            )
        else:
            out.append(
                f"  {s}: $orch=${d['cost_orch']:.0f}, $S1_spawned=$0  "
                f"→  ratio=∞ (orquestador no entrega nada spawneable)"
            )

    return '\n'.join(out)


def attribute_commits_to_orchestrators(attribution: dict) -> dict:
    """Para cada orquestador, suma los commits de sus S1 spawneadas."""
    out = collections.defaultdict(lambda: dict(n_commits=0, n_prs=0, n_beads=0))
    for key, a in attribution.items():
        # El orquestador tiene su propio outcome (compute_outcome_for_session)
        # Los S1 spawneados tienen los suyos
        # Aquí solo sumamos los outcomes de los S1 spawneados
        for w in a['spawned_s1']:
            # Lazy: leer outcome del S1
            # (evitamos import circular — caller pasa outcomes pre-computados)
            pass
    return dict(out)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--since', required=True)
    ap.add_argument('--until', default=None)
    ap.add_argument('--buffer-min', type=int, default=60, help='Buffer en minutos para atribución')
    args = ap.parse_args()

    cells = quad.scan_sessions(args.since, args.until)
    records = load_ledger(
        datetime.date.fromisoformat(args.since),
        datetime.date.fromisoformat(args.until) if args.until else None,
        roots={'pi': __import__('pathlib').Path(quad.BASE)},
    )
    print(quad.format_table(cells))
    print()
    attr = build_attribution_from_records(records, buffer_minutes=args.buffer_min)
    print(format_attribution_report(cells, attr))
