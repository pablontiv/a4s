#!/usr/bin/env python3
"""Canonical session ledger for Pi, Claude Code, and Codex."""
from __future__ import annotations

import datetime as dt
import json
from collections import Counter
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Iterable, Literal, Mapping

UTC = dt.timezone.utc
PI_CUTOVER = dt.datetime(2026, 9, 4, 4, 43, 9, tzinfo=UTC)
DEFAULT_ROOTS = {
    'pi': Path.home() / '.pi/agent/sessions',
    'claude': Path.home() / '.claude/projects',
    'codex': Path.home() / '.codex',
}


@dataclass(frozen=True)
class TopologyEvidence:
    delegation: bool = False
    coordination: bool = False
    direct_coordination: bool = False


def classify_topology(evidence: TopologyEvidence, parseable: bool) -> tuple[str, str]:
    if not parseable:
        return 'unknown', 'unknown'
    if evidence.coordination and evidence.delegation:
        topology = 'S4'
    elif evidence.coordination:
        topology = 'S3'
    elif evidence.delegation:
        topology = 'S2'
    else:
        topology = 'S1'
    return topology, 'direct' if evidence.delegation or evidence.direct_coordination else 'inferred'


@dataclass(frozen=True)
class SessionRecord:
    id: str | None
    harness: Literal['pi', 'claude', 'codex']
    source_path: str
    schema_version: str
    started_at: dt.datetime | None
    ended_at: dt.datetime | None
    cwd: str | None
    model: str | None
    provider: str | None
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    cost_native_usd: float | None = None
    topology: Literal['S1', 'S2', 'S3', 'S4'] | None = None
    observed_topology: Literal['S1', 'S2', 'S3', 'S4', 'unknown'] = 'unknown'
    topology_confidence: Literal['direct', 'inferred', 'unknown'] = 'unknown'
    topology_evidence: TopologyEvidence = field(default_factory=TopologyEvidence)
    pi_extension: Literal['pi-subagents-j0k3r', 'pi-subagents', 'mixed/unknown'] | None = None
    commits: frozenset[str] = field(default_factory=frozenset)
    commit_coverage: Literal['observable', 'not-a-repo', 'no-timestamps', 'error'] = 'not-a-repo'
    prs: frozenset[int] = field(default_factory=frozenset)
    beads_closed: frozenset[str] = field(default_factory=frozenset)


def parse_timestamp(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None


def legacy_spawn_count(record: dict) -> int:
    if record.get('type') != 'message':
        return 0
    message = record.get('message')
    if not isinstance(message, dict) or message.get('role') != 'assistant':
        return 0
    content = message.get('content')
    if not isinstance(content, list):
        return 0
    return sum(
        1 for block in content
        if isinstance(block, dict)
        and block.get('type') == 'toolCall'
        and block.get('name') in {'subagent', 'subagent_run'}
    )


def classify_pi_topology(directory: str, custom_types: Counter[str], spawn_tool_calls: int) -> Literal['S1', 'S2', 'S3', 'S4']:
    lower = directory.lower()
    orchestrated = (
        any(name.startswith('intercom') or name.startswith('fm-') or 'firstmate' in name for name in custom_types)
        or any(token in lower for token in ('a4s', 'bead-hs', 'review', 'worktrees'))
    )
    delegated = custom_types['subagent-notify'] > 0 or spawn_tool_calls > 0
    if orchestrated and delegated:
        return 'S4'
    if orchestrated:
        return 'S3'
    if delegated:
        return 'S2'
    return 'S1'


def extension_for_window(started_at: dt.datetime | None, ended_at: dt.datetime | None) -> Literal['pi-subagents-j0k3r', 'pi-subagents', 'mixed/unknown']:
    if not started_at or not ended_at:
        return 'mixed/unknown'
    if ended_at < PI_CUTOVER:
        return 'pi-subagents-j0k3r'
    if started_at > PI_CUTOVER:
        return 'pi-subagents'
    return 'mixed/unknown'


def load_ledger(since: dt.date, until: dt.date | None = None, roots: Mapping[str, Path] = DEFAULT_ROOTS) -> list[SessionRecord]:
    """Load every JSONL selected by mtime from the three source roots."""
    parsers = {'pi': parse_pi_session, 'claude': parse_claude_session, 'codex': parse_codex_session}
    records: list[SessionRecord] = []
    for harness, root in roots.items():
        parser = parsers[harness]
        if not root.exists():
            continue
        for path in root.rglob('*.jsonl'):
            modified = dt.datetime.fromtimestamp(path.stat().st_mtime).date()
            if modified < since or (until and modified > until):
                continue
            records.append(parser(path))
    return records


def parse_pi_session(path: Path) -> SessionRecord:
    started_at = ended_at = None
    session_id = cwd = model = provider = None
    custom_types: Counter[str] = Counter()
    spawn_tool_calls = input_tokens = output_tokens = cache_read_tokens = cache_write_tokens = 0
    cost = 0.0
    parsed_records = 0

    with path.open(errors='ignore') as source:
        for line in source:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            parsed_records += 1
            kind = record.get('type')
            if kind == 'session':
                session_id = session_id or record.get('id')
                cwd = cwd or record.get('cwd')
                started_at = started_at or parse_timestamp(record.get('timestamp'))
            elif kind == 'model_change':
                model = record.get('modelId') or model
                provider = record.get('provider') or provider
            if kind in ('message', 'tool'):
                ended_at = parse_timestamp(record.get('timestamp')) or ended_at
            spawn_tool_calls += legacy_spawn_count(record)
            if kind in ('custom', 'custom_message'):
                custom_types[record.get('customType', '')] += 1
            if kind in ('message', 'compaction'):
                message = record.get('message') if kind == 'message' else record
                usage = message.get('usage') if isinstance(message, dict) else None
                if kind == 'compaction':
                    usage = record.get('usage')
                if isinstance(usage, dict):
                    input_tokens += usage.get('input', 0) or usage.get('input_tokens', 0) or 0
                    output_tokens += usage.get('output', 0) or usage.get('output_tokens', 0) or 0
                    cache_read_tokens += usage.get('cacheRead', 0) or usage.get('cache_read_input_tokens', 0) or 0
                    cache_write_tokens += usage.get('cacheWrite', 0) or usage.get('cache_creation_input_tokens', 0) or 0
                    cost += usage.get('cost', {}).get('total', 0) or 0

    ended_at = ended_at or started_at
    topology = classify_pi_topology(path.parent.name, custom_types, spawn_tool_calls)
    evidence = TopologyEvidence(
        delegation=custom_types['subagent-notify'] > 0 or spawn_tool_calls > 0,
        coordination=topology in {'S3', 'S4'},
        direct_coordination=any(name.startswith('intercom') or name.startswith('fm-') or 'firstmate' in name for name in custom_types),
    )
    observed_topology, topology_confidence = classify_topology(evidence, parseable=parsed_records > 0)
    return SessionRecord(
        id=session_id,
        harness='pi',
        source_path=str(path),
        schema_version='pi-jsonl-v1',
        started_at=started_at,
        ended_at=ended_at,
        cwd=cwd,
        model=model,
        provider=provider,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cache_read_tokens=cache_read_tokens,
        cache_write_tokens=cache_write_tokens,
        cost_native_usd=cost,
        topology=topology,
        observed_topology=observed_topology,
        topology_confidence=topology_confidence,
        topology_evidence=evidence,
        pi_extension=extension_for_window(started_at, ended_at),
    )


def parse_claude_session(path: Path) -> SessionRecord:
    started_at = ended_at = None
    session_id = cwd = model = None
    input_tokens = output_tokens = cache_read_tokens = cache_write_tokens = 0
    delegation = False
    parsed_records = 0
    with path.open(errors='ignore') as source:
        for line in source:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            parsed_records += 1
            timestamp = parse_timestamp(record.get('timestamp'))
            started_at = started_at or timestamp
            ended_at = timestamp or ended_at
            session_id = session_id or record.get('sessionId')
            cwd = cwd or record.get('cwd')
            message = record.get('message')
            if record.get('type') == 'assistant' and isinstance(message, dict):
                delegation = delegation or any(isinstance(block, dict) and block.get('name') == 'Agent' for block in (message.get('content') or []))
                model = message.get('model') or model
                usage = message.get('usage') or {}
                input_tokens += usage.get('input_tokens', 0) or 0
                output_tokens += usage.get('output_tokens', 0) or 0
                cache_read_tokens += usage.get('cache_read_input_tokens', 0) or 0
                cache_write_tokens += usage.get('cache_creation_input_tokens', 0) or 0
    evidence = TopologyEvidence(delegation=delegation)
    observed_topology, topology_confidence = classify_topology(evidence, parsed_records > 0)
    return SessionRecord(
        id=session_id or path.stem, harness='claude', source_path=str(path),
        schema_version='claude-jsonl-v1', started_at=started_at, ended_at=ended_at,
        cwd=cwd, model=model, provider='anthropic' if model else None,
        input_tokens=input_tokens, output_tokens=output_tokens,
        cache_read_tokens=cache_read_tokens, cache_write_tokens=cache_write_tokens,
        cost_native_usd=None, observed_topology=observed_topology,
        topology_confidence=topology_confidence, topology_evidence=evidence,
    )


def parse_codex_session(path: Path) -> SessionRecord:
    started_at = ended_at = None
    session_id = cwd = model = provider = None
    input_tokens = output_tokens = cache_read_tokens = cache_write_tokens = 0
    delegation = False
    parsed_records = 0
    with path.open(errors='ignore') as source:
        for line in source:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            parsed_records += 1
            timestamp = parse_timestamp(record.get('timestamp'))
            started_at = started_at or timestamp
            ended_at = timestamp or ended_at
            payload = record.get('payload') if isinstance(record.get('payload'), dict) else {}
            delegation = delegation or payload.get('name') in {'spawn_agent', 'followup_task'}
            if record.get('type') == 'session_meta':
                session_id = session_id or payload.get('session_id') or payload.get('id')
                cwd = cwd or payload.get('cwd')
                model = model or payload.get('model')
                provider = provider or payload.get('model_provider')
                started_at = started_at or parse_timestamp(payload.get('timestamp'))
            if record.get('type') == 'event_msg' and payload.get('type') == 'token_count':
                usage = ((payload.get('info') or {}).get('total_token_usage') or {})
                input_tokens = usage.get('input_tokens', 0) or 0
                output_tokens = usage.get('output_tokens', 0) or 0
                cache_read_tokens = usage.get('cached_input_tokens', 0) or 0
                cache_write_tokens = usage.get('cache_write_input_tokens', 0) or 0
    evidence = TopologyEvidence(delegation=delegation)
    observed_topology, topology_confidence = classify_topology(evidence, parsed_records > 0)
    return SessionRecord(
        id=session_id or path.stem, harness='codex', source_path=str(path),
        schema_version='codex-jsonl-v1', started_at=started_at, ended_at=ended_at,
        cwd=cwd, model=model, provider=provider or 'openai',
        input_tokens=input_tokens, output_tokens=output_tokens,
        cache_read_tokens=cache_read_tokens, cache_write_tokens=cache_write_tokens,
        cost_native_usd=None, observed_topology=observed_topology,
        topology_confidence=topology_confidence, topology_evidence=evidence,
    )
