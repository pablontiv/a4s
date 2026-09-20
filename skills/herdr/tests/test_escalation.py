"""Offline tests for helper/escalation.py (Worker escalation routing, bead a4s-ya4.10.2).

`bd` is an in-memory stateful fake and `herdr agent prompt` is a recording callable (or a fake executable for the
CLI test). No Beads database, Herdr session, agent or provider is touched.
"""

from __future__ import annotations

import copy
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERDR_DIR = Path(__file__).resolve().parents[1]
HELPER = HERDR_DIR / "helper" / "escalation.py"
sys.path.insert(0, str(HELPER.parent))

import escalation as es  # noqa: E402
import task_ack as ta  # noqa: E402

BEAD = "a4s-x1"
CORR = "corr.a4s-x1.1789000000.0"
PO = "wO:p1"
ASSIGNEE = "Pablo"
REPORT = "/tmp/a4s-x1-blocker.md"
MC_BEAD = {"id": "mc-1", "status": "in_progress", "labels": ["mission-control"], "assignee": "mc-session",
           "metadata": {"pane": "wM:p1", "tab": "wM:t1", "worker": "mc-session", "terminal_id": "term_mc"}}


class FakeBd:
    """Stateful `bd show/update/list` over an in-memory Bead table; enforces bd's assignee guard."""

    def __init__(self, beads=None, mc=(MC_BEAD,), list_fails=False, update_fails=False):
        self.beads = {b["id"]: b for b in (beads or [])}
        self.mc, self.list_fails, self.update_fails = list(mc), list_fails, update_fails
        self.writes = []  # (argv, BEADS_ACTOR)

    def __call__(self, argv, cwd=None, env=None):
        cmd = argv[1]
        if cmd == "list":
            if self.list_fails:
                return 1, "", "bd list boom"
            assert argv[2:6] == ["--label", "mission-control", "--status", "in_progress"], argv
            return 0, json.dumps(copy.deepcopy(self.mc)), ""
        bead = self.beads.get(argv[2])
        if bead is None:
            return 1, "", "issue not found"
        if cmd == "show":
            return 0, json.dumps([copy.deepcopy(bead)]), ""
        actor = (env or {}).get("BEADS_ACTOR", "")
        if self.update_fails or (bead.get("assignee") and actor != bead["assignee"]):
            return 1, "", "update refused"
        self.writes.append((argv, actor))
        m = bead.setdefault("metadata", {})
        for flag, val in zip(argv[3::2], argv[4::2]):
            if flag == "--set-metadata":
                k, _, v = val.partition("=")
                m[k] = v
        return 0, "", ""


class Herdr:
    """Recording `herdr agent prompt <target> <text>`: `outcomes` is the rc for each successive call (default 0)."""

    def __init__(self, *outcomes):
        self.outcomes, self.calls = list(outcomes), []

    def __call__(self, target, text):
        self.calls.append((target, text))
        rc = self.outcomes.pop(0) if self.outcomes else 0
        return rc, "", "target blocked or unavailable" if rc else ""

    @property
    def targets(self):
        return [t for t, _ in self.calls]


def bead(**metadata):
    md = {"correlation_id": CORR, "orchestrator_target": PO, "worker": "w1", "pane": "wT:p9", "tab": "wT:t9"}
    md.update(metadata)
    return {"id": BEAD, "status": "in_progress", "assignee": ASSIGNEE,
            "metadata": {k: v for k, v in md.items() if v is not None}}


class EscalationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = str(Path(self.tmp.name) / "state")

    def tearDown(self):
        self.tmp.cleanup()

    def route(self, fake, herdr, kind="BLOCKER", **over):
        args = dict(bead_id=BEAD, correlation_id=CORR, kind=kind, artifact_path=REPORT)
        args.update(over)
        return es.escalate(ta.Beads("/repo", runner=fake), herdr, self.state, **args)

    def md(self, fake):
        return fake.beads[BEAD]["metadata"]

    def tickets(self, pattern="*.md"):
        d = Path(self.state) / "attention"
        return sorted(p.name for p in d.glob(pattern)) if d.exists() else []

    # ------------------------------------------------------------- correct routing
    def test_blocker_and_question_go_to_the_stamped_target_only_as_correlated_attention(self):
        for kind in ("BLOCKER", "QUESTION"):
            with self.subTest(kind):
                fake, herdr = FakeBd([bead()]), Herdr()
                code, res = self.route(fake, herdr, kind)
                expected = ("ATTENTION REQUIRED verdict=blocked type=%s artifact_path=%s bead_id=%s correlation_id=%s"
                            % (kind, REPORT, BEAD, CORR))
                self.assertEqual((code, res["status"]), (0, "DELIVERED"))
                self.assertEqual(herdr.calls, [(PO, expected)])  # exactly one delivery, to exactly the target
                self.assertEqual(res["envelope"], expected)
                self.assertEqual(fake.writes, [])  # a delivered escalation leaves no failure evidence
                self.assertEqual(self.tickets(), [])

    def test_target_is_read_from_the_bead_never_from_the_worker(self):
        fake, herdr = FakeBd([bead(orchestrator_target="po-agent")]), Herdr()
        self.route(fake, herdr)
        self.assertEqual(herdr.targets, ["po-agent"])
        with self.assertRaises(TypeError):  # no target parameter exists on the router
            es.escalate(ta.Beads("/repo", runner=fake), herdr, self.state, bead_id=BEAD, correlation_id=CORR,
                        kind="BLOCKER", artifact_path=REPORT, target="wM:p1")

    def test_delivery_never_uses_wait_or_a_timeout_flag(self):
        seen = {}

        class Recorder:
            def run(self, argv, **kw):
                seen["argv"] = argv
                return subprocess.CompletedProcess(argv, 0, "", "")

        real, es.subprocess = es.subprocess, Recorder()
        try:
            self.assertEqual(es.herdr_prompt(PO, "hello")[0], 0)
        finally:
            es.subprocess = real
        self.assertEqual(seen["argv"][1:], ["agent", "prompt", PO, "hello"])

    # ------------------------------------------------------------- missing / invalid target: nothing is sent
    def test_missing_target_is_refused_with_evidence_and_nothing_is_sent(self):
        fake, herdr = FakeBd([bead(orchestrator_target=None)]), Herdr()
        code, res = self.route(fake, herdr)
        self.assertEqual((code, res["status"], res["code"], res["stop"]), (3, "REFUSED", "TARGET_MISSING", True))
        self.assertEqual(herdr.calls, [])  # not to Human, not to MC, not to anyone
        self.assertNotIn("envelope", res)  # nothing the Worker could relay elsewhere
        md = self.md(fake)
        self.assertEqual((md["escalation_delivery"], md["escalation_correlation_id"]), ("refused", CORR))
        self.assertIn("TARGET_MISSING", md["escalation_error"])
        self.assertEqual(len(fake.writes), 1)
        self.assertEqual(fake.writes[0][1], ASSIGNEE)
        self.assertTrue(Path(res["artifact_path"]).exists())
        self.assertEqual(fake.beads[BEAD]["status"], "in_progress")  # lifecycle untouched

    def test_invalid_target_values_are_refused(self):
        for value in ("bad target", "-rf", "wO:p1;rm", "$(x)", "wO:p1\nwM:p1", "wO:p1\n", "", " "):
            with self.subTest(value=value):
                fake, herdr = FakeBd([bead(orchestrator_target=value)]), Herdr()
                code, res = self.route(fake, herdr)
                self.assertEqual(code, 3)
                self.assertIn(res["code"], {"TARGET_INVALID", "TARGET_MISSING"})
                self.assertEqual(herdr.calls, [])

    def test_the_worker_cannot_be_its_own_escalation_target(self):
        for key in ("worker", "pane", "tab"):
            with self.subTest(key):
                fake, herdr = FakeBd([bead(orchestrator_target=bead()["metadata"][key])]), Herdr()
                code, res = self.route(fake, herdr)
                self.assertEqual((code, res["code"]), (3, "TARGET_IS_WORKER"))
                self.assertEqual(herdr.calls, [])

    # ------------------------------------------------------------- Human / MC are never targets
    def test_human_and_mission_control_names_are_forbidden_targets(self):
        for value in ("mc", "MC", "mission-control", "Mission_Control", "mc-1", "human", "Human-Operator", "operator",
                      "user", "owner"):
            with self.subTest(value=value):
                fake, herdr = FakeBd([bead(orchestrator_target=value)]), Herdr()
                code, res = self.route(fake, herdr)
                self.assertEqual((code, res["status"], res["code"]), (3, "REFUSED", "TARGET_FORBIDDEN"))
                self.assertEqual(herdr.calls, [])
                self.assertEqual(self.md(fake)["escalation_delivery"], "refused")

    def test_the_mission_control_bead_identities_are_forbidden_targets(self):
        for value in ("wM:p1", "wM:t1", "mc-session", "term_mc"):
            with self.subTest(value=value):
                fake, herdr = FakeBd([bead(orchestrator_target=value)]), Herdr()
                code, res = self.route(fake, herdr)
                self.assertEqual((code, res["code"]), (3, "TARGET_FORBIDDEN"))
                self.assertEqual(herdr.calls, [])

    def test_unverifiable_mission_control_fails_closed(self):
        fake, herdr = FakeBd([bead()], list_fails=True), Herdr()
        code, res = self.route(fake, herdr)
        self.assertEqual((code, res["code"]), (3, "TARGET_UNVERIFIABLE"))
        self.assertEqual(herdr.calls, [])

    # ------------------------------------------------------------- delivery failure: evidence, notice to the same target, stop
    def test_rejected_delivery_persists_evidence_then_notifies_the_same_target_once_and_stops(self):
        fake, herdr = FakeBd([bead()]), Herdr(1, 0)  # escalation rejected, DELIVERY_FAILED notice accepted
        code, res = self.route(fake, herdr, "QUESTION")
        self.assertEqual((code, res["status"], res["code"], res["stop"]), (3, "DELIVERY_FAILED", "DELIVERY_FAILED", True))
        self.assertEqual(herdr.targets, [PO, PO])  # the same target path, twice, never anywhere else
        self.assertTrue(herdr.calls[0][1].startswith("ATTENTION REQUIRED "))
        notice = herdr.calls[1][1]
        self.assertEqual(notice, "ATTENTION DELIVERY_FAILED verdict=blocked artifact_path=%s bead_id=%s "
                                 "correlation_id=%s target=%s" % (res["artifact_path"], BEAD, CORR, PO))
        self.assertEqual(res["notice_envelope"], notice)
        self.assertEqual(res["notice"], "delivered to %s" % PO)
        md = self.md(fake)
        self.assertEqual((md["escalation_delivery"], md["escalation_target"], md["escalation_correlation_id"]),
                         ("failed", PO, CORR))
        self.assertIn("rc=1", md["escalation_error"])
        self.assertIn("target blocked or unavailable", md["escalation_error"])
        self.assertEqual(md["escalation_artifact_path"], res["artifact_path"])
        self.assertEqual(md["escalation_notice"], "delivered")
        self.assertRegex(md["escalation_failed_at"], r"^\d{4}-\d\d-\d\dT")
        self.assertEqual({a for _, a in fake.writes}, {ASSIGNEE})
        ticket = Path(res["artifact_path"]).read_text()
        self.assertIn("kind: ESCALATION_DELIVERY_FAILED", ticket)
        self.assertIn("NOT routed to the Human Operator or Mission Control", ticket)
        self.assertEqual(fake.beads[BEAD]["status"], "in_progress")  # no close, no lifecycle change

    def test_failed_notice_is_recorded_and_there_is_still_no_fallback(self):
        fake, herdr = FakeBd([bead()]), Herdr(1, 1, 0, 0)  # would succeed if anything else were tried
        code, res = self.route(fake, herdr)
        self.assertEqual((code, res["status"]), (3, "DELIVERY_FAILED"))
        self.assertEqual(herdr.targets, [PO, PO])  # two attempts, both to the target, no third
        self.assertTrue(res["notice"].startswith("undelivered"))
        self.assertEqual(self.md(fake)["escalation_notice"], "undelivered")
        self.assertEqual(self.md(fake)["escalation_delivery"], "failed")

    def test_herdr_missing_is_a_delivery_failure_not_a_reroute(self):
        fake = FakeBd([bead()])
        calls = []

        def gone(target, text):
            calls.append(target)
            return 127, "", "No such file or directory: 'herdr'"

        code, res = es.escalate(ta.Beads("/repo", runner=fake), gone, self.state, BEAD, CORR, "BLOCKER", REPORT)
        self.assertEqual((code, res["code"]), (3, "DELIVERY_FAILED"))
        self.assertEqual(calls, [PO, PO])

    def test_evidence_write_failure_is_reported_and_still_stops(self):
        fake, herdr = FakeBd([bead()], update_fails=True), Herdr(1, 0)
        code, res = self.route(fake, herdr)
        self.assertEqual((code, res["status"]), (3, "DELIVERY_FAILED"))
        self.assertTrue(res["bead_evidence"].startswith("not written"))
        self.assertTrue(Path(res["artifact_path"]).exists())  # the ticket is the evidence of last resort
        self.assertEqual(herdr.targets, [PO, PO])

    def test_repeated_failure_is_one_ticket(self):
        for _ in range(3):
            self.route(FakeBd([bead()]), Herdr(1, 0))
        self.assertEqual(len(self.tickets("%s--ESCALATION_DELIVERY_FAILED--*.md" % BEAD)), 1)

    # ------------------------------------------------------------- untrusted Bead / request: nothing sent, nothing written
    def test_uncorrelated_or_foreign_requests_are_refused_without_delivery_or_bead_write(self):
        cases = {
            "wrong correlation": (FakeBd([bead()]), dict(correlation_id="corr.other.1.0"), "CORRELATION_MISMATCH"),
            "bead never correlated": (FakeBd([bead(correlation_id=None)]), {}, "BEAD_UNCORRELATED"),
            "unknown bead": (FakeBd([]), {}, "BEAD_UNREADABLE"),
            "bad type": (FakeBd([bead()]), dict(kind="ASK_USER"), "MALFORMED"),
            "empty report": (FakeBd([bead()]), dict(artifact_path=""), "MALFORMED"),
            "shell in report": (FakeBd([bead()]), dict(artifact_path="/tmp/x;rm"), "MALFORMED"),
        }
        closed = bead()
        closed["status"] = "closed"
        cases["closed bead"] = (FakeBd([closed]), {}, "BEAD_NOT_IN_PROGRESS")
        for name, (fake, over, code_expected) in cases.items():
            with self.subTest(name):
                herdr = Herdr()
                code, res = self.route(fake, herdr, **over)
                self.assertEqual((code, res["code"]), (3, code_expected))
                self.assertEqual(herdr.calls, [])
                self.assertEqual(fake.writes, [])
                self.assertNotIn("envelope", res)
                self.assertEqual(res["bead_evidence"], "not written")

    # ------------------------------------------------------------- CLI end to end (fake bd + fake herdr executables)
    def cli(self, herdr_rc, target=PO, extra=()):
        t = Path(self.tmp.name)
        store, log = t / "store.json", t / "herdr.log"
        store.write_text(json.dumps({BEAD: bead(orchestrator_target=target)}))
        log.write_text("")
        bd = t / "bd"
        bd.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, sys\n"
            "p = os.environ['A4S_STORE']; db = json.load(open(p)); a = sys.argv[1:]\n"
            "if a[0] == 'list': print(json.dumps([])); sys.exit(0)\n"
            "b = db.get(a[1])\n"
            "if b is None: sys.exit(1)\n"
            "if a[0] == 'show': print(json.dumps([b])); sys.exit(0)\n"
            "if os.environ.get('BEADS_ACTOR') != b['assignee']: sys.exit(1)\n"
            "for f, v in zip(a[2::2], a[3::2]):\n"
            "    k, _, val = v.partition('=')\n"
            "    if f == '--set-metadata': b['metadata'][k] = val\n"
            "json.dump(db, open(p, 'w'))\n")
        herdr = t / "herdr"
        herdr.write_text("#!/bin/sh\nprintf '%%s\\n' \"$*\" >> %s\nexit %d\n" % (log, herdr_rc))
        for f in (bd, herdr):
            f.chmod(f.stat().st_mode | stat.S_IXUSR)
        env = dict(os.environ, A4S_BD=str(bd), A4S_HERDR=str(herdr), A4S_STORE=str(store))
        p = subprocess.run([sys.executable, str(HELPER), "--repo", str(t), "--state-dir", self.state,
                            "--bead-id", BEAD, "--correlation-id", CORR, "--type", "QUESTION",
                            "--artifact-path", REPORT] + list(extra), capture_output=True, text=True, env=env)
        calls = [l for l in log.read_text().splitlines() if l]
        try:
            return p.returncode, json.loads(p.stdout or "null"), calls, json.loads(store.read_text())[BEAD]["metadata"]
        except ValueError:
            return p.returncode, None, calls, {}

    def test_cli_delivers_to_the_target(self):
        code, res, calls, _ = self.cli(0)
        self.assertEqual((code, res["status"]), (0, "DELIVERED"))
        self.assertEqual(calls, ["agent prompt %s %s" % (PO, res["envelope"])])
        self.assertNotIn("--wait", calls[0])

    def test_cli_delivery_failure_stops_with_evidence_and_only_ever_calls_the_target(self):
        code, res, calls, md = self.cli(1)
        self.assertEqual((code, res["status"]), (3, "DELIVERY_FAILED"))
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(c.startswith("agent prompt %s " % PO) for c in calls), calls)
        self.assertEqual(md["escalation_delivery"], "failed")

    def test_cli_refuses_human_and_mc_targets_without_calling_herdr(self):
        for target in ("mc", "human", "operator", "user"):
            with self.subTest(target):
                code, res, calls, md = self.cli(0, target=target)
                self.assertEqual((code, res["code"]), (3, "TARGET_FORBIDDEN"))
                self.assertEqual(calls, [])
                self.assertEqual(md["escalation_delivery"], "refused")

    def test_cli_has_no_target_override(self):
        code, res, calls, _ = self.cli(0, extra=["--target", "wM:p1"])
        self.assertEqual(code, 2)  # argparse rejects it
        self.assertEqual(calls, [])


class WorkerContractWordingTest(unittest.TestCase):
    """The docs the Worker is told to follow must not permit a direct question to the user, Human Operator or MC."""

    SKILL = (HERDR_DIR / "SKILL.md").read_text()
    RECONCILE = (HERDR_DIR / "scripts" / "a4s-reconcile").read_text()
    README = (HERDR_DIR / "scripts" / "README.md").read_text()
    PERMISSIVE = re.compile(r"\basks? the user\b|\bask the user\b|\bask(s)? user\b|\buser directly\b", re.I)

    def test_no_wording_permits_worker_to_user_questions(self):
        for name, text in (("SKILL.md", self.SKILL), ("a4s-reconcile", self.RECONCILE), ("README.md", self.README)):
            with self.subTest(name):
                self.assertIsNone(self.PERMISSIVE.search(text), self.PERMISSIVE.search(text))

    def test_skill_states_the_routing_contract(self):
        for needle in ("orchestrator_target", "ATTENTION DELIVERY_FAILED", "helper/escalation.py",
                       "never asks the Human Operator or Mission Control", "Never falls back"):
            with self.subTest(needle):
                self.assertIn(needle, self.SKILL)


if __name__ == "__main__":
    unittest.main()
