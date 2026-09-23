#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence


@dataclass(frozen=True)
class Envelope:
    kind: str
    details: dict[str, object]


class ProviderFailure(RuntimeError):
    pass


def repository_root(cwd: Path) -> Path | None:
    try:
        current = cwd.resolve(strict=True)
    except OSError:
        return None
    if not current.is_dir():
        return None
    try:
        result = subprocess.run(
            ["git", "-C", str(current), "rev-parse", "--show-toplevel"],
            text=True,
            capture_output=True,
            check=False,
        )
    except OSError:
        return None
    if result.returncode != 0 or result.stderr.strip() or not result.stdout.strip():
        return None
    try:
        root = Path(result.stdout.strip()).resolve(strict=True)
        current.relative_to(root)
    except (OSError, ValueError):
        return None
    beads = root / ".beads"
    return root if beads.is_dir() and not beads.is_symlink() else None


def resolve_provider(root: Path) -> tuple[str, ...]:
    wrapper = root / "tooling" / "beads" / "bd.sh"
    return (str(wrapper),) if wrapper.is_file() and not wrapper.is_symlink() else ("bd",)


def run_provider(root: Path, command: tuple[str, ...]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            [*resolve_provider(root), *command],
            cwd=root,
            text=True,
            capture_output=True,
            check=False,
        )
    except OSError as error:
        raise ProviderFailure(command) from error


def provider_json(root: Path, command: tuple[str, ...]) -> object:
    result = run_provider(root, command)
    if result.returncode != 0 or result.stderr.strip() or not result.stdout.strip():
        raise ProviderFailure(command)
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise ValueError("malformed provider JSON") from error


def _issue(row: object) -> dict[str, object]:
    if not isinstance(row, dict):
        raise ValueError("issue is not an object")
    required = ("id", "title", "priority", "status")
    if any(not isinstance(row.get(field), str if field != "priority" else int) for field in required):
        raise ValueError("issue has invalid fields")
    dependencies = row.get("dependencies", [])
    if not isinstance(dependencies, list):
        raise ValueError("issue has invalid dependencies")
    return row


def project_snapshot(issues: object, ready: object) -> Envelope:
    if not isinstance(issues, list) or not isinstance(ready, list):
        raise ValueError("provider list is not an array")
    rows = [_issue(row) for row in issues]
    ready_ids: list[str] = []
    for row in ready:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"]:
            raise ValueError("ready issue has invalid id")
        if row["id"] not in ready_ids:
            ready_ids.append(row["id"])
    ready_rank = {issue_id: rank for rank, issue_id in enumerate(ready_ids)}
    todos: list[dict[str, object]] = []
    withheld: list[dict[str, str]] = []
    for row in rows:
        issue_id = row["id"]
        title = row["title"]
        status = row["status"]
        if status == "open":
            blocks: list[str] = []
            for dependency in row["dependencies"]:
                if not isinstance(dependency, dict):
                    raise ValueError("dependency is not an object")
                if dependency.get("type") == "blocks":
                    blocker = dependency.get("depends_on_id")
                    if not isinstance(blocker, str) or not blocker:
                        raise ValueError("blocks dependency is invalid")
                    blocks.append(f"bead:{blocker}")
            todos.append({
                "key": f"bead:{issue_id}",
                "id": issue_id,
                "title": title,
                "priority": row["priority"],
                "blocked_by": sorted(set(blocks)),
                "ready": issue_id in ready_rank,
            })
        elif status in ("in_progress", "blocked"):
            withheld.append({"id": issue_id, "title": title, "status": status})
    todos.sort(key=lambda item: (0, ready_rank[item["id"]]) if item["id"] in ready_rank else (1, item["priority"], item["id"]))
    for rank, todo in enumerate(todos):
        todo["rank"] = rank
    withheld.sort(key=lambda item: (item["status"], item["id"]))
    return Envelope("snapshot" if todos else "no_open", {"todos": todos, "withheld": withheld})


def snapshot(cwd: Path) -> Envelope:
    root = repository_root(cwd)
    if root is None:
        return Envelope("not_beads_repo", {})
    try:
        issues = provider_json(root, ("list", "--status", "open,in_progress,blocked", "--brief", "--limit", "0", "--json"))
        if not isinstance(issues, list):
            raise ValueError("provider list is not an array")
        issue_ids = [row.get("id") for row in issues if isinstance(row, dict) and isinstance(row.get("id"), str)]
        dependencies = provider_json(root, ("dep", "list", *issue_ids, "--json")) if issue_ids else []
        if not isinstance(dependencies, list):
            raise ValueError("provider dependencies are not an array")
        by_issue: dict[str, list[object]] = {issue_id: [] for issue_id in issue_ids}
        for dependency in dependencies:
            if not isinstance(dependency, dict) or not isinstance(dependency.get("issue_id"), str):
                raise ValueError("dependency is invalid")
            if dependency["issue_id"] in by_issue:
                by_issue[dependency["issue_id"]].append(dependency)
        enriched = [dict(row, dependencies=by_issue.get(row["id"], [])) for row in issues if isinstance(row, dict)]
        ready = provider_json(root, ("list", "--ready", "--brief", "--sort", "priority", "--limit", "0", "--json"))
        return project_snapshot(enriched, ready)
    except ProviderFailure:
        return Envelope("provider_failed", {})
    except ValueError:
        return Envelope("malformed_provider_output", {})


def valid_bead_id(bead_id: str) -> bool:
    return bool(bead_id) and bead_id == bead_id.strip() and not bead_id.startswith("-")


def exactly_one_issue(payload: object, bead_id: str) -> dict[str, object]:
    if not isinstance(payload, list) or len(payload) != 1:
        raise ValueError("expected one issue")
    row = _issue(payload[0])
    if row["id"] != bead_id:
        raise ValueError("wrong issue")
    return row


def detail(cwd: Path, bead_id: str) -> Envelope:
    if not valid_bead_id(bead_id):
        return Envelope("invalid_bead", {})
    root = repository_root(cwd)
    if root is None:
        return Envelope("not_beads_repo", {})
    try:
        row = exactly_one_issue(provider_json(root, ("show", bead_id, "--json")), bead_id)
        description = row.get("description", "")
        acceptance = row.get("acceptance_criteria", "")
        if not isinstance(description, str) or not isinstance(acceptance, str):
            raise ValueError("detail text is invalid")
        return Envelope("detail", {"id": row["id"], "title": row["title"], "description": description, "acceptance_criteria": acceptance, "status": row["status"]})
    except ProviderFailure:
        return Envelope("provider_failed", {})
    except ValueError:
        return Envelope("malformed_provider_output", {})


def evidence_reference(root: Path, evidence: Path) -> str | None:
    candidate = evidence if evidence.is_absolute() else root / evidence
    try:
        if candidate.is_symlink():
            return None
        resolved_root = root.resolve(strict=True)
        resolved = candidate.resolve(strict=True)
        relative = resolved.relative_to(resolved_root)
    except (OSError, ValueError):
        return None
    current = resolved_root
    for part in relative.parts:
        current /= part
        if current.is_symlink():
            return None
    return relative.as_posix() if resolved.is_file() else None


def finalize(cwd: Path, bead_id: str, verdict: str, evidence: Path) -> Envelope:
    if not valid_bead_id(bead_id):
        return Envelope("invalid_bead", {})
    if verdict not in ("pass", "fail"):
        return Envelope("invalid_bead", {})
    root = repository_root(cwd)
    if root is None:
        return Envelope("not_beads_repo", {})
    reference = evidence_reference(root, evidence)
    if reference is None:
        return Envelope("invalid_evidence", {})
    status, label = ("closed", "PASS") if verdict == "pass" else ("blocked", "FAIL")
    update = run_provider(root, ("update", bead_id, "--status", status, "--append-notes", f"{label} evidence={reference}", "--json"))
    if update.returncode != 0:
        return Envelope("provider_failed", {})
    try:
        observed = exactly_one_issue(provider_json(root, ("show", bead_id, "--json")), bead_id)
        if observed["status"] != status:
            return Envelope("provider_failed", {})
        return Envelope("finalized", {"issue": observed, "evidence": reference})
    except ProviderFailure:
        return Envelope("provider_failed", {})
    except ValueError:
        return Envelope("malformed_provider_output", {})


def main(argv: Sequence[str]) -> int:
    args = list(argv)
    if args == ["snapshot"]:
        envelope = snapshot(Path.cwd())
    elif len(args) == 3 and args[0] == "detail" and args[1] == "--bead":
        envelope = detail(Path.cwd(), args[2])
    elif len(args) == 7 and args[0] == "finalize" and args[1] == "--bead" and args[3] == "--verdict" and args[5] == "--evidence":
        envelope = finalize(Path.cwd(), args[2], args[4], Path(args[6]))
    else:
        print("usage: beads_todo_loop.py snapshot | detail --bead ID | finalize --bead ID --verdict pass|fail --evidence PATH", file=sys.stderr)
        return 2
    print(json.dumps({"schema_version": 2, "kind": envelope.kind, "details": envelope.details}, separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
