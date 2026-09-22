from __future__ import annotations

import importlib.util
import io
import json
import os
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

    def make_real_repo(self, root: Path) -> Path:
        subprocess.run(["git", "init", "-q", str(root)], check=True)
        subprocess.run(
            ["git", "-C", str(root), "config", "user.name", "race-worker"], check=True
        )
        subprocess.run(
            ["git", "-C", str(root), "config", "user.email", "race@example.test"],
            check=True,
        )
        subprocess.run(
            [
                "bd",
                "init",
                "--non-interactive",
                "--skip-agents",
                "--skip-hooks",
                "--prefix",
                "tst",
            ],
            cwd=root,
            text=True,
            capture_output=True,
            check=True,
            timeout=60,
        )
        return root

    def create_real_bead(self, repo: Path, title: str) -> str:
        result = subprocess.run(
            ["bd", "create", title, "--priority", "1", "--silent"],
            cwd=repo,
            text=True,
            capture_output=True,
            check=True,
            timeout=60,
        )
        return result.stdout.strip()

    def run_real_adapter(self, repo: Path, args: list[str]) -> dict[str, object]:
        environment = os.environ.copy()
        environment["BEADS_ACTOR"] = "race-worker"
        result = subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            cwd=repo,
            env=environment,
            text=True,
            capture_output=True,
            check=False,
            timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        return json.loads(result.stdout)

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

    def test_claim_uses_atomic_selection_instead_of_prime_advisory_id(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        fake.reply(
            ["ready", "--sort", "priority", "--claim", "--json"],
            **stdout_json([{"id": "b-selected"}]),
        )
        fake.reply(
            ["show", "b-selected", "--json"],
            **stdout_json(
                [{"id": "b-selected", "status": "in_progress", "assignee": "worker"}]
            ),
        )
        gate = adapter.Envelope("ready", {"issues": [{"id": "b-advisory"}]})

        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            with (
                patch.object(adapter, "prime", return_value=gate),
                patch.object(adapter, "run_bd", side_effect=fake),
                patch.dict(os.environ, {"BEADS_ACTOR": "worker"}),
            ):
                result = adapter.claim(repo)

        self.assertEqual(result.kind, "claimed")
        self.assertEqual(result.details["issue"]["id"], "b-selected")
        fake.assert_drained()

    def test_claim_refuses_post_claim_assignee_mismatch(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        fake.reply(
            ["ready", "--sort", "priority", "--claim", "--json"],
            **stdout_json([{"id": "b-1"}]),
        )
        fake.reply(
            ["show", "b-1", "--json"],
            **stdout_json(
                [{"id": "b-1", "status": "in_progress", "assignee": "other"}]
            ),
        )

        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            with (
                patch.object(
                    adapter,
                    "prime",
                    return_value=adapter.Envelope("ready", {"issues": [{"id": "b-1"}]}),
                ),
                patch.object(adapter, "run_bd", side_effect=fake),
                patch.dict(os.environ, {"BEADS_ACTOR": "worker"}),
            ):
                result = adapter.claim(repo)

        self.assertEqual(result.kind, "claim_lost")
        fake.assert_drained()

    def test_claim_returns_no_ready_when_atomic_claim_loses_race(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        fake.reply(
            ["ready", "--sort", "priority", "--claim", "--json"],
            **stdout_json([]),
        )

        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            with (
                patch.object(
                    adapter,
                    "prime",
                    return_value=adapter.Envelope("ready", {"issues": [{"id": "b-1"}]}),
                ),
                patch.object(adapter, "run_bd", side_effect=fake),
            ):
                result = adapter.claim(repo)

        self.assertEqual(result.kind, "no_ready")
        self.assertEqual(result.details, {"issues": []})
        fake.assert_drained()

    def test_claim_stops_when_prime_gate_fails(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()

        with patch.object(
            adapter, "prime", return_value=adapter.Envelope("doctor_failed", {})
        ), patch.object(adapter, "run_bd", side_effect=fake):
            result = adapter.claim(Path("unused"))

        self.assertEqual(result.kind, "doctor_failed")
        self.assertEqual(fake.calls, [])

    def test_finalize_rejects_outside_repo_evidence(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()

        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            repo = self.make_repo(base / "repo")
            outside_file = base / "outside.txt"
            outside_file.write_text("proof", encoding="utf-8")
            with patch.object(adapter, "run_bd", side_effect=fake):
                result = adapter.finalize(repo, "b-1", "pass", outside_file)

        self.assertEqual(result.kind, "invalid_evidence")
        self.assertEqual(fake.calls, [])

    def test_finalize_rejects_missing_evidence_without_mutation(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()

        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            with patch.object(adapter, "run_bd", side_effect=fake):
                result = adapter.finalize(repo, "b-1", "pass", repo / "missing.txt")

        self.assertEqual(result.kind, "invalid_evidence")
        self.assertEqual(fake.calls, [])

    def test_finalize_rejects_symlinked_evidence_without_mutation(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()

        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            target = repo / "proof.txt"
            target.write_text("proof", encoding="utf-8")
            link = repo / "proof-link.txt"
            link.symlink_to(target)
            with patch.object(adapter, "run_bd", side_effect=fake):
                result = adapter.finalize(repo, "b-1", "fail", link)

        self.assertEqual(result.kind, "invalid_evidence")
        self.assertEqual(fake.calls, [])

    def test_finalize_pass_closes_exact_id_with_repository_relative_evidence(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        fake.reply(["close", "b-1", "--reason", "evidence=reports/pass.txt"])
        fake.reply(
            ["show", "b-1", "--json"],
            **stdout_json([{"id": "b-1", "status": "closed"}]),
        )

        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            evidence = repo / "reports" / "pass.txt"
            evidence.parent.mkdir()
            evidence.write_text("proof", encoding="utf-8")
            with patch.object(adapter, "run_bd", side_effect=fake):
                result = adapter.finalize(repo, "b-1", "pass", evidence)

        self.assertEqual(result.kind, "finalized")
        self.assertEqual(result.details["issue"], {"id": "b-1", "status": "closed"})
        fake.assert_drained()

    def test_finalize_fail_blocks_exact_id_and_appends_evidence(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        fake.reply(
            [
                "update",
                "b-2",
                "--status",
                "blocked",
                "--append-notes",
                "FAIL evidence=reports/fail.txt",
            ]
        )
        fake.reply(
            ["show", "b-2", "--json"],
            **stdout_json([{"id": "b-2", "status": "blocked"}]),
        )

        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            evidence = repo / "reports" / "fail.txt"
            evidence.parent.mkdir()
            evidence.write_text("failure", encoding="utf-8")
            with patch.object(adapter, "run_bd", side_effect=fake):
                result = adapter.finalize(repo, "b-2", "fail", evidence)

        self.assertEqual(result.kind, "finalized")
        self.assertEqual(result.details["issue"], {"id": "b-2", "status": "blocked"})
        fake.assert_drained()

    def test_finalize_rejects_empty_bead_id_before_mutation(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()

        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            evidence = repo / "proof.txt"
            evidence.write_text("proof", encoding="utf-8")
            with patch.object(adapter, "run_bd", side_effect=fake):
                result = adapter.finalize(repo, "", "pass", evidence)

        self.assertEqual(result.kind, "blocked")
        self.assertEqual(result.details, {"reason": "invalid_bead_id"})
        self.assertEqual(fake.calls, [])

    def test_finalize_blocks_when_read_back_status_does_not_match_verdict(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        fake.reply(["close", "b-1", "--reason", "evidence=proof.txt"])
        fake.reply(
            ["show", "b-1", "--json"],
            **stdout_json([{"id": "b-1", "status": "in_progress"}]),
        )

        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            evidence = repo / "proof.txt"
            evidence.write_text("proof", encoding="utf-8")
            with patch.object(adapter, "run_bd", side_effect=fake):
                result = adapter.finalize(repo, "b-1", "pass", evidence)

        self.assertEqual(result.kind, "blocked")
        self.assertEqual(result.details, {"reason": "final_state_mismatch"})
        fake.assert_drained()

    def test_two_process_claim_race_has_one_winner(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo = self.make_real_repo(Path(td))
            expected_id = self.create_real_bead(repo, "only ready work")
            environment = os.environ.copy()
            environment["BEADS_ACTOR"] = "race-worker"
            command = [sys.executable, str(SCRIPT), "claim"]
            processes = [
                subprocess.Popen(
                    command,
                    cwd=repo,
                    env=environment,
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
                for _ in range(2)
            ]
            results: list[dict[str, object]] = []
            for process in processes:
                stdout, stderr = process.communicate(timeout=120)
                self.assertEqual(process.returncode, 0, stderr)
                self.assertEqual(stderr, "")
                results.append(json.loads(stdout))

        self.assertEqual(sorted(result["kind"] for result in results), ["claimed", "no_ready"])
        winner = next(result for result in results if result["kind"] == "claimed")
        self.assertEqual(winner["details"]["issue"]["id"], expected_id)

    def test_real_finalize_maps_pass_and_fail(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo = self.make_real_repo(Path(td))
            reports = repo / "reports"
            reports.mkdir()

            pass_id = self.create_real_bead(repo, "passing work")
            claimed_pass = self.run_real_adapter(repo, ["claim"])
            self.assertEqual(claimed_pass["details"]["issue"]["id"], pass_id)
            (reports / "pass.txt").write_text("all checks passed", encoding="utf-8")
            finalized_pass = self.run_real_adapter(
                repo,
                [
                    "finalize",
                    "--bead",
                    pass_id,
                    "--verdict",
                    "pass",
                    "--evidence",
                    "reports/pass.txt",
                ],
            )
            self.assertEqual(finalized_pass["kind"], "finalized")
            shown_pass = json.loads(
                subprocess.run(
                    ["bd", "show", pass_id, "--json"],
                    cwd=repo,
                    text=True,
                    capture_output=True,
                    check=True,
                    timeout=60,
                ).stdout
            )[0]

            fail_id = self.create_real_bead(repo, "failing work")
            claimed_fail = self.run_real_adapter(repo, ["claim"])
            self.assertEqual(claimed_fail["details"]["issue"]["id"], fail_id)
            (reports / "fail.txt").write_text("validation failed", encoding="utf-8")
            finalized_fail = self.run_real_adapter(
                repo,
                [
                    "finalize",
                    "--bead",
                    fail_id,
                    "--verdict",
                    "fail",
                    "--evidence",
                    "reports/fail.txt",
                ],
            )
            self.assertEqual(finalized_fail["kind"], "finalized")
            shown_fail = json.loads(
                subprocess.run(
                    ["bd", "show", fail_id, "--json"],
                    cwd=repo,
                    text=True,
                    capture_output=True,
                    check=True,
                    timeout=60,
                ).stdout
            )[0]
            ready_after = json.loads(
                subprocess.run(
                    ["bd", "ready", "--sort", "priority", "--json"],
                    cwd=repo,
                    text=True,
                    capture_output=True,
                    check=True,
                    timeout=60,
                ).stdout
            )

        self.assertEqual(shown_pass["status"], "closed")
        self.assertEqual(shown_pass["close_reason"], "evidence=reports/pass.txt")
        self.assertEqual(shown_fail["status"], "blocked")
        self.assertIn("FAIL evidence=reports/fail.txt", shown_fail["notes"])
        self.assertEqual(ready_after, [])

    def test_main_dispatches_claim_and_serializes_envelope(self) -> None:
        adapter = load_adapter()
        stdout = io.StringIO()
        envelope = adapter.Envelope("claimed", {"issue": {"id": "b-1"}})

        with patch.object(adapter, "claim", return_value=envelope), redirect_stdout(stdout):
            code = adapter.main(["claim"])

        self.assertEqual(code, 0)
        self.assertEqual(
            json.loads(stdout.getvalue()),
            {
                "schema_version": 1,
                "kind": "claimed",
                "details": {"issue": {"id": "b-1"}},
            },
        )

    def test_main_dispatches_finalize_arguments_and_serializes_envelope(self) -> None:
        adapter = load_adapter()
        stdout = io.StringIO()
        envelope = adapter.Envelope("finalized", {"issue": {"id": "b-1"}})

        with (
            patch.object(adapter, "finalize", return_value=envelope) as finalize_call,
            redirect_stdout(stdout),
        ):
            code = adapter.main(
                [
                    "finalize",
                    "--bead",
                    "b-1",
                    "--verdict",
                    "pass",
                    "--evidence",
                    "reports/pass.txt",
                ]
            )

        self.assertEqual(code, 0)
        finalize_call.assert_called_once_with(
            Path.cwd(), "b-1", "pass", Path("reports/pass.txt")
        )
        self.assertEqual(json.loads(stdout.getvalue())["kind"], "finalized")

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
