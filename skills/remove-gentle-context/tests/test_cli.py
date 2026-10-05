from __future__ import annotations

import base64
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path, PureWindowsPath
from unittest import mock


SKILL_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = SKILL_ROOT.parents[1]
SCRIPT = SKILL_ROOT / "scripts" / "cleanup.py"
FIXTURES = SKILL_ROOT / "tests" / "fixtures"
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "ci.yml"
REMOVED_MODE_ENV = "REMOVE_GENTLE_CONTEXT_" + "TEST" + "_MODE"
REMOVED_ATOMIC_ENV = "REMOVE_GENTLE_CONTEXT_" + "INJECT" + "_ATOMIC_FAIL"


def load_cleanup_module():
    spec = importlib.util.spec_from_file_location("remove_gentle_context_cleanup", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("cleanup module spec unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CliResult:
    def __init__(self, completed: subprocess.CompletedProcess[str]) -> None:
        self.returncode = completed.returncode
        self.stdout = completed.stdout
        self.stderr = completed.stderr
        try:
            self.json = json.loads(completed.stdout) if completed.stdout.strip() else {}
        except json.JSONDecodeError:
            self.json = {}
        self.output_path = Path(self.json["output_path"]) if "output_path" in self.json else None
        self.digest = self.json.get("digest")


class CliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.temp_root = Path(self.temp.name).resolve(strict=True)
        self.home = self.temp_root / "home"
        self.home.mkdir()
        self.project = self.temp_root / "project"
        self.project.mkdir()
        self.artifacts = self.temp_root / "artifacts"
        self.artifacts.mkdir()
        self.env = {
            **os.environ,
            REMOVED_MODE_ENV: "1",
            "PYTHONPATH": str(SKILL_ROOT),
            "XDG_STATE_HOME": str(self.temp_root / "state"),
        }

    def run_cli(self, *args: str, env: dict[str, str] | None = None) -> CliResult:
        completed = subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            cwd=SKILL_ROOT,
            env=self.env if env is None else env,
            text=True,
            capture_output=True,
            check=False,
        )
        return CliResult(completed)

    def run_ok(self, *args: str) -> CliResult:
        result = self.run_cli(*args)
        if result.returncode != 0:
            self.fail(f"CLI failed with {result.returncode}\nSTDOUT: {result.stdout}\nSTDERR: {result.stderr}")
        return result

    def inventory(self) -> CliResult:
        return self.run_ok(
            "inventory",
            "--home",
            str(self.home),
            "--platform",
            "linux",
            "--project-root",
            str(self.project),
            "--output",
            str(self.artifacts / "inventory.json"),
        )

    def plan(self, inventory: CliResult) -> CliResult:
        assert inventory.output_path is not None
        self.last_inventory_path = inventory.output_path
        return self.run_ok("plan", "--inventory", str(inventory.output_path), "--output", str(self.artifacts / "plan.json"))

    def apply(self, plan: CliResult, *, receipt_name: str = "receipt.json") -> CliResult:
        assert plan.output_path is not None
        assert isinstance(plan.digest, str)
        return self.run_ok("apply", "--inventory", str(self.last_inventory_path), "--plan", str(plan.output_path), "--approve", plan.digest, "--receipt", str(self.artifacts / receipt_name))

    def verify(self, receipt: CliResult, plan: CliResult | None = None) -> CliResult:
        plan_path = Path(plan.output_path) if plan is not None and plan.output_path is not None else self.artifacts / "plan.json"
        return self.run_ok("verify", "--inventory", str(self.last_inventory_path), "--plan", str(plan_path), "--receipt", str(receipt.json["receipt_path"]), "--output", str(self.artifacts / "verification.json"))

    def restore(self, manifest_path: str, digest: str, receipt_path: str) -> CliResult:
        return self.run_ok("restore", "--manifest", manifest_path, "--receipt", receipt_path, "--approve", digest, "--output", str(self.artifacts / "restore.json"))



    def git_blob_bytes(self, path: Path) -> bytes:
        relative = path.relative_to(REPO_ROOT).as_posix()
        completed = subprocess.run(
            ["git", "cat-file", "blob", f"HEAD:{relative}"],
            cwd=REPO_ROOT,
            capture_output=True,
            check=False,
        )
        if completed.returncode != 0:
            self.fail(completed.stderr.decode("utf-8", errors="replace"))
        return completed.stdout

    def test_repository_eol_policy_preserves_byte_sensitive_fixtures(self) -> None:
        attributes_path = REPO_ROOT / ".gitattributes"
        attributes_lines = attributes_path.read_text(encoding="utf-8").splitlines()
        crlf_fixture = FIXTURES / "declarative" / "json-surgery-crlf.json"
        lf_fixture = FIXTURES / "declarative" / "json-surgery-formatting.json"
        crlf_fixture_attr = crlf_fixture.relative_to(REPO_ROOT).as_posix() + " -text"

        self.assertIn("* text=auto eol=lf", attributes_lines)
        self.assertIn(crlf_fixture_attr, attributes_lines)

        crlf_blob = self.git_blob_bytes(crlf_fixture)
        lf_blob = self.git_blob_bytes(lf_fixture)
        self.assertIn(b"\r\n", crlf_blob, "intentional CRLF fixture must stay byte-for-byte CRLF in Git")
        self.assertNotIn(b"\r\n", lf_blob, "ordinary JSON fixture blobs must stay LF in Git")

    def test_receipt_artifact_serializes_backup_manifest_path_with_forward_slashes(self) -> None:
        cleanup = load_cleanup_module()
        windows_manifest = PureWindowsPath("C:/gentle-example/state/remove-gentle-context/backups/example/manifest.json")
        receipt = cleanup.Receipt(backup_manifest_path=windows_manifest, status=cleanup.ReceiptStatus.COMPLETED)

        artifact = cleanup.receipt_artifact(receipt)

        self.assertIs(receipt.backup_manifest_path, windows_manifest)
        self.assertEqual(artifact["backup_manifest_path"], "C:/gentle-example/state/remove-gentle-context/backups/example/manifest.json")
        self.assertNotIn("\\", artifact["backup_manifest_path"])

        apply_summary = cleanup.receipt_command_summary(
            command="apply",
            receipt_path=PureWindowsPath("C:/gentle-example/state/remove-gentle-context/receipt.json"),
            receipt=receipt,
            artifact=artifact,
            backup_manifest_digest=None,
            counts={"operations": 0, "lifecycle": 0},
        )
        restore_summary = cleanup.receipt_command_summary(
            command="restore",
            receipt_path=PureWindowsPath("C:/gentle-example/state/remove-gentle-context/restore.json"),
            receipt=receipt,
            artifact=artifact,
        )

        self.assertEqual(apply_summary["backup_manifest_path"], artifact["backup_manifest_path"])
        self.assertEqual(restore_summary["backup_manifest_path"], artifact["backup_manifest_path"])
        self.assertIn("backup_manifest_digest", apply_summary)
        self.assertIsNone(apply_summary["backup_manifest_digest"])
        self.assertNotIn("backup_manifest_digest", restore_summary)
        self.assertNotIn("\\", apply_summary["backup_manifest_path"])
        self.assertNotIn("\\", restore_summary["backup_manifest_path"])

        native_manifest = self.artifacts / "manifest.json"
        native_manifest.write_text('{"schema":"remove-gentle-context.backup/v1"}\n', encoding="utf-8")
        native_receipt = cleanup.Receipt(backup_manifest_path=native_manifest, status=cleanup.ReceiptStatus.COMPLETED)
        native_artifact = cleanup.receipt_artifact(native_receipt)
        native_receipt_path = self.artifacts / "native-receipt.json"
        native_receipt_path.write_text(
            json.dumps(native_artifact, sort_keys=True, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        loaded_native_receipt = cleanup.load_receipt(native_receipt_path)

        self.assertIsInstance(loaded_native_receipt.backup_manifest_path, Path)
        self.assertEqual(loaded_native_receipt.backup_manifest_path.read_text(encoding="utf-8"), native_manifest.read_text(encoding="utf-8"))

    def test_cli_file_has_portable_shebang_and_posix_executable_mode(self) -> None:
        first_line = SCRIPT.read_text(encoding="utf-8").splitlines()[0]
        self.assertEqual(first_line, "#!/usr/bin/env python3")
        if os.name == "posix":
            self.assertTrue(os.access(SCRIPT, os.X_OK), "cleanup.py must be executable on POSIX")

    def test_help_lists_exact_five_commands(self) -> None:
        result = self.run_cli("--help")
        self.assertEqual(result.returncode, 0)
        self.assertIn("inventory", result.stdout)
        self.assertIn("plan", result.stdout)
        self.assertIn("apply", result.stdout)
        self.assertIn("verify", result.stdout)
        self.assertIn("restore", result.stdout)

        inventory_help = self.run_cli("inventory", "--help")
        self.assertEqual(inventory_help.returncode, 0)
        self.assertIn("--home", inventory_help.stdout)
        self.assertIn("--platform", inventory_help.stdout)
        self.assertIn("--env", inventory_help.stdout)




    def test_workflow_uses_one_linux_job_and_portable_commands(self) -> None:
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("runs-on: ubuntu-latest", text)
        self.assertNotIn("macos-latest", text)
        self.assertNotIn("windows-latest", text)
        self.assertNotIn("matrix:", text)
        self.assertFalse((WORKFLOW.parent / "test-model-optimizer.yml").exists())
        self.assertEqual(text.count('python-version: "3.11"'), 1)
        self.assertIn("working-directory: skills/remove-gentle-context", text)
        self.assertIn("python -m unittest discover -s tests -t . -v", text)
        self.assertIn("python -m py_compile scripts/cleanup.py", text)
        self.assertIn("python scripts/cleanup.py --help", text)
        self.assertNotIn("cd skills/remove-gentle-context", text)
        self.assertNotIn("./scripts/cleanup.py", text)

    def test_apply_requires_exact_approval(self) -> None:
        result = self.run_cli("apply", "--plan", str(self.artifacts / "plan.json"))
        self.assertEqual(result.returncode, 2)
        self.assertIn("--approve", result.stderr)

    def test_programmatic_invalid_arguments_return_usage_without_system_exit(self) -> None:
        cleanup = load_cleanup_module()
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            result = cleanup.main(["apply", "--plan", str(self.artifacts / "plan.json")])

        self.assertEqual(result, cleanup.EXIT_USAGE)
        self.assertIn("usage:", stderr.getvalue())
        self.assertIn("--approve", stderr.getvalue())

    def test_environment_artifact_round_trips_semantic_keys_and_default_state_path(self) -> None:
        appdata = self.temp_root / "roaming"
        localappdata = self.temp_root / "local"
        xdg_state = self.temp_root / "xdg-state"
        xdg_config = self.temp_root / "xdg-config"
        for root in (appdata, localappdata, xdg_state, xdg_config):
            root.mkdir()

        inventory = self.run_ok(
            "inventory",
            "--home",
            str(self.home),
            "--platform",
            "windows",
            "--env",
            f"LOCALAPPDATA={localappdata}",
            "--env",
            f"APPDATA={appdata}",
            "--env",
            f"XDG_STATE_HOME={xdg_state}",
            "--env",
            f"XDG_CONFIG_HOME={xdg_config}",
            "--output",
            str(self.artifacts / "windows-inventory.json"),
        )
        assert inventory.output_path is not None
        artifact = json.loads(inventory.output_path.read_text())
        self.assertEqual(artifact["environment"]["APPDATA"], str(appdata.resolve()))
        self.assertEqual(artifact["environment"]["LOCALAPPDATA"], str(localappdata.resolve()))
        self.assertEqual(artifact["environment"]["XDG_STATE_HOME"], str(xdg_state.resolve()))
        self.assertEqual(set(artifact["environment"]), {"APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_STATE_HOME"})

        plan = self.run_ok("plan", "--inventory", str(inventory.output_path))
        self.assertTrue(str(plan.output_path).startswith(str(localappdata / "remove-gentle-context" / "state" / "artifacts")))

        linux_inventory = self.run_ok(
            "inventory",
            "--home",
            str(self.home),
            "--platform",
            "linux",
            "--env",
            f"XDG_STATE_HOME={xdg_state}",
        )
        self.assertTrue(str(linux_inventory.output_path).startswith(str(xdg_state / "remove-gentle-context" / "artifacts")))

    def test_inventory_environment_does_not_leak_unapproved_inherited_env(self) -> None:
        xdg_state = self.temp_root / "state-authority"
        xdg_state.mkdir()
        noisy_env = {**self.env, "APPDATA_SHADOW": str(self.temp_root / "shadow"), "GENTLE_PRIVATE_ROOT": str(self.temp_root / "private")}
        inventory = self.run_cli(
            "inventory",
            "--home",
            str(self.home),
            "--platform",
            "linux",
            "--env",
            f"XDG_STATE_HOME={xdg_state}",
            "--output",
            str(self.artifacts / "bounded-env-inventory.json"),
            env=noisy_env,
        )
        self.assertEqual(inventory.returncode, 0)
        assert inventory.output_path is not None

        artifact = json.loads(inventory.output_path.read_text())
        self.assertEqual(artifact["environment"], {"XDG_STATE_HOME": str(xdg_state.resolve())})
        self.assertNotIn("APPDATA_SHADOW", json.dumps(artifact, sort_keys=True))
        self.assertNotIn("GENTLE_PRIVATE_ROOT", json.dumps(artifact, sort_keys=True))

    def test_inventory_loader_requires_and_validates_environment_field(self) -> None:
        cleanup = load_cleanup_module()
        inventory = self.inventory()
        assert inventory.output_path is not None
        original = json.loads(inventory.output_path.read_text())

        missing = self.artifacts / "missing-environment.json"
        missing_data = dict(original)
        missing_data.pop("environment", None)
        missing.write_text(json.dumps(missing_data, sort_keys=True, separators=(",", ":")), encoding="utf-8")
        with self.assertRaisesRegex(cleanup.CliError, "artifact_missing_field"):
            cleanup.load_inventory(missing)

        relative = self.artifacts / "relative-environment.json"
        relative_data = dict(original)
        relative_data["environment"] = {"XDG_STATE_HOME": "relative-state"}
        unsigned = {key: value for key, value in relative_data.items() if key not in {"schema", "digest"}}
        relative_data["digest"] = cleanup.digest_json(unsigned)
        relative.write_text(json.dumps(relative_data, sort_keys=True, separators=(",", ":")), encoding="utf-8")
        with self.assertRaisesRegex(cleanup.CliError, "environment"):
            cleanup.load_inventory(relative)

        unknown = self.artifacts / "unknown-environment.json"
        unknown_data = dict(original)
        unknown_data["environment"] = {"GENTLE_PRIVATE_ROOT": str(self.temp_root / "private")}
        unsigned = {key: value for key, value in unknown_data.items() if key not in {"schema", "digest"}}
        unknown_data["digest"] = cleanup.digest_json(unsigned)
        unknown.write_text(json.dumps(unknown_data, sort_keys=True, separators=(",", ":")), encoding="utf-8")
        with self.assertRaisesRegex(cleanup.CliError, "environment"):
            cleanup.load_inventory(unknown)





    def test_atomic_output_interruption_leaves_previous_artifact_intact(self) -> None:
        output = self.artifacts / "inventory.json"
        output.write_text('{"previous":true}\n', encoding="utf-8")
        cleanup = load_cleanup_module()
        stderr = io.StringIO()
        with mock.patch.object(cleanup, "write_json_atomic", side_effect=OSError("simulated atomic failure")), contextlib.redirect_stderr(stderr):
            failed = cleanup.main(["inventory", "--home", str(self.home), "--platform", "linux", "--output", str(output)])
        self.assertEqual(failed, 13)
        self.assertIn("OSError", stderr.getvalue())
        self.assertEqual(output.read_text(encoding="utf-8"), '{"previous":true}\n')

        ignored_env = {**self.env, REMOVED_ATOMIC_ENV: str(output)}
        succeeded = self.run_cli("inventory", "--home", str(self.home), "--platform", "linux", "--output", str(output), env=ignored_env)
        self.assertEqual(succeeded.returncode, 0)
        self.assertNotEqual(output.read_text(encoding="utf-8"), '{"previous":true}\n')

    def test_cli_apply_writes_receipt_before_nonzero_exit_for_contained_transaction_failure(self) -> None:
        cleanup = load_cleanup_module()
        target = self.home / "cli-contained-failure.txt"
        target.write_text("before", encoding="utf-8")
        context = cleanup.RuntimeContext(cleanup.PlatformProfile("linux", self.home, {"XDG_STATE_HOME": str(self.temp_root / "state")}))
        inventory = cleanup.Inventory(
            os_name=context.profile.os_name,
            home=str(self.home),
            root_map=dict(sorted(cleanup.root_map(context).items())),
            environment=dict(sorted(context.profile.env.items())),
            adapter_versions={"fixture": "1.0"},
            adapter_layouts={"fixture": "layout-v1"},
        ).with_digest()
        before = b"before"
        after = b"after"
        before_digest = "sha256:" + hashlib.sha256(before).hexdigest()
        after_digest = "sha256:" + hashlib.sha256(after).hexdigest()
        plan = cleanup.Plan(
            inventory_digest=inventory.digest,
            os_name=inventory.os_name,
            home=inventory.home,
            root_map=dict(sorted(inventory.root_map.items())),
            adapter_versions={"fixture": "1.0"},
            adapter_layouts={"fixture": "layout-v1"},
            operations=(
                cleanup.Operation(
                    kind=cleanup.OperationKind.WRITE_FILE,
                    path=str(target),
                    preimage_base64=base64.b64encode(before).decode("ascii"),
                    preimage_sha256=before_digest,
                    postimage_base64=base64.b64encode(after).decode("ascii"),
                    postimage_sha256=after_digest,
                ),
            ),
        ).with_digest()
        inventory_path = self.artifacts / "contained-inventory.json"
        plan_path = self.artifacts / "contained-plan.json"
        receipt_path = self.artifacts / "contained-receipt.json"
        inventory_path.write_text(json.dumps(cleanup.inventory_artifact(inventory), sort_keys=True, separators=(",", ":")), encoding="utf-8")
        plan_path.write_text(json.dumps(cleanup.plan_artifact(plan), sort_keys=True, separators=(",", ":")), encoding="utf-8")
        fake_receipt = cleanup.Receipt(
            operation_outcomes=(cleanup.OperationOutcome(0, str(cleanup.OperationKind.WRITE_FILE), str(target), "failed", "backup_failed"),),
            status=cleanup.ReceiptStatus.NOT_STARTED,
            plan=plan,
            inventory=inventory,
        )
        class StdoutCapture:
            def __init__(self) -> None:
                self.buffer = io.BytesIO()

            def write(self, _text: str) -> int:
                return 0

            def flush(self) -> None:
                return

        stdout = StdoutCapture()
        stderr = io.StringIO()
        argv = ["apply", "--inventory", str(inventory_path), "--plan", str(plan_path), "--approve", plan.digest or "", "--receipt", str(receipt_path)]

        with mock.patch.object(cleanup, "execute_plan", return_value=fake_receipt), mock.patch.object(cleanup.sys, "stdout", stdout), contextlib.redirect_stderr(stderr):
            with self.assertRaises(SystemExit) as raised:
                cleanup.main(argv)

        self.assertEqual(raised.exception.code, cleanup.EXIT_APPLY)
        self.assertTrue(receipt_path.is_file())
        persisted = cleanup.load_receipt(receipt_path)
        self.assertEqual(persisted.status, cleanup.ReceiptStatus.NOT_STARTED)
        self.assertEqual(persisted.operation_outcomes[0].error, "backup_failed")
        self.assertEqual(json.loads(stdout.buffer.getvalue())["status"], "not_started")
        self.assertIn("apply_not_started", stderr.getvalue())


    def test_inventory_context_roots_must_be_absolute_canonical_and_not_links(self) -> None:
        relative_home = self.run_cli("inventory", "--home", "relative-home", "--platform", "linux", "--output", str(self.artifacts / "relative.json"))
        self.assertEqual(relative_home.returncode, 2)
        self.assertIn("root", relative_home.stderr)

        symlink_home = self.temp_root / "home-link"
        symlink_home.symlink_to(self.home, target_is_directory=True)
        linked_home = self.run_cli("inventory", "--home", str(symlink_home), "--platform", "linux", "--output", str(self.artifacts / "linked.json"))
        self.assertEqual(linked_home.returncode, 2)
        self.assertIn("root", linked_home.stderr)

        relative_env = self.run_cli("inventory", "--home", str(self.home), "--platform", "linux", "--env", "XDG_CONFIG_HOME=relative-config", "--output", str(self.artifacts / "relative-env.json"))
        self.assertEqual(relative_env.returncode, 2)
        self.assertIn("env", relative_env.stderr)

        canonical_env_root = self.temp_root / "xdg-config"
        canonical_env_root.mkdir()
        valid = self.run_cli("inventory", "--home", str(self.home), "--platform", "linux", "--env", f"XDG_CONFIG_HOME={canonical_env_root}", "--output", str(self.artifacts / "valid-env.json"))
        self.assertEqual(valid.returncode, 0)



if __name__ == "__main__":
    unittest.main()
