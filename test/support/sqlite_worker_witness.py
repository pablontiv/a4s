#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sqlite3
import time
from pathlib import Path
from typing import Any

SCHEMA = "a4s.worker-witness-receipt/v1"
TERMINAL = {"completed", "failed", "cancelled", "interrupted"}
EXPECTED_TASKS = 8
MAX_SNAPSHOTS = 64
REQUIRED_TASK_COLUMNS = {
    "id", "cwd", "session_id", "nested_session_path", "task", "status",
    "attempt", "started_at", "ended_at",
}
REQUIRED_ATTEMPT_COLUMNS = {"task_id", "attempt", "cwd", "session_id", "nested_session_path"}
REQUIRED_EVENT_COLUMNS = {"task_id", "attempt", "cwd", "created_at", "status", "activity"}


def _open_read_only(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=0)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    return connection


def _columns(connection: sqlite3.Connection, table: str) -> set[str]:
    return {str(row[1]) for row in connection.execute(f"PRAGMA table_info({table})")}


def _read_view(
    connection: sqlite3.Connection,
    *,
    cwd: str,
    parent_session_id: str,
    nonce: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], bool]:
    if not REQUIRED_TASK_COLUMNS <= _columns(connection, "subagent_tasks"):
        return [], [], False
    if not REQUIRED_ATTEMPT_COLUMNS <= _columns(connection, "subagent_task_attempts"):
        return [], [], False
    if not REQUIRED_EVENT_COLUMNS <= _columns(connection, "subagent_events"):
        return [], [], False
    marker = f"[a4s-worker-nonce:{nonce}]"
    rows = connection.execute(
        """SELECT id, attempt, cwd, session_id, nested_session_path, task, status,
                  started_at, ended_at
           FROM subagent_tasks
           WHERE cwd = ? AND session_id = ? AND instr(task, ?) > 0
           ORDER BY id LIMIT ?""",
        (cwd, parent_session_id, marker, EXPECTED_TASKS + 1),
    ).fetchall()
    tasks = [
        {
            "taskId": row["id"],
            "attempt": row["attempt"],
            "cwd": row["cwd"],
            "parentSessionId": row["session_id"],
            "nestedSessionPath": row["nested_session_path"],
            "task": row["task"],
            "status": row["status"],
            "startedAt": row["started_at"],
            "endedAt": row["ended_at"],
        }
        for row in rows
    ]
    task_ids = [task["taskId"] for task in tasks]
    events: list[dict[str, Any]] = []
    if task_ids:
        placeholders = ",".join("?" for _ in task_ids)
        event_rows = connection.execute(
            f"""SELECT task_id, attempt, cwd, MIN(created_at) AS created_at, 'running' AS status, 'started' AS activity
                FROM subagent_events
                WHERE cwd = ? AND task_id IN ({placeholders}) AND status = 'running' AND activity = 'started'
                GROUP BY task_id, attempt, cwd
                ORDER BY task_id LIMIT ?""",
            (cwd, *task_ids, EXPECTED_TASKS + 1),
        ).fetchall()
        events = [
            {
                "taskId": row["task_id"],
                "attempt": row["attempt"],
                "cwd": row["cwd"],
                "createdAt": row["created_at"],
                "status": row["status"],
                "activity": row["activity"],
            }
            for row in event_rows
        ]
        attempt_rows = connection.execute(
            f"""SELECT task_id, attempt, cwd, session_id, nested_session_path
                FROM subagent_task_attempts
                WHERE cwd = ? AND task_id IN ({placeholders})
                ORDER BY task_id, attempt LIMIT ?""",
            (cwd, *task_ids, EXPECTED_TASKS + 1),
        ).fetchall()
        attempts_complete = (
            len(attempt_rows) == len(tasks)
            and all(row["attempt"] == 1 for row in attempt_rows)
            and {row["task_id"] for row in attempt_rows} == set(task_ids)
        )
    else:
        attempts_complete = True
    return tasks, events, attempts_complete


def observe(
    *,
    database: Path,
    cwd: str,
    parent_session_id: str,
    nonce: str,
    timeout_ms: int,
    poll_ms: int = 10,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_ms / 1000
    snapshots: list[dict[str, Any]] = []
    started_events: list[dict[str, Any]] = []
    running_seen = False
    last_projection: tuple[tuple[str, str], ...] | None = None
    schema_complete = False
    attempts_complete = False
    while time.monotonic() < deadline:
        try:
            with _open_read_only(database) as connection:
                tasks, events, attempts_complete = _read_view(
                    connection,
                    cwd=cwd,
                    parent_session_id=parent_session_id,
                    nonce=nonce,
                )
                schema_complete = True
        except (OSError, sqlite3.Error):
            tasks, events = [], []
        projection = tuple((str(task.get("taskId")), str(task.get("status"))) for task in tasks)
        if projection != last_projection and len(snapshots) < MAX_SNAPSHOTS:
            snapshots.append({
                "observedAt": str(time.monotonic_ns()),
                "complete": schema_complete,
                "tasks": tasks,
            })
            last_projection = projection
        started_events = events
        running_seen = running_seen or (
            len(tasks) == EXPECTED_TASKS and all(task.get("status") == "running" for task in tasks)
        )
        terminal = len(tasks) == EXPECTED_TASKS and all(task.get("status") in TERMINAL for task in tasks)
        if terminal:
            break
        time.sleep(poll_ms / 1000)

    final_tasks = snapshots[-1]["tasks"] if snapshots else []
    ids = [task.get("taskId") for task in final_tasks]
    nested = [task.get("nestedSessionPath") for task in final_tasks]
    started_ids = {
        event.get("taskId") for event in started_events
        if event.get("status") == "running" and event.get("activity") == "started"
    }
    complete_identity = (
        schema_complete
        and attempts_complete
        and len(final_tasks) == EXPECTED_TASKS
        and len(set(ids)) == EXPECTED_TASKS
        and all(task.get("attempt") == 1 for task in final_tasks)
        and all(isinstance(value, str) and value for value in nested)
        and len(set(nested)) == EXPECTED_TASKS
    )
    terminal_complete = (
        complete_identity
        and started_ids == set(ids)
        and all(task.get("status") in TERMINAL for task in final_tasks)
        and all(task.get("startedAt") and task.get("endedAt") for task in final_tasks)
    )
    overlap = False
    if terminal_complete:
        starts = [str(task["startedAt"]) for task in final_tasks]
        ends = [str(task["endedAt"]) for task in final_tasks]
        overlap = max(starts) < min(ends)
    passed = complete_identity and running_seen and terminal_complete and overlap
    contradictory = len(final_tasks) > EXPECTED_TASKS or len(set(ids)) != len(ids) or (
        len(final_tasks) == EXPECTED_TASKS and attempts_complete and not overlap and terminal_complete
    )
    status = "PASS" if passed else "FAIL" if contradictory else "UNKNOWN"
    return {
        "schema": SCHEMA,
        "status": status,
        "campaign_key": "",
        "nonce": nonce,
        "cwd": cwd,
        "parent_session_id": parent_session_id,
        "snapshots": snapshots,
        "started_events": started_events,
        "task_ids": sorted(str(value) for value in ids if isinstance(value, str)),
        "attempts": [task.get("attempt") for task in final_tasks],
        "nested_sessions": sorted(str(value) for value in nested if isinstance(value, str)),
        "running_view_seen": running_seen,
        "terminal_complete": terminal_complete,
        "overlap": overlap,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--parent-session", required=True)
    parser.add_argument("--nonce", required=True)
    parser.add_argument("--campaign-key", required=True)
    parser.add_argument("--timeout-ms", type=int, required=True)
    options = parser.parse_args()
    receipt = observe(
        database=options.database,
        cwd=options.cwd,
        parent_session_id=options.parent_session,
        nonce=options.nonce,
        timeout_ms=options.timeout_ms,
    )
    receipt["campaign_key"] = options.campaign_key
    print(json.dumps(receipt, ensure_ascii=True, separators=(",", ":")))
    return 0 if receipt["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
