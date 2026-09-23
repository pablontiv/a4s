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


def run(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run([str(repo / "tooling" / "beads" / "bd.sh"), *args], cwd=repo, text=True, capture_output=True, check=True, timeout=120)


def run_script(repo: Path, *args: str) -> dict[str, object]:
    result = subprocess.run([sys.executable, str(SCRIPT), *args], cwd=repo, text=True, capture_output=True, check=True, timeout=120)
    return json.loads(result.stdout)


class HomeserverTodoLoopE2ETests(unittest.TestCase):
    def test_homeserver_wrapper_uses_disposable_local_beads_state(self) -> None:
        source = Path(os.environ["HOMESERVER_ROOT"])
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            (repo / "tooling").mkdir()
            shutil.copytree(source / "tooling" / "beads", repo / "tooling" / "beads")
            shutil.copytree(source / "tooling" / "validation", repo / "tooling" / "validation")
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            run(repo, "init", "--non-interactive", "--skip-agents", "--skip-hooks", "--prefix", "hst")
            run(repo, "create", "Synthetic Homeserver work", "--silent")
            snapshot = run_script(repo, "snapshot")
            self.assertEqual(snapshot["kind"], "snapshot")
            self.assertTrue((repo / ".beads").is_dir())
            self.assertNotIn("lease_expires_at", json.dumps(snapshot))


if __name__ == "__main__":
    unittest.main()
