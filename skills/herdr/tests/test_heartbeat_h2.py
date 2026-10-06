"""Pruebas locales del reconciliador Heartbeat H2.

Cada caso usa observaciones sintéticas. Ningún caso contacta una sesión, una
base de Beads, un modelo ni un proveedor.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import plistlib
import stat
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

HELPER = Path(__file__).resolve().parents[1] / "helper" / "heartbeat_h2.py"
sys.path.insert(0, str(HELPER.parent))

import heartbeat_h2 as h2  # noqa: E402

PO = "w4J:p3"
NOW = "2026-09-19T03:00:00Z"
OLD = "2026-09-19T01:00:00Z"
FRESH = "2026-09-19T02:55:00Z"


def obs(*, ready=(), in_progress=(), closed=(), panes=(), po_status="idle", seq=10, callbacks=None):
    return {
        "at": NOW,
        "po": {"pane_id": PO, "agent_status": po_status, "state_change_seq": seq, "session_path": None},
        "ready": [{"id": i, "issue_type": "task"} for i in ready],
        "in_progress": [{"id": i, "updated_at": u, "issue_type": t} for i, u, t in in_progress],
        "closed": [{"id": i, "issue_type": "task"} if isinstance(i, str) else {"id": i[0], "issue_type": i[1]} for i in closed],
        "panes": list(panes),
        "callbacks": callbacks or {"seen": 0, "answered": 0},
    }


def pane(pane_id, label, status):
    return {"pane_id": pane_id, "label": label, "cwd": "/repo", "agent_status": status}


def prev_state(**kw):
    base = {"at": "2026-09-19T02:55:00Z", "po": {"agent_status": "idle", "state_change_seq": 10}, "ready": [], "in_progress": {}, "wake_sent": True}
    base.update(kw)
    return base


class EvaluateTests(unittest.TestCase):
    def test_first_tick_is_baseline_not_pass(self):
        self.assertEqual(h2.evaluate(None, obs())["verdict"], "BASELINE")

    def test_idle_worker_with_open_bead_emits_stale_work_with_pane_and_bead(self):
        result = h2.evaluate(prev_state(in_progress={"a4s-1": OLD}), obs(in_progress=[("a4s-1", OLD, "task")], panes=[pane("w4J:p9", "a4s-1", "idle")]))
        self.assertEqual(result["verdict"], "PASS_STALE")
        self.assertEqual(result["events"][0], {"kind": "STALE_WORK", "pane_id": "w4J:p9", "bead_id": "a4s-1", "reason": "worker_idle_bead_open", "age_min": 120})
        self.assertEqual(h2.render_event(result["events"][0]), "STALE_WORK pane_id=w4J:p9 bead_id=a4s-1 reason=worker_idle_bead_open age_min=120")

    def test_blocked_worker_elevates_question_attention(self):
        result = h2.evaluate(prev_state(in_progress={"a4s-1": OLD}), obs(in_progress=[("a4s-1", OLD, "task")], panes=[pane("w4J:p9", "a4s-1", "blocked")]))
        self.assertEqual(result["events"][0]["kind"], "QUESTION")
        self.assertIn("ATTENTION type=QUESTION pane_id=w4J:p9 bead_id=a4s-1", h2.render_event(result["events"][0]))

    def test_open_bead_without_worker_is_attributed_to_the_orchestrator_pane(self):
        result = h2.evaluate(prev_state(in_progress={"a4s-2": OLD}), obs(in_progress=[("a4s-2", OLD, "task")]))
        self.assertEqual((result["events"][0]["pane_id"], result["events"][0]["bead_id"]), (PO, "a4s-2"))

    def test_ready_work_left_unclaimed_by_idle_orchestrator_is_stale(self):
        result = h2.evaluate(prev_state(), obs(ready=["a4s-3", "a4s-4"]))
        self.assertEqual(result["verdict"], "PASS_STALE")
        self.assertEqual((result["events"][0]["bead_id"], result["events"][0]["reason"]), ("a4s-3", "ready_unclaimed"))

    def test_claim_of_ready_bead_is_progress(self):
        result = h2.evaluate(prev_state(ready=["a4s-3"]), obs(ready=["a4s-4"], in_progress=[("a4s-3", FRESH, "task")], panes=[pane("w4J:p9", "a4s-3", "working")]))
        self.assertEqual((result["verdict"], result["facts"]["claims"]), ("PASS_PROGRESS", ["a4s-3"]))

    def test_closed_bead_is_progress(self):
        result = h2.evaluate(prev_state(in_progress={"a4s-3": OLD}), obs(closed=["a4s-3"]))
        self.assertEqual((result["verdict"], result["facts"]["closes"]), ("PASS_PROGRESS", ["a4s-3"]))

    def test_closed_epic_is_not_progress(self):
        result = h2.evaluate(prev_state(in_progress={"epic-1": OLD}), obs(closed=[("epic-1", "epic")]))
        self.assertNotEqual(result["verdict"], "PASS_PROGRESS")
        self.assertEqual(result["facts"]["closes"], [])

    def test_closed_epic_alongside_task_counts_only_the_task(self):
        result = h2.evaluate(prev_state(), obs(closed=[("epic-1", "epic"), ("a4s-3", "task")]))
        self.assertEqual((result["verdict"], result["facts"]["closes"]), ("PASS_PROGRESS", ["a4s-3"]))

    def test_answered_callback_is_harvest_and_wins_over_progress(self):
        result = h2.evaluate(prev_state(in_progress={"a4s-3": OLD}), obs(closed=["a4s-3"], callbacks={"seen": 1, "answered": 1}))
        self.assertEqual(result["verdict"], "PASS_HARVEST")

    def test_unanswered_callback_is_not_harvest(self):
        result = h2.evaluate(prev_state(), obs(callbacks={"seen": 1, "answered": 0}))
        self.assertNotEqual(result["verdict"], "PASS_HARVEST")

    def test_epics_alone_are_noop_not_pass(self):
        result = h2.evaluate(prev_state(in_progress={"a4s-e": OLD}), obs(in_progress=[("a4s-e", OLD, "epic")]))
        self.assertEqual(result["verdict"], "NOOP")

    def test_in_flight_bead_with_working_pane_is_working_not_pass(self):
        result = h2.evaluate(prev_state(in_progress={"a4s-1": OLD}), obs(in_progress=[("a4s-1", OLD, "task")], panes=[pane("w4J:p9", "a4s-1", "working")]))
        self.assertEqual(result["verdict"], "WORKING")

    def test_recently_idle_worker_with_no_evidence_fails_after_wake(self):
        result = h2.evaluate(prev_state(in_progress={"a4s-1": FRESH}), obs(in_progress=[("a4s-1", FRESH, "task")], panes=[pane("w4J:p9", "a4s-1", "idle")]))
        self.assertEqual((result["verdict"], result["reason"]), ("FAIL", "no_evidence_after_wake"))

    def test_events_are_bounded(self):
        many = [(f"a4s-{n}", OLD, "task") for n in range(9)]
        self.assertEqual(len(h2.evaluate(prev_state(in_progress={i: OLD for i, _, _ in many}), obs(in_progress=many))["events"]), h2.MAX_EVENTS)

    def test_wake_prompt_carries_verdict_and_pointers_only(self):
        result = h2.evaluate(prev_state(), obs(ready=["a4s-3"]))
        text = h2.wake_prompt(result)
        self.assertTrue(text.startswith("HEARTBEAT:"))
        self.assertIn("H2 verdict=PASS_STALE ; STALE_WORK pane_id=w4J:p3 bead_id=a4s-3", text)


class ScanCallbackTests(unittest.TestCase):
    def write(self, dirname, lines, tail=""):
        path = Path(dirname) / "session.jsonl"
        path.write_text("".join(json.dumps(x) + "\n" for x in lines) + tail)
        return str(path)

    @staticmethod
    def message(role, text):
        return {"type": "message", "message": {"role": role, "content": [{"type": "text", "text": text}]}}

    def test_first_scan_starts_at_end_and_never_replays_history(self):
        with tempfile.TemporaryDirectory() as d:
            path = self.write(d, [self.message("user", "WORK_RESULT SUBMITTED bead_id=x")])
            offset, counts = h2.scan_callbacks(path, None)
            self.assertEqual(counts, {"seen": 0, "answered": 0})
            self.assertEqual(offset, Path(path).stat().st_size)

    def test_callback_then_assistant_turn_is_answered_and_heartbeat_is_ignored(self):
        with tempfile.TemporaryDirectory() as d:
            path = self.write(d, [self.message("user", "old")])
            offset, _ = h2.scan_callbacks(path, None)
            with open(path, "a") as f:
                for line in (
                    self.message("user", "HEARTBEAT: usa WORK_RESULT SUBMITTED o ATTENTION type=QUESTION"),
                    self.message("assistant", "ok"),
                    self.message("user", "WORK_RESULT SUBMITTED verdict=pass artifact_path=/tmp/x bead_id=a4s-1"),
                    self.message("assistant", "harvested"),
                ):
                    f.write(json.dumps(line) + "\n")
            _, counts = h2.scan_callbacks(path, offset)
            self.assertEqual(counts, {"seen": 1, "answered": 1})

    def test_callback_without_following_turn_is_seen_not_answered(self):
        with tempfile.TemporaryDirectory() as d:
            path = self.write(d, [])
            with open(path, "a") as f:
                f.write(json.dumps(self.message("user", "ATTENTION REQUIRED verdict=blocked bead_id=a4s-1")) + "\n")
            _, counts = h2.scan_callbacks(path, 0)
            self.assertEqual(counts, {"seen": 1, "answered": 0})

    def test_partial_trailing_line_is_left_for_next_tick(self):
        with tempfile.TemporaryDirectory() as d:
            path = self.write(d, [self.message("user", "WORK_RESULT SUBMITTED bead_id=a")], tail='{"type":"mess')
            offset, counts = h2.scan_callbacks(path, 0)
            self.assertEqual(counts["seen"], 1)
            self.assertLess(offset, Path(path).stat().st_size)

    def test_missing_record_is_unknown_not_zero(self):
        self.assertEqual(h2.scan_callbacks(None, None)[1], {"seen": None, "answered": None})


class ObserveTests(unittest.TestCase):
    def runner(self, calls):
        bead = {"id": "a4s-1", "updated_at": OLD, "issue_type": "task"}
        answers = {
            ("herdr", "agent", "get"): {"result": {"agent": {"workspace_id": "w4J", "agent_status": "done", "state_change_seq": 7, "agent_session": {"kind": "path", "value": "/x.jsonl"}}}},
            ("herdr", "agent", "list"): {"result": {"agents": [
                {"pane_id": PO, "tab_id": "w4J:t3", "workspace_id": "w4J", "cwd": "/repo", "agent_status": "done"},
                {"pane_id": "w4J:p9", "tab_id": "w4J:t9", "workspace_id": "w4J", "cwd": "/repo", "agent_status": "working"},
                {"pane_id": "w4H:p1", "tab_id": "w4H:t1", "workspace_id": "w4H", "cwd": "/other", "agent_status": "idle"},
            ]}},
            ("herdr", "tab", "list"): {"result": {"tabs": [{"tab_id": "w4J:t9", "label": "a4s-1"}]}},
            ("bd", "ready", "--json"): [{"id": "a4s-2", "issue_type": "task"}],
            ("bd", "list", "--status"): [bead],
        }

        def run(argv):
            calls.append(argv)
            key = tuple(argv[:3])
            if argv[:5] == ["bd", "list", "--status", "closed", "--closed-after"]:
                return [{"id": "a4s-0", "issue_type": "task"}, {"id": "a4s-e", "issue_type": "epic"}]
            return answers[key]
        return run

    def test_observe_scopes_to_po_workspace_and_binds_labels(self):
        calls = []
        result = h2.observe(PO, None, None, run=self.runner(calls))
        self.assertEqual([p["pane_id"] for p in result["panes"]], ["w4J:p9"])
        self.assertEqual(result["panes"][0]["label"], "a4s-1")
        self.assertEqual(result["po"]["session_path"], "/x.jsonl")
        self.assertEqual(result["closed"], [])
        self.assertFalse(any(c[:5] == ["bd", "list", "--status", "closed", "--closed-after"] for c in calls))

    def test_observe_queries_closed_since_previous_tick(self):
        result = h2.observe(PO, None, NOW, run=self.runner([]))
        self.assertEqual(result["closed"], [{"id": "a4s-0", "issue_type": "task"}, {"id": "a4s-e", "issue_type": "epic"}])


class MainTests(unittest.TestCase):
    def run_main(self, args, observation, subprocess_results=None):
        calls = []

        def fake_run(argv, **_kwargs):
            calls.append(argv)
            return mock.Mock(returncode=(subprocess_results or {}).get(argv[1] + argv[2], 0))

        state_dir = Path(args[args.index("--state-dir") + 1]) if "--state-dir" in args else Path(tempfile.mkdtemp())
        self.log_root = state_dir / "a4s-root"
        out = io.StringIO()
        with mock.patch.dict(os.environ, {"A4S_STATE_ROOT": str(self.log_root)}), mock.patch.object(h2, "observe", return_value=observation), mock.patch.object(h2.subprocess, "run", fake_run), contextlib.redirect_stdout(out):
            code = h2.main(args)
        return code, json.loads(out.getvalue()), calls

    def log_records(self):
        paths = list((self.log_root / "log" / "heartbeat").glob("*.jsonl"))
        return [json.loads(line) for path in paths for line in path.read_text().splitlines()]

    def test_default_is_read_only_no_wake_no_state(self):
        with tempfile.TemporaryDirectory() as d:
            code, _, calls = self.run_main(["--po-pane", PO, "--state-dir", d], obs(ready=["a4s-3"]))
            self.assertEqual((code, calls), (0, []))
            self.assertEqual({path.name for path in Path(d).iterdir()}, {"tick.lock", "a4s-root"})
            self.assertFalse((Path(d) / "state.json").exists())

    def test_live_wakes_orchestrator_once_and_notifies_stale_evidence(self):
        with tempfile.TemporaryDirectory() as d:
            self.run_main(["--po-pane", PO, "--state-dir", d, "--live"], obs())
            code, report, calls = self.run_main(["--po-pane", PO, "--state-dir", d, "--live"], obs(ready=["a4s-3"]))
            self.assertEqual((code, report["verdict"], report["wake_sent"]), (0, "PASS_STALE", True))
            wake = next(c for c in calls if c[:3] == ["herdr", "agent", "prompt"])
            self.assertEqual(wake[3], PO)
            self.assertIn("STALE_WORK pane_id=w4J:p3 bead_id=a4s-3", wake[4])
            self.assertEqual(sum(1 for c in calls if c[:3] == ["herdr", "notification", "show"]), 1)
            self.assertFalse((Path(d) / "ticks.jsonl").exists())
            completed = [r for r in self.log_records() if r["event_name"] == "heartbeat.tick.completed"]
            self.assertEqual([r["heartbeat.verdict"] for r in completed], ["BASELINE", "PASS_STALE"])

    def test_normal_notification_runs_once_after_state_save_and_is_best_effort(self):
        for notification_code in (0, 1):
            with self.subTest(notification_code=notification_code), tempfile.TemporaryDirectory() as d:
                self.run_main(["--po-pane", PO, "--state-dir", d, "--live"], obs())
                timeline = []
                calls = []
                real_write_state = h2.write_state

                def save_state(*args, **kwargs):
                    durable = real_write_state(*args, **kwargs)
                    timeline.append("state_saved")
                    return durable

                def fake_run(argv, **kwargs):
                    calls.append((argv, kwargs))
                    if argv[:3] == ["herdr", "notification", "show"]:
                        timeline.append("notification")
                        return mock.Mock(returncode=notification_code)
                    return mock.Mock(returncode=0)

                out = io.StringIO()
                with mock.patch.dict(os.environ, {"A4S_STATE_ROOT": str(self.log_root)}), mock.patch.object(h2, "observe", return_value=obs(ready=["a4s-3"])), mock.patch.object(h2, "write_state", side_effect=save_state), mock.patch.object(h2.subprocess, "run", side_effect=fake_run), contextlib.redirect_stdout(out):
                    code = h2.main(["--po-pane", PO, "--state-dir", d, "--live"])
                report = json.loads(out.getvalue())
                self.assertEqual((code, report["verdict"]), (0, "PASS_STALE"))
                notifications = [call for call in calls if call[0][:3] == ["herdr", "notification", "show"]]
                self.assertEqual(len(notifications), 1)
                self.assertLess(timeline.index("state_saved"), timeline.index("notification"))
                self.assertEqual((notifications[0][1]["stdout"], notifications[0][1]["stderr"]), (h2.subprocess.DEVNULL, h2.subprocess.DEVNULL))

    def test_new_evidence_with_state_write_failure_sends_only_fixed_failure_notification(self):
        with tempfile.TemporaryDirectory() as d:
            self.run_main(["--po-pane", PO, "--state-dir", d, "--live"], obs())
            calls = []

            def fake_run(argv, **kwargs):
                calls.append((argv, kwargs))
                return mock.Mock(returncode=0)

            out = io.StringIO()
            err = io.StringIO()
            with mock.patch.dict(os.environ, {"A4S_STATE_ROOT": str(self.log_root)}), mock.patch.object(h2, "observe", return_value=obs(ready=["a4s-3"])), mock.patch.object(h2, "write_state", side_effect=h2.StateError("write failed")), mock.patch.object(h2.subprocess, "run", side_effect=fake_run), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = h2.main(["--po-pane", PO, "--state-dir", d, "--live"])
            report = json.loads(out.getvalue())
            self.assertEqual((code, report["verdict"], report["reason"]), (2, "FAIL", "state_error"))
            self.assertEqual(err.getvalue(), "")
            notifications = [call for call in calls if call[0][:3] == ["herdr", "notification", "show"]]
            self.assertEqual(len(notifications), 1)
            argv, kwargs = notifications[0]
            self.assertEqual(argv, ["herdr", "notification", "show", "A4S heartbeat H2 FAIL", "--body", "state_error"])
            self.assertEqual((kwargs["stdout"], kwargs["stderr"]), (h2.subprocess.DEVNULL, h2.subprocess.DEVNULL))
            wake = next(call[0] for call in calls if call[0][:3] == ["herdr", "agent", "prompt"])
            self.assertIn("H2 verdict=PASS_STALE", wake[4])

    def test_same_stale_evidence_is_not_renotified_within_the_hour(self):
        with tempfile.TemporaryDirectory() as d:
            self.run_main(["--po-pane", PO, "--state-dir", d, "--live"], obs())
            self.run_main(["--po-pane", PO, "--state-dir", d, "--live"], obs(ready=["a4s-3"]))
            _, _, calls = self.run_main(["--po-pane", PO, "--state-dir", d, "--live"], obs(ready=["a4s-3"]))
            self.assertEqual(sum(1 for c in calls if c[:3] == ["herdr", "notification", "show"]), 0)
            self.assertEqual(sum(1 for c in calls if c[:3] == ["herdr", "agent", "prompt"]), 1)

    def test_undelivered_wake_is_a_logged_fail_with_exit_2(self):
        with tempfile.TemporaryDirectory() as d:
            code, report, _ = self.run_main(["--po-pane", PO, "--state-dir", d, "--live"], obs(), {"agentprompt": 1})
            self.assertEqual((code, report["verdict"], report["reason"]), (2, "FAIL", "wake_undelivered"))
            failed = [r for r in self.log_records() if r["event_name"] == "heartbeat.tick.failed"]
            self.assertEqual(failed[-1]["error.code"], "wake_undelivered")

    def test_unobservable_state_is_fail_not_silence(self):
        out = io.StringIO()
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, {"A4S_STATE_ROOT": str(Path(d) / "root")}), mock.patch.object(h2, "observe", side_effect=h2.ObserveError("bd: exit 1")), contextlib.redirect_stdout(out):
            code = h2.main(["--po-pane", PO])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(out.getvalue())["reason"], "observe_error")


class StateFileTests(unittest.TestCase):
    def run_with_state(self, content):
        out = io.StringIO()
        with tempfile.TemporaryDirectory() as d:
            if content is not None:
                (Path(d) / "state.json").write_text(content)
            with mock.patch.dict(os.environ, {"A4S_STATE_ROOT": str(Path(d) / "root")}), mock.patch.object(h2, "observe") as observe, mock.patch.object(h2.subprocess, "run") as run, contextlib.redirect_stdout(out):
                code = h2.main(["--po-pane", PO, "--state-dir", d, "--record"])
            self.assertFalse(observe.called)
            self.assertFalse(run.called)
            self.assertFalse((Path(d) / "ticks.jsonl").exists())
            return code, json.loads(out.getvalue())

    def test_malformed_state_is_clean_fail_not_traceback(self):
        cases = {
            "legacy_at_only": json.dumps({"at": NOW}),
            "not_json": "{oops",
            "not_object": "[]",
            "bad_timestamp": json.dumps({"at": "yesterday", "po": {"state_change_seq": 1}, "in_progress": {}}),
            "in_progress_list": json.dumps({"at": NOW, "po": {"state_change_seq": 1}, "in_progress": []}),
            "notified_bad_stamp": json.dumps({"at": NOW, "po": {"state_change_seq": 1}, "in_progress": {}, "notified": {"k": 5}}),
            "offset_string": json.dumps({"at": NOW, "po": {"state_change_seq": 1}, "in_progress": {}, "session_offset": "7"}),
        }
        for name, content in cases.items():
            with self.subTest(name):
                code, report = self.run_with_state(content)
                self.assertEqual((code, report["verdict"]), (2, "FAIL"))
                self.assertEqual(report["reason"], "state_error")

    def test_missing_state_is_first_tick_not_error(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(h2.load_state(Path(d)))

    def test_state_written_by_next_state_round_trips(self):
        with tempfile.TemporaryDirectory() as d:
            durable = h2.write_state(Path(d), h2.next_state(obs(in_progress=[("a4s-3", OLD, "task")]), True, {"FAIL": NOW}, 12, "corr.1"))
            self.assertTrue(durable)
            loaded = h2.load_state(Path(d))
            self.assertEqual((loaded["session_offset"], loaded["correlation_id"]), (12, "corr.1"))

    def test_malformed_state_notifies_on_live(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "state.json").write_text(json.dumps({"at": NOW}))
            with mock.patch.dict(os.environ, {"A4S_STATE_ROOT": str(Path(d) / "root")}), mock.patch.object(h2.subprocess, "run") as run, contextlib.redirect_stdout(io.StringIO()):
                code = h2.main(["--po-pane", PO, "--state-dir", d, "--live"])
            self.assertEqual(code, 2)
            self.assertEqual(run.call_args[0][0][:3], ["herdr", "notification", "show"])

    def test_state_failure_helper_covers_load_write_live_and_notification_failure(self):
        scenarios = [
            (path, live, notification_fails)
            for path in ("load", "write")
            for live, notification_fails in ((False, False), (True, False), (True, True))
        ]
        for path, live, notification_fails in scenarios:
            with self.subTest(path=path, live=live, notification_fails=notification_fails), tempfile.TemporaryDirectory() as d:
                base = Path(d)
                state_dir = base / "state"
                root = base / "root"
                state_dir.mkdir()
                if path == "load":
                    (state_dir / "state.json").write_text("{broken")
                calls = []

                def fake_run(argv, **kwargs):
                    calls.append((argv, kwargs))
                    if argv[:3] == ["herdr", "notification", "show"] and notification_fails:
                        raise OSError("notification failed")
                    return mock.Mock(returncode=0)

                args = ["--po-pane", PO, "--state-dir", str(state_dir), "--live" if live else "--record"]
                out = io.StringIO()
                err = io.StringIO()
                with contextlib.ExitStack() as stack:
                    stack.enter_context(mock.patch.dict(os.environ, {"A4S_STATE_ROOT": str(root)}))
                    stack.enter_context(mock.patch.object(h2.subprocess, "run", side_effect=fake_run))
                    stack.enter_context(mock.patch.object(h2, "observe", return_value=obs()))
                    if path == "write":
                        stack.enter_context(mock.patch.object(h2, "write_state", side_effect=h2.StateError("write failed")))
                    stack.enter_context(contextlib.redirect_stdout(out))
                    stack.enter_context(contextlib.redirect_stderr(err))
                    code = h2.main(args)
                report = json.loads(out.getvalue())
                self.assertEqual((code, report["verdict"], report["reason"]), (2, "FAIL", "state_error"))
                self.assertEqual(err.getvalue(), "")

                notifications = [call for call in calls if call[0][:3] == ["herdr", "notification", "show"]]
                self.assertEqual(len(notifications), 1 if live else 0)
                if live:
                    argv, kwargs = notifications[0]
                    self.assertEqual(argv, ["herdr", "notification", "show", "A4S heartbeat H2 FAIL", "--body", "state_error"])
                    self.assertEqual((kwargs["stdout"], kwargs["stderr"]), (h2.subprocess.DEVNULL, h2.subprocess.DEVNULL))

                records = [json.loads(line) for file in (root / "log" / "heartbeat").glob("*.jsonl") for line in file.read_text().splitlines()]
                failed = next(record for record in records if record["event_name"] == "heartbeat.tick.failed")
                expected_sent = live and not notification_fails
                self.assertEqual(failed["heartbeat.notification_sent"], expected_sent)
                self.assertEqual(failed["heartbeat.verdict"], "FAIL")
                self.assertEqual(failed["heartbeat.reason"], "state_error")
                self.assertEqual(failed["error.code"], "state_invalid" if path == "load" else "state_io")

    def test_outer_state_failures_notify_once_only_in_live_mode(self):
        scenarios = [
            (failure, live, notification_fails)
            for failure in ("prepare", "lock")
            for live, notification_fails in ((False, False), (True, False), (True, True))
        ]
        for failure, live, notification_fails in scenarios:
            with self.subTest(failure=failure, live=live, notification_fails=notification_fails), tempfile.TemporaryDirectory() as d:
                base = Path(d)
                root = base / "root"
                state_dir = base / "state"
                calls = []
                real_secure_open = h2._secure_open

                def fake_run(argv, **kwargs):
                    calls.append((argv, kwargs))
                    if notification_fails:
                        raise OSError("notification failed")
                    return mock.Mock(returncode=0)

                def fail_lock(path, flags, mode=0o600):
                    if Path(path).name == "tick.lock":
                        raise OSError("lock failed")
                    return real_secure_open(path, flags, mode)

                args = ["--po-pane", PO, "--state-dir", str(state_dir), "--live" if live else "--record"]
                out = io.StringIO()
                err = io.StringIO()
                with contextlib.ExitStack() as stack:
                    stack.enter_context(mock.patch.dict(os.environ, {"A4S_STATE_ROOT": str(root)}))
                    stack.enter_context(mock.patch.object(h2.subprocess, "run", side_effect=fake_run))
                    observe = stack.enter_context(mock.patch.object(h2, "observe"))
                    if failure == "prepare":
                        stack.enter_context(mock.patch.object(h2, "ensure_private_dir", side_effect=h2.StateError("prepare failed")))
                    else:
                        stack.enter_context(mock.patch.object(h2, "_secure_open", side_effect=fail_lock))
                    stack.enter_context(contextlib.redirect_stdout(out))
                    stack.enter_context(contextlib.redirect_stderr(err))
                    code = h2.main(args)
                report = json.loads(out.getvalue())
                self.assertEqual((code, report["verdict"], report["reason"]), (2, "FAIL", "state_error"))
                self.assertFalse(observe.called)
                self.assertEqual(err.getvalue(), "")
                notifications = [call for call in calls if call[0][:3] == ["herdr", "notification", "show"]]
                self.assertEqual(len(notifications), 1 if live else 0)
                if live:
                    argv, kwargs = notifications[0]
                    self.assertEqual(argv, ["herdr", "notification", "show", "A4S heartbeat H2 FAIL", "--body", "state_error"])
                    self.assertEqual((kwargs["stdout"], kwargs["stderr"]), (h2.subprocess.DEVNULL, h2.subprocess.DEVNULL))
                if failure == "lock":
                    records = [json.loads(line) for file in (root / "log" / "heartbeat").glob("*.jsonl") for line in file.read_text().splitlines()]
                    failed = next(record for record in records if record["event_name"] == "heartbeat.tick.failed")
                    self.assertEqual(failed["heartbeat.notification_sent"], live and not notification_fails)


class LoggingStorageTests(unittest.TestCase):
    def test_root_precedence_and_default_layout(self):
        state, log, legacy = h2.storage_paths(None, {"HOME": "/home/a", "XDG_STATE_HOME": "/xdg"})
        self.assertEqual(state, Path("/xdg/a4s/state/heartbeat"))
        self.assertEqual(log, Path("/xdg/a4s/log/heartbeat"))
        self.assertEqual(legacy, Path("/home/a/.local/state/a4s/heartbeat-h2"))
        state, log, _ = h2.storage_paths(None, {"HOME": "/home/a", "XDG_STATE_HOME": "/xdg", "A4S_STATE_ROOT": "/custom"})
        self.assertEqual((state, log), (Path("/custom/state/heartbeat"), Path("/custom/log/heartbeat")))
        state, _, legacy = h2.storage_paths(Path("/explicit"), {"HOME": "/home/a", "A4S_STATE_ROOT": "/custom"})
        self.assertEqual((state, legacy), (Path("/explicit"), None))

    def test_legacy_state_is_copied_and_legacy_files_remain(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            env = {"HOME": str(base / "home"), "A4S_STATE_ROOT": str(base / "new")}
            state_dir, _, legacy_dir = h2.storage_paths(None, env)
            prior = h2.next_state(obs(), True, {}, 4, "corr.legacy")
            h2.write_state(legacy_dir, prior)
            ticks = legacy_dir / "ticks.jsonl"
            ticks.write_text("legacy\n")
            before = (legacy_dir / "state.json").read_bytes()
            loaded = h2.load_or_copy_legacy_state(state_dir, legacy_dir)
            self.assertEqual(loaded["correlation_id"], "corr.legacy")
            self.assertEqual((legacy_dir / "state.json").read_bytes(), before)
            self.assertEqual(ticks.read_text(), "legacy\n")
            self.assertEqual(h2.load_state(state_dir)["session_offset"], 4)

    def test_legacy_migration_rejects_symlink_directory_and_parent(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            target = base / "target"
            h2.write_state(target, h2.next_state(obs(), False, {}, 0, "corr.legacy"))

            home = base / "home-final"
            parent = home / ".local" / "state" / "a4s"
            parent.mkdir(parents=True)
            legacy = parent / "heartbeat-h2"
            legacy.symlink_to(target, target_is_directory=True)
            with self.assertRaises(h2.StateError):
                h2.load_or_copy_legacy_state(base / "new-final", legacy)

            home = base / "home-parent"
            parent = home / ".local" / "state"
            parent.mkdir(parents=True)
            linked_parent = parent / "a4s"
            linked_parent.symlink_to(base, target_is_directory=True)
            with self.assertRaises(h2.StateError):
                h2.load_or_copy_legacy_state(base / "new-parent", linked_parent / "heartbeat-h2")

    def test_invalid_health_sidecars_are_bounded_and_safe(self):
        cases = {
            "too_large": b"x" * (h2.MAX_HEALTH_BYTES + 1),
            "huge_integer": ("{\"schema\":\"a4s.logging-health/1\",\"dropped_count\":" + "9" * 5000 + "}").encode(),
            "deep": ("[" * 1100 + "0" + "]" * 1100).encode(),
            "wrong_shape": b'{"schema":"a4s.logging-health/1","dropped_count":{"value":1}}',
            "extra_field": b'{"schema":"a4s.logging-health/1","dropped_count":0,"extra":1}',
            "duplicate_field": b'{"schema":"bad","schema":"a4s.logging-health/1","dropped_count":0}',
            "broken_json": b"{",
            "invalid_unicode": b"\xff",
            "out_of_range": json.dumps({"schema": h2.HEALTH_SCHEMA, "dropped_count": h2.MAX_DROPPED_COUNT + 1}).encode(),
        }
        with tempfile.TemporaryDirectory() as d:
            for name, raw in cases.items():
                with self.subTest(name=name):
                    root = Path(d) / name
                    health_dir = root / "state" / "heartbeat"
                    health_dir.mkdir(parents=True)
                    (health_dir / "logging-health.json").write_bytes(raw)
                    journal = h2.Journal(root / "log" / "heartbeat", "corr.1", "op.1", "record")
                    self.assertEqual(journal.dropped_count, 1)
                    self.assertTrue(journal.health_invalid)
                    self.assertTrue(journal.append("heartbeat.tick.completed"))
                    record = json.loads(next((root / "log" / "heartbeat").glob("*.jsonl")).read_text())
                    self.assertTrue(record["a4s.logging.lossy"])
                    self.assertEqual(record["a4s.logging.dropped_count"], 1)

            root = Path(d) / "read-error"
            with mock.patch.object(h2, "_secure_open", side_effect=OSError("read failed")):
                journal = h2.Journal(root / "log" / "heartbeat", "corr.1", "op.1", "record")
            self.assertEqual(journal.dropped_count, 1)
            self.assertTrue(journal.health_invalid)

    def test_invalid_health_sidecar_does_not_change_tick_or_write_stderr(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "root"
            health_dir = root / "state" / "heartbeat"
            health_dir.mkdir(parents=True)
            (health_dir / "logging-health.json").write_text("{broken")
            out = io.StringIO()
            err = io.StringIO()
            with mock.patch.dict(os.environ, {"A4S_STATE_ROOT": str(root)}), mock.patch.object(h2, "observe", return_value=obs()), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = h2.main(["--po-pane", PO, "--state-dir", str(Path(d) / "state"), "--record"])
            self.assertEqual((code, json.loads(out.getvalue())["verdict"]), (0, "BASELINE"))
            self.assertEqual(err.getvalue(), "")
            records = [json.loads(line) for path in (root / "log" / "heartbeat").glob("*.jsonl") for line in path.read_text().splitlines()]
            self.assertTrue(all(record["a4s.logging.lossy"] for record in records))
            self.assertTrue(all(record["a4s.logging.dropped_count"] == 1 for record in records))

    def test_private_permissions_for_directories_and_files(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "a4s"
            state_dir = root / "state" / "heartbeat"
            for path in (root, root / "state"):
                h2.ensure_private_dir(path)
            with h2.tick_lock(state_dir):
                h2.write_state(state_dir, h2.next_state(obs(), False, {}, 0, "corr.1"))
            journal = h2.Journal(root / "log" / "heartbeat", "corr.1", "op.1", "record")
            journal.append("heartbeat.tick.started", at=datetime(2026, 9, 19, tzinfo=timezone.utc))
            for path in (root, root / "state", state_dir, root / "log", root / "log" / "heartbeat"):
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)
            for path in (state_dir / "tick.lock", state_dir / "state.json", root / "log" / "heartbeat" / "2026-09-19.jsonl"):
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_symlinks_are_rejected_for_state_lock_and_journal(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            target = base / "target"
            target.write_text("safe")
            state_dir = base / "state"
            state_dir.mkdir()
            (state_dir / "state.json").symlink_to(target)
            with self.assertRaises(h2.StateError):
                h2.load_state(state_dir)
            lock_dir = base / "lock"
            lock_dir.mkdir()
            (lock_dir / "tick.lock").symlink_to(target)
            with self.assertRaises(h2.StateError):
                with h2.tick_lock(lock_dir):
                    pass
            log_dir = base / "root" / "log" / "heartbeat"
            log_dir.mkdir(parents=True)
            (log_dir / "2026-09-19.jsonl").symlink_to(target)
            h2.Journal(log_dir, "corr.1", "op.1", "record").append(
                "heartbeat.tick.started", at=datetime(2026, 9, 19, tzinfo=timezone.utc)
            )
            self.assertEqual(target.read_text(), "safe")

    def test_lock_contention_is_nonblocking(self):
        with tempfile.TemporaryDirectory() as d:
            with h2.tick_lock(Path(d)):
                with self.assertRaises(h2.LockBusy):
                    with h2.tick_lock(Path(d)):
                        pass

    def test_journal_rolls_over_by_utc_date_and_keeps_old_files(self):
        with tempfile.TemporaryDirectory() as d:
            log_dir = Path(d) / "log" / "heartbeat"
            journal = h2.Journal(log_dir, "corr.1", "op.1", "record")
            journal.append("heartbeat.tick.started", at=datetime(2026, 9, 19, 23, 59, tzinfo=timezone.utc))
            journal.append("heartbeat.tick.completed", at=datetime(2026, 9, 20, 0, 1, tzinfo=timezone.utc))
            self.assertEqual(sorted(path.name for path in log_dir.glob("*.jsonl")), ["2026-09-19.jsonl", "2026-09-20.jsonl"])

    def test_journal_completes_short_writes(self):
        with tempfile.TemporaryDirectory() as d:
            log_dir = Path(d) / "log" / "heartbeat"
            journal = h2.Journal(log_dir, "corr.1", "op.1", "record")
            real_write = os.write
            calls = []

            def short_write(fd, payload):
                calls.append(len(payload))
                return real_write(fd, payload[:7])

            with mock.patch.object(h2.os, "write", side_effect=short_write):
                written = journal.append(
                    "heartbeat.tick.completed",
                    at=datetime(2026, 9, 19, tzinfo=timezone.utc),
                )
            raw = (log_dir / "2026-09-19.jsonl").read_bytes()
            self.assertTrue(written)
            self.assertGreater(len(calls), 1)
            self.assertTrue(raw.endswith(b"\n"))
            self.assertEqual(raw.count(b"\n"), 1)
            self.assertEqual(json.loads(raw)["event_name"], "heartbeat.tick.completed")

    def test_journal_reports_prior_loss_on_next_success(self):
        with tempfile.TemporaryDirectory() as d:
            log_dir = Path(d) / "log" / "heartbeat"
            journal = h2.Journal(log_dir, "corr.1", "op.1", "record")
            real_write = os.write
            attempts = 0

            def fail_first(fd, payload):
                nonlocal attempts
                attempts += 1
                if attempts == 1:
                    return 0
                return real_write(fd, payload)

            with mock.patch.object(h2.os, "write", side_effect=fail_first):
                self.assertFalse(journal.append("heartbeat.tick.started"))
                self.assertTrue(journal.append("heartbeat.tick.completed"))
            record = json.loads(next(log_dir.glob("*.jsonl")).read_text())
            self.assertEqual(record["event_name"], "heartbeat.tick.completed")
            self.assertTrue(record["a4s.logging.lossy"])
            self.assertEqual(record["a4s.logging.dropped_count"], 1)
            self.assertEqual(journal.dropped_count, 1)

    def test_partial_write_is_rolled_back_before_next_append(self):
        with tempfile.TemporaryDirectory() as d:
            log_dir = Path(d) / "log" / "heartbeat"
            journal = h2.Journal(log_dir, "corr.1", "op.1", "record")
            real_write = os.write
            attempts = 0

            def partial_then_error(fd, payload):
                nonlocal attempts
                attempts += 1
                if attempts == 1:
                    return real_write(fd, payload[:11])
                if attempts == 2:
                    raise OSError("write failed")
                return real_write(fd, payload)

            with mock.patch.object(h2.os, "write", side_effect=partial_then_error):
                self.assertFalse(journal.append("heartbeat.tick.started"))
                self.assertTrue(journal.append("heartbeat.tick.completed"))
            raw = next(log_dir.glob("*.jsonl")).read_bytes()
            self.assertEqual(raw.count(b"\n"), 1)
            self.assertEqual(json.loads(raw)["event_name"], "heartbeat.tick.completed")
            self.assertFalse(journal.disabled)

    def test_failed_rollback_disables_journal_and_preserves_fragment(self):
        with tempfile.TemporaryDirectory() as d:
            log_dir = Path(d) / "log" / "heartbeat"
            journal = h2.Journal(log_dir, "corr.1", "op.1", "record")
            real_write = os.write
            attempts = 0

            def partial_then_error(fd, payload):
                nonlocal attempts
                attempts += 1
                if attempts == 1:
                    return real_write(fd, payload[:9])
                raise OSError("write failed")

            with mock.patch.object(h2.os, "write", side_effect=partial_then_error), mock.patch.object(h2.os, "ftruncate", side_effect=OSError("rollback failed")):
                self.assertFalse(journal.append("heartbeat.tick.started"))
            path = next(log_dir.glob("*.jsonl"))
            fragment = path.read_bytes()
            self.assertTrue(journal.disabled)
            self.assertFalse(journal.append("heartbeat.tick.completed"))
            self.assertEqual(path.read_bytes(), fragment)
            other = h2.Journal(log_dir, "corr.2", "op.2", "record")
            self.assertFalse(other.append("heartbeat.tick.completed"))
            self.assertTrue(other.disabled)
            self.assertEqual(path.read_bytes(), fragment)

    def test_loss_counter_survives_between_journal_instances(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "root"
            log_dir = root / "log" / "heartbeat"
            first = h2.Journal(log_dir, "corr.1", "op.1", "record")
            real_open = h2._secure_open

            def fail_journal_open(path, flags, mode=0o600):
                if str(path).endswith(".jsonl"):
                    raise OSError("journal unavailable")
                return real_open(path, flags, mode)

            with mock.patch.object(h2, "_secure_open", side_effect=fail_journal_open):
                self.assertFalse(first.append("heartbeat.tick.started"))
            health_dir = root / "state" / "heartbeat"
            health = health_dir / "logging-health.json"
            self.assertEqual(json.loads(health.read_text()), {"schema": h2.HEALTH_SCHEMA, "dropped_count": 1})
            self.assertEqual(stat.S_IMODE(health_dir.parent.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(health_dir.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(health.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE((health_dir / "logging-health.lock").stat().st_mode), 0o600)

            second = h2.Journal(log_dir, "corr.2", "op.2", "record")
            self.assertEqual(second.dropped_count, 1)
            self.assertTrue(second.append("heartbeat.tick.completed"))
            record = json.loads(next(log_dir.glob("*.jsonl")).read_text())
            self.assertTrue(record["a4s.logging.lossy"])
            self.assertEqual(record["a4s.logging.dropped_count"], 1)

    def test_jsonl_schema_ids_and_redaction(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "root"
            state = Path(d) / "state"
            args = ["--po-pane", PO, "--repo", "/secret/repo", "--state-dir", str(state), "--record"]
            outputs = []
            with mock.patch.dict(os.environ, {"A4S_STATE_ROOT": str(root)}), mock.patch.object(h2, "observe", return_value=obs()):
                for _ in range(2):
                    out = io.StringIO()
                    with contextlib.redirect_stdout(out):
                        self.assertEqual(h2.main(args), 0)
                    outputs.append(json.loads(out.getvalue()))
            records = [json.loads(line) for path in (root / "log" / "heartbeat").glob("*.jsonl") for line in path.read_text().splitlines()]
            self.assertEqual([r["event_name"] for r in records], ["heartbeat.tick.started", "heartbeat.tick.completed"] * 2)
            self.assertEqual({r["schema"] for r in records}, {"a4s.log/1"})
            self.assertEqual({(r["severity_text"], r["severity_number"]) for r in records}, {("INFO", 9)})
            self.assertTrue(all(r["timestamp"].endswith("Z") for r in records))
            self.assertTrue(all(h2.parse_ts(r["timestamp"]).tzinfo is not None for r in records))
            self.assertEqual({r["resource.host.id_hash"] for r in records}, {"unknown"})
            self.assertEqual({r["resource.a4s.harness.kind"] for r in records}, {"python-cli"})
            self.assertEqual({r["resource.a4s.harness.role"] for r in records}, {"scheduler"})
            self.assertEqual({r["a4s.logging.lossy"] for r in records}, {False})
            self.assertEqual({r["attributes.a4s.correlation_id"] for r in records}, {h2.load_state(state)["correlation_id"]})
            operations = [r["attributes.a4s.operation_id"] for r in records]
            self.assertEqual(operations[0], operations[1])
            self.assertEqual(operations[2], operations[3])
            self.assertNotEqual(operations[0], operations[2])
            encoded = "\n".join(json.dumps(r) for r in records)
            for forbidden in ("/secret/repo", PO, "--repo", "HEARTBEAT:", "token"):
                self.assertNotIn(forbidden, encoded)

    def test_journal_failure_does_not_change_result_or_state(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "root"
            state = Path(d) / "state"
            real_open = h2._secure_open

            def fail_jsonl(path, flags, mode=0o600):
                if str(path).endswith(".jsonl"):
                    raise OSError("journal unavailable")
                return real_open(path, flags, mode)

            out = io.StringIO()
            with mock.patch.dict(os.environ, {"A4S_STATE_ROOT": str(root)}), mock.patch.object(h2, "observe", return_value=obs()), mock.patch.object(h2, "_secure_open", side_effect=fail_jsonl), mock.patch.object(h2, "_write_health_counter", return_value=False), contextlib.redirect_stdout(out):
                code = h2.main(["--po-pane", PO, "--state-dir", str(state), "--record"])
            self.assertEqual((code, json.loads(out.getvalue())["verdict"]), (0, "BASELINE"))
            self.assertTrue((state / "state.json").exists())

    def test_secure_open_closes_once_when_fstat_fails(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "file"
            path.write_text("x")
            real_open = os.open
            real_close = os.close
            real_fstat = os.fstat
            fd = real_open(path, os.O_RDONLY)
            with mock.patch.object(h2.os, "open", return_value=fd), mock.patch.object(h2.os, "fstat", side_effect=OSError("fstat failed")), mock.patch.object(h2.os, "close", side_effect=real_close) as close:
                with self.assertRaises(OSError):
                    h2._secure_open(path, os.O_RDONLY)
                self.assertEqual(close.call_count, 1)
            with self.assertRaises(OSError):
                real_fstat(fd)

    def test_secure_open_closes_once_when_fchmod_fails(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "file"
            path.write_text("x")
            real_open = os.open
            real_close = os.close
            real_fstat = os.fstat
            fd = real_open(path, os.O_RDWR)
            with mock.patch.object(h2.os, "open", return_value=fd), mock.patch.object(h2.os, "fchmod", side_effect=OSError("fchmod failed")), mock.patch.object(h2.os, "close", side_effect=real_close) as close:
                with self.assertRaises(OSError):
                    h2._secure_open(path, os.O_RDWR)
                self.assertEqual(close.call_count, 1)
            with self.assertRaises(OSError):
                real_fstat(fd)

    def test_secure_open_closes_once_when_file_type_is_invalid(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d)
            real_open = os.open
            real_close = os.close
            real_fstat = os.fstat
            fd = real_open(path, os.O_RDONLY)
            with mock.patch.object(h2.os, "open", return_value=fd), mock.patch.object(h2.os, "close", side_effect=real_close) as close:
                with self.assertRaises(OSError):
                    h2._secure_open(path, os.O_RDONLY)
                self.assertEqual(close.call_count, 1)
            with self.assertRaises(OSError):
                real_fstat(fd)

    def test_atomic_write_keeps_previous_state_on_replace_failure(self):
        with tempfile.TemporaryDirectory() as d:
            state_dir = Path(d)
            original = h2.next_state(obs(), False, {}, 0, "corr.old")
            h2.write_state(state_dir, original)
            before = (state_dir / "state.json").read_bytes()
            with mock.patch.object(h2.os, "replace", side_effect=OSError("replace failed")):
                with self.assertRaises(h2.StateError):
                    h2.write_state(state_dir, h2.next_state(obs(), True, {}, 2, "corr.new"))
            self.assertEqual((state_dir / "state.json").read_bytes(), before)
            self.assertEqual(list(state_dir.glob(".state-*")), [])

    def test_atomic_write_commits_private_file_before_directory_fsync(self):
        with tempfile.TemporaryDirectory() as d:
            state_dir = Path(d)
            replacement_modes = []
            real_replace = os.replace
            real_fsync = os.fsync

            def inspect_replace(source, target):
                replacement_modes.append(stat.S_IMODE(Path(source).stat().st_mode))
                return real_replace(source, target)

            def fail_directory_fsync(fd):
                if stat.S_ISDIR(os.fstat(fd).st_mode):
                    raise OSError("directory fsync failed")
                return real_fsync(fd)

            state = h2.next_state(obs(), False, {}, 0, "corr.new")
            with mock.patch.object(h2.os, "replace", side_effect=inspect_replace), mock.patch.object(h2.os, "fsync", side_effect=fail_directory_fsync):
                durable = h2.write_state(state_dir, state)
            self.assertFalse(durable)
            self.assertEqual(replacement_modes, [0o600])
            self.assertEqual(stat.S_IMODE((state_dir / "state.json").stat().st_mode), 0o600)
            self.assertEqual(h2.load_state(state_dir)["correlation_id"], "corr.new")

    def test_uncertain_state_durability_emits_warn_without_changing_result(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "root"
            state_dir = Path(d) / "state"
            real_fsync = os.fsync

            def fail_directory_fsync(fd):
                if stat.S_ISDIR(os.fstat(fd).st_mode):
                    raise OSError("directory fsync failed")
                return real_fsync(fd)

            out = io.StringIO()
            with mock.patch.dict(os.environ, {"A4S_STATE_ROOT": str(root)}), mock.patch.object(h2, "observe", return_value=obs()), mock.patch.object(h2.os, "fsync", side_effect=fail_directory_fsync), contextlib.redirect_stdout(out):
                code = h2.main(["--po-pane", PO, "--state-dir", str(state_dir), "--record"])
            self.assertEqual((code, json.loads(out.getvalue())["verdict"]), (0, "BASELINE"))
            records = [json.loads(line) for path in (root / "log" / "heartbeat").glob("*.jsonl") for line in path.read_text().splitlines()]
            warning = next(record for record in records if record["event_name"] == "heartbeat.state.durability_uncertain")
            self.assertEqual((warning["severity_text"], warning["severity_number"]), ("WARN", 13))
            self.assertFalse(warning["heartbeat.state.durable"])

    def test_plist_discards_standard_streams_and_keeps_schedule(self):
        plist = HELPER.with_name("com.pablontiv.a4s.orchestrator-heartbeat-h2.plist.example")
        with plist.open("rb") as handle:
            data = plistlib.load(handle)
        self.assertEqual((data["StandardOutPath"], data["StandardErrorPath"]), ("/dev/null", "/dev/null"))
        self.assertEqual(data["StartInterval"], 300)
        self.assertIn("--live", data["ProgramArguments"])


class ContractTests(unittest.TestCase):
    def test_helper_has_no_wait_sleep_or_timeout_machinery(self):
        source = HELPER.read_text().replace(h2.WAKE_TEXT, "")
        for forbidden in ("sleep", "timeout=", '"wait"', "while True", "retry"):
            self.assertNotIn(forbidden, source)

    def test_helper_never_mutates_beads_lifecycle(self):
        source = HELPER.read_text()
        for forbidden in ('"close"', '"update"', '"--claim"', '"create"'):
            self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main()
