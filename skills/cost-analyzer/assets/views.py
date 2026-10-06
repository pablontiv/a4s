#!/usr/bin/env python3
"""Aggregations over the canonical SessionRecord ledger."""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Iterable

from dataset import SessionRecord


@dataclass
class CohortSummary:
    sessions: int = 0
    native_cost_sessions: int = 0
    native_cost_usd: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    total_tokens: int = 0
    git_observable_sessions: int = 0
    commits: set[str] = field(default_factory=set)
    prs: set[int] = field(default_factory=set)
    beads: set[str] = field(default_factory=set)

    @property
    def unique_shas(self) -> int:
        return len(self.commits)

    def tokens_per_sha(self) -> int | None:
        return self.total_tokens // self.unique_shas if self.unique_shas else None


HarnessSummary = CohortSummary


def aggregate_harness(records: Iterable[SessionRecord]) -> dict[str, CohortSummary]:
    summary: dict[str, CohortSummary] = defaultdict(CohortSummary)
    for record in records:
        target = summary[record.harness]
        target.sessions += 1
        target.input_tokens += record.input_tokens
        target.output_tokens += record.output_tokens
        target.cache_read_tokens += record.cache_read_tokens
        target.cache_write_tokens += record.cache_write_tokens
        target.total_tokens += record.input_tokens + record.output_tokens + record.cache_read_tokens + record.cache_write_tokens
        target.git_observable_sessions += record.commit_coverage == 'observable'
        target.commits.update(record.commits)
        target.prs.update(record.prs)
        target.beads.update(record.beads_closed)
        if record.cost_native_usd is not None:
            target.native_cost_sessions += 1
            target.native_cost_usd += record.cost_native_usd
    return dict(summary)


def aggregate_topology(records: Iterable[SessionRecord]) -> dict[str, CohortSummary]:
    summary: dict[str, CohortSummary] = defaultdict(CohortSummary)
    for record in records:
        key = f'{record.harness} × {record.observed_topology}'
        target = summary[key]
        target.sessions += 1
        target.input_tokens += record.input_tokens
        target.output_tokens += record.output_tokens
        target.cache_read_tokens += record.cache_read_tokens
        target.cache_write_tokens += record.cache_write_tokens
        target.total_tokens += record.input_tokens + record.output_tokens + record.cache_read_tokens + record.cache_write_tokens
        target.commits.update(record.commits)
    return dict(summary)


def aggregate_form(records: Iterable[SessionRecord]) -> dict[str, CohortSummary]:
    """D4 FIX: Aggregate sessions by form (4 forms taxonomy).

    Groups sessions by their form classification (form-solo, form-orch-hybrid,
    form-delegator-pure, form-cross-session) across all harnesses.
    """
    summary: dict[str, CohortSummary] = defaultdict(CohortSummary)
    for record in records:
        key = record.form
        if key == 'unknown':
            continue
        target = summary[key]
        target.sessions += 1
        target.input_tokens += record.input_tokens
        target.output_tokens += record.output_tokens
        target.cache_read_tokens += record.cache_read_tokens
        target.cache_write_tokens += record.cache_write_tokens
        target.total_tokens += record.input_tokens + record.output_tokens + record.cache_read_tokens + record.cache_write_tokens
        target.git_observable_sessions += record.commit_coverage == 'observable'
        target.commits.update(record.commits)
        target.prs.update(record.prs)
        target.beads.update(record.beads_closed)
        if record.cost_native_usd is not None:
            target.native_cost_sessions += 1
            target.native_cost_usd += record.cost_native_usd
    return dict(summary)


def render_topology_overview(summary: dict[str, CohortSummary]) -> str:
    out = ['=== TOPOLOGÍA POR HARNESS ===', '', f"{'cohorte':18s} {'sess':>5s} {'tokens':>12s} {'SHAs':>6s} {'tok/SHA':>10s}"]
    for key in sorted(summary):
        item = summary[key]
        per_sha = str(item.tokens_per_sha()) if item.tokens_per_sha() is not None else '—'
        out.append(f'{key:18s} {item.sessions:>5d} {item.total_tokens:>12d} {item.unique_shas:>6d} {per_sha:>10s}')
    return '\n'.join(out)


def render_harness_overview(summary: dict[str, HarnessSummary]) -> str:
    complete_coverage = bool(summary) and all(s.native_cost_sessions == s.sessions for s in summary.values())
    out = ['=== HARNESS OVERVIEW ===', '']
    out.append(f"{'harness':10s} {'sessions':>9s} {'native $':>10s} {'coverage':>10s} {'Git':>8s} {'tokens':>12s} {'SHAs':>7s} {'tok/SHA':>10s} {'PRs':>5s} {'beads':>6s}")
    for harness in ('pi', 'claude', 'codex'):
        item = summary.get(harness)
        if not item:
            continue
        tokens = item.total_tokens
        cost = f'${item.native_cost_usd:.2f}' if item.native_cost_sessions else '-'
        coverage = f'{item.native_cost_sessions}/{item.sessions}'
        git_coverage = f'{item.git_observable_sessions}/{item.sessions}'
        per_sha = str(item.tokens_per_sha()) if item.tokens_per_sha() is not None else '—'
        out.append(
            f"{harness:10s} {item.sessions:>9d} {cost:>10s} "
            f"{coverage:>10s} {git_coverage:>8s} {tokens:>12d} "
            f"{len(item.commits):>7d} {per_sha:>10s} {len(item.prs):>5d} {len(item.beads):>6d}"
        )
    out.append('')
    out.append('winner $/SHA: available only when every harness has native-cost coverage' if complete_coverage else 'winner $/SHA: unavailable (native-cost coverage is partial)')
    return '\n'.join(out)


def render_tokens_breakdown(summary: dict[str, HarnessSummary]) -> str:
    """Token breakdown by harness, highlighting cacheRead impact on quota.

    cacheRead tokens count against quota even though cost in USD is lower.
    """
    out = ['=== TOKEN BREAKDOWN BY HARNESS ===', '']
    out.append('Note: cacheRead tokens count against quota even though cost in USD is lower.')
    out.append('')
    out.append(
        f"{'harness':10s} {'sessions':>9s} {'input':>12s} {'output':>12s} "
        f"{'cacheRead':>12s} {'cacheWrite':>12s} {'total':>12s} {'%cached':>8s}"
    )
    for harness in ('pi', 'claude', 'codex'):
        item = summary.get(harness)
        if not item:
            continue
        cached = item.cache_read_tokens + item.cache_write_tokens
        total = item.total_tokens
        cached_pct = (cached / total * 100) if total > 0 else 0.0
        out.append(
            f"{harness:10s} {item.sessions:>9d} {item.input_tokens:>12d} "
            f"{item.output_tokens:>12d} {item.cache_read_tokens:>12d} "
            f"{item.cache_write_tokens:>12d} {total:>12d} {cached_pct:>7.1f}%"
        )
    out.append('')
    out.append('Interpretation: input and output tokens are cache-agnostic.')
    out.append('                cacheRead is quota-counted volume even if cost-effective.')
    out.append('                cacheWrite is quota-counted volume even if cost-effective.')
    return '\n'.join(out)


def render_form_overview(summary: dict[str, CohortSummary]) -> str:
    """D4 FIX: Render the 4 forms taxonomy in the report.

    Displays sessions, tokens, and commits by form classification.
    Forms are mutually exclusive classifications independent of topology.
    """
    form_labels = {
        'form-solo': 'Form 1: Solo (no subagents, no cross-session)',
        'form-orch-hybrid': 'Form 2: Orchestrator + Subagents (hybrid)',
        'form-delegator-pure': 'Form 3: Pure Delegator (subagents dominant)',
        'form-cross-session': 'Form 4: Cross-Session Orchestration',
    }

    out = ['=== TAXONOMÍA DE FORMAS (4 FORMAS) ===', '', f"{'form':30s} {'sess':>5s} {'tokens':>12s} {'commits':>8s} {'tok/commit':>12s}"]
    for form_key in ('form-solo', 'form-orch-hybrid', 'form-delegator-pure', 'form-cross-session'):
        item = summary.get(form_key)
        if not item or item.sessions == 0:
            continue
        label = form_labels.get(form_key, form_key)
        tokens_per_commit = (item.total_tokens // item.unique_shas) if item.unique_shas else 0
        out.append(
            f"{label:30s} {item.sessions:>5d} {item.total_tokens:>12d} "
            f"{item.unique_shas:>8d} {tokens_per_commit:>12d}"
        )
    return '\n'.join(out)
