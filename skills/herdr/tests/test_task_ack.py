"""Offline tests for helper/task_ack.py (TASK_ACK RECEIVED / TASK_STARTED).

`bd` is replaced by an in-memory stateful fake (or, for the CLI test, a fake executable). No Beads database,
Herdr session, agent or provider is touched.
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

HELPER = Path(__file__).resolve().parents[1] / "helper" / "task_ack.py"
sys.path.insert(0, str(HELPER.parent))

import task_ack as ta  # noqa: E402

BEAD = "a4s-ya4.10"
CORR = "corr.a4s-ya4.10.1789000000.0"
ASSIGNEE = "Pablo"
T_ACK = "2026-09-20T01:00:00Z"
T_START = "2026-09-20T01:00:30Z"
T_LATER = "2026-09-20T02:00:00Z"


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
    md = {"correlation_id": CORR, "worker": "w1", "pane": "wT:p9", "tab": "wT:t9"}
    md.update(metadata)
    md = {k: v for k, v in md.items() if v is not None}
    return {"id": BEAD, "status": "in_progress", "assignee": ASSIGNEE, "metadata": md}


def ack_env(**over):
    f = dict(receipt_id="rcpt.1", correlation_id=CORR, bead_id=BEAD, acknowledged_by="w1")
    f.update(over)
    return ta.build_ack(**f)


def start_env(**over):
    f = dict(start_id="start.1", correlation_id=CORR, bead_id=BEAD, worker="w1", pane="wT:p9", tab="wT:t9")
    f.update(over)
    return ta.build_start(**f)


class TaskAckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = str(Path(self.tmp.name) / "state")

    def tearDown(self):
        self.tmp.cleanup()

    def run_kind(self, fake, kind, envelope, **kw):
        return ta.handle(kind, envelope, ta.Beads("/repo", runner=fake), self.state, **kw)

    def md(self, fake):
        return fake.beads[BEAD]["metadata"]

    def tickets(self, pattern="*.md"):
        d = Path(self.state) / "attention"
        return sorted(p.name for p in d.glob(pattern)) if d.exists() else []

    # ------------------------------------------------------------- receipt
    def test_ack_persists_receipt_fields_in_one_write_as_assignee(self):
        fake = FakeBd(**{BEAD: bead()})
        code, res = self.run_kind(fake, "ack", ack_env(), received_at=T_ACK)
        self.assertEqual((code, res["status"]), (0, "RECORDED"))
        md = self.md(fake)
        self.assertEqual((md["receipt_id"], md["received_at"], md["acknowledged_by"]), ("rcpt.1", T_ACK, "w1"))
        self.assertRegex(md["acknowledged_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertEqual(md["correlation_id"], CORR)  # the dispatcher's stamp is untouched
        self.assertEqual(len(fake.writes), 1)  # one atomic bd update
        self.assertEqual(fake.writes[0][1], ASSIGNEE)  # bd's assignee guard: act as the assignee
        self.assertNotIn("--force", fake.writes[0][0])
        self.assertNotIn("--actor", fake.writes[0][0])
        self.assertEqual(res["envelope"], ack_env())  # the exact line the Worker relays to the PO
        self.assertEqual(self.tickets(), [])

    def test_ack_received_at_defaults_to_acknowledged_at(self):
        fake = FakeBd(**{BEAD: bead()})
        ta.record_ack(ta.Beads("/repo", runner=fake), ta.parse_envelope(ack_env())[1], now=T_ACK)
        self.assertEqual((self.md(fake)["received_at"], self.md(fake)["acknowledged_at"]), (T_ACK, T_ACK))

    # ------------------------------------------------------------- start
    def test_start_persists_start_fields_after_ack(self):
        fake = FakeBd(**{BEAD: bead()})
        self.run_kind(fake, "ack", ack_env())
        code, res = self.run_kind(fake, "start", start_env())
        self.assertEqual((code, res["status"]), (0, "RECORDED"))
        md = self.md(fake)
        self.assertEqual((md["start_id"], md["worker"], md["pane"], md["tab"]), ("start.1", "w1", "wT:p9", "wT:t9"))
        self.assertRegex(md["started_at"], r"^\d{4}-")
        self.assertEqual(md["receipt_id"], "rcpt.1")  # the ack record is preserved

    def test_start_persists_identity_when_dispatcher_stamped_none(self):
        fake = FakeBd(**{BEAD: bead(worker=None, pane=None, tab=None)})
        self.run_kind(fake, "ack", ack_env())
        code, _ = self.run_kind(fake, "start", start_env())
        self.assertEqual(code, 0)
        self.assertEqual((self.md(fake)["worker"], self.md(fake)["pane"], self.md(fake)["tab"]), ("w1", "wT:p9", "wT:t9"))

    def test_start_identity_mismatch_fails_closed_without_overwrite(self):
        fake = FakeBd(**{BEAD: bead()})
        self.run_kind(fake, "ack", ack_env())
        before = copy.deepcopy(self.md(fake))
        code, res = self.run_kind(fake, "start", start_env(pane="wT:p1"))
        self.assertEqual((code, res["code"]), (3, "IDENTITY_MISMATCH"))
        self.assertEqual(self.md(fake), before)

    # ------------------------------------------------------------- idempotency
    def test_duplicate_receipt_preserves_logical_state_and_timestamps(self):
        fake = FakeBd(**{BEAD: bead()})
        self.run_kind(fake, "ack", ack_env(), received_at=T_ACK)
        snapshot, writes = copy.deepcopy(self.md(fake)), len(fake.writes)
        for _ in range(2):
            code, res = self.run_kind(fake, "ack", ack_env(), received_at=T_LATER)
            self.assertEqual((code, res["status"]), (0, "DUPLICATE"))
        self.assertEqual(self.md(fake), snapshot)
        self.assertEqual(len(fake.writes), writes)  # no write at all
        self.assertEqual(self.tickets(), [])

    def test_duplicate_start_preserves_logical_state_and_timestamps(self):
        fake = FakeBd(**{BEAD: bead()})
        self.run_kind(fake, "ack", ack_env())
        self.run_kind(fake, "start", start_env())
        snapshot, writes = copy.deepcopy(self.md(fake)), len(fake.writes)
        code, res = self.run_kind(fake, "start", start_env())
        self.assertEqual((code, res["status"]), (0, "DUPLICATE"))
        self.assertEqual(self.md(fake), snapshot)
        self.assertEqual(len(fake.writes), writes)

    def test_conflicting_ids_never_overwrite(self):
        fake = FakeBd(**{BEAD: bead()})
        self.run_kind(fake, "ack", ack_env())
        self.run_kind(fake, "start", start_env())
        snapshot = copy.deepcopy(self.md(fake))
        code, res = self.run_kind(fake, "ack", ack_env(receipt_id="rcpt.2"))
        self.assertEqual((code, res["code"]), (3, "ACK_CONFLICT"))
        code, res = self.run_kind(fake, "start", start_env(start_id="start.2"))
        self.assertEqual((code, res["code"]), (3, "START_CONFLICT"))
        self.assertEqual(self.md(fake), snapshot)

    # ------------------------------------------------------------- correlation: fail closed, nothing inferred
    def test_missing_correlation_fails_closed_with_attention_evidence(self):
        for kind, envelope in (("ack", ack_env(correlation_id="")), ("start", start_env(correlation_id=""))):
            with self.subTest(kind):
                fake = FakeBd(**{BEAD: bead(receipt_id="rcpt.0" if kind == "start" else None)})
                before = copy.deepcopy(fake.beads)
                code, res = self.run_kind(fake, kind, envelope)
                self.assertEqual((code, res["status"], res["code"]), (3, "ATTENTION", "MISSING_CORRELATION"))
                self.assertEqual(fake.beads, before)  # no state written, none inferred from the Bead's own id
                self.assertEqual(fake.writes, [])
                self.assertEqual(res["envelope"], "ATTENTION REQUIRED verdict=blocked artifact_path=%s bead_id=%s" % (
                    res["artifact_path"], BEAD))
                ticket = Path(res["artifact_path"]).read_text()
                self.assertIn("lifecycle_mutation: none", ticket)
                self.assertIn("kind: TASK_ACK_MISSING_CORRELATION", ticket)
                self.assertIn(envelope, ticket)
        self.assertEqual(len(self.tickets("%s--TASK_ACK_MISSING_CORRELATION--*.md" % BEAD)), 2)

    def test_mismatched_correlation_fails_closed(self):
        for kind, envelope in (("ack", ack_env(correlation_id="corr.other.1.0")),
                               ("start", start_env(correlation_id="corr.other.1.0"))):
            with self.subTest(kind):
                fake = FakeBd(**{BEAD: bead(receipt_id="rcpt.0", received_at=T_ACK, acknowledged_at=T_ACK,
                                            acknowledged_by="w1")})
                before = copy.deepcopy(fake.beads)
                code, res = self.run_kind(fake, kind, envelope)
                self.assertEqual((code, res["code"]), (3, "CORRELATION_MISMATCH"))
                self.assertEqual(fake.beads, before)
                self.assertEqual(fake.writes, [])
                self.assertTrue(Path(res["artifact_path"]).exists())

    def test_bead_without_dispatcher_correlation_fails_closed(self):
        fake = FakeBd(**{BEAD: bead(correlation_id=None)})
        code, res = self.run_kind(fake, "ack", ack_env())
        self.assertEqual((code, res["code"]), (3, "BEAD_UNCORRELATED"))
        self.assertEqual(fake.writes, [])

    def test_no_ack_or_start_on_a_bead_that_is_not_in_progress(self):
        b = bead()
        b["status"] = "closed"
        fake = FakeBd(**{BEAD: b})
        code, res = self.run_kind(fake, "ack", ack_env())
        self.assertEqual((code, res["code"]), (3, "BEAD_NOT_IN_PROGRESS"))
        self.assertEqual(fake.writes, [])

    def test_unknown_bead_fails_closed(self):
        code, res = self.run_kind(FakeBd(), "ack", ack_env())
        self.assertEqual((code, res["code"]), (3, "BEAD_UNREADABLE"))
        self.assertTrue(Path(res["artifact_path"]).exists())

    # ------------------------------------------------------------- no start without ack
    def test_no_start_without_ack(self):
        fake = FakeBd(**{BEAD: bead()})
        code, res = self.run_kind(fake, "start", start_env())
        self.assertEqual((code, res["status"], res["code"]), (3, "ATTENTION", "START_WITHOUT_ACK"))
        self.assertNotIn("start_id", self.md(fake))
        self.assertNotIn("receipt_id", self.md(fake))  # the ack is not fabricated to make the start valid
        self.assertEqual(fake.writes, [])
        self.assertEqual(len(self.tickets("%s--TASK_ACK_START_WITHOUT_ACK--*.md" % BEAD)), 1)
        # once a real ack exists the very same start is accepted
        self.run_kind(fake, "ack", ack_env())
        code, res = self.run_kind(fake, "start", start_env())
        self.assertEqual((code, res["status"]), (0, "RECORDED"))

    def test_repeated_violation_writes_one_ticket(self):
        fake = FakeBd(**{BEAD: bead()})
        for _ in range(3):
            self.run_kind(fake, "start", start_env())
        self.assertEqual(len(self.tickets()), 1)

    def test_write_failure_is_a_closed_error_not_a_silent_success(self):
        fake = FakeBd(**{BEAD: bead()})
        fake.beads[BEAD]["assignee"] = "someone-else"
        beads = ta.Beads("/repo", runner=lambda argv, cwd=None, env=None: fake(argv, cwd, {"BEADS_ACTOR": "wrong"})
                         if argv[1] == "update" else fake(argv, cwd, env))
        code, res = ta.handle("ack", ack_env(), beads, self.state)
        self.assertEqual((code, res["code"]), (3, "WRITE_FAILED"))

    # ------------------------------------------------------------- strict grammar (no free-text parsing)
    def test_envelope_grammar_is_strict(self):
        ok = ack_env()
        self.assertEqual(ta.parse_envelope(ok)[0], "ack")
        self.assertEqual(ta.parse_envelope(start_env())[0], "start")
        bad = {
            "free text": "please acknowledge the task",
            "wrong prefix": ok.replace("TASK_ACK RECEIVED", "TASK_ACK DONE"),
            "unknown key": ok + " note=hi",
            "duplicate key": ok + " receipt_id=rcpt.2",
            "extra bare word": ok + " thanks",
            "leading text": "ok " + ok,
            "flag-shaped value": ack_env(bead_id="-rf"),
            "quoted value": ok.replace("acknowledged_by=w1", 'acknowledged_by="w 1"'),
            "shell metachar": ack_env(acknowledged_by="w1;rm"),
            "empty value": ok.replace("receipt_id=rcpt.1", "receipt_id="),
        }
        for name, line in bad.items():
            with self.subTest(name):
                with self.assertRaises(ta.ClosedError) as cm:
                    ta.parse_envelope(line)
                self.assertIn(cm.exception.code, {"MALFORMED", "MISSING_ID"})

    def test_missing_id_and_fields_have_their_own_codes(self):
        with self.assertRaises(ta.ClosedError) as cm:
            ta.parse_envelope(ack_env(receipt_id=""))
        self.assertEqual(cm.exception.code, "MISSING_ID")
        with self.assertRaises(ta.ClosedError) as cm:
            ta.parse_envelope(start_env(pane=""))
        self.assertEqual(cm.exception.code, "MISSING_FIELD")

    def test_kind_confusion_is_rejected(self):
        fake = FakeBd(**{BEAD: bead()})
        code, res = self.run_kind(fake, "ack", start_env())
        self.assertEqual((code, res["code"]), (3, "MALFORMED"))
        self.assertEqual(fake.writes, [])

    def test_malformed_envelope_still_yields_evidence(self):
        code, res = ta.handle("ack", "garbage", ta.Beads("/repo", runner=FakeBd()), self.state)
        self.assertEqual((code, res["code"], res["bead_id"]), (3, "MALFORMED", "unknown"))
        self.assertTrue(Path(res["artifact_path"]).exists())

    # ------------------------------------------------------------- CLI end to end (fake bd executable)
    def test_cli_round_trip_and_exit_codes(self):
        t = Path(self.tmp.name)
        store = t / "store.json"
        store.write_text(json.dumps({BEAD: bead()}))
        fake = t / "bd"
        fake.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, sys\n"
            "p = os.environ['A4S_STORE']; db = json.load(open(p)); a = sys.argv[1:]\n"
            "b = db.get(a[1])\n"
            "if b is None: sys.exit(1)\n"
            "if a[0] == 'show': print(json.dumps([b])); sys.exit(0)\n"
            "if os.environ.get('BEADS_ACTOR') != b['assignee']: sys.exit(1)\n"
            "for f, v in zip(a[2::2], a[3::2]):\n"
            "    k, _, val = v.partition('=')\n"
            "    if f == '--set-metadata': b['metadata'][k] = val\n"
            "json.dump(db, open(p, 'w'))\n")
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
        env = dict(os.environ, A4S_BD=str(fake), A4S_STORE=str(store))
        cli = [sys.executable, str(HELPER), "--repo", str(t), "--state-dir", self.state]

        def call(*a):
            p = subprocess.run(cli + list(a), capture_output=True, text=True, env=env)
            return p.returncode, json.loads(p.stdout)

        code, res = call("start", "--bead-id", BEAD, "--correlation-id", CORR, "--start-id", "s1",
                         "--worker", "w1", "--pane", "wT:p9", "--tab", "wT:t9")
        self.assertEqual((code, res["code"]), (3, "START_WITHOUT_ACK"))
        code, res = call("ack", "--bead-id", BEAD, "--correlation-id", "", "--receipt-id", "r1", "--acknowledged-by", "w1")
        self.assertEqual((code, res["code"]), (3, "MISSING_CORRELATION"))
        code, res = call("ack", "--bead-id", BEAD, "--correlation-id", CORR, "--receipt-id", "r1", "--acknowledged-by", "w1")
        self.assertEqual((code, res["status"]), (0, "RECORDED"))
        code, res = call("ack", "--bead-id", BEAD, "--correlation-id", CORR, "--receipt-id", "r1", "--acknowledged-by", "w1")
        self.assertEqual((code, res["status"]), (0, "DUPLICATE"))
        code, res = call("start", "--bead-id", BEAD, "--correlation-id", CORR, "--start-id", "s1",
                         "--worker", "w1", "--pane", "wT:p9", "--tab", "wT:t9")
        self.assertEqual((code, res["status"]), (0, "RECORDED"))
        md = json.loads(store.read_text())[BEAD]["metadata"]
        self.assertEqual({k: md[k] for k in ("receipt_id", "start_id", "acknowledged_by")},
                         {"receipt_id": "r1", "start_id": "s1", "acknowledged_by": "w1"})
        for key in ta.ACK_FIELDS + ta.START_FIELDS:
            self.assertIn(key, md)


if __name__ == "__main__":
    unittest.main()
