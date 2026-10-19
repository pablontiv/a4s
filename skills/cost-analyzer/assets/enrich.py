import os
import subprocess
from dataclasses import replace
from typing import Iterable

from dataset import SessionRecord
from outcomes import _git_log


def enrich_records(records: Iterable[SessionRecord]) -> list[SessionRecord]:
    """Añade SHAs del cwd durante la ventana de cada sesión; no muta registros."""
    enriched = []
    for record in records:
        if not (record.started_at and record.ended_at):
            enriched.append(replace(record, commit_coverage='no-timestamps'))
            continue
        if not record.cwd or not os.path.isdir(record.cwd):
            enriched.append(replace(record, commit_coverage='not-a-repo'))
            continue
        try:
            is_repo = subprocess.run(['git', '-C', record.cwd, 'rev-parse', '--is-inside-work-tree'], capture_output=True, text=True, timeout=5)
            if is_repo.returncode != 0:
                enriched.append(replace(record, commit_coverage='not-a-repo'))
                continue
            commits = _git_log(record.cwd, record.started_at, record.ended_at)
        except (OSError, subprocess.TimeoutExpired):
            enriched.append(replace(record, commit_coverage='error'))
            continue
        enriched.append(replace(record, commits=frozenset(sha for sha, _ in commits), commit_coverage='observable'))
    return enriched


def unique_shas(records: Iterable[SessionRecord]) -> frozenset[str]:
    return frozenset(sha for record in records for sha in record.commits)
