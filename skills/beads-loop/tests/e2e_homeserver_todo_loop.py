from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "beads_todo_loop.py"


def run(repo: Path, calls: list[tuple[str, ...]], *args: str) -> subprocess.CompletedProcess[str]:
    calls.append(args)
    return subprocess.run([str(repo / "tooling" / "beads" / "bd.sh"), *args], cwd=repo, text=True, capture_output=True, check=True, timeout=120)


def run_script(repo: Path, *args: str) -> dict[str, object]:
    result = subprocess.run([sys.executable, str(SCRIPT), *args], cwd=repo, text=True, capture_output=True, check=True, timeout=120)
    return json.loads(result.stdout)


class HomeserverTodoLoopE2ETests(unittest.TestCase):
    def test_homeserver_wrapper_runs_disposable_complete_graph_without_leases(self) -> None:
        root = os.environ.get("HOMESERVER_ROOT")
        if not root:
            self.skipTest("HOMESERVER_ROOT is required for the optional Homeserver wrapper E2E")
        source = Path(root)
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            (repo / "tooling").mkdir()
            shutil.copytree(source / "tooling" / "beads", repo / "tooling" / "beads")
            shutil.copytree(source / "tooling" / "validation", repo / "tooling" / "validation")
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            calls: list[tuple[str, ...]] = []
            run(repo, calls, "init", "--non-interactive", "--skip-agents", "--skip-hooks", "--prefix", "hst")
            a = run(repo, calls, "create", "A", "--priority", "1", "--silent").stdout.strip()
            b = run(repo, calls, "create", "B", "--priority", "1", "--silent").stdout.strip()
            c = run(repo, calls, "create", "C", "--priority", "1", "--silent").stdout.strip()
            run(repo, calls, "dep", a, "--blocks", b)
            first = run_script(repo, "snapshot")
            self.assertEqual([item["id"] for item in first["details"]["todos"]], [a, c, b])
            reports = repo / "reports" / "beads-loop"
            reports.mkdir(parents=True)
            for bead, verdict in ((a, "pass"), (c, "fail"), (b, "pass")):
                evidence = reports / f"{bead}.md"
                evidence.write_text("evidence", encoding="utf-8")
                self.assertEqual(run_script(repo, "finalize", "--bead", bead, "--verdict", verdict, "--evidence", evidence.relative_to(repo).as_posix())["kind"], "finalized")
            self.assertEqual(run_script(repo, "snapshot")["kind"], "no_open")
            self.assertTrue((repo / ".beads").is_dir())
            self.assertTrue(all("--global" not in call and "--claim" not in call for call in calls))
            self.assertNotIn("lease_expires_at", json.dumps(first))


if __name__ == "__main__":
    unittest.main()
