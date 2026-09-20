"""Offline tests for helper/task_result.py (TASK_RESULT record + the harvest gate's rule set, bead a4s-ya4.11).

`bd` is replaced by an in-memory stateful fake (or, for the CLI test, a fake executable). No Beads database,
Herdr session, agent or provider is touched. Artifacts are real files under a temp dir.
"""

from __future__ import annotations

import copy
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HELPER = Path(__file__).resolve().parents[1] / "helper" / "task_result.py"
sys.path.insert(0, str(HELPER.parent))

import task_ack as ta  # noqa: E402
import task_result as tr  # noqa: E402

BEAD = "a4s-ya4.11"
CORR = "corr.a4s-ya4.11.1789000000.0"
ASSIGNEE = "Pablo"
T_RESULT = "2026-09-20T03:00:00Z"
T_LATER = "2026-09-20T04:00:00Z"


class FakeBd:
    """Stateful `bd show/update` over an in-memory Bead table; enforces bd's assignee guard."""

    def __init__(self, **beads):
        self.beads = beads
        self.writes = []  # (argv, BEADS_ACTOR)

    def __call__(self, argv, cwd=None, env=None):
        cmd, bead_id = argv[1], argv[2]
        bead = self.beads.get(bead_id)
        if bead is None:
            return 1, "", "issue not found"
        if cmd == "show":
            return 0, json.dumps([copy.deepcopy(bead)]), ""
        actor = (env or {}).get("BEADS_ACTOR", "")
        if bead.get("assignee") and actor != bead["assignee"]:
            return 1, "", 'assignee is "%s", actor is "%s"' % (bead["assignee"], actor)
        self.writes.append((argv, actor))
        m = bead.setdefault("metadata", {})
        rest = argv[3:]
        for flag, val in zip(rest[::2], rest[1::2]):
            if flag == "--set-metadata":
                k, _, v = val.partition("=")
                m[k] = v
            elif flag == "--unset-metadata":
                m.pop(val, None)
        return 0, "", ""


def bead(**metadata):
    md = {"correlation_id": CORR, "worker": "w1", "pane": "wT:p9", "tab": "wT:t9", "receipt_id": "rcpt.1",
          "received_at": "2026-09-20T01:00:00Z", "acknowledged_at": "2026-09-20T01:00:01Z", "acknowledged_by": "w1"}
    md.update(metadata)
    md = {k: v for k, v in md.items() if v is not None}
    return {"id": BEAD, "status": "in_progress", "assignee": ASSIGNEE, "metadata": md}


class TaskResultTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.state = str(self.dir / "state")
        self.report = str(self.dir / "report.md")
        Path(self.report).write_text("# report\n")

    def tearDown(self):
        self.tmp.cleanup()

    def env(self, **over):
        f = dict(result_id="res.1", correlation_id=CORR, bead_id=BEAD, result_by="w1", verdict="pass",
                 artifact_path=self.report)
        f.update(over)
        return tr.build_result(**f)

    def run_env(self, fake, envelope=None, **kw):
        return tr.handle(envelope if envelope is not None else self.env(), ta.Beads("/repo", runner=fake),
                         self.state, **kw)

    def md(self, fake):
        return fake.beads[BEAD]["metadata"]

    def tickets(self, pattern="*.md"):
        d = Path(self.state) / "attention"
        return sorted(p.name for p in d.glob(pattern)) if d.exists() else []

    def assert_no_write(self, fake, res, code):
        self.assertEqual((res["status"], res["code"]), ("ATTENTION", code), res)
        self.assertEqual(fake.writes, [])
        self.assertFalse(any(k in self.md(fake) for k in ("result_id", "result_verdict")))
        self.assertTrue(res["envelope"].startswith("ATTENTION REQUIRED verdict=blocked artifact_path="))

    # ------------------------------------------------------------- recording
    def test_records_the_full_result_in_one_write_as_assignee(self):
        fake = FakeBd(**{BEAD: bead()})
        code, res = self.run_env(fake, now=T_RESULT)
        self.assertEqual((code, res["status"]), (0, "RECORDED"))
        md = self.md(fake)
        self.assertEqual({k: md[k] for k in tr.RESULT_FIELDS}, {
            "result_id": "res.1", "result_at": T_RESULT, "result_by": "w1", "result_verdict": "pass",
            "result_artifact_path": self.report, "result_correlation_id": CORR})
        self.assertEqual(md["correlation_id"], CORR)  # the dispatcher's stamp is untouched
        self.assertEqual(len(fake.writes), 1)  # one atomic bd update
        self.assertEqual(fake.writes[0][1], ASSIGNEE)
        self.assertNotIn("--force", fake.writes[0][0])
        self.assertEqual(res["envelope"], self.env())
        self.assertEqual(res["callback_envelope"], "WORK_RESULT SUBMITTED verdict=pass artifact_path=%s bead_id=%s "
                         "result_id=res.1 correlation_id=%s" % (self.report, BEAD, CORR))
        self.assertEqual(self.tickets(), [])

    def test_both_verdicts_are_recorded_verbatim(self):
        for verdict in ("pass", "fail"):
            with self.subTest(verdict):
                fake = FakeBd(**{BEAD: bead()})
                self.assertEqual(self.run_env(fake, self.env(verdict=verdict))[0], 0)
                self.assertEqual(self.md(fake)["result_verdict"], verdict)

    def test_record_read_back_is_valid(self):
        fake = FakeBd(**{BEAD: bead()})
        self.run_env(fake)
        state, rec = tr.verify_record(self.md(fake), "w1")
        self.assertEqual((state, rec["result_verdict"], rec["result_artifact_path"]), ("valid", "pass", self.report))

    # ------------------------------------------------------------- correlation
    def test_missing_correlation_fails_closed(self):
        fake = FakeBd(**{BEAD: bead()})
        code, res = self.run_env(fake, self.env(correlation_id=""))
        self.assertEqual(code, 3)
        self.assert_no_write(fake, res, "MISSING_CORRELATION")
        self.assertEqual(len(self.tickets("%s--TASK_RESULT_MISSING_CORRELATION--*.md" % BEAD)), 1)

    def test_mismatched_correlation_fails_closed(self):
        fake = FakeBd(**{BEAD: bead()})
        code, res = self.run_env(fake, self.env(correlation_id="corr.a4s-ya4.11.1.0"))
        self.assertEqual(code, 3)
        self.assert_no_write(fake, res, "CORRELATION_MISMATCH")

    def test_uncorrelated_bead_cannot_record_a_result(self):
        fake = FakeBd(**{BEAD: bead(correlation_id=None)})
        self.assert_no_write(fake, self.run_env(fake)[1], "BEAD_UNCORRELATED")

    def test_bead_must_be_in_progress(self):
        b = bead()
        b["status"] = "closed"
        fake = FakeBd(**{BEAD: b})
        self.assert_no_write(fake, self.run_env(fake)[1], "BEAD_NOT_IN_PROGRESS")

    def test_unreadable_bead_fails_closed(self):
        self.assertEqual(self.run_env(FakeBd())[1]["code"], "BEAD_UNREADABLE")

    # ------------------------------------------------------------- closed verdict set / grammar
    def test_verdict_outside_the_closed_set_is_rejected(self):
        for verdict in ("PASS", "unverified", "ok", "pass,fail", "passed", "blocked", "Pass"):
            with self.subTest(verdict):
                fake = FakeBd(**{BEAD: bead()})
                code, res = self.run_env(fake, self.env(verdict=verdict))
                self.assertEqual(code, 3)
                self.assert_no_write(fake, res, "INVALID_VERDICT")

    def test_missing_fields_are_rejected(self):
        for field, code in (("result_id", "MISSING_ID"), ("result_by", "MISSING_FIELD"), ("verdict", "MISSING_FIELD"),
                            ("artifact_path", "MISSING_FIELD"), ("bead_id", "MISSING_FIELD")):
            with self.subTest(field):
                fake = FakeBd(**{BEAD: bead()})
                code_, res = self.run_env(fake, self.env(**{field: ""}))
                self.assertEqual((code_, res["code"]), (3, code))
                self.assertEqual(fake.writes, [])

    def test_free_text_and_unknown_or_repeated_keys_are_malformed(self):
        cases = ["", "WORK_RESULT SUBMITTED verdict=pass", "TASK_RESULT RECORDED " + "a" * 5,
                 self.env() + " extra=1", self.env() + " verdict=fail", self.env() + " and some free text",
                 "  " + self.env().replace("TASK_RESULT", "task_result"),
                 self.env(result_id="res 1").replace("result_id=res 1", "result_id=")]
        for envelope in cases:
            with self.subTest(envelope[:60]):
                fake = FakeBd(**{BEAD: bead()})
                code, res = self.run_env(fake, envelope)
                self.assertEqual(code, 3, res)
                self.assertEqual(fake.writes, [])

    def test_hostile_values_are_rejected(self):
        for over in ({"result_id": "-x"}, {"result_by": "w1;rm"}, {"result_id": "a" * 129}):
            with self.subTest(over):
                fake = FakeBd(**{BEAD: bead()})
                code, res = self.run_env(fake, self.env(**over))
                self.assertEqual((code, res["code"]), (3, "MALFORMED"))
                self.assertEqual(fake.writes, [])

    # ------------------------------------------------------------- safe artifact path
    def test_unsafe_artifact_paths_are_rejected(self):
        for path in ("relative/report.md", "/tmp/../etc/passwd", "/tmp//x.md", "//x.md", "/tmp/./x.md", "/tmp/dir/",
                     "/tmp/x;y.md", "/tmp/$HOME.md", "/" + "a" * 300, "/", "~/x.md"):
            with self.subTest(path[:40]):
                fake = FakeBd(**{BEAD: bead()})
                code, res = self.run_env(fake, self.env(artifact_path=path))
                self.assertEqual(code, 3)
                self.assert_no_write(fake, res, "UNSAFE_ARTIFACT")

    def test_a_path_with_a_space_cannot_smuggle_extra_tokens(self):
        fake = FakeBd(**{BEAD: bead()})
        code, res = self.run_env(fake, self.env(artifact_path="/tmp/a b.md"))  # splits into a stray token
        self.assertEqual((code, res["code"]), (3, "MALFORMED"))
        self.assertEqual(fake.writes, [])

    def test_artifact_must_exist_as_a_regular_file(self):
        target = self.dir / "real.md"
        target.write_text("x")
        link = self.dir / "link.md"
        link.symlink_to(target)
        for path in (str(self.dir / "absent.md"), str(self.dir), str(link)):
            with self.subTest(path[-12:]):
                fake = FakeBd(**{BEAD: bead()})
                code, res = self.run_env(fake, self.env(artifact_path=path))
                self.assertEqual(code, 3)
                self.assert_no_write(fake, res, "ARTIFACT_MISSING")

    # ------------------------------------------------------------- identity
    def test_result_by_must_be_the_dispatcher_stamped_worker(self):
        fake = FakeBd(**{BEAD: bead()})
        code, res = self.run_env(fake, self.env(result_by="w2"))
        self.assertEqual(code, 3)
        self.assert_no_write(fake, res, "IDENTITY_MISMATCH")

    def test_result_by_must_be_the_agent_that_acked(self):
        fake = FakeBd(**{BEAD: bead(acknowledged_by="w2")})
        self.assert_no_write(fake, self.run_env(fake)[1], "IDENTITY_MISMATCH")

    def test_unstamped_worker_cannot_be_verified(self):
        fake = FakeBd(**{BEAD: bead(worker=None)})
        self.assert_no_write(fake, self.run_env(fake)[1], "IDENTITY_UNVERIFIABLE")

    # ------------------------------------------------------------- TASK_ACK / TASK_STARTED compatibility
    def test_result_requires_a_recorded_ack_and_never_infers_one(self):
        fake = FakeBd(**{BEAD: bead(receipt_id=None, received_at=None, acknowledged_at=None, acknowledged_by=None)})
        self.assert_no_write(fake, self.run_env(fake)[1], "RESULT_WITHOUT_ACK")
        self.assertNotIn("receipt_id", self.md(fake))

    def test_result_does_not_require_or_touch_the_start_record(self):
        fake = FakeBd(**{BEAD: bead()})  # acked, not started
        self.assertEqual(self.run_env(fake)[0], 0)
        md = self.md(fake)
        self.assertNotIn("start_id", md)
        self.assertEqual(md["receipt_id"], "rcpt.1")  # the ack record is preserved

    def test_result_preserves_a_recorded_start(self):
        fake = FakeBd(**{BEAD: bead(start_id="start.1", started_at="2026-09-20T01:00:30Z")})
        self.assertEqual(self.run_env(fake)[0], 0)
        self.assertEqual((self.md(fake)["start_id"], self.md(fake)["started_at"]), ("start.1", "2026-09-20T01:00:30Z"))

    def test_ack_and_start_helpers_still_work_next_to_a_result(self):
        fake = FakeBd(**{BEAD: bead(receipt_id=None, received_at=None, acknowledged_at=None, acknowledged_by=None)})
        beads = ta.Beads("/repo", runner=fake)
        ta.handle("ack", ta.build_ack("rcpt.1", CORR, BEAD, "w1"), beads, self.state)
        ta.handle("start", ta.build_start("start.1", CORR, BEAD, "w1", "wT:p9", "wT:t9"), beads, self.state)
        self.assertEqual(self.run_env(fake)[0], 0)
        self.assertEqual({k: self.md(fake).get(k) for k in ("receipt_id", "start_id", "result_id")},
                         {"receipt_id": "rcpt.1", "start_id": "start.1", "result_id": "res.1"})

    # ------------------------------------------------------------- duplicate / conflict
    def test_same_result_twice_is_a_noop_that_keeps_the_original_time(self):
        fake = FakeBd(**{BEAD: bead()})
        self.run_env(fake, now=T_RESULT)
        before = copy.deepcopy(self.md(fake))
        code, res = self.run_env(fake, now=T_LATER)
        self.assertEqual((code, res["status"]), (0, "DUPLICATE"))
        self.assertEqual(self.md(fake), before)
        self.assertEqual(len(fake.writes), 1)
        self.assertEqual(res["callback_envelope"].split()[0:2], ["WORK_RESULT", "SUBMITTED"])  # the retry may still callback

    def test_duplicate_does_not_need_the_artifact_to_still_exist(self):
        fake = FakeBd(**{BEAD: bead()})
        self.run_env(fake)
        Path(self.report).unlink()
        self.assertEqual(self.run_env(fake)[1]["status"], "DUPLICATE")

    def test_conflicting_results_are_never_overwritten(self):
        other = self.dir / "other.md"
        other.write_text("y")
        cases = {"different result_id": self.env(result_id="res.2"),
                 "same id, different verdict": self.env(verdict="fail"),
                 "same id, different artifact": self.env(artifact_path=str(other))}
        for name, envelope in cases.items():
            with self.subTest(name):
                fake = FakeBd(**{BEAD: bead()})
                self.run_env(fake, now=T_RESULT)
                before = copy.deepcopy(self.md(fake))
                code, res = self.run_env(fake, envelope, now=T_LATER)
                self.assertEqual((code, res["code"]), (3, "RESULT_CONFLICT"))
                self.assertEqual(self.md(fake), before)
                self.assertEqual(len(fake.writes), 1)

    def test_stale_partial_result_keys_are_replaced_only_by_a_complete_record(self):
        fake = FakeBd(**{BEAD: bead(result_verdict="pass")})  # a lone, hand-written key
        code, _ = self.run_env(fake)
        self.assertEqual(code, 0)
        self.assertEqual(tr.verify_record(self.md(fake), "w1")[0], "valid")

    # ------------------------------------------------------------- re-dispatch reset
    def test_a_result_of_the_previous_dispatch_cannot_be_recorded_after_redispatch(self):
        fake = FakeBd(**{BEAD: bead()})
        self.run_env(fake)
        # the reconciler re-dispatches: new correlation, previous ack/start/result cleared, worker re-stamped
        new_corr = "corr.a4s-ya4.11.1789000999.1"
        m = self.md(fake)
        for key in ta.RESET_FIELDS + tr.RESULT_FIELDS:
            m.pop(key, None)
        m.update(correlation_id=new_corr, worker="w1-1", redispatch="1")
        stale = self.run_env(fake, self.env(result_id="res.old"))  # the old worker still holds the old correlation
        self.assertEqual((stale[0], stale[1]["code"]), (3, "CORRELATION_MISMATCH"))
        # the new worker acks and records normally; the old record left no trace
        ta.handle("ack", ta.build_ack("rcpt.2", new_corr, BEAD, "w1-1"), ta.Beads("/repo", runner=fake), self.state)
        code, res = self.run_env(fake, self.env(result_id="res.new", correlation_id=new_corr, result_by="w1-1"))
        self.assertEqual((code, res["status"]), (0, "RECORDED"))
        self.assertEqual((self.md(fake)["result_id"], self.md(fake)["result_correlation_id"]), ("res.new", new_corr))

    def test_result_fields_are_disjoint_from_ack_start_and_dispatcher_keys(self):
        owned = set(ta.RESET_FIELDS) | {"worker", "pane", "tab", "correlation_id", "orchestrator_target"}
        self.assertEqual(set(tr.RESULT_FIELDS) & owned, set())

    # ------------------------------------------------------------- verify_record (harvest gate rule set)
    def valid_md(self, **over):
        fake = FakeBd(**{BEAD: bead()})
        self.run_env(fake, now=T_RESULT)
        return dict(self.md(fake), **over)

    def test_verify_record_states(self):
        self.assertEqual(tr.verify_record(bead()["metadata"], "w1"), ("missing", {}))
        self.assertEqual(tr.verify_record(self.valid_md(), "w1")[0], "valid")

    def test_verify_record_rejects_each_tampering_with_a_specific_code(self):
        cases = {
            "RESULT_INCOMPLETE": {"result_at": None},
            "CORRELATION_MISMATCH": {"result_correlation_id": "corr.older.1.0"},
            "BEAD_UNCORRELATED": {"correlation_id": None},
            "INVALID_VERDICT": {"result_verdict": "unverified"},
            "UNSAFE_ARTIFACT": {"result_artifact_path": "/tmp/../etc/passwd"},
            "ARTIFACT_MISSING": {"result_artifact_path": str(self.dir / "gone.md")},
            "IDENTITY_MISMATCH": {"result_by": "w9"},
            "RESULT_WITHOUT_ACK": {"receipt_id": None},
            "MALFORMED": {"result_at": "yesterday"},
        }
        for code, over in cases.items():
            with self.subTest(code):
                m = {k: v for k, v in self.valid_md(**over).items() if v is not None}
                state, info = tr.verify_record(m, "w1")
                self.assertEqual((state, info["code"]), ("invalid", code), info)

    def test_verify_record_binds_identity_to_the_worker_being_harvested(self):
        state, info = tr.verify_record(self.valid_md(), "some-other-agent")
        self.assertEqual((state, info["code"]), ("invalid", "IDENTITY_MISMATCH"))
        state, info = tr.verify_record(self.valid_md(), None)
        self.assertEqual((state, info["code"]), ("invalid", "IDENTITY_UNVERIFIABLE"))

    # ------------------------------------------------------------- tickets / CLI
    def test_failure_ticket_is_evidence_only_and_idempotent(self):
        fake = FakeBd(**{BEAD: bead()})
        self.run_env(fake, self.env(verdict="maybe"))
        self.run_env(fake, self.env(verdict="maybe"))
        names = self.tickets("*INVALID_VERDICT*")
        self.assertEqual(len(names), 1, names)
        text = (Path(self.state) / "attention" / names[0]).read_text()
        self.assertIn("lifecycle_mutation: none", text)
        self.assertIn("no result was inferred", text)

    def test_cli_records_via_bd_and_prints_the_callback_envelope(self):
        bd = self.dir / "bd"
        log = self.dir / "bd.log"
        store = self.dir / "bead.json"
        store.write_text(json.dumps(bead()))
        bd.write_text('#!/usr/bin/env python3\nimport json,os,sys\na=sys.argv[1:]\ns=os.environ["FX"]\n'
                      'b=json.load(open(s))\nopen(os.environ["LOG"],"a").write(json.dumps([a,os.environ.get("BEADS_ACTOR")])+"\\n")\n'
                      'if a[0]=="show": print(json.dumps([b])); sys.exit(0)\n'
                      'for f,v in zip(a[2::2],a[3::2]):\n    k,_,x=v.partition("=")\n    b["metadata"][k]=x\n'
                      'json.dump(b,open(s,"w"))\n')
        bd.chmod(bd.stat().st_mode | stat.S_IXUSR)
        env = dict(os.environ, A4S_BD=str(bd), FX=str(store), LOG=str(log))
        cli = [sys.executable, str(HELPER), "--repo", str(self.dir), "--state-dir", self.state, "--bead-id", BEAD,
               "--correlation-id", CORR, "--result-id", "res.1", "--result-by", "w1", "--verdict", "pass",
               "--artifact-path", self.report]
        p = subprocess.run(cli, capture_output=True, text=True, env=env)
        res = json.loads(p.stdout)
        self.assertEqual((p.returncode, res["status"]), (0, "RECORDED"), p.stdout + p.stderr)
        self.assertEqual(json.loads(store.read_text())["metadata"]["result_verdict"], "pass")
        self.assertIn("WORK_RESULT SUBMITTED verdict=pass", res["callback_envelope"])
        self.assertEqual(json.loads(log.read_text().splitlines()[-1])[1], ASSIGNEE)
        bad = subprocess.run(cli[:-1] + ["relative.md"], capture_output=True, text=True, env=env)
        self.assertEqual((bad.returncode, json.loads(bad.stdout)["code"]), (3, "UNSAFE_ARTIFACT"))


if __name__ == "__main__":
    unittest.main()
