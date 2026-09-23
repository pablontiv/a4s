from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType
from unittest.mock import patch


SKILL_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = SKILL_ROOT / "scripts" / "beads_todo_loop.py"


def load_adapter() -> ModuleType:
    spec = importlib.util.spec_from_file_location("beads_todo_loop", SCRIPT)
    if spec is None or spec.loader is None:
        raise AssertionError(f"cannot load {SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def completed(args: tuple[str, ...], payload: object) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(["bd", *args], 0, json.dumps(payload), "")


class FakeProvider:
    def __init__(self, replies: list[object]) -> None:
        self.replies = list(replies)
        self.calls: list[tuple[Path, tuple[str, ...]]] = []

    def __call__(self, root: Path, command: tuple[str, ...]) -> subprocess.CompletedProcess[str]:
        self.calls.append((root, command))
        if not self.replies:
            raise AssertionError(f"unexpected provider call: {command}")
        return completed(command, self.replies.pop(0))


class BeadsTodoLoopTests(unittest.TestCase):
    def make_repo(self, root: Path) -> Path:
        subprocess.run(["git", "init", "-q", str(root)], check=True)
        (root / ".beads").mkdir()
        return root

    def test_snapshot_projects_open_graph_without_full_text(self) -> None:
        adapter = load_adapter()
        with tempfile.TemporaryDirectory() as temporary:
            repo = self.make_repo(Path(temporary))
            provider = FakeProvider([
                [
                    {"id": "a", "title": "Implement A", "priority": 1, "status": "open", "dependencies": []},
                    {"id": "b", "title": "Implement B", "priority": 1, "status": "open", "dependencies": [{"type": "blocks", "depends_on_id": "a"}], "acceptance_criteria": "secret acceptance text"},
                ],
                [{"id": "a"}],
            ])
            with patch.object(adapter, "run_provider", provider):
                result = adapter.snapshot(repo)

        self.assertEqual(result.kind, "snapshot")
        self.assertEqual(result.details["todos"], [
            {"key": "bead:a", "id": "a", "title": "Implement A", "priority": 1, "rank": 0, "blocked_by": [], "ready": True},
            {"key": "bead:b", "id": "b", "title": "Implement B", "priority": 1, "rank": 1, "blocked_by": ["bead:a"], "ready": False},
        ])
        self.assertNotIn("secret acceptance text", json.dumps(result.details))
        self.assertTrue(all("--claim" not in command for _, command in provider.calls))

    def test_snapshot_withholds_legacy_in_progress_and_blocked_work(self) -> None:
        adapter = load_adapter()
        with tempfile.TemporaryDirectory() as temporary:
            repo = self.make_repo(Path(temporary))
            provider = FakeProvider([
                [
                    {"id": "legacy", "title": "Old run", "priority": 1, "status": "in_progress", "dependencies": []},
                    {"id": "blocked", "title": "Needs input", "priority": 1, "status": "blocked", "dependencies": []},
                ],
                [],
            ])
            with patch.object(adapter, "run_provider", provider):
                result = adapter.snapshot(repo)

        self.assertEqual(result.kind, "no_open")
        self.assertEqual(result.details["withheld"], [
            {"id": "blocked", "title": "Needs input", "status": "blocked"},
            {"id": "legacy", "title": "Old run", "status": "in_progress"},
        ])

    def test_snapshot_ignores_parent_child_dependency(self) -> None:
        adapter = load_adapter()
        with tempfile.TemporaryDirectory() as temporary:
            repo = self.make_repo(Path(temporary))
            provider = FakeProvider([
                [{"id": "child", "title": "Child", "priority": 2, "status": "open", "dependencies": [{"type": "parent-child", "depends_on_id": "parent"}]}],
                [],
            ])
            with patch.object(adapter, "run_provider", provider):
                result = adapter.snapshot(repo)

        self.assertEqual(result.details["todos"][0]["blocked_by"], [])

    def test_resolve_provider_uses_wrapper_only_when_regular_file(self) -> None:
        adapter = load_adapter()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.assertEqual(adapter.resolve_provider(root), ("bd",))
            wrapper = root / "tooling" / "beads" / "bd.sh"
            wrapper.parent.mkdir(parents=True)
            wrapper.write_text("#!/bin/sh\n", encoding="utf-8")
            self.assertEqual(adapter.resolve_provider(root), (str(wrapper),))

    def test_detail_returns_full_text_only_for_selected_bead(self) -> None:
        adapter = load_adapter()
        with tempfile.TemporaryDirectory() as temporary:
            repo = self.make_repo(Path(temporary))
            provider = FakeProvider([[
                {"id": "a", "title": "Implement A", "description": "full selected description", "acceptance_criteria": "full selected acceptance", "status": "open", "priority": 1, "dependencies": []}
            ]])
            with patch.object(adapter, "run_provider", provider):
                result = adapter.detail(repo, "a")

        self.assertEqual(result.kind, "detail")
        self.assertEqual(result.details, {"id": "a", "title": "Implement A", "description": "full selected description", "acceptance_criteria": "full selected acceptance", "status": "open"})
        self.assertEqual(provider.calls[0][1], ("show", "a", "--json"))

    def test_finalize_pass_uses_nonleasing_update_and_rereads_status(self) -> None:
        adapter = load_adapter()
        with tempfile.TemporaryDirectory() as temporary:
            repo = self.make_repo(Path(temporary))
            evidence = repo / "reports" / "a.md"
            evidence.parent.mkdir()
            evidence.write_text("evidence", encoding="utf-8")
            provider = FakeProvider([{}, [{"id": "a", "title": "Implement A", "status": "closed", "priority": 1, "dependencies": []}]])
            with patch.object(adapter, "run_provider", provider):
                result = adapter.finalize(repo, "a", "pass", evidence)

        self.assertEqual(result.kind, "finalized")
        self.assertEqual(provider.calls[0][1], ("update", "a", "--status", "closed", "--append-notes", "PASS evidence=reports/a.md", "--json"))
        self.assertNotIn("--claim", provider.calls[0][1])
        self.assertEqual(provider.calls[1][1], ("show", "a", "--json"))

    def test_finalize_rejects_outside_or_symlinked_evidence(self) -> None:
        adapter = load_adapter()
        with tempfile.TemporaryDirectory() as temporary, tempfile.TemporaryDirectory() as outside_temporary:
            repo = self.make_repo(Path(temporary))
            outside = Path(outside_temporary) / "evidence.md"
            outside.write_text("evidence", encoding="utf-8")
            link = repo / "link.md"
            link.symlink_to(outside)
            self.assertEqual(adapter.finalize(repo, "a", "pass", outside).kind, "invalid_evidence")
            self.assertEqual(adapter.finalize(repo, "a", "pass", link).kind, "invalid_evidence")


if __name__ == "__main__":
    unittest.main()
