from __future__ import annotations

import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import ModuleType
from unittest.mock import patch


SKILL_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = SKILL_ROOT / "scripts" / "beads_loop.py"
SKILL = SKILL_ROOT / "SKILL.md"
README = SKILL_ROOT.parents[1] / "README.md"


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

    def create_real_bead(
        self,
        repo: Path,
        title: str,
        *,
        priority: int = 1,
        description: str | None = None,
        acceptance: str | None = None,
    ) -> str:
        command = ["bd", "create", title, "--priority", str(priority), "--silent"]
        if description is not None:
            command.extend(["--description", description])
        if acceptance is not None:
            command.extend(["--acceptance", acceptance])
        result = subprocess.run(
            command,
            cwd=repo,
            text=True,
            capture_output=True,
            check=True,
            timeout=60,
        )
        return result.stdout.strip()

    def run_real_bd_json(self, repo: Path, args: list[str]) -> object:
        result = subprocess.run(
            ["bd", *args],
            cwd=repo,
            text=True,
            capture_output=True,
            check=True,
            timeout=60,
        )
        return json.loads(result.stdout)

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

    def run_scripted_loop(self, repo: Path) -> dict[str, object]:
        claimed_ids: list[str] = []
        observed_acceptance: list[str] = []
        reports = repo / "reports" / "beads-loop"
        reports.mkdir(parents=True)

        while True:
            gate = self.run_real_adapter(repo, ["prime"])
            if gate["kind"] != "ready":
                return {
                    "terminal": gate["kind"],
                    "terminal_envelope": gate,
                    "claimed_ids": claimed_ids,
                    "acceptance": observed_acceptance,
                }

            claimed = self.run_real_adapter(repo, ["claim"])
            self.assertEqual(claimed["kind"], "claimed", claimed)
            issue = claimed["details"]["issue"]
            self.assertIsInstance(issue["description"], str)
            self.assertIsInstance(issue["acceptance_criteria"], str)
            bead_id = issue["id"]
            claimed_ids.append(bead_id)
            observed_acceptance.append(issue["acceptance_criteria"])

            evidence = reports / f"iteration-{len(claimed_ids)}.md"
            evidence.write_text(
                "\n".join(
                    (
                        f"# Evidence for {bead_id}",
                        "",
                        f"Acceptance: {issue['acceptance_criteria']}",
                        "Validation: git diff --check passed.",
                        "",
                    )
                ),
                encoding="utf-8",
            )
            validation = subprocess.run(
                ["git", "diff", "--check"],
                cwd=repo,
                text=True,
                capture_output=True,
                check=False,
                timeout=60,
            )
            self.assertEqual(validation.returncode, 0, validation.stderr)

            finalized = self.run_real_adapter(
                repo,
                [
                    "finalize",
                    "--bead",
                    bead_id,
                    "--verdict",
                    "pass",
                    "--evidence",
                    evidence.relative_to(repo).as_posix(),
                ],
            )
            self.assertEqual(finalized["kind"], "finalized", finalized)
            self.assertEqual(finalized["details"]["issue"]["id"], bead_id)
            self.assertEqual(finalized["details"]["issue"]["status"], "closed")

    def test_skill_documents_absolute_adapter_current_repository_loop(self) -> None:
        text = SKILL.read_text(encoding="utf-8")
        required_in_order = (
            "current Git repository",
            "absolute path",
            'python3 "$BEADS_LOOP_ADAPTER" prime',
            'python3 "$BEADS_LOOP_ADAPTER" claim',
            "description and acceptance criteria",
            "in-repository evidence report",
            "applicable validation",
            'python3 "$BEADS_LOOP_ADAPTER" finalize --bead "$BEAD_ID" --verdict pass --evidence "$EVIDENCE_PATH"',
            'python3 "$BEADS_LOOP_ADAPTER" finalize --bead "$BEAD_ID" --verdict fail --evidence "$EVIDENCE_PATH"',
            "Repeat from `prime`",
        )
        position = -1
        for phrase in required_in_order:
            found = text.find(phrase)
            self.assertGreater(found, position, phrase)
            position = found
        self.assertNotIn("python3 scripts/beads_loop.py", text)
        self.assertEqual(text.count('python3 "$BEADS_LOOP_ADAPTER"'), 4)
        for terminal in (
            "no_ready",
            "not_beads_repo",
            "doctor_failed",
            "claim_lost",
            "blocked",
            "invalid_evidence",
        ):
            self.assertIn(f"`{terminal}`", text)

    def test_documented_absolute_adapter_command_runs_from_target_repo(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo = self.make_real_repo(Path(td))
            environment = os.environ.copy()
            environment["BEADS_ACTOR"] = "race-worker"
            environment["BEADS_LOOP_ADAPTER"] = str(SCRIPT.resolve(strict=True))
            result = subprocess.run(
                ["/bin/sh", "-c", 'python3 "$BEADS_LOOP_ADAPTER" prime'],
                cwd=repo,
                env=environment,
                text=True,
                capture_output=True,
                check=False,
                timeout=120,
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertEqual(json.loads(result.stdout)["kind"], "no_ready")

    def test_skill_never_documents_bd_memories_or_global_selection(self) -> None:
        text = SKILL.read_text(encoding="utf-8")
        self.assertNotIn("bd remember", text)
        self.assertNotIn("bd memories", text)
        self.assertNotIn("--global", text)
        self.assertNotIn("--claim-next", text)
        self.assertNotIn("--continue", text)
        self.assertNotIn("--repo", text)

    def test_skill_has_no_direct_provider_sibling_or_deployment_commands(self) -> None:
        text = SKILL.read_text(encoding="utf-8")
        self.assertNotRegex(text, r"(?m)^\s*bd(?:\s|$)")
        for forbidden in (
            "Rootline",
            "Herdr",
            "../",
            "ln -s",
            "install",
            "deploy",
            "queue",
            "daemon",
            "scheduler",
            "state store",
        ):
            self.assertNotIn(forbidden, text)
        self.assertIn("accepts no arguments", text)
        self.assertIn("Resolve `scripts/beads_loop.py` relative to this skill directory", text)

    def test_readme_publishes_beads_loop(self) -> None:
        text = README.read_text(encoding="utf-8")
        self.assertIn("[Beads autonomous loop](skills/beads-loop/)", text)

    def test_headless_loop_fixture_ends_after_no_ready(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo = self.make_real_repo(Path(td))
            ready_later = self.create_real_bead(
                repo,
                "lower-priority ready work",
                priority=2,
                description="Complete the lower-priority fixture work.",
                acceptance="The lower-priority fixture check passes.",
            )
            ready_first = self.create_real_bead(
                repo,
                "highest-priority ready work",
                priority=0,
                description="Complete the highest-priority fixture work.",
                acceptance="The highest-priority fixture check passes.",
            )
            blocked_id = self.create_real_bead(repo, "already blocked work")
            subprocess.run(
                ["bd", "update", blocked_id, "--status", "blocked"],
                cwd=repo,
                text=True,
                capture_output=True,
                check=True,
                timeout=60,
            )
            closed_id = self.create_real_bead(repo, "already closed work")
            subprocess.run(
                ["bd", "close", closed_id, "--reason", "fixture setup"],
                cwd=repo,
                text=True,
                capture_output=True,
                check=True,
                timeout=60,
            )

            ready_before = self.run_real_bd_json(repo, ["ready", "--sort", "priority", "--json"])
            expected_cli_order = [issue["id"] for issue in ready_before]
            result = self.run_scripted_loop(repo)
            blocked_after = self.run_real_bd_json(repo, ["show", blocked_id, "--json"])[0]
            closed_after = self.run_real_bd_json(repo, ["show", closed_id, "--json"])[0]

        self.assertEqual(expected_cli_order, [ready_first, ready_later])
        self.assertEqual(result["terminal"], "no_ready")
        self.assertEqual(result["claimed_ids"], expected_cli_order)
        self.assertEqual(
            result["acceptance"],
            [
                "The highest-priority fixture check passes.",
                "The lower-priority fixture check passes.",
            ],
        )
        self.assertEqual(blocked_after["status"], "blocked")
        self.assertEqual(closed_after["status"], "closed")

    def test_prime_rejects_non_beads_directory_without_bd_subprocess(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        with tempfile.TemporaryDirectory() as td, patch.object(adapter, "run_bd", side_effect=fake):
            result = adapter.prime(Path(td))
        self.assertEqual(result.kind, "not_beads_repo")
        self.assertEqual(fake.calls, [])

    def test_prime_cli_emits_one_not_beads_repo_envelope_when_git_is_unavailable(self) -> None:
        adapter = load_adapter()
        bd_calls: list[tuple[object, ...]] = []

        def unavailable_git(argv: object, *args: object, **kwargs: object) -> object:
            if isinstance(argv, (list, tuple)) and argv and argv[0] == "git":
                raise OSError("git unavailable")
            bd_calls.append(tuple(argv) if isinstance(argv, (list, tuple)) else (argv,))
            raise AssertionError(f"unexpected subprocess invocation: {argv!r}")

        output = io.StringIO()
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            with (
                patch.object(adapter.Path, "cwd", return_value=repo),
                patch.object(adapter.subprocess, "run", side_effect=unavailable_git),
                redirect_stdout(output),
            ):
                exit_code = adapter.main(["prime"])

        self.assertEqual(exit_code, 0)
        self.assertEqual(output.getvalue().splitlines(), [
            '{"details":{},"kind":"not_beads_repo","schema_version":1}'
        ])
        self.assertEqual(bd_calls, [])

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

    def test_prime_accepts_generic_doctor_with_diagnostics_and_overall_ok_true(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        fake.reply(
            ["doctor", "--agent", "--json"],
            **stdout_json({"diagnostics": [], "overall_ok": True, "schema_version": 1}),
        )
        fake.reply(["prime", "--no-memories"], stdout="discard me")
        fake.reply(["ready", "--sort", "priority", "--json"], **stdout_json([]))

        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            with patch.object(adapter, "run_bd", side_effect=fake):
                result = adapter.prime(repo)

        self.assertEqual(result.kind, "no_ready")
        self.assertEqual(
            [args for _, args in fake.calls],
            [
                ("doctor", "--agent", "--json"),
                ("prime", "--no-memories"),
                ("ready", "--sort", "priority", "--json"),
            ],
        )
        fake.assert_drained()

    def test_prime_rejects_generic_doctor_with_overall_ok_false(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        fake.reply(
            ["doctor", "--agent", "--json"],
            **stdout_json({"checks": [], "overall_ok": False}),
        )
        fake.reply(["prime", "--no-memories"], stdout="must not run")
        fake.reply(["ready", "--sort", "priority", "--json"], **stdout_json([]))

        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            with patch.object(adapter, "run_bd", side_effect=fake):
                result = adapter.prime(repo)

        self.assertEqual(result.kind, "doctor_failed")
        self.assertEqual([args for _, args in fake.calls], [("doctor", "--agent", "--json")])

    def test_prime_rejects_conventions_doctor_with_overall_ok_false(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        fake.reply(
            ["doctor", "--agent", "--json"],
            returncode=1,
            **stderr_json({"code": "embedded_unsupported"}),
        )
        fake.reply(
            ["doctor", "--check", "conventions", "--agent", "--json"],
            **stdout_json({"checks": [], "overall_ok": False}),
        )
        fake.reply(["prime", "--no-memories"], stdout="must not run")
        fake.reply(["ready", "--sort", "priority", "--json"], **stdout_json([]))

        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            with patch.object(adapter, "run_bd", side_effect=fake):
                result = adapter.prime(repo)

        self.assertEqual(result.kind, "doctor_failed")
        self.assertEqual(
            [args for _, args in fake.calls],
            [
                ("doctor", "--agent", "--json"),
                ("doctor", "--check", "conventions", "--agent", "--json"),
            ],
        )

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

    def test_finalize_pass_conditionally_closes_owned_id_with_evidence(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        owned = {"id": "b-1", "status": "in_progress", "assignee": "worker"}
        closed = {"id": "b-1", "status": "closed", "assignee": "worker"}
        fake.reply(["show", "b-1", "--json"], **stdout_json([owned]))
        fake.reply(
            [
                "update",
                "b-1",
                "--status",
                "closed",
                "--if-assignee",
                "worker",
                "--if-status",
                "in_progress",
                "--append-notes",
                "PASS evidence=reports/pass.txt",
            ]
        )
        fake.reply(["show", "b-1", "--json"], **stdout_json([closed]))

        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            evidence = repo / "reports" / "pass.txt"
            evidence.parent.mkdir()
            evidence.write_text("proof", encoding="utf-8")
            with (
                patch.object(adapter, "run_bd", side_effect=fake),
                patch.dict(os.environ, {"BEADS_ACTOR": "worker"}),
            ):
                result = adapter.finalize(repo, "b-1", "pass", evidence)

        self.assertEqual(result.kind, "finalized")
        self.assertEqual(result.details["issue"], closed)
        fake.assert_drained()

    def test_finalize_resolves_repository_relative_evidence_from_nested_cwd(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        owned = {"id": "b-1", "status": "in_progress", "assignee": "worker"}
        closed = {"id": "b-1", "status": "closed", "assignee": "worker"}
        fake.reply(["show", "b-1", "--json"], **stdout_json([owned]))
        fake.reply(
            [
                "update",
                "b-1",
                "--status",
                "closed",
                "--if-assignee",
                "worker",
                "--if-status",
                "in_progress",
                "--append-notes",
                "PASS evidence=reports/evidence.md",
            ]
        )
        fake.reply(["show", "b-1", "--json"], **stdout_json([closed]))

        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            nested = repo / "nested"
            nested.mkdir()
            evidence = repo / "reports" / "evidence.md"
            evidence.parent.mkdir()
            evidence.write_text("proof", encoding="utf-8")
            with (
                patch.object(adapter, "run_bd", side_effect=fake),
                patch.dict(os.environ, {"BEADS_ACTOR": "worker"}),
            ):
                result = adapter.finalize(
                    nested, "b-1", "pass", Path("reports/evidence.md")
                )

        self.assertEqual(result.kind, "finalized")
        self.assertEqual(result.details["evidence"], "reports/evidence.md")
        fake.assert_drained()

    def test_finalize_fail_conditionally_blocks_owned_id_and_appends_evidence(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        owned = {"id": "b-2", "status": "in_progress", "assignee": "worker"}
        blocked = {"id": "b-2", "status": "blocked", "assignee": "worker"}
        fake.reply(["show", "b-2", "--json"], **stdout_json([owned]))
        fake.reply(
            [
                "update",
                "b-2",
                "--status",
                "blocked",
                "--if-assignee",
                "worker",
                "--if-status",
                "in_progress",
                "--append-notes",
                "FAIL evidence=reports/fail.txt",
            ]
        )
        fake.reply(["show", "b-2", "--json"], **stdout_json([blocked]))

        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            evidence = repo / "reports" / "fail.txt"
            evidence.parent.mkdir()
            evidence.write_text("failure", encoding="utf-8")
            with (
                patch.object(adapter, "run_bd", side_effect=fake),
                patch.dict(os.environ, {"BEADS_ACTOR": "worker"}),
            ):
                result = adapter.finalize(repo, "b-2", "fail", evidence)

        self.assertEqual(result.kind, "finalized")
        self.assertEqual(result.details["issue"], blocked)
        fake.assert_drained()

    def test_finalize_refuses_unresolved_actor_without_mutation(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()

        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            evidence = repo / "proof.txt"
            evidence.write_text("proof", encoding="utf-8")
            with (
                patch.object(adapter, "run_bd", side_effect=fake),
                patch.object(adapter, "_resolved_actor", return_value=None),
            ):
                result = adapter.finalize(repo, "b-1", "pass", evidence)

        self.assertEqual(result.kind, "claim_lost")
        self.assertEqual(result.details, {"reason": "actor_unresolved"})
        self.assertEqual(fake.calls, [])

    def test_finalize_refuses_assignee_mismatch_without_mutation(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        fake.reply(
            ["show", "b-1", "--json"],
            **stdout_json(
                [{"id": "b-1", "status": "in_progress", "assignee": "other"}]
            ),
        )

        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            evidence = repo / "proof.txt"
            evidence.write_text("proof", encoding="utf-8")
            with (
                patch.object(adapter, "run_bd", side_effect=fake),
                patch.dict(os.environ, {"BEADS_ACTOR": "worker"}),
            ):
                result = adapter.finalize(repo, "b-1", "pass", evidence)

        self.assertEqual(result.kind, "claim_lost")
        self.assertEqual(result.details, {"reason": "ownership_mismatch"})
        self.assertEqual([args for _, args in fake.calls], [("show", "b-1", "--json")])
        fake.assert_drained()

    def test_finalize_refuses_status_mismatch_without_mutation(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        fake.reply(
            ["show", "b-1", "--json"],
            **stdout_json([{"id": "b-1", "status": "open", "assignee": "worker"}]),
        )

        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            evidence = repo / "proof.txt"
            evidence.write_text("proof", encoding="utf-8")
            with (
                patch.object(adapter, "run_bd", side_effect=fake),
                patch.dict(os.environ, {"BEADS_ACTOR": "worker"}),
            ):
                result = adapter.finalize(repo, "b-1", "fail", evidence)

        self.assertEqual(result.kind, "claim_lost")
        self.assertEqual(result.details, {"reason": "ownership_mismatch"})
        self.assertEqual([args for _, args in fake.calls], [("show", "b-1", "--json")])
        fake.assert_drained()

    def test_finalize_maps_conditional_guard_loss_without_read_back(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        owned = {"id": "b-1", "status": "in_progress", "assignee": "worker"}
        fake.reply(["show", "b-1", "--json"], **stdout_json([owned]))
        fake.reply(
            [
                "update",
                "b-1",
                "--status",
                "closed",
                "--if-assignee",
                "worker",
                "--if-status",
                "in_progress",
                "--append-notes",
                "PASS evidence=proof.txt",
            ],
            returncode=13,
            stderr="stale guard",
        )

        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            evidence = repo / "proof.txt"
            evidence.write_text("proof", encoding="utf-8")
            with (
                patch.object(adapter, "run_bd", side_effect=fake),
                patch.dict(os.environ, {"BEADS_ACTOR": "worker"}),
            ):
                result = adapter.finalize(repo, "b-1", "pass", evidence)

        self.assertEqual(result.kind, "claim_lost")
        self.assertEqual(
            result.details, {"reason": "conditional_guard_failed", "exit_code": 13}
        )
        self.assertEqual(len(fake.calls), 2)
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

    def test_finalize_blocks_when_read_back_state_does_not_match_verdict(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        owned = {"id": "b-1", "status": "in_progress", "assignee": "worker"}
        fake.reply(["show", "b-1", "--json"], **stdout_json([owned]))
        fake.reply(
            [
                "update",
                "b-1",
                "--status",
                "closed",
                "--if-assignee",
                "worker",
                "--if-status",
                "in_progress",
                "--append-notes",
                "PASS evidence=proof.txt",
            ]
        )
        fake.reply(
            ["show", "b-1", "--json"],
            **stdout_json(
                [{"id": "b-1", "status": "closed", "assignee": "other"}]
            ),
        )

        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            evidence = repo / "proof.txt"
            evidence.write_text("proof", encoding="utf-8")
            with (
                patch.object(adapter, "run_bd", side_effect=fake),
                patch.dict(os.environ, {"BEADS_ACTOR": "worker"}),
            ):
                result = adapter.finalize(repo, "b-1", "pass", evidence)

        self.assertEqual(result.kind, "blocked")
        self.assertEqual(result.details, {"reason": "final_state_mismatch"})
        fake.assert_drained()

    def test_two_process_claim_race_has_one_winner(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo = self.make_real_repo(Path(td))
            expected_id = self.create_real_bead(
                repo,
                "only ready work",
                description="Complete the concurrency fixture work.",
                acceptance="Exactly one worker claims this Bead.",
            )
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

            pass_id = self.create_real_bead(
                repo,
                "passing work",
                description="Complete the passing finalization fixture.",
                acceptance="The Bead closes with an evidence reference.",
            )
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

            fail_id = self.create_real_bead(
                repo,
                "failing work",
                description="Complete the failing finalization fixture.",
                acceptance="A failed verdict blocks the Bead with evidence.",
            )
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
        self.assertEqual(shown_pass["assignee"], "race-worker")
        self.assertIn("PASS evidence=reports/pass.txt", shown_pass["notes"])
        self.assertEqual(shown_fail["status"], "blocked")
        self.assertEqual(shown_fail["assignee"], "race-worker")
        self.assertIn("FAIL evidence=reports/fail.txt", shown_fail["notes"])
        self.assertEqual(ready_after, [])

    def test_prime_rejects_malformed_doctor_json_without_fallback(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        fake.reply(["doctor", "--agent", "--json"], stdout="{not-json secret")
        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            with patch.object(adapter, "run_bd", side_effect=fake):
                result = adapter.prime(repo)
        self.assertEqual(result.kind, "doctor_failed")
        self.assertEqual([args for _, args in fake.calls], [("doctor", "--agent", "--json")])
        self.assertNotIn("secret", json.dumps(result.details))

    def test_prime_blocks_when_prime_command_fails(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        fake.reply(["doctor", "--agent", "--json"], **stdout_json({"status": "ok"}))
        fake.reply(["prime", "--no-memories"], returncode=7)
        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            with patch.object(adapter, "run_bd", side_effect=fake):
                result = adapter.prime(repo)
        self.assertEqual(result.kind, "blocked")
        self.assertEqual(result.details, {"reason": "prime_failed", "exit_code": 7})
        self.assertEqual(
            [args for _, args in fake.calls],
            [("doctor", "--agent", "--json"), ("prime", "--no-memories")],
        )
        fake.assert_drained()

    def test_prime_blocks_when_ready_command_is_unavailable(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        fake.reply(["doctor", "--agent", "--json"], **stdout_json({"status": "ok"}))
        fake.reply(["prime", "--no-memories"])
        ready_args = ("ready", "--sort", "priority", "--json")

        def unavailable_ready(cwd: Path, args: list[str] | tuple[str, ...]) -> subprocess.CompletedProcess[str]:
            if tuple(args) == ready_args:
                fake.calls.append((cwd, ready_args))
                raise FileNotFoundError("bd")
            return fake(cwd, args)

        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            with patch.object(adapter, "run_bd", side_effect=unavailable_ready):
                result = adapter.prime(repo)
        self.assertEqual(result.kind, "blocked")
        self.assertEqual(result.details, {"reason": "ready_failed"})
        self.assertEqual(
            [args for _, args in fake.calls],
            [
                ("doctor", "--agent", "--json"),
                ("prime", "--no-memories"),
                ready_args,
            ],
        )
        fake.assert_drained()

    def test_claim_reports_repository_changed_after_ready_gate(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            gate = adapter.Envelope("ready", {"issues": [{"id": "b-1"}]})

            def ready_gate(cwd: Path) -> adapter.Envelope:
                adapter.repository_root(cwd)
                return gate

            with (
                patch.object(adapter, "prime", side_effect=ready_gate),
                patch.object(adapter, "repository_root", side_effect=[repo, None]),
                patch.object(adapter, "run_bd", side_effect=fake),
            ):
                result = adapter.claim(repo)
        self.assertEqual(result.kind, "claim_lost")
        self.assertEqual(result.details, {"reason": "repository_changed"})
        self.assertEqual(fake.calls, [])

    def test_claim_rejects_non_list_claim_output(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        fake.reply(
            ["ready", "--sort", "priority", "--claim", "--json"],
            **stdout_json({"id": "b-1"}),
        )
        gate = adapter.Envelope("ready", {"issues": [{"id": "b-1"}]})
        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            with (
                patch.object(adapter, "prime", return_value=gate),
                patch.object(adapter, "run_bd", side_effect=fake),
            ):
                result = adapter.claim(repo)
        self.assertEqual(result.kind, "claim_lost")
        self.assertEqual(result.details, {"reason": "unexpected_claim_output"})
        self.assertEqual(
            [args for _, args in fake.calls],
            [("ready", "--sort", "priority", "--claim", "--json")],
        )
        fake.assert_drained()

    def test_claim_refuses_unresolved_actor_without_show(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        fake.reply(
            ["ready", "--sort", "priority", "--claim", "--json"],
            **stdout_json([{"id": "b-1"}]),
        )
        gate = adapter.Envelope("ready", {"issues": [{"id": "b-1"}]})
        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            with (
                patch.object(adapter, "prime", return_value=gate),
                patch.object(adapter, "run_bd", side_effect=fake),
                patch.object(adapter, "_resolved_actor", return_value=None),
            ):
                result = adapter.claim(repo)
        self.assertEqual(result.kind, "claim_lost")
        self.assertEqual(result.details, {"reason": "actor_unresolved"})
        self.assertEqual(
            [args for _, args in fake.calls],
            [("ready", "--sort", "priority", "--claim", "--json")],
        )
        fake.assert_drained()

    def test_finalize_rejects_invalid_verdict_before_provider_call(self) -> None:
        adapter = load_adapter()
        fake = FakeBd()
        with tempfile.TemporaryDirectory() as td:
            repo = self.make_repo(Path(td))
            evidence = repo / "proof.txt"
            evidence.write_text("proof", encoding="utf-8")
            with patch.object(adapter, "run_bd", side_effect=fake):
                result = adapter.finalize(repo, "b-1", "retry", evidence)
        self.assertEqual(result.kind, "blocked")
        self.assertEqual(result.details, {"reason": "invalid_verdict"})
        self.assertEqual(fake.calls, [])

    def test_main_serializes_one_envelope_for_claim_lost(self) -> None:
        adapter = load_adapter()
        stdout = io.StringIO()
        stderr = io.StringIO()
        envelope = adapter.Envelope("claim_lost", {"reason": "claim_failed"})
        with (
            patch.object(adapter, "claim", return_value=envelope),
            redirect_stdout(stdout),
            redirect_stderr(stderr),
        ):
            code = adapter.main(["claim"])
        self.assertEqual(code, 0)
        self.assertEqual(
            stdout.getvalue(),
            '{"details":{"reason":"claim_failed"},"kind":"claim_lost","schema_version":1}\n',
        )
        self.assertEqual(len(stdout.getvalue().splitlines()), 1)
        self.assertEqual(stderr.getvalue(), "")

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
