"""Read-only evidence for delivery-efficiency reporting."""
from __future__ import annotations

import datetime as dt
import subprocess
from dataclasses import dataclass
from pathlib import Path

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
