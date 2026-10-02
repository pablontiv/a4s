#!/usr/bin/env python3
"""Render the pending Beads backlog as a read-only priority tree."""

from __future__ import annotations

import json
import subprocess
import sys
from collections import defaultdict
from typing import Any

PENDING_STATUSES = "open,in_progress,blocked,deferred"


def load_pending() -> list[dict[str, Any]]:
    try:
        result = subprocess.run(
            [
                "bd",
                "list",
                "--status",
                PENDING_STATUSES,
                "--brief",
                "--limit",
                "0",
                "--json",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as error:
        raise RuntimeError("bd no esta disponible en PATH") from error

    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise RuntimeError(f"bd list fallo: {detail}")

    try:
        records = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("bd list no devolvio JSON valido") from error

    if not isinstance(records, list) or not all(isinstance(record, dict) for record in records):
        raise RuntimeError("bd list devolvio una estructura inesperada")
    return records


def priority_label(value: Any) -> str:
    if isinstance(value, bool):
        return f"P{str(value).lower()}"
    if isinstance(value, int):
        return f"P{value}"
    if value is None:
        return "P?"
    return f"P{value}"


def priority_sort_key(value: Any) -> tuple[int, int | str]:
    if isinstance(value, int) and not isinstance(value, bool):
        return (0, value)
    if value is None:
        return (2, "")
    return (1, str(value))


def record_sort_key(record: dict[str, Any]) -> tuple[int, str]:
    return (0 if record.get("issue_type") == "epic" else 1, str(record.get("id", "")))


def blockers(record: dict[str, Any], by_id: dict[str, dict[str, Any]]) -> list[str]:
    found: set[str] = set()
    for dependency in record.get("dependencies") or []:
        if not isinstance(dependency, dict) or dependency.get("type") != "blocks":
            continue
        blocker_id = dependency.get("depends_on_id")
        blocker = by_id.get(str(blocker_id))
        if blocker is not None and blocker.get("status") != "closed":
            found.add(str(blocker_id))
    return sorted(found)


def node_text(record: dict[str, Any], group_ids: set[str], by_id: dict[str, dict[str, Any]]) -> str:
    record_id = str(record.get("id", "<missing-id>"))
    issue_type = str(record.get("issue_type", "unknown"))
    status = str(record.get("status", "unknown"))
    title = str(record.get("title", "<missing-title>"))
    annotations: list[str] = []

    parent = record.get("parent")
    if parent and str(parent) not in group_ids:
        annotations.append(f"parent: {parent}")

    pending_blockers = blockers(record, by_id)
    if pending_blockers:
        annotations.append(f"blocked_by: {','.join(pending_blockers)}")

    suffix = "" if not annotations else " (" + "; ".join(annotations) + ")"
    return f"{record_id} [{issue_type}, {status}] {title}{suffix}"


def render_group(records: list[dict[str, Any]], by_id: dict[str, dict[str, Any]]) -> list[str]:
    group_ids = {str(record.get("id")) for record in records}
    children: dict[str, list[dict[str, Any]]] = defaultdict(list)
    roots: list[dict[str, Any]] = []

    for record in records:
        parent = record.get("parent")
        if parent and str(parent) in group_ids:
            children[str(parent)].append(record)
        else:
            roots.append(record)

    for siblings in children.values():
        siblings.sort(key=record_sort_key)
    roots.sort(key=record_sort_key)

    lines: list[str] = []
    visited: set[str] = set()

    def visit(record: dict[str, Any], prefix: str, is_last: bool) -> None:
        record_id = str(record.get("id", "<missing-id>"))
        if record_id in visited:
            return
        visited.add(record_id)
        connector = "`-- " if is_last else "|-- "
        lines.append(prefix + connector + node_text(record, group_ids, by_id))
        nested = children.get(record_id, [])
        child_prefix = prefix + ("    " if is_last else "|   ")
        for index, child in enumerate(nested):
            visit(child, child_prefix, index == len(nested) - 1)

    for index, root in enumerate(roots):
        visit(root, "", index == len(roots) - 1)

    remaining = sorted(
        (record for record in records if str(record.get("id")) not in visited),
        key=record_sort_key,
    )
    for index, record in enumerate(remaining):
        if str(record.get("id")) in visited:
            continue
        visit(record, "", index == len(remaining) - 1)

    return lines


def render(records: list[dict[str, Any]]) -> str:
    by_id = {str(record.get("id")): record for record in records}
    groups: dict[Any, list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        groups[record.get("priority")].append(record)

    lines = [f"BACKLOG BY PRIORITY ({len(records)} pending)"]
    for priority in sorted(groups, key=priority_sort_key):
        lines.extend(["", priority_label(priority)])
        lines.extend(render_group(groups[priority], by_id))
    return "\n".join(lines)


def main() -> int:
    try:
        print(render(load_pending()))
    except RuntimeError as error:
        print(f"roadmap: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
