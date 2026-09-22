#!/usr/bin/env python3
"""
cost-analyzer / assets / outcomes.py

Mide outcomes REALES por sesión Pi clasificada en S1–S4:

1. **Commits**: `git log --since/--until` en el cwd de la sesión
2. **PRs merged**: `gh pr list --state merged --json` cruzado por fecha del commit
3. **Beads cerradas**: `bd list --status=closed --json` filtrado por metadata.worktree
4. **Subagentes dispatched**: conteo de `subagent-notify` y fan-out máximo
5. **Atribución S3/S4 → S1 spawneadas**: encontrar S1 abiertas dentro de la ventana
   temporal de un S3/S4 cuyo cwd esté en un worktree (heurística proximity)

Uso:
    from outcomes import compute_outcomes
    outcomes = compute_outcomes(cells)  # cells viene de quad.scan_sessions()
    print_outcomes_table(outcomes)
"""
import json
import os
import sys
import subprocess
import collections
import datetime
from typing import Any, List, Optional, TypedDict


class OutcomeAggregate(TypedDict):
    n: int
    sessions_with_commits: int
    total_commits: int
    unique_commit_shas: set[str]
    sessions_with_prs: int
    total_prs: int
    sessions_with_beads: int
    total_beads: int
    total_subagent_notifies: int
    max_fan_out: int


def aggregate_record_outcomes(records):
    """Aggregate already-enriched canonical records without reopening JSONL."""
    result = collections.defaultdict(lambda: {'commits': set(), 'prs': set(), 'beads': set()})
    for record in records:
        target = result[record.harness]
        target['commits'].update(record.commits)
        target['prs'].update(record.prs)
        target['beads'].update(record.beads_closed)
    return dict(result)


def compute_outcome_for_record(record, with_prs: bool = True, with_beads: bool = True) -> dict:
    """Project an enriched canonical record into the legacy outcome shape.

    This adapter deliberately uses only evidence already on ``record``; it
    never opens ``record.source_path`` or re-runs external outcome lookups.
    """
    commit_shas = sorted(record.commits)
    return dict(
        commits=len(commit_shas),
        commit_shas=commit_shas,
        prs=sorted(record.prs) if with_prs else [],
        beads=sorted(record.beads_closed) if with_beads else [],
        subagent_notifies=0,
        fan_out_max=0,
        cwd=record.cwd,
        ts_start=record.started_at.isoformat() if record.started_at else None,
        ts_end=record.ended_at.isoformat() if record.ended_at else None,
    )


def _git_log(cwd: Optional[str], since: datetime.datetime, until: datetime.datetime) -> List[tuple[str, str]]:
    """Devuelve los commits en `cwd` entre since y until como [(sha, subject)]."""
    if not (cwd and os.path.isdir(cwd)):
        return []
    try:
        r = subprocess.run(
            ['git', '-C', cwd, 'log',
             '--since', since.strftime('%Y-%m-%dT%H:%M:%S'),
             '--until', until.strftime('%Y-%m-%dT%H:%M:%S'),
             '--format=%H %s'],
            capture_output=True, text=True, timeout=15
        )
        if r.returncode != 0 or not r.stdout.strip():
            return []
        lines = []
        for ln in r.stdout.strip().split('\n'):
            sha, _, subject = ln.partition(' ')
            lines.append((sha, subject))
        return lines
    except Exception:
        return []


def _git_log_with_files(cwd: str, since: datetime.datetime, until: datetime.datetime) -> List[tuple]:
    """Devuelve [(sha, filepath)] para cada archivo modificado en commits del rango.

    Si un commit toca N archivos, aparece N veces.
    """
    if not (cwd and os.path.isdir(cwd)):
        return []
    try:
        r = subprocess.run(
            ['git', '-C', cwd, 'log',
             '--since', since.strftime('%Y-%m-%dT%H:%M:%S'),
             '--until', until.strftime('%Y-%m-%dT%H:%M:%S'),
             '--name-only', '--format=%H'],
            capture_output=True, text=True, timeout=15
        )
        if r.returncode != 0 or not r.stdout.strip():
            return []
        out = []
        current_sha = None
        for ln in r.stdout.split('\n'):
            ln = ln.strip()
            if not ln:
                current_sha = None
                continue
            if len(ln) >= 7 and all(c in '0123456789abcdef' for c in ln.lower()):
                current_sha = ln
            elif current_sha:
                out.append((current_sha, ln))
        return out
    except Exception:
        return []


def categorize_path(path: str) -> str:
    """Categoriza un filepath: 'code', 'doc', 'test', 'config', 'other'."""
    p = path.lower()
    if '/docs/' in p or '/.workspace/docs' in p or p.endswith(('.md', '.mdx', '.rst', '.txt')):
        return 'doc'
    if '.test.' in p or '__tests__' in p or '/tests/' in p or '/test/' in p or p.endswith('.spec.ts') or p.endswith('_test.py') or '/spec/' in p:
        return 'test'
    if p.endswith(('.json', '.yaml', '.yml', '.toml')) or 'package.json' in p or 'tsconfig' in p or p.endswith('.lock'):
        return 'config'
    code_exts = ('.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.swift', '.kt', '.java', '.c', '.cpp', '.h', '.sql', '.sh')
    if any(p.endswith(ext) for ext in code_exts):
        return 'code'
    return 'other'


def _gh_pr_for_commit(cwd: Optional[str], sha: str) -> Optional[dict]:
    """Busca el PR que contiene este commit (gh api)."""
    try:
        r = subprocess.run(
            ['gh', 'pr', 'list', '--state', 'all', '--search', sha,
             '--json', 'number,title,state,mergedAt,url', '--limit', '1'],
            capture_output=True, text=True, timeout=15, cwd=cwd
        )
        if r.returncode == 0 and r.stdout.strip():
            arr = json.loads(r.stdout)
            if arr:
                return arr[0]
    except Exception:
        pass
    return None


def _bd_closed_in_range(worktree: str, since: datetime.datetime, until: datetime.datetime) -> List[dict]:
    """Busca beads cerradas cuyo metadata.worktree coincida con la sesión."""
    try:
        # bd list --status=closed --json con metadata
        r = subprocess.run(
            ['bd', 'list', '--status', 'closed', '--json', '--limit', '0'],
            capture_output=True, text=True, timeout=20, cwd=worktree or '.'
        )
        if r.returncode != 0 or not r.stdout.strip():
            return []
        beads = json.loads(r.stdout)
        out = []
        for b in beads:
            closed_at = b.get('closed_at') or b.get('updated_at')
            if not closed_at:
                continue
            try:
                t = datetime.datetime.fromisoformat(closed_at.replace('Z', '+00:00'))
            except Exception:
                continue
            if t < since or t > until:
                continue
            wt = (b.get('metadata') or {}).get('worktree', '')
            if worktree and wt and worktree not in wt and wt not in worktree:
                continue
            out.append(b)
        return out
    except Exception:
        return []


def _session_window(jsonl_path: str) -> tuple[Optional[datetime.datetime], Optional[datetime.datetime]]:
    """Lee la ventana temporal (ts_start, ts_end) de un JSONL de sesión."""
    ts_first = ts_last = None
    try:
        with open(jsonl_path, 'rb') as source:
            for line in source:
                try:
                    record = json.loads(line.decode('utf-8', errors='ignore').strip())
                except Exception:
                    continue
                record_type = record.get('type', '')
                if record_type == 'session':
                    timestamp = record.get('timestamp')
                    if timestamp and ts_first is None:
                        ts_first = timestamp
                if record_type in ('message', 'tool'):
                    timestamp = record.get('timestamp')
                    if timestamp:
                        ts_last = timestamp
    except OSError:
        return None, None
    try:
        started_at = datetime.datetime.fromisoformat(ts_first.replace('Z', '+00:00')) if ts_first else None
        ended_at = datetime.datetime.fromisoformat(ts_last.replace('Z', '+00:00')) if ts_last else started_at
    except ValueError:
        return None, None
    return started_at, ended_at


def _session_cwd(jsonl_path: str) -> Optional[str]:
    try:
        with open(jsonl_path, 'rb') as source:
            for line in source:
                try:
                    record = json.loads(line.decode('utf-8', errors='ignore').strip())
                except Exception:
                    continue
                if record.get('type') == 'session':
                    cwd = record.get('cwd')
                    if isinstance(cwd, str):
                        return cwd
    except OSError:
        return None
    return None


def compute_outcome_for_session(jsonl_path: str, with_prs: bool = True, with_beads: bool = True) -> dict[str, Any]:
    """Computa outcomes para una sesión; PRs y beads son opcionales."""
    t1, t2 = _session_window(jsonl_path)
    if not (t1 and t2):
        return dict(
            commits=0, commit_shas=[], prs=[], beads=[],
            subagent_notifies=0, fan_out_max=0, cwd=None,
            ts_start=None, ts_end=None,
        )
    cwd = _session_cwd(jsonl_path)

    # 1. Commits
    commits = _git_log(cwd, t1, t2)

    # 2. PRs (uno por commit; deduplicar por PR number)
    prs_seen = {}
    if with_prs:
        for sha, subj in commits:
            pr = _gh_pr_for_commit(cwd, sha)
            if pr and pr.get('number') not in prs_seen:
                prs_seen[pr['number']] = pr

    # 3. Beads cerradas (solo si el cwd parece un worktree a4s)
    beads = []
    if with_beads and cwd and 'a4s' in cwd:
        beads = _bd_closed_in_range(cwd, t1, t2)

    # 4. Subagent-notify y fan-out
    subn_events = []
    try:
        with open(jsonl_path, 'rb') as source:
            for line in source:
                try:
                    record = json.loads(line.decode('utf-8', errors='ignore').strip())
                except Exception:
                    continue
                if record.get('type') in ('custom', 'custom_message') and record.get('customType') == 'subagent-notify':
                    subn_events.append(record.get('timestamp'))
    except OSError:
        pass

    fan_out_max = 0
    if subn_events:
        ts_sorted = []
        for ts in subn_events:
            try:
                ts_sorted.append(datetime.datetime.fromisoformat(ts.replace('Z', '+00:00')))
            except Exception:
                pass
        ts_sorted.sort()
        for i, t in enumerate(ts_sorted):
            window = sum(1 for t2_ in ts_sorted if 0 <= (t2_ - t).total_seconds() <= 60)
            fan_out_max = max(fan_out_max, window)

    return dict(
        commits=len(commits),
        commit_shas=[c[0] for c in commits],
        prs=list(prs_seen.values()),
        beads=beads,
        subagent_notifies=len(subn_events),
        fan_out_max=fan_out_max,
        cwd=cwd,
        ts_start=t1.isoformat() if t1 else None,
        ts_end=t2.isoformat() if t2 else None,
    )


def _new_outcome_aggregate() -> OutcomeAggregate:
    return {
        'n': 0,
        'sessions_with_commits': 0,
        'total_commits': 0,
        'unique_commit_shas': set(),
        'sessions_with_prs': 0,
        'total_prs': 0,
        'sessions_with_beads': 0,
        'total_beads': 0,
        'total_subagent_notifies': 0,
        'max_fan_out': 0,
    }


def compute_outcomes(cells: dict[str, Any], with_prs: bool = True, with_beads: bool = True,
                     progress: bool = True) -> dict[str, OutcomeAggregate]:
    """Itera sobre cells y devuelve {scenario: aggregated_outcome}.

    `cells` es el dict producido por quad.scan_sessions().
    Cada escenario agrega los outcomes de TODAS sus sesiones.
    """
    agg: collections.defaultdict[str, OutcomeAggregate] = collections.defaultdict(_new_outcome_aggregate)

    # Aplanar todas las sesiones con su scenario
    all_sess: list[tuple[str, str]] = []
    for scenario, cell in cells.items():
        for f in cell.get('files', []):
            all_sess.append((scenario, f))

    total = len(all_sess)
    for i, (scenario, f) in enumerate(all_sess):
        if progress and (i % 10 == 0 or i == total - 1):
            print(f'  outcomes: {i+1}/{total}', file=sys.stderr)
        o = compute_outcome_for_session(f, with_prs=with_prs, with_beads=with_beads)
        a = agg[scenario]
        a['n'] += 1
        if o['commits'] > 0:
            a['sessions_with_commits'] += 1
            a['unique_commit_shas'].update(o['commit_shas'])
            a['total_commits'] = len(a['unique_commit_shas'])
        if o['prs']:
            a['sessions_with_prs'] += 1
            a['total_prs'] += len(o['prs'])
        if o['beads']:
            a['sessions_with_beads'] += 1
            a['total_beads'] += len(o['beads'])
        a['total_subagent_notifies'] += o['subagent_notifies']
        a['max_fan_out'] = max(a['max_fan_out'], o['fan_out_max'])
    # El set se conserva internamente para deduplicar; no lo necesita el formateador.
    return dict(agg)


def format_outcomes_table(outcomes: dict[str, OutcomeAggregate]) -> str:
    out = []
    out.append('=== OUTCOMES POR ESCENARIO ===\n')
    out.append(f"{'escenario':10s} {'N':>4s} {'commits':>9s} {'commits/sess':>13s} {'PRs':>5s} {'beads':>6s} {'sub_n':>6s} {'max_fan':>8s}")
    for k in ['S1', 'S2', 'S3', 'S4']:
        v = outcomes.get(k)
        if not v or v['n'] == 0:
            continue
        cps = v['total_commits'] / v['n']
        labels = {
            'S1': 'S1 solo',
            'S2': 'S2 subags',
            'S3': 'S3 orq',
            'S4': 'S4 orq+sub',
        }
        out.append(
            f"{labels[k]:10s} {v['n']:>4d} {v['total_commits']:>9d} "
            f"{cps:>13.2f} {v['total_prs']:>5d} {v['total_beads']:>6d} "
            f"{v['total_subagent_notifies']:>6d} {v['max_fan_out']:>8d}"
        )
    return '\n'.join(out)


if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--since', required=True)
    ap.add_argument('--until', default=None)
    ap.add_argument('--no-prs', action='store_true', help='Saltar lookup de PRs (más rápido)')
    ap.add_argument('--no-beads', action='store_true', help='Saltar lookup de beads')
    args = ap.parse_args()

    from quad import (  # pyright: ignore[reportMissingImports]
        format_table,
        scan_sessions,
    )
    cells = scan_sessions(args.since, args.until)
    print(format_table(cells))
    print()
    outcomes = compute_outcomes(
        cells,
        with_prs=not args.no_prs,
        with_beads=not args.no_beads,
    )
    print(format_outcomes_table(outcomes))
