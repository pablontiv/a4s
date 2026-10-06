#!/usr/bin/env python3
"""
cost-analyzer / assets / linkage.py

D8 FIX: Session-to-commit linkage and tokens-per-commit metrics.

Methodology:
1. Load all sessions from canonical ledger with time windows [start, end]
2. Enumerate commits from repository (all branches, within date range)
3. Attribute each commit to the session whose time window contains it
4. On overlap: choose session with minimum duration (specificity)
5. Aggregate tokens by form/topology and compute tokens_per_commit
6. Report unattributed commits

Output: LinkageResult with session->commit mapping and metrics.
"""
import sys
import os
import json
import subprocess
import datetime
from typing import Optional, List, Dict, Tuple
from collections import defaultdict
from dataclasses import dataclass, field

from dataset import SessionRecord


@dataclass
class LinkageResult:
    """Result of session-to-commit linkage analysis."""
    period_since: datetime.date
    period_until: datetime.date
    author_email: Optional[str] = None
    total_sessions: int = 0
    total_commits_all: int = 0
    total_commits_main: int = 0
    total_commits_worktrees: int = 0
    attributed_commits: int = 0
    unattributed_commits: int = 0
    attribution_rate_pct: float = 0.0
    scenario_aggregation: Dict[str, dict] = field(default_factory=dict)
    unattributed_details: List[Tuple[str, str, str]] = field(default_factory=list)


def parse_timestamp(ts_str: str) -> Optional[datetime.datetime]:
    """Parse ISO timestamp."""
    if not ts_str:
        return None
    try:
        return datetime.datetime.fromisoformat(ts_str.replace('Z', '+00:00'))
    except (ValueError, AttributeError):
        return None


def get_all_commits(repo_path: str, since: datetime.date, until: datetime.date, author_email: Optional[str] = None) -> List[Tuple[str, str, str]]:
    """Extract all commits from all branches.

    Returns [(sha, timestamp_iso, subject)].
    """
    try:
        cmd = [
            'git', '-C', repo_path, 'log',
            f'--since={since.isoformat()}',
            f'--until={until.isoformat()}',
            '--format=%H|%cI|%s',
            '--all'
        ]
        if author_email:
            cmd.extend(['--author', author_email])
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            return []
        commits = []
        for line in result.stdout.strip().split('\n'):
            if not line:
                continue
            parts = line.split('|', 2)
            if len(parts) == 3:
                sha, timestamp, subject = parts
                commits.append((sha, timestamp, subject))
        return commits
    except Exception:
        return []


def get_main_commits(repo_path: str, since: datetime.date, until: datetime.date, author_email: Optional[str] = None) -> set[str]:
    """Get set of commit SHAs on main branch."""
    try:
        cmd = [
            'git', '-C', repo_path, 'log',
            f'--since={since.isoformat()}',
            f'--until={until.isoformat()}',
            '--format=%H',
            'main'
        ]
        if author_email:
            cmd.extend(['--author', author_email])
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            return set()
        return set(line.strip() for line in result.stdout.strip().split('\n') if line.strip())
    except Exception:
        return set()


def attribute_commit_to_session(commit_ts: datetime.datetime, session_windows: List[dict]) -> Optional[dict]:
    """Attribute a commit to a session.

    Rule: commit belongs to the session whose time window [start, end] contains it.
    On overlap: choose session with minimum duration (highest specificity).
    """
    candidates = []
    for window in session_windows:
        start = window['start']
        end = window['end']
        if start and end and start <= commit_ts <= end:
            duration = (end - start).total_seconds()
            candidates.append((duration, window))

    if not candidates:
        return None

    candidates.sort(key=lambda x: x[0])
    return candidates[0][1]


def analyze_linkage(records: List[SessionRecord], repo_path: str, since: datetime.date, until: datetime.date, author_email: Optional[str] = None) -> LinkageResult:
    """Analyze session-to-commit linkage.

    Args:
        records: list of SessionRecord from canonical ledger
        repo_path: path to git repository
        since: start date for analysis
        until: end date for analysis
        author_email: optional filter by author

    Returns:
        LinkageResult with attribution metrics and tokens-per-commit by form/topology
    """
    result = LinkageResult(
        period_since=since,
        period_until=until,
        author_email=author_email,
        scenario_aggregation={},
        unattributed_details=[],
    )

    session_windows = []
    for record in records:
        if not record.started_at:
            continue
        window = {
            'session_id': record.id,
            'start': record.started_at,
            'end': record.ended_at or record.started_at,
            'tokens': (record.input_tokens + record.output_tokens +
                      record.cache_read_tokens + record.cache_write_tokens),
            'form': record.form,
            'topology': record.observed_topology,
            'harness': record.harness,
        }
        session_windows.append(window)

    result.total_sessions = len(session_windows)

    all_commits = get_all_commits(repo_path, since, until, author_email)
    main_commits = get_main_commits(repo_path, since, until, author_email)

    result.total_commits_all = len(all_commits)
    result.total_commits_main = len(main_commits)
    result.total_commits_worktrees = len(all_commits) - len(main_commits)

    attribution = []
    unattributed = []

    for sha, ts_iso, subject in all_commits:
        commit_ts = parse_timestamp(ts_iso)
        if not commit_ts:
            unattributed.append((sha, ts_iso, 'invalid_timestamp'))
            continue

        window = attribute_commit_to_session(commit_ts, session_windows)
        if not window:
            unattributed.append((sha, ts_iso, 'no_session_match'))
            continue

        is_in_main = sha in main_commits
        attribution.append({
            'commit_sha': sha,
            'commit_timestamp': ts_iso,
            'commit_subject': subject,
            'in_main': is_in_main,
            'session_id': window['session_id'],
            'session_form': window['form'],
            'session_topology': window['topology'],
            'session_tokens': window['tokens'],
            'session_harness': window['harness'],
        })

    result.attributed_commits = len(attribution)
    result.unattributed_commits = len(unattributed)
    result.unattributed_details = unattributed
    result.attribution_rate_pct = (len(attribution) / len(all_commits) * 100) if all_commits else 0.0

    scenario_agg = defaultdict(lambda: {'sessions': set(), 'tokens': 0, 'commits': 0, 'tokens_per_commit': 0.0})
    session_tokens = {}

    for item in attribution:
        sid = item['session_id']
        scenario = item['session_form']
        if sid not in session_tokens:
            session_tokens[sid] = item['session_tokens']

    for item in attribution:
        scenario = item['session_form']
        scenario_agg[scenario]['sessions'].add(item['session_id'])
        scenario_agg[scenario]['commits'] += 1

    for sid, tokens in session_tokens.items():
        for item in attribution:
            if item['session_id'] == sid:
                scenario = item['session_form']
                scenario_agg[scenario]['tokens'] += tokens
                break

    for form_key, agg in scenario_agg.items():
        if agg['commits'] > 0:
            agg['tokens_per_commit'] = agg['tokens'] / agg['commits']
        result.scenario_aggregation[form_key] = {
            'sessions': len(agg['sessions']),
            'tokens': agg['tokens'],
            'commits': agg['commits'],
            'tokens_per_commit': agg['tokens_per_commit'],
        }

    return result
