from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "beads_todo_loop.py"


def run(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["bd", *args], cwd=repo, text=True, capture_output=True, check=True, timeout=60)


def run_script(repo: Path, *args: str) -> dict[str, object]:
    result = subprocess.run([sys.executable, str(SCRIPT), *args], cwd=repo, text=True, capture_output=True, check=False, timeout=60)
    if result.returncode:
        raise AssertionError(result.stderr)
    return json.loads(result.stdout)


class A4STodoLoopE2ETests(unittest.TestCase):
    def test_disposable_a4s_graph_projects_and_finalizes_without_lease(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            run(repo, "init", "--non-interactive", "--skip-agents", "--skip-hooks", "--prefix", "a4s")
            a = run(repo, "create", "A", "--priority", "1", "--silent").stdout.strip()
            b = run(repo, "create", "B", "--priority", "1", "--silent").stdout.strip()
            c = run(repo, "create", "C", "--priority", "1", "--silent").stdout.strip()
            run(repo, "dep", a, "--blocks", b)
            first = run_script(repo, "snapshot")
            self.assertEqual([item["id"] for item in first["details"]["todos"]], [a, c, b])
            self.assertEqual(first["details"]["todos"][2]["blocked_by"], [f"bead:{a}"])
            self.assertNotIn("lease_expires_at", json.dumps(first))
            reports = repo / "reports" / "beads-loop"
            reports.mkdir(parents=True)
            evidence = reports / "a.md"
            evidence.write_text("evidence", encoding="utf-8")
            self.assertEqual(run_script(repo, "finalize", "--bead", a, "--verdict", "pass", "--evidence", "reports/beads-loop/a.md")["kind"], "finalized")
            final = run_script(repo, "snapshot")
            self.assertEqual([item["id"] for item in final["details"]["todos"]], [b, c])
            c_evidence = reports / "c.md"
            c_evidence.write_text("evidence", encoding="utf-8")
            self.assertEqual(run_script(repo, "finalize", "--bead", c, "--verdict", "fail", "--evidence", "reports/beads-loop/c.md")["kind"], "finalized")
            after_failure = run_script(repo, "snapshot")
            self.assertEqual([item["id"] for item in after_failure["details"]["todos"]], [b])
            b_evidence = reports / "b.md"
            b_evidence.write_text("evidence", encoding="utf-8")
            self.assertEqual(run_script(repo, "finalize", "--bead", b, "--verdict", "pass", "--evidence", "reports/beads-loop/b.md")["kind"], "finalized")
            self.assertEqual(run_script(repo, "snapshot")["kind"], "no_open")


if __name__ == "__main__":
    unittest.main()
