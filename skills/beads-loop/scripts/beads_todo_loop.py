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
    result = subprocess.run(
        ["git", "-C", str(current), "rev-parse", "--show-toplevel"],
        text=True,
        capture_output=True,
        check=False,
    )
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
    return subprocess.run(
        [*resolve_provider(root), *command],
        cwd=root,
        text=True,
        capture_output=True,
        check=False,
    )


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
        ready = provider_json(root, ("list", "--ready", "--brief", "--sort", "priority", "--limit", "0", "--json"))
        return project_snapshot(issues, ready)
    except ProviderFailure:
        return Envelope("provider_failed", {})
    except ValueError:
        return Envelope("malformed_provider_output", {})


def main(argv: Sequence[str]) -> int:
    if list(argv) != ["snapshot"]:
        print("usage: beads_todo_loop.py snapshot", file=sys.stderr)
        return 2
    envelope = snapshot(Path.cwd())
    print(json.dumps({"schema_version": 2, "kind": envelope.kind, "details": envelope.details}, separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
