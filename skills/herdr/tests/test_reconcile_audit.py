from __future__ import annotations

import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "a4s-reconcile"
PLIST = SCRIPT.parent / "dev.a4s.reconcile.plist"


def load_module():
    loader = importlib.machinery.SourceFileLoader("a4s_reconcile_audit_test", str(SCRIPT))
    spec = importlib.util.spec_from_loader("a4s_reconcile_audit_test", loader)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    loader.exec_module(module)
    return module


class ReconcileAuditTest(unittest.TestCase):
    def setUp(self):
        self.mod = load_module()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir(mode=0o700)

    def tearDown(self):
        self.tmp.cleanup()

    def ctx(self, apply=True):
        args = type("Args", (), {
            "apply": apply, "repo": str(self.repo), "root": str(self.root), "callback": "po",
            "dispatch_label": "auto-dispatch", "settle": 60, "reap_grace": 120,
            "max_redispatch": 2, "max_dispatch": 3, "default_kind": "claude",
            "default_model": "sonnet", "stale_after": 1800, "ack_after": 300,
            "mc_grace": 60, "plan_ignoring_mc_gate": False,
        })()
        ctx = self.mod.Ctx(args)
        ctx.gate = {"verdict": "OK", "reasons": [], "owner": None}
        return ctx

    def records(self, ctx):
        return self.mod.read_audit(ctx.audit_path)["records"]

    def pending(self, ctx, bead="b-1", scopes=None):
        scopes = scopes or ["bead:%s" % bead]
        mutation_id = "1" * 32
        rec = self.mod.audit_record(mutation_id, "intent", "bd.update", {"bead_id": bead},
                                    scopes, "pending", "intent-recorded")
        self.mod.record_audit(ctx, rec)
        return mutation_id

    def test_six_operation_families_use_typed_records_without_canaries(self):
        ctx = self.ctx()
        canary = "PROMPT_SECRET_PAYLOAD_PATH_ENV_ARGV_STDERR_STDOUT"
        changes = [
            self.mod.BdUpdate("b-1", ("--claim",), actor="actor", dispatch_id="d-1"),
            self.mod.BdClose("b-2", "free text reason", actor="actor"),
            self.mod.TabCreate("b-3", "d-3", "wT", "/secret/path", "b-3"),
            self.mod.TabClose("b-4", "wT:t4"),
            self.mod.AgentStart("b-5", "d-5", "worker-5", "wT:p5", "claude", "sonnet"),
            self.mod.AgentPrompt("b-6", "d-6", "worker-6", canary),
        ]
        with mock.patch.object(self.mod, "run_process", return_value=("exited", 0, "secret-out", "secret-err", None)):
            for change in changes:
                self.mod.mutate(ctx, change)
        records = self.records(ctx)
        self.assertEqual({r["operation"] for r in records[::2]}, self.mod.AUDIT_OPERATIONS)
        self.assertTrue(all(r["event"] == "intent" for r in records[::2]))
        self.assertTrue(all(r["event"] == "result" for r in records[1::2]))
        raw = Path(ctx.audit_path).read_text()
        for value in (canary, "/secret/path", "secret-out", "secret-err", "free text reason"):
            self.assertNotIn(value, raw)
        forbidden = {"argv", "prompt", "payload", "path", "env", "stdout", "stderr", "error", "message"}
        self.assertTrue(all(not forbidden.intersection(record) for record in records))

    def test_intent_is_durable_before_one_process_and_result_follows(self):
        ctx = self.ctx()
        order = []

        def record(_ctx, rec):
            order.append(rec["event"])

        def process(*_args, **_kw):
            order.append("process")
            return "exited", 0, "", "", None

        with mock.patch.object(self.mod, "record_audit", side_effect=record), \
                mock.patch.object(self.mod, "run_process", side_effect=process) as started:
            self.mod.mutate(ctx, self.mod.BdClose("b-1", "reason"))
        self.assertEqual(order, ["intent", "process", "result"])
        self.assertEqual(started.call_count, 1)

    def test_intent_failure_starts_zero_processes(self):
        ctx = self.ctx()
        with mock.patch.object(self.mod, "record_audit", side_effect=OSError("disk")), \
                mock.patch.object(self.mod, "run_process") as started:
            with self.assertRaises(self.mod.MutationHalt):
                self.mod.mutate(ctx, self.mod.BdClose("b-1", "reason"))
        started.assert_not_called()

    def test_partial_intent_rolls_back_and_starts_zero_processes(self):
        ctx = self.ctx()
        real_write = os.write
        calls = 0

        def partial(fd, data):
            nonlocal calls
            calls += 1
            if calls == 1:
                return real_write(fd, data[:11])
            raise OSError("write failed")

        with mock.patch.object(self.mod.os, "write", side_effect=partial), \
                mock.patch.object(self.mod, "run_process") as started:
            with self.assertRaises(self.mod.MutationHalt):
                self.mod.mutate(ctx, self.mod.BdClose("b-1", "reason"))
        started.assert_not_called()
        self.assertEqual(Path(ctx.audit_path).stat().st_size, 0)
        self.assertEqual(self.records(ctx), [])

    def test_partial_result_rolls_back_to_pending_and_stops_tick(self):
        ctx = self.ctx()
        real_write = os.write
        calls = 0

        def partial_result(fd, data):
            nonlocal calls
            calls += 1
            if calls == 1:
                return real_write(fd, data)
            if calls == 2:
                return real_write(fd, data[:13])
            raise OSError("write failed")

        with mock.patch.object(self.mod.os, "write", side_effect=partial_result), \
                mock.patch.object(self.mod, "run_process", return_value=("exited", 0, "", "", None)) as started:
            with self.assertRaises(self.mod.MutationHalt):
                self.mod.mutate(ctx, self.mod.BdClose("b-1", "reason"))
        self.assertEqual(started.call_count, 1)
        records = self.records(ctx)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["event"], "intent")
        self.assertEqual(self.mod.mutation_state(self.mod.read_audit(ctx.audit_path)["mutations"][records[0]["mutation_id"]]),
                         "pending")

    def test_failed_result_rollback_is_fatal_and_leaves_corrupt_audit(self):
        ctx = self.ctx()
        real_write = os.write
        calls = 0

        def partial_result(fd, data):
            nonlocal calls
            calls += 1
            if calls == 1:
                return real_write(fd, data)
            if calls == 2:
                return real_write(fd, data[:9])
            raise OSError("write failed")

        with mock.patch.object(self.mod.os, "write", side_effect=partial_result), \
                mock.patch.object(self.mod.os, "ftruncate", side_effect=OSError("rollback failed")), \
                mock.patch.object(self.mod, "run_process", return_value=("exited", 0, "", "", None)) as started:
            with self.assertRaisesRegex(self.mod.MutationHalt, "AuditRollbackFailed"):
                self.mod.mutate(ctx, self.mod.BdClose("b-1", "reason"))
        self.assertEqual(started.call_count, 1)
        self.assertGreater(Path(ctx.audit_path).stat().st_size, 0)
        with self.assertRaises(self.mod.AuditCorrupt):
            self.mod.read_audit(ctx.audit_path)

    def test_short_writes_complete_a_valid_record(self):
        ctx = self.ctx()
        record = self.mod.audit_record("6" * 32, "intent", "bd.close", {"bead_id": "b-1"},
                                       ["bead:b-1"], "pending", "intent-recorded")
        real_write = os.write

        def short(fd, data):
            return real_write(fd, data[:7])

        with mock.patch.object(self.mod.os, "write", side_effect=short):
            self.mod.record_audit(ctx, record)
        self.assertEqual(self.records(ctx), [record])

    def test_popen_value_error_is_not_applied_without_message(self):
        ctx = self.ctx()
        with mock.patch.object(self.mod.subprocess, "Popen", side_effect=ValueError("NUL secret")):
            with self.assertRaises(self.mod.StepError):
                self.mod.mutate(ctx, self.mod.BdClose("b-1", "reason"))
        result = self.records(ctx)[-1]
        self.assertEqual((result["status"], result["code"]), ("not-applied", "process-not-created"))
        self.assertNotIn("NUL secret", Path(ctx.audit_path).read_text())
        with mock.patch.object(self.mod.subprocess, "Popen", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.mod.run_process(["unused"])

    def test_process_outcomes_have_closed_codes(self):
        cases = [
            (("not-started", None, "", "", OSError()), "not-applied", "process-not-created", self.mod.StepError),
            (("timeout", -9, "", "", Exception()), "ambiguous", "process-timeout", self.mod.MutationHalt),
            (("exited", 7, "", "", None), "ambiguous", "exit-nonzero", self.mod.MutationHalt),
            (("exception", None, "", "", Exception()), "ambiguous", "execution-exception", self.mod.MutationHalt),
            (("exited", -15, "", "", None), "ambiguous", "process-signal", self.mod.MutationHalt),
        ]
        for index, (outcome, status, code, error) in enumerate(cases):
            with self.subTest(code=code):
                root = self.root / ("case-%d" % index)
                root.mkdir(mode=0o700)
                old = self.root
                self.root = root
                ctx = self.ctx()
                with mock.patch.object(self.mod, "run_process", return_value=outcome):
                    with self.assertRaises(error):
                        self.mod.mutate(ctx, self.mod.BdClose("b-1", "reason"))
                result = self.records(ctx)[-1]
                self.assertEqual((result["status"], result["code"]), (status, code))
                self.root = old

    def test_result_persistence_failure_halts_after_one_process(self):
        ctx = self.ctx()
        seen = []

        def record(_ctx, rec):
            seen.append(rec["event"])
            if rec["event"] == "result":
                raise OSError("disk")

        with mock.patch.object(self.mod, "record_audit", side_effect=record), \
                mock.patch.object(self.mod, "run_process", return_value=("exited", 0, "", "", None)) as started:
            with self.assertRaises(self.mod.MutationHalt):
                self.mod.mutate(ctx, self.mod.BdClose("b-1", "reason"))
        self.assertEqual(seen, ["intent", "result"])
        self.assertEqual(started.call_count, 1)

    def test_parser_rejects_truncation_duplicate_keys_and_bad_order(self):
        path = self.root / "audit.jsonl"
        path.write_bytes(b'{"schema":"a4s.audit/1"}')
        os.chmod(path, 0o600)
        with self.assertRaises(self.mod.AuditCorrupt):
            self.mod.read_audit(str(path))
        path.write_text('{"schema":"a4s.audit/1","schema":"a4s.audit/1"}\n')
        os.chmod(path, 0o600)
        with self.assertRaises(self.mod.AuditCorrupt):
            self.mod.read_audit(str(path))
        intent = self.mod.audit_record("2" * 32, "intent", "bd.close", {"bead_id": "b-1"},
                                       ["bead:b-1"], "pending", "intent-recorded")
        result = self.mod.audit_record("2" * 32, "result", "bd.close", {"bead_id": "b-1"},
                                       ["bead:b-1"], "applied", "exit-zero")
        path.write_text(json.dumps(result) + "\n" + json.dumps(intent) + "\n")
        os.chmod(path, 0o600)
        with self.assertRaises(self.mod.AuditCorrupt):
            self.mod.read_audit(str(path))

    def test_numeric_record_ids_are_corrupt_and_cannot_be_resolved(self):
        ctx = self.ctx()
        self.mod.secure_tree(ctx.root, ("audit", "reconcile"), True)
        intent = self.mod.audit_record("4" * 32, "intent", "bd.close", {"bead_id": "b-1"},
                                       ["bead:b-1"], "pending", "intent-recorded")
        for field in ("record_id", "mutation_id"):
            invalid = dict(intent)
            invalid[field] = int("4" * 32)
            Path(ctx.audit_path).write_text(json.dumps(invalid) + "\n")
            os.chmod(ctx.audit_path, 0o600)
            with self.subTest(field=field), self.assertRaises(self.mod.AuditCorrupt):
                self.mod.read_audit(ctx.audit_path)
        before = Path(ctx.audit_path).read_bytes()
        self.assertEqual(self.mod.audit_resolve(ctx, "4" * 32, "mutation-applied"), 3)
        self.assertEqual(Path(ctx.audit_path).read_bytes(), before)

    def test_resolution_is_append_only_and_rejects_repeat(self):
        ctx = self.ctx()
        mutation_id = self.pending(ctx)
        before = Path(ctx.audit_path).read_bytes()
        self.assertEqual(self.mod.audit_resolve(ctx, mutation_id, "mutation-applied"), 0)
        after = Path(ctx.audit_path).read_bytes()
        self.assertTrue(after.startswith(before))
        self.assertEqual(self.records(ctx)[-1]["event"], "resolution")
        self.assertEqual(self.mod.audit_resolve(ctx, mutation_id, "mutation-not-applied"), 2)

    def test_scope_blocking_and_legacy_global_block(self):
        ctx = self.ctx(apply=False)
        mutation_id = "3" * 32
        intent = self.mod.audit_record(mutation_id, "intent", "bd.update", {"bead_id": "b-1"},
                                       ["bead:b-1"], "pending", "intent-recorded")
        ctx.audit_view = {"records": [intent], "mutations": {mutation_id: {"intent": intent, "result": None,
                                                                           "resolution": None}},
                          "global_block": False}
        with self.assertRaises(self.mod.StepError):
            self.mod.mutate(ctx, self.mod.BdClose("b-1", "reason"))
        with mock.patch("builtins.print"):
            self.mod.mutate(ctx, self.mod.BdClose("b-2", "reason"))
        ctx.audit_view["global_block"] = True
        with self.assertRaises(self.mod.StepError):
            self.mod.mutate(ctx, self.mod.BdClose("b-2", "reason"))

    def test_lock_is_not_truncated_and_status_is_read_only(self):
        ctx = self.ctx()
        self.mod.secure_tree(ctx.root, ("state", "reconcile"), True)
        lock_path = Path(ctx.lock_path)
        lock_path.write_text("sentinel")
        os.chmod(lock_path, 0o600)
        before = lock_path.read_bytes()
        self.assertEqual(self.mod.audit_status(ctx), 0)
        self.assertEqual(lock_path.read_bytes(), before)

    def test_first_status_creates_only_the_canonical_lock(self):
        root = self.root / "first-status"
        root.mkdir(mode=0o700)
        old = self.root
        self.root = root
        ctx = self.ctx()
        self.root = old
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(self.mod.audit_status(ctx), 0)
        self.assertTrue(Path(ctx.lock_path).is_file())
        self.assertEqual(stat.S_IMODE(os.stat(ctx.lock_path).st_mode), 0o600)
        self.assertFalse(Path(ctx.audit_path).exists())
        self.assertFalse(Path(ctx.log_path).exists())

    def test_first_status_holds_shared_lock_and_returns_one_snapshot(self):
        ctx = self.ctx()
        self.mod.secure_tree(ctx.root, ("audit", "reconcile"), True)
        Path(ctx.audit_path).write_bytes(b"")
        os.chmod(ctx.audit_path, 0o600)
        audit_before = Path(ctx.audit_path).read_bytes()
        entered = threading.Event()
        release = threading.Event()
        intent = self.mod.audit_record("5" * 32, "intent", "bd.close", {"bead_id": "b-1"},
                                       ["bead:b-1"], "pending", "intent-recorded")
        view = {"records": [intent], "mutations": {"5" * 32: {"intent": intent, "result": None,
                                                                  "resolution": None}},
                "global_block": False}

        def slow_read(_path):
            entered.set()
            release.wait(5)
            return view

        result = []
        output = io.StringIO()
        with mock.patch.object(self.mod, "read_audit", side_effect=slow_read), contextlib.redirect_stdout(output):
            thread = threading.Thread(target=lambda: result.append(self.mod.audit_status(ctx)))
            thread.start()
            self.assertTrue(entered.wait(5))
            with self.assertRaises(BlockingIOError):
                self.mod.open_lock(ctx.lock_path, exclusive=True, create=True, nonblocking=True)
            release.set()
            thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(result, [0])
        snapshot = json.loads(output.getvalue())
        self.assertEqual((snapshot["records"], len(snapshot["open"])), (1, 1))
        self.assertEqual(Path(ctx.audit_path).read_bytes(), audit_before)
        self.assertEqual(stat.S_IMODE(os.stat(ctx.lock_path).st_mode), 0o600)
        writer = self.mod.open_lock(ctx.lock_path, exclusive=True, create=True, nonblocking=True)
        os.close(writer)

    def test_lock_modes_exclude_a_writer_and_allow_readers(self):
        ctx = self.ctx()
        writer = self.mod.open_lock(ctx.lock_path, exclusive=True, create=True, nonblocking=True)
        try:
            with self.assertRaises(BlockingIOError):
                self.mod.open_lock(ctx.lock_path, exclusive=True, create=True, nonblocking=True)
            with self.assertRaises(BlockingIOError):
                self.mod.open_lock(ctx.lock_path, exclusive=False, create=False, nonblocking=True)
        finally:
            os.close(writer)
        reader_one = self.mod.open_lock(ctx.lock_path, exclusive=False, create=False, nonblocking=True)
        reader_two = self.mod.open_lock(ctx.lock_path, exclusive=False, create=False, nonblocking=True)
        os.close(reader_two)
        os.close(reader_one)

    def test_dry_run_creates_nothing(self):
        isolated = self.root / "dry"
        ctx = self.ctx(apply=False)
        ctx.root = str(isolated)
        ctx.state = str(isolated / "state" / "reconcile")
        ctx.audit_path = str(isolated / "audit" / "reconcile" / "audit.jsonl")
        ctx.log_path = str(isolated / "log" / "reconcile" / "events.jsonl")
        ctx.lock_path = str(isolated / "state" / "reconcile" / "tick.lock")
        with mock.patch("builtins.print"):
            self.mod.mutate(ctx, self.mod.BdClose("b-1", "reason"))
        self.assertFalse(isolated.exists())

    def test_log_failure_does_not_change_mutation_result(self):
        ctx = self.ctx()
        with mock.patch.object(self.mod, "append_best_effort", return_value=False), \
                mock.patch.object(self.mod, "run_process", return_value=("exited", 0, "", "", None)):
            result = self.mod.mutate(ctx, self.mod.BdClose("b-1", "reason"))
        self.assertEqual(result[0], 0)
        self.assertEqual(self.records(ctx)[-1]["status"], "applied")

    def test_flags_and_plist(self):
        missing = subprocess.run([sys.executable, str(SCRIPT), "--audit-resolve", "1" * 32],
                                 capture_output=True, text=True)
        self.assertEqual(missing.returncode, 2)
        exclusive = subprocess.run([sys.executable, str(SCRIPT), "--apply", "--audit-status"],
                                   capture_output=True, text=True)
        self.assertEqual(exclusive.returncode, 2)
        plist = PLIST.read_text()
        self.assertEqual(plist.count("<string>/dev/null</string>"), 2)
        self.assertNotIn("launchd.out.log", plist)
        self.assertNotIn("launchd.err.log", plist)

    def test_permissions_and_symlink_rejection(self):
        ctx = self.ctx()
        self.pending(ctx)
        self.assertEqual(stat.S_IMODE(os.stat(ctx.audit_path).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(Path(ctx.audit_path).parent).st_mode), 0o700)
        outside = self.root / "outside"
        outside.mkdir(mode=0o700)
        linked_root = self.root / "linked-root"
        linked_root.mkdir(mode=0o700)
        os.symlink(outside, linked_root / "audit")
        with self.assertRaises(OSError):
            self.mod.secure_tree(str(linked_root), ("audit", "reconcile"), True)


if __name__ == "__main__":
    unittest.main()
