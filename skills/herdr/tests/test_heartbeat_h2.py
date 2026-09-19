"""Offline tests for the H2 heartbeat reconciler.

Every scenario injects synthetic Beads/Herdr observations or a fake runner. No
Herdr session, Bead database, model, or provider is contacted.
"""

from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
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
        "closed": list(closed),
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
                return [{"id": "a4s-0"}]
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
        self.assertEqual(result["closed"], ["a4s-0"])


class MainTests(unittest.TestCase):
    def run_main(self, args, observation, subprocess_results=None):
        calls = []

        def fake_run(argv, **_kwargs):
            calls.append(argv)
            return mock.Mock(returncode=(subprocess_results or {}).get(argv[1] + argv[2], 0))

        out = io.StringIO()
        with mock.patch.object(h2, "observe", return_value=observation), mock.patch.object(h2.subprocess, "run", fake_run), contextlib.redirect_stdout(out):
            code = h2.main(args)
        return code, json.loads(out.getvalue()), calls

    def test_default_is_read_only_no_wake_no_state(self):
        with tempfile.TemporaryDirectory() as d:
            code, _, calls = self.run_main(["--po-pane", PO, "--state-dir", d], obs(ready=["a4s-3"]))
            self.assertEqual((code, calls), (0, []))
            self.assertEqual(list(Path(d).iterdir()), [])

    def test_live_wakes_orchestrator_once_and_notifies_stale_evidence(self):
        with tempfile.TemporaryDirectory() as d:
            self.run_main(["--po-pane", PO, "--state-dir", d, "--live"], obs())
            code, report, calls = self.run_main(["--po-pane", PO, "--state-dir", d, "--live"], obs(ready=["a4s-3"]))
            self.assertEqual((code, report["verdict"], report["wake_sent"]), (0, "PASS_STALE", True))
            wake = next(c for c in calls if c[:3] == ["herdr", "agent", "prompt"])
            self.assertEqual(wake[3], PO)
            self.assertIn("STALE_WORK pane_id=w4J:p3 bead_id=a4s-3", wake[4])
            self.assertEqual(sum(1 for c in calls if c[:3] == ["herdr", "notification", "show"]), 1)
            ticks = (Path(d) / "ticks.jsonl").read_text().splitlines()
            self.assertEqual([json.loads(t)["verdict"] for t in ticks], ["BASELINE", "PASS_STALE"])

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
            self.assertEqual(json.loads((Path(d) / "ticks.jsonl").read_text())["verdict"], "FAIL")

    def test_unobservable_state_is_fail_not_silence(self):
        out = io.StringIO()
        with mock.patch.object(h2, "observe", side_effect=h2.ObserveError("bd: exit 1")), contextlib.redirect_stdout(out):
            code = h2.main(["--po-pane", PO])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(out.getvalue())["reason"], "observe_error: bd: exit 1")


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
