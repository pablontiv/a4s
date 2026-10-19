from __future__ import annotations

import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "support"))
from sqlite_worker_witness import observe  # noqa: E402


SCHEMA = """
CREATE TABLE subagent_tasks (
 id TEXT PRIMARY KEY, cwd TEXT, session_id TEXT, nested_session_path TEXT, task TEXT,
 status TEXT, attempt INTEGER, started_at TEXT, ended_at TEXT
);
CREATE TABLE subagent_task_attempts (
 task_id TEXT, attempt INTEGER, cwd TEXT, session_id TEXT, nested_session_path TEXT
);
CREATE TABLE subagent_events (
 id INTEGER PRIMARY KEY, task_id TEXT, attempt INTEGER, cwd TEXT, created_at TEXT, status TEXT, activity TEXT
);
"""


class SqliteWorkerWitnessTests(unittest.TestCase):
    def test_read_only_witness_proves_running_and_terminal_views(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "history.sqlite"
            cwd = str(Path(directory) / "work")
            nonce = "nonce-a"
            parent = "parent-a"
            connection = sqlite3.connect(database)
            connection.executescript(SCHEMA)
            for index in range(8):
                task_id = f"task-{index}"
                started = f"2026-01-01T00:00:0{index}.000Z"
                connection.execute(
                    "INSERT INTO subagent_tasks VALUES (?, ?, ?, ?, ?, 'running', 1, ?, NULL)",
                    (task_id, cwd, parent, f"session-{index}", f"[a4s-worker-nonce:{nonce}] task", started),
                )
                connection.execute(
                    "INSERT INTO subagent_task_attempts VALUES (?, 1, ?, ?, ?)",
                    (task_id, cwd, parent, f"session-{index}"),
                )
                connection.execute(
                    "INSERT INTO subagent_events VALUES (?, ?, 1, ?, ?, 'running', 'started')",
                    (index + 1, task_id, cwd, started),
                )
            connection.commit()
            connection.close()

            def finish() -> None:
                time.sleep(0.05)
                writer = sqlite3.connect(database)
                writer.execute(
                    "UPDATE subagent_tasks SET status='completed', ended_at='2026-01-01T00:00:20.000Z'"
                )
                writer.commit()
                writer.close()

            thread = threading.Thread(target=finish)
            thread.start()
            receipt = observe(
                database=database,
                cwd=cwd,
                parent_session_id=parent,
                nonce=nonce,
                timeout_ms=1000,
            )
            thread.join()
            self.assertEqual(receipt["status"], "PASS")
            self.assertTrue(receipt["running_view_seen"])
            self.assertEqual(len(receipt["task_ids"]), 8)

    def test_incomplete_sqlite_schema_is_unknown(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "history.sqlite"
            with sqlite3.connect(database) as connection:
                connection.execute("CREATE TABLE subagent_tasks (id TEXT)")
            receipt = observe(
                database=database,
                cwd="/tmp/work",
                parent_session_id="parent",
                nonce="nonce",
                timeout_ms=20,
                poll_ms=5,
            )
            self.assertEqual(receipt["status"], "UNKNOWN")


if __name__ == "__main__":
    unittest.main()
