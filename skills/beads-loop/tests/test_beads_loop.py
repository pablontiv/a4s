from __future__ import annotations

import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import ModuleType
from unittest.mock import patch


SKILL_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = SKILL_ROOT / "scripts" / "beads_loop.py"


def load_adapter() -> ModuleType:
    if not SCRIPT.is_file():
        raise AssertionError(f"adapter does not exist: {SCRIPT}")
    spec = importlib.util.spec_from_file_location("beads_loop", SCRIPT)
    if spec is None or spec.loader is None:
        raise AssertionError(f"cannot load adapter: {SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def completed(
    args: tuple[str, ...],
    *,
    returncode: int = 0,
    stdout: str = "",
    stderr: str = "",
) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(["bd", *args], returncode, stdout, stderr)


def stdout_json(payload: object) -> dict[str, object]:
    return {"stdout": json.dumps(payload)}


def stderr_json(payload: object) -> dict[str, object]:
    return {"stderr": json.dumps(payload)}


class FakeBd:
    def __init__(self) -> None:
        self.calls: list[tuple[Path, tuple[str, ...]]] = []
        self._replies: list[tuple[tuple[str, ...], subprocess.CompletedProcess[str]]] = []

    def reply(self, args: list[str], *, returncode: int = 0, stdout: str = "", stderr: str = "") -> None:
        command = tuple(args)
        self._replies.append(
            (command, completed(command, returncode=returncode, stdout=stdout, stderr=stderr))
        )

    def __call__(self, cwd: Path, args: list[str] | tuple[str, ...]) -> subprocess.CompletedProcess[str]:
        command = tuple(args)
        self.calls.append((cwd, command))
        if not self._replies:
            raise AssertionError(f"unexpected bd call: {command}")
        expected, result = self._replies.pop(0)
        if command != expected:
            raise AssertionError(f"expected bd {expected}, got {command}")
        return result

    def assert_drained(self) -> None:
        if self._replies:
            raise AssertionError(f"unused bd replies: {[args for args, _ in self._replies]}")


class BeadsLoopTests(unittest.TestCase):
    def make_repo(self, root: Path) -> Path:
        subprocess.run(["git", "init", "-q", str(root)], check=True)
        (root / ".beads").mkdir()
        return root

    def test_prime_rejects_non_beads_directory_without_bd_subprocess(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        with tempfile.TemporaryDirectory() as td, patch.object(adapter, "run_bd", side_effect=fake):
            result = adapter.prime(Path(td))
        self.assertEqual(result.kind, "not_beads_repo")
        self.assertEqual(fake.calls, [])

    def test_prime_uses_conventions_for_embedded_unsupported(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        fake.reply(
            ["doctor", "--agent", "--json"],
            returncode=1,
            **stderr_json({"code": "embedded_unsupported"}),
        )
        fake.reply(
            ["doctor", "--check", "conventions", "--agent", "--json"],
            **stdout_json({"status": "ok"}),
        )
        fake.reply(["prime", "--no-memories"], stdout="discard me")
        fake.reply(["ready", "--sort", "priority", "--json"], **stdout_json([]))

        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            with patch.object(adapter, "run_bd", side_effect=fake):
                result = adapter.prime(repo)

        self.assertEqual(result.kind, "no_ready")
        fake.assert_drained()

    def test_prime_does_not_fallback_for_other_doctor_failure(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        fake.reply(
            ["doctor", "--agent", "--json"],
            returncode=1,
            **stderr_json({"code": "database_unavailable"}),
        )

        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            with patch.object(adapter, "run_bd", side_effect=fake):
                result = adapter.prime(repo)

        self.assertEqual(result.kind, "doctor_failed")
        self.assertEqual([args for _, args in fake.calls], [("doctor", "--agent", "--json")])
        fake.assert_drained()

    def test_prime_returns_doctor_failed_when_bd_is_unavailable(self) -> None:
        adapter = load_adapter()

        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            with patch.object(adapter, "run_bd", side_effect=FileNotFoundError("bd")):
                try:
                    result = adapter.prime(repo)
                except OSError as exc:
                    self.fail(f"prime leaked provider error: {exc}")

        self.assertEqual(result.kind, "doctor_failed")

    def test_prime_rejects_ambiguous_doctor_json(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        fake.reply(
            ["doctor", "--agent", "--json"],
            stdout=json.dumps({"status": "ok"}),
            stderr=json.dumps({"code": "embedded_unsupported"}),
        )

        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            with patch.object(adapter, "run_bd", side_effect=fake):
                result = adapter.prime(repo)

        self.assertEqual(result.kind, "doctor_failed")
        fake.assert_drained()

    def test_prime_rejects_unexpected_doctor_json(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        fake.reply(["doctor", "--agent", "--json"], **stdout_json({"surprise": True}))
        fake.reply(["prime", "--no-memories"], stdout="must not run")
        fake.reply(["ready", "--sort", "priority", "--json"], **stdout_json([]))

        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            with patch.object(adapter, "run_bd", side_effect=fake):
                result = adapter.prime(repo)

        self.assertEqual(result.kind, "doctor_failed")
        self.assertEqual([args for _, args in fake.calls], [("doctor", "--agent", "--json")])

    def test_prime_discards_text_containing_bd_remember(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        fake.reply(["doctor", "--agent", "--json"], **stdout_json({"status": "ok"}))
        fake.reply(["prime", "--no-memories"], stdout="use bd remember secret")
        fake.reply(
            ["ready", "--sort", "priority", "--json"],
            **stdout_json([{"id": "b-1", "title": "work"}]),
        )

        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            with patch.object(adapter, "run_bd", side_effect=fake):
                result = adapter.prime(repo)

        self.assertEqual(result.kind, "ready")
        self.assertNotIn("remember", json.dumps(result.details).lower())
        self.assertEqual(result.details["issues"], [{"id": "b-1", "title": "work"}])
        fake.assert_drained()

    def test_prime_classifies_empty_ready_list(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        fake.reply(["doctor", "--agent", "--json"], **stdout_json({"status": "ok"}))
        fake.reply(["prime", "--no-memories"], stdout="ignored")
        fake.reply(["ready", "--sort", "priority", "--json"], **stdout_json([]))

        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            with patch.object(adapter, "run_bd", side_effect=fake):
                result = adapter.prime(repo)

        self.assertEqual(result.kind, "no_ready")
        self.assertEqual(result.details, {"issues": []})
        fake.assert_drained()

    def test_prime_blocks_on_ready_item_without_id(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        fake.reply(["doctor", "--agent", "--json"], **stdout_json({"status": "ok"}))
        fake.reply(["prime", "--no-memories"], stdout="ignored")
        fake.reply(
            ["ready", "--sort", "priority", "--json"],
            **stdout_json([{"title": "missing id"}]),
        )

        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            with patch.object(adapter, "run_bd", side_effect=fake):
                result = adapter.prime(repo)

        self.assertEqual(result.kind, "blocked")
        fake.assert_drained()

    def test_prime_blocks_on_malformed_ready_json_without_leaking_output(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        fake.reply(["doctor", "--agent", "--json"], **stdout_json({"status": "ok"}))
        fake.reply(["prime", "--no-memories"], stdout="ignored")
        fake.reply(["ready", "--sort", "priority", "--json"], stdout="not-json secret")

        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            with patch.object(adapter, "run_bd", side_effect=fake):
                result = adapter.prime(repo)

        self.assertEqual(result.kind, "blocked")
        self.assertNotIn("secret", json.dumps(result.details))
        fake.assert_drained()

    def test_main_serializes_one_versioned_json_envelope(self) -> None:
        adapter = load_adapter()
        self.assertTrue(hasattr(adapter, "main"), "adapter main is missing")
        stdout = io.StringIO()
        envelope = adapter.Envelope("no_ready", {"issues": []})

        with patch.object(adapter, "prime", return_value=envelope), redirect_stdout(stdout):
            code = adapter.main(["prime"])

        self.assertEqual(code, 0)
        self.assertEqual(
            json.loads(stdout.getvalue()),
            {"schema_version": 1, "kind": "no_ready", "details": {"issues": []}},
        )
        self.assertEqual(len(stdout.getvalue().splitlines()), 1)


if __name__ == "__main__":
    unittest.main()
