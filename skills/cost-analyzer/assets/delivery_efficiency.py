"""Read-only evidence for delivery-efficiency reporting."""
from __future__ import annotations

import datetime as dt
import statistics
import subprocess
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from dataset import SessionRecord
from outcomes import categorize_path


MATURITY_DAYS = 7


@dataclass(frozen=True)
class CommitEvidence:
    sha: str
    repository: Path
    committed_at: dt.datetime | None
    path_categories: frozenset[str]
    eligibility: str
    maturity: str
    durability: str


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )


def run_git(repo: Path, *args: str) -> str | None:
    """Return stdout for a successful read-only Git command, else ``None``."""
    try:
        result = _git(repo, *args)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout if result.returncode == 0 else None


def resolve_default_ref(repo: Path) -> str | None:
    for ref in ("refs/remotes/origin/HEAD", "refs/heads/main", "refs/heads/master"):
        if run_git(repo, "rev-parse", "--verify", "--quiet", ref) is not None:
            return ref
    return None


def _is_shallow(repo: Path) -> bool | None:
    value = run_git(repo, "rev-parse", "--is-shallow-repository")
    if value is None:
        return None
    return value.strip() == "true"


def _is_ancestor(repo: Path, sha: str, default_ref: str) -> bool | None:
    try:
        result = _git(repo, "merge-base", "--is-ancestor", sha, default_ref)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode == 0:
        return True
    if result.returncode == 1:
        return False
    return None


def is_explicitly_reverted(repo: Path, default_ref: str, sha: str) -> bool | None:
    body = run_git(repo, "log", default_ref, "--format=%B", "--grep", f"This reverts commit {sha}")
    return None if body is None else bool(body.strip())


def _commit_details(repo: Path, sha: str) -> tuple[dt.datetime | None, frozenset[str]] | None:
    output = run_git(repo, "show", "--format=%cI", "--name-only", "--no-renames", sha)
    if output is None:
        return None
    lines = output.splitlines()
    if not lines:
        return None
    try:
        committed_at = dt.datetime.fromisoformat(lines[0].replace("Z", "+00:00"))
    except ValueError:
        return None
    paths = [line for line in lines[1:] if line.strip()]
    return committed_at, frozenset(categorize_path(path) for path in paths)


@dataclass(frozen=True)
class DeliveryCohort:
    repository: str
    cohort: str
    session_cost: float
    attributable_cost: float
    durable_shas: frozenset[str]
    immature_count: int
    reverted_count: int
    unknown_count: int
    coverage: float
    median_lead_seconds: float | None
    status: str

    @property
    def cdpc(self) -> float | None:
        return self.attributable_cost / len(self.durable_shas) if self.durable_shas else None


def inspect_commit(repo: Path, sha: str, evaluation_date: dt.date) -> CommitEvidence:
    """Classify a commit without changing repository state or refs."""
    details = _commit_details(repo, sha)
    if details is None:
        return CommitEvidence(sha, repo, None, frozenset(), "unknown", "unknown", "unknown-history")

    committed_at, categories = details
    eligibility = "production-code" if "code" in categories else "excluded-noncode"
    if eligibility == "excluded-noncode":
        return CommitEvidence(sha, repo, committed_at, categories, eligibility, "not-applicable", "not-applicable")

    maturity_cutoff = evaluation_date - dt.timedelta(days=MATURITY_DAYS)
    if committed_at.date() > maturity_cutoff:
        return CommitEvidence(sha, repo, committed_at, categories, eligibility, "immature", "not-applicable")

    default_ref = resolve_default_ref(repo)
    shallow = _is_shallow(repo)
    if default_ref is None or shallow is not False:
        return CommitEvidence(sha, repo, committed_at, categories, eligibility, "mature", "unknown-history")

    ancestor = _is_ancestor(repo, sha, default_ref)
    if ancestor is None:
        return CommitEvidence(sha, repo, committed_at, categories, eligibility, "mature", "unknown-history")
    if not ancestor:
        return CommitEvidence(sha, repo, committed_at, categories, eligibility, "mature", "not-on-default")

    reverted = is_explicitly_reverted(repo, default_ref, sha)
    if reverted is None:
        return CommitEvidence(sha, repo, committed_at, categories, eligibility, "mature", "unknown-history")
    return CommitEvidence(
        sha,
        repo,
        committed_at,
        categories,
        eligibility,
        "mature",
        "reverted" if reverted else "durable",
    )


def _repository_for(cwd: str | None) -> Path | None:
    if not cwd:
        return None
    root = run_git(Path(cwd), "rev-parse", "--show-toplevel")
    return Path(root.strip()) if root and root.strip() else None


def analyze_delivery_efficiency(
    records: Iterable[SessionRecord], evaluation_date: dt.date,
) -> list[DeliveryCohort]:
    """Allocate durable production changes to homogeneous topology cohorts."""
    pi_records = [record for record in records if record.harness == "pi"]
    evidence_cache: dict[tuple[Path, str], CommitEvidence] = {}
    observations: dict[tuple[Path, str], list[SessionRecord]] = defaultdict(list)
    evidence_by_record: dict[int, list[CommitEvidence]] = defaultdict(list)
    total_cost: dict[tuple[Path, str], float] = defaultdict(float)

    for index, record in enumerate(pi_records):
        repo = _repository_for(record.cwd)
        if repo is None:
            continue
        total_cost[(repo, record.observed_topology)] += record.cost_native_usd or 0.0
        for sha in record.commits:
            key = (repo, sha)
            evidence = evidence_cache.setdefault(key, inspect_commit(repo, sha, evaluation_date))
            observations[key].append(record)
            evidence_by_record[index].append(evidence)

    cohort_for_sha: dict[tuple[Path, str], str] = {}
    durable_by_cohort: dict[tuple[Path, str], set[str]] = defaultdict(set)
    earliest_start: dict[tuple[Path, str], dt.datetime] = {}
    immature: dict[tuple[Path, str], int] = defaultdict(int)
    reverted: dict[tuple[Path, str], int] = defaultdict(int)
    unknown: dict[tuple[Path, str], int] = defaultdict(int)

    for key, observers in observations.items():
        evidence = evidence_cache[key]
        scenarios = {record.observed_topology for record in observers}
        cohort = next(iter(scenarios)) if len(scenarios) == 1 else "mixed"
        cohort_for_sha[key] = cohort
        target = (key[0], cohort)
        if evidence.durability == "durable":
            durable_by_cohort[target].add(key[1])
            starts = [record.started_at for record in observers if record.started_at]
            if starts:
                earliest_start[key] = min(starts)
        elif evidence.maturity == "immature":
            immature[target] += 1
        elif evidence.durability == "reverted":
            reverted[target] += 1
        elif evidence.durability in {"unknown-history", "not-on-default", "unknown"}:
            unknown[target] += 1

    attributable: dict[tuple[Path, str], float] = defaultdict(float)
    for index, record in enumerate(pi_records):
        repo = _repository_for(record.cwd)
        if repo is None:
            continue
        durable = [
            evidence for evidence in evidence_by_record[index]
            if evidence.durability == "durable"
        ]
        if not durable:
            continue
        share = (record.cost_native_usd or 0.0) / len(durable)
        for evidence in durable:
            attributable[(repo, cohort_for_sha[(repo, evidence.sha)])] += share

    all_keys = set(total_cost) | set(durable_by_cohort) | set(immature) | set(reverted) | set(unknown)
    rows: list[DeliveryCohort] = []
    for repo, cohort in sorted(all_keys, key=lambda item: (str(item[0]), item[1])):
        shas = frozenset(durable_by_cohort[(repo, cohort)])
        cost = total_cost.get((repo, cohort), 0.0)
        attributed = attributable.get((repo, cohort), 0.0)
        coverage = attributed / cost if cost else 0.0
        leads = [
            (evidence_cache[(repo, sha)].committed_at - earliest_start[(repo, sha)]).total_seconds()
            for sha in shas
            if evidence_cache[(repo, sha)].committed_at and (repo, sha) in earliest_start
        ]
        if cohort == "mixed":
            status = "mixed"
        elif unknown[(repo, cohort)]:
            status = "unknown-history"
        elif not shas:
            status = "no-durable-changes"
        elif coverage < 0.80:
            status = "insufficient-coverage"
        else:
            status = "ranked"
        rows.append(DeliveryCohort(
            str(repo), cohort, cost, attributed, shas, immature[(repo, cohort)],
            reverted[(repo, cohort)], unknown[(repo, cohort)], coverage,
            statistics.median(leads) if leads else None, status,
        ))
    return rows
