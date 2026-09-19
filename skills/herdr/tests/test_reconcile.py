"""Offline tests for scripts/a4s-reconcile.

`bd` and `herdr` are replaced by fake executables driven by a JSON fixture
(A4S_BD / A4S_HERDR). No live Beads, Herdr, agent, or provider is touched.
"""

from __future__ import annotations

import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "a4s-reconcile"

FAKE_BD = r'''#!/usr/bin/env python3
import json, os, sys
fx = json.load(open(os.environ["A4S_FIXTURE"]))
a = sys.argv[1:]
ro = "--readonly" in a
a = [x for x in a if x != "--readonly"]
log = open(os.environ["A4S_LOG"], "a")
if a[0] in ("update", "close"):
    if ro:
        print("readonly violation", file=sys.stderr); sys.exit(1)
    actor = a[a.index("--actor") + 1] if "--actor" in a else os.environ.get("BEADS_ACTOR", "")
    want = fx.get("assignees", {}).get(a[1])
    if want is not None and "--claim" not in a and actor != want:
        print('assignee is "%s", actor is "%s"; reclaim or use --force to override' % (want, actor), file=sys.stderr)
        sys.exit(1)
    log.write("bd " + " ".join(a) + " ##BEADS_ACTOR=" + os.environ.get("BEADS_ACTOR", "") + "\n"); sys.exit(0)
log.write("bd-read " + " ".join(a) + "\n")
if a[0] == "ready":
    out = fx.get("ready", [])
elif "--label-any" in a:
    out = fx.get("needs", [])
elif "--label" in a:
    out = fx.get("mc_beads", [])
elif a[a.index("--status") + 1] == "in_progress":
    # like real bd: the in_progress list also carries the MC ownership Bead(s)
    out = fx.get("in_progress", []) + [b for b in fx.get("mc_beads", [])
                                       if b["id"] not in {x["id"] for x in fx.get("in_progress", [])}]
elif a[a.index("--status") + 1] == "blocked":
    out = fx.get("blocked", [])
elif a[a.index("--status") + 1] == "closed":
    out = fx.get("closed", [])
else:
    out = fx.get("live_tabs", [])
print(json.dumps(out))
'''

FAKE_HERDR = r'''#!/usr/bin/env python3
import json, os, sys
fx = json.load(open(os.environ["A4S_FIXTURE"]))
a = sys.argv[1:]
log = open(os.environ["A4S_LOG"], "a")
log.write("herdr " + " ".join(a) + "\n")
if a[:2] == ["status", "server"]:
    if fx.get("down"):
        print("status: not running"); sys.exit(1)
    print("status: running"); sys.exit(0)
if a[:2] == ["agent", "list"]:
    print(json.dumps({"result": {"agents": list(fx.get("agents", {}).values())}}))
elif a[:2] == ["agent", "get"]:
    ag = fx.get("agents", {}).get(a[2])
    if ag is None:
        print(json.dumps({"error": {"code": "agent_not_found"}}), file=sys.stderr); sys.exit(1)
    print(json.dumps({"result": {"agent": ag}}))
elif a[:2] == ["tab", "list"]:
    print(json.dumps({"result": {"tabs": fx.get("tabs", [])}}))
elif a[:2] == ["pane", "list"]:
    cnt = os.environ["A4S_LOG"] + ".panes"
    n = (int(open(cnt).read()) if os.path.exists(cnt) else 0) + 1
    open(cnt, "w").write(str(n))
    panes = fx.get("panes", [])
    if fx.get("flip_after") is not None and n > fx["flip_after"]:
        panes = [p for p in panes if p["pane_id"] != "wM:p1"]
    print(json.dumps({"result": {"panes": panes}}))
elif a[:2] == ["workspace", "list"]:
    print(json.dumps({"result": {"workspaces": fx.get("workspaces", [])}}))
elif a[:2] == ["tab", "create"]:
    print(json.dumps({"result": {"tab": {"tab_id": "wT:t9"}, "root_pane": {"pane_id": "wT:p9"}}}))
elif a[:2] == ["agent", "read"]:
    print("fake agent screen tail")
else:
    print("{}")
'''

HERDR_READS = {("agent", "list"), ("agent", "get"), ("agent", "read"), ("tab", "list"), ("pane", "list"),
               ("workspace", "list"), ("status", "server")}
NOW = time.time()


def iso(offset):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(NOW + offset))


def bead(id_, **kw):
    b = {"id": id_, "title": "T " + id_, "issue_type": "task", "status": "in_progress",
         "labels": [], "metadata": {}}
    b.update(kw)
    return b


def agent(name, status, pane="wT:p1", tab="wT:t1", cwd="/nowhere"):
    return {"name": name, "agent_status": status, "pane_id": pane, "tab_id": tab, "cwd": cwd}


MC_META = {"pane": "wM:p1", "tab": "wM:t1", "workspace": "wM", "terminal_id": "term_mc", "session": "/s/mc.jsonl"}
MC_PANE = {"pane_id": "wM:p1", "tab_id": "wM:t1", "workspace_id": "wM", "terminal_id": "term_mc", "agent": "pi",
           "agent_session": {"value": "/s/mc.jsonl"}, "agent_status": "idle"}
MC_TAB = {"tab_id": "wM:t1", "label": "mc", "workspace_id": "wM", "pane_count": 1}
OTHER_MC_TAB = {"tab_id": "wZ:t1", "label": "mc", "workspace_id": "wZ", "pane_count": 1}
ACTOR = "Pablo Ontiveros"


def mc_bead(id_="mc-1", lease=+600, **meta_over):
    m = dict(MC_META)
    m.update(meta_over)
    m = {k: v for k, v in m.items() if v is not None}
    return bead(id_, labels=["mission-control"], metadata=m, assignee="mc-session", lease_expires_at=iso(lease))


def load_module():
    loader = importlib.machinery.SourceFileLoader("a4s_reconcile", str(SCRIPT))
    spec = importlib.util.spec_from_loader("a4s_reconcile", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


class ReconcileTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = Path(self.tmp.name)
        for name, body in (("bd", FAKE_BD), ("herdr", FAKE_HERDR)):
            p = t / name
            p.write_text(body)
            p.chmod(p.stat().st_mode | stat.S_IXUSR)
        self.t = t
        (t / "repo").mkdir()
        self.log = t / "calls.log"

    def tearDown(self):
        self.tmp.cleanup()

    def fx(self, **kw):
        """Fixture with a healthy canonical MC (owner Bead + live pane + mc tab) unless overridden."""
        d = {"workspaces": [{"workspace_id": "wT", "label": "repo"}, {"workspace_id": "wM", "label": "mission-control"}],
             "tabs": [MC_TAB], "panes": [MC_PANE], "mc_beads": [mc_bead()],
             "agents": {"mc": agent("mc", "idle", pane="wM:p1", tab="wM:t1")}}
        d["tabs"] = d["tabs"] + kw.pop("tabs", [])
        d["panes"] = d["panes"] + kw.pop("panes", [])
        d["agents"] = dict(d["agents"], **kw.pop("agents", {}))
        d.update(kw)
        return d

    def tick(self, fx, *args, apply=False, repo="repo"):
        (self.t / "fx.json").write_text(json.dumps(fx))
        self.log.write_text("")
        pc = Path(str(self.log) + ".panes")
        if pc.exists():
            pc.unlink()
        (self.t / repo).mkdir(exist_ok=True)
        env = dict(os.environ, A4S_BD=str(self.t / "bd"), A4S_HERDR=str(self.t / "herdr"),
                   A4S_FIXTURE=str(self.t / "fx.json"), A4S_LOG=str(self.log), HERDR_TAB_ID="wS:t0",
                   BEADS_ACTOR=ACTOR)
        cmd = [sys.executable, str(SCRIPT), "--repo", str(self.t / repo), "--state-dir", str(self.t / "state"),
               "--callback", "wO:p1"] + list(args) + (["--apply"] if apply else ["--dry-run"])
        p = subprocess.run(cmd, capture_output=True, text=True, env=env)
        return p, self.log.read_text()

    def mutations(self, log):
        out = []
        for l in log.splitlines():
            if l.startswith("bd "):
                out.append(l)
            elif l.startswith("herdr "):
                w = l.split()[1:3]
                if tuple(w) not in HERDR_READS:
                    out.append(l)
        return out

    def tickets(self, pattern="*.md"):
        d = self.t / "state" / "attention"
        return sorted(f.name for f in d.glob(pattern)) if d.exists() else []

    # ---------------------------------------------------------------- baseline behaviour
    def test_herdr_down_is_noop(self):
        p, log = self.tick(self.fx(down=True, in_progress=[bead("b-1")]), apply=True)
        self.assertEqual(p.returncode, 0)
        self.assertIn("no-op", p.stdout)
        self.assertNotIn("bd-read", log)

    def test_dry_run_default_mutates_nothing_even_when_actions_planned(self):
        fx = self.fx(in_progress=[bead("b-1", metadata={"worker": "w1", "pane": "wT:p1"})],
                     agents={"w1": agent("w1", "done")})
        p, log = self.tick(fx)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("PLAN  HARVEST", p.stdout)
        self.assertEqual(self.mutations(log), [])
        self.assertFalse((self.t / "state").exists())

    def test_working_left_alone(self):
        fx = self.fx(in_progress=[bead("b-1", metadata={"worker": "w1"})], agents={"w1": agent("w1", "working")})
        p, log = self.tick(fx, apply=True)
        self.assertIn("LEAVE", p.stdout)
        self.assertEqual(self.mutations(log), [])

    def test_done_harvests_then_closes_as_assignee(self):
        fx = self.fx(in_progress=[bead("b-1", assignee=ACTOR, metadata={"worker": "w1"})],
                     agents={"w1": agent("w1", "done")}, assignees={"b-1": ACTOR})
        p, log = self.tick(fx, apply=True)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        closes = [l for l in log.splitlines() if l.startswith("bd close b-1")]
        self.assertEqual(len(closes), 1, log)
        self.assertNotIn("--actor", closes[0])  # the flag would override BEADS_ACTOR and trip the assignee guard
        self.assertIn("##BEADS_ACTOR=" + ACTOR, closes[0])
        self.assertIn("closed_by=a4s-reconcile", closes[0])  # true identity survives in the reason
        self.assertTrue((self.t / "state" / "harvest" / "b-1-w1.txt").exists())
        audit = [json.loads(l) for l in (self.t / "state" / "audit.jsonl").read_text().splitlines()]
        self.assertEqual([(r["actor"], r["bd_actor_env"], r["tool"]) for r in audit], [("a4s-reconcile", ACTOR, "bd")])

    def test_not_found_redispatches_and_links_new_worker(self):
        fx = self.fx(in_progress=[bead("b-1", description="do it", assignee=ACTOR,
                                        metadata={"worker": "gone", "tab": "wT:t5"})], assignees={"b-1": ACTOR})
        p, log = self.tick(fx, apply=True)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("herdr tab create --workspace wT", log)
        self.assertIn("worker=r-b-1-1", log)
        self.assertIn("prev_tabs=wT:t5", log)
        self.assertIn("herdr agent start r-b-1-1 --kind claude --pane wT:p9 -- --model sonnet", log)
        self.assertIn("herdr agent prompt r-b-1-1", log)
        self.assertIn('BEADS_ACTOR="%s" bd close b-1' % ACTOR, log)  # worker close instructions use the assignee
        self.assertNotIn("--claim", log)

    def test_not_found_redispatch_is_bounded(self):
        fx = self.fx(in_progress=[bead("b-1", metadata={"worker": "gone", "redispatch": "2"})])
        p, log = self.tick(fx, apply=True)
        self.assertIn("REDISPATCH_EXHAUSTED", p.stdout)
        self.assertEqual(self.mutations(log), [])
        self.assertEqual(len(self.tickets("b-1--REDISPATCH_EXHAUSTED--*.md")), 1)

    def test_settling_worker_not_judged(self):
        fx = self.fx(in_progress=[bead("b-1", metadata={"worker": "gone", "dispatched_at": str(int(time.time()))})])
        p, log = self.tick(fx, apply=True)
        self.assertIn("settling", p.stdout)
        self.assertEqual(self.mutations(log), [])

    def test_blocked_worker_is_evidence_only_and_idempotent(self):
        fx = self.fx(in_progress=[bead("b-1", metadata={"worker": "w1"})], agents={"w1": agent("w1", "blocked")})
        p1, log1 = self.tick(fx, apply=True)
        self.assertEqual(self.mutations(log1), [])
        files = list((self.t / "state" / "attention").glob("b-1--*.md"))
        self.assertEqual(len(files), 1)
        self.assertIn("lifecycle_mutation: none", files[0].read_text())
        p2, _ = self.tick(fx, apply=True)
        self.assertIn("already ticketed", p2.stdout)
        self.assertEqual(len(list((self.t / "state" / "attention").glob("b-1--*.md"))), 1)

    def test_idle_and_pane_mismatch_fail_closed(self):
        fx = self.fx(in_progress=[bead("b-1", metadata={"worker": "w1"}),
                                  bead("b-2", metadata={"worker": "w2", "pane": "wT:p7"})],
                     agents={"w1": agent("w1", "idle"), "w2": agent("w2", "done", pane="wT:p2")})
        p, log = self.tick(fx, apply=True)
        self.assertIn("WORKER_IDLE", p.stdout)
        self.assertIn("WORKER_MISMATCH", p.stdout)
        self.assertEqual(self.mutations(log), [])

    def test_reaper_closes_finished_tab_but_respects_guards(self):
        old = "2026-01-01T00:00:00Z"
        closed = [bead("c-ok", status="closed", closed_at=old, metadata={"worker": "w1", "tab": "wT:t1"}),
                  bead("c-busy", status="closed", closed_at=old, metadata={"worker": "w2", "tab": "wT:t2"}),
                  bead("c-shared", status="closed", closed_at=old, metadata={"worker": "w3", "tab": "wT:t3"}),
                  bead("c-self", status="closed", closed_at=old, metadata={"worker": "w4", "tab": "wS:t0"}),
                  bead("c-fresh", status="closed", closed_at=iso(0), metadata={"worker": "w5", "tab": "wT:t5"})]
        tabs = [{"tab_id": t, "pane_count": 1} for t in ("wT:t1", "wT:t2", "wT:t3", "wS:t0", "wT:t5")]
        fx = self.fx(closed=closed, tabs=tabs,
                     live_tabs=[bead("o-1", metadata={"worker": "wx", "tab": "wT:t3"})],
                     agents={"w1": agent("w1", "done", tab="wT:t1"), "w2": agent("w2", "working", tab="wT:t2")})
        p, log = self.tick(fx, apply=True)
        closes = [l for l in log.splitlines() if l.startswith("herdr tab close")]
        self.assertEqual(closes, ["herdr tab close wT:t1"], p.stdout)

    def test_blocked_and_needs_decision_ticketed_without_mutation(self):
        fx = self.fx(blocked=[bead("b-1", status="blocked")],
                     needs=[bead("b-2", status="open", labels=["needs-decision"])])
        p, log = self.tick(fx, apply=True)
        self.assertEqual(self.mutations(log), [])
        names = sorted(n.split("--")[1] for n in self.tickets("b-*.md"))
        self.assertEqual(names, ["BEAD_BLOCKED", "NEEDS_DECISION"])

    def test_dispatch_is_opt_in_claims_and_is_bounded(self):
        ready = [bead("r-1", status="open", labels=["auto-dispatch"], metadata={"kind": "pi"}),
                 bead("r-2", status="open", labels=[]),
                 bead("r-epic", status="open", labels=["auto-dispatch"], issue_type="epic")]
        p, log = self.tick(self.fx(ready=ready), apply=True)
        self.assertIn("bd update r-1 --claim", log)
        self.assertIn("herdr agent start r-r-1 --kind pi --pane wT:p9", log)
        self.assertNotIn("r-2", "".join(l for l in log.splitlines() if l.startswith("bd update")))
        self.assertNotIn("r-epic", log.replace("bd-read", ""))

    def test_ready_assigned_to_someone_else_is_skipped(self):
        ready = [bead("r-1", status="open", labels=["auto-dispatch"], assignee="someone-else")]
        p, log = self.tick(self.fx(ready=ready), apply=True)
        self.assertIn("assigned to someone-else", p.stdout)
        self.assertEqual(self.mutations(log), [])

    def test_dispatch_requires_callback_and_known_kind(self):
        ready = [bead("r-1", status="open", labels=["auto-dispatch"], metadata={"kind": "codex"})]
        p, log = self.tick(self.fx(ready=ready), apply=True)
        self.assertIn("not in ['claude', 'pi']", p.stdout)
        self.assertNotIn("herdr agent start", log)
        self.assertEqual(p.returncode, 1)

    def test_ready_dispatch_is_idempotent_across_ticks(self):
        ready = [bead("r-1", status="open", labels=["auto-dispatch"])]
        p1, log1 = self.tick(self.fx(ready=ready), apply=True)
        self.assertEqual(len([l for l in log1.splitlines() if l.startswith("herdr tab create")]), 1)
        # after the tick: Bead claimed + worker stamped, agent live and working => nothing ready, nothing to do
        fx2 = self.fx(in_progress=[bead("r-1", assignee=ACTOR, labels=["auto-dispatch"],
                                        metadata={"worker": "r-r-1", "pane": "wT:p9", "tab": "wT:t9",
                                                  "dispatched_at": str(int(time.time()) - 600)})],
                      agents={"r-r-1": agent("r-r-1", "working", pane="wT:p9", tab="wT:t9")})
        p2, log2 = self.tick(fx2, apply=True)
        self.assertEqual(self.mutations(log2), [])
        self.assertIn("LEAVE", p2.stdout)

    def test_dry_run_plan_is_repeatable(self):
        ready = [bead("r-1", status="open", labels=["auto-dispatch"])]
        strip = lambda s: "\n".join(l for l in s.splitlines() if "dispatched_at" not in l)
        a, _ = self.tick(self.fx(ready=ready))
        b, _ = self.tick(self.fx(ready=ready))
        self.assertEqual(strip(a.stdout), strip(b.stdout))

    # ---------------------------------------------------------------- MC safety gate
    def work_fixture(self, **kw):
        """Everything the reconciler would normally act on: dispatch, redispatch, harvest, reap."""
        old = "2026-01-01T00:00:00Z"
        d = dict(ready=[bead("r-1", status="open", labels=["auto-dispatch"])],
                 in_progress=[bead("g-1", metadata={"worker": "gone"}),
                              bead("d-1", metadata={"worker": "w1"}, assignee=ACTOR)],
                 closed=[bead("c-1", status="closed", closed_at=old, metadata={"worker": "w9", "tab": "wT:t7"})],
                 tabs=[{"tab_id": "wT:t7", "pane_count": 1}], agents={"w1": agent("w1", "done")},
                 assignees={"d-1": ACTOR})
        d.update(kw)
        return d

    def test_mc_gate_open_lets_work_through(self):
        p, log = self.tick(self.fx(**self.work_fixture()), apply=True)
        self.assertIn("MC-GATE", p.stdout)
        self.assertIn("OPEN owner=mc-1 pane=wM:p1", p.stdout)
        self.assertTrue(self.mutations(log))
        self.assertIn("herdr tab close wT:t7", log)

    def test_mc_gate_closed_verdicts_mean_zero_mutations(self):
        cases = {
            "ABSENT-label-alone-is-not-ownership": ("ABSENT", dict(mc_beads=[])),
            "DUPLICATED-two-owner-beads": ("DUPLICATED", dict(mc_beads=[mc_bead("mc-1"), mc_bead("mc-2")])),
            "DUPLICATED-second-labelled-claimant": ("DUPLICATED", dict(tabs=[OTHER_MC_TAB])),
            "STALE-lease-expired": ("STALE", dict(mc_beads=[mc_bead(lease=-3600)])),
            "STALE-no-lease": ("STALE", dict(mc_beads=[bead("mc-1", labels=["mission-control"], metadata=dict(MC_META))])),
            "STALE-owner-pane-gone": ("STALE", dict(mc_beads=[mc_bead(pane="wM:p9")])),
            "AMBIGUOUS-terminal-mismatch": ("AMBIGUOUS", dict(mc_beads=[mc_bead(terminal_id="term_other")])),
            "AMBIGUOUS-session-mismatch": ("AMBIGUOUS", dict(mc_beads=[mc_bead(session="/s/other.jsonl")])),
            "AMBIGUOUS-no-identity": ("AMBIGUOUS", dict(mc_beads=[mc_bead(terminal_id=None, session=None)])),
        }
        for name, (verdict, over) in cases.items():
            with self.subTest(name):
                fx = self.fx(**dict(self.work_fixture(), **over))
                for apply in (True, False):
                    p, log = self.tick(fx, apply=apply)
                    self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
                    self.assertIn("CLOSED (%s)" % verdict, p.stdout)
                    self.assertEqual(self.mutations(log), [], log)
                    self.assertNotIn("would run", p.stdout)
                self.assertTrue(self.tickets("mission-control--MC_GATE_%s--*.md" % verdict), self.tickets())
                shutil.rmtree(self.t / "state", ignore_errors=True)

    def test_mc_gate_ticket_is_evidence_only_and_idempotent(self):
        fx = self.fx(**self.work_fixture(), **{})
        fx["mc_beads"] = []
        self.tick(fx, apply=True)
        p, log = self.tick(fx, apply=True)
        self.assertIn("already ticketed", p.stdout)
        files = list((self.t / "state" / "attention").glob("mission-control--MC_GATE_ABSENT--*.md"))
        self.assertEqual(len(files), 1)
        self.assertIn("lifecycle_mutation: none", files[0].read_text())
        self.assertEqual(self.mutations(log), [])

    def test_mc_gate_is_rechecked_before_each_dispatch(self):
        ready = [bead("r-1", status="open", labels=["auto-dispatch"]), bead("r-2", status="open", labels=["auto-dispatch"])]
        # pane list #1 = snapshot, #2 = re-check before dispatch 1, #3 = re-check before dispatch 2 (MC vanished)
        p, log = self.tick(self.fx(ready=ready, flip_after=2), apply=True)
        self.assertEqual(len([l for l in log.splitlines() if l.startswith("herdr tab create")]), 1, p.stdout)
        self.assertIn("CLOSED (STALE) at re-check", p.stdout)
        self.assertTrue(self.tickets("mission-control--MC_GATE_STALE--*.md"))

    def test_plan_ignoring_gate_is_dry_run_only(self):
        fx = self.fx(**dict(self.work_fixture(), mc_beads=[]))
        p, log = self.tick(fx, "--plan-ignoring-mc-gate")
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("CLOSED (ABSENT)", p.stdout)
        self.assertIn("PLAN  DISPATCH", p.stdout)
        self.assertEqual(self.mutations(log), [])
        self.assertFalse((self.t / "state").exists())
        p, log = self.tick(fx, "--plan-ignoring-mc-gate", apply=True)
        self.assertEqual(p.returncode, 2)
        self.assertEqual(log, "")

    # ---------------------------------------------------------------- mc pane is never mutated
    def test_reaper_never_closes_mc_tab(self):
        old = "2026-01-01T00:00:00Z"
        closed = [bead("c-mc", status="closed", closed_at=old, metadata={"worker": "mc", "tab": "wM:t1"}),
                  bead("c-ynab", status="closed", closed_at=old, metadata={"worker": "y", "tab": "wM:t6"})]
        fx = self.fx(closed=closed, tabs=[{"tab_id": "wM:t6", "label": "ynab", "workspace_id": "wM", "pane_count": 1}],
                     panes=[{"pane_id": "wM:p6", "tab_id": "wM:t6", "workspace_id": "wM"}])
        p, log = self.tick(fx, apply=True)
        self.assertEqual(self.mutations(log), [], p.stdout)
        self.assertEqual(len(self.tickets("c-mc--MC_PROTECTED--*.md")), 1)
        self.assertEqual(len(self.tickets("c-ynab--MC_PROTECTED--*.md")), 1)  # whole MC workspace is off-limits

    def test_dispatch_never_targets_mc_workspace(self):
        # repo basename == MC workspace label: the resolved space IS the MC space -> refuse before claiming
        ready = [bead("r-1", status="open", labels=["auto-dispatch"])]
        p, log = self.tick(self.fx(ready=ready), apply=True, repo="mission-control")
        self.assertEqual(self.mutations(log), [], p.stdout)
        self.assertIn("Mission Control workspace", p.stdout)
        self.assertTrue(self.tickets("r-1--MC_PROTECTED--*.md"))

    def test_guard_allowlist_and_protected_targets_unit(self):
        mod = load_module()
        args = type("A", (), dict(apply=False, repo=str(self.t / "repo"), state_dir=str(self.t / "s"), callback="x",
                                  dispatch_label="", settle=60, reap_grace=120, max_redispatch=2, max_dispatch=3,
                                  default_kind="claude", default_model="sonnet", stale_after=1800, mc_grace=60,
                                  plan_ignoring_mc_gate=False))()
        ctx = mod.Ctx(args)
        ctx.workspaces = {"wM": {"workspace_id": "wM", "label": "mission-control"}, "wT": {"workspace_id": "wT", "label": "repo"}}
        ctx.tabs = {"wM:t1": MC_TAB, "wM:t6": {"tab_id": "wM:t6", "label": "ynab", "workspace_id": "wM"},
                    "wT:t1": {"tab_id": "wT:t1", "label": "w", "workspace_id": "wT"}}
        ctx.panes = {"wM:p1": MC_PANE, "wM:p6": {"pane_id": "wM:p6", "tab_id": "wM:t6", "workspace_id": "wM"},
                     "wT:p1": {"pane_id": "wT:p1", "tab_id": "wT:t1", "workspace_id": "wT"}}
        ctx.agents = {"mc": agent("mc", "idle", pane="wM:p1", tab="wM:t1"), "w": agent("w", "working")}
        ctx.mc_beads = [mc_bead()]
        self.assertTrue(mod.evaluate_gate(ctx))
        refused = [["pane", "split", "wM:p1"], ["pane", "move", "wM:p1"], ["pane", "close", "wT:p1"],
                   ["workspace", "create", "--label", "x"], ["workspace", "close", "wM"], ["tab", "rename", "wM:t1", "x"],
                   ["tab", "create", "--workspace", "wM", "--label", "b"], ["tab", "create", "--workspace", "wT", "--label", "mc"],
                   ["tab", "create", "--workspace", "wT", "--label", "Mission-Control"],
                   ["tab", "close", "wM:t1"], ["tab", "close", "wM:t6"],
                   ["agent", "start", "n", "--kind", "claude", "--pane", "wM:p1"],
                   ["agent", "start", "n", "--kind", "claude", "--pane", "wM:p6"],
                   ["agent", "prompt", "mc", "hi"], ["agent", "prompt", "wM:p1", "hi"]]
        for argv in refused:
            with self.subTest(argv=argv), self.assertRaises(mod.GuardViolation):
                mod.mutate(ctx, argv)  # dry-run too: the guard runs before the would-run print
        allowed = [["tab", "create", "--workspace", "wT", "--cwd", "/x", "--label", "b-1", "--no-focus"],
                   ["tab", "close", "wT:t1"], ["agent", "start", "n", "--kind", "pi", "--pane", "wT:p1"],
                   ["agent", "prompt", "w", "hi"]]
        for argv in allowed:
            with self.subTest(argv=argv), contextlib.redirect_stdout(io.StringIO()):
                mod.mutate(ctx, argv)
        ctx.gate = {"verdict": "STALE", "reasons": ["x"], "owner": None}
        with self.assertRaises(mod.GuardViolation):
            mod.mutate(ctx, allowed[0])  # closed gate refuses every mutation, even benign ones
        with self.assertRaises(mod.GuardViolation):
            mod.mutate(ctx, ["update", "b-1"], tool="bd")

    # ---------------------------------------------------------------- MC ownership Bead is never mutated (F1)
    def assert_mc_untouched(self, p, log, bead_id="mc-1"):
        self.assertEqual(self.mutations(log), [], p.stdout)
        self.assertNotRegex(log, r"(?m)^bd (close|update) %s\b" % bead_id)
        self.assertNotIn("herdr tab create", log)
        self.assertFalse((self.t / "state" / "harvest").exists(), "no harvest artifact for the MC Bead")
        self.assertNotIn("HARVEST", p.stdout)
        self.assertNotIn("REDISPATCH", p.stdout)

    def test_mc_owner_bead_with_done_worker_is_never_harvest_closed(self):
        # reviewer P1: MC owner Bead links a worker whose herdr status is `done` -> was harvested + `bd close`d
        fx = self.fx(mc_beads=[mc_bead(worker="mc")],
                     agents={"mc": agent("mc", "done", pane="wM:p1", tab="wM:t1")}, assignees={"mc-1": "mc-session"})
        for apply in (True, False):
            with self.subTest(apply=apply):
                p, log = self.tick(fx, apply=apply)
                self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
                self.assertIn("MC ownership Bead", p.stdout)
                self.assert_mc_untouched(p, log)
                self.assertNotIn("would run", p.stdout)

    def test_mc_owner_bead_with_missing_worker_is_never_redispatched(self):
        # reviewer P3: MC owner Bead links a worker that herdr no longer lists -> NOT_FOUND -> re-dispatch + re-stamp
        fx = self.fx(mc_beads=[mc_bead(worker="mc-gone", tab="wM:t1")], assignees={"mc-1": "mc-session"})
        for apply in (True, False):
            with self.subTest(apply=apply):
                p, log = self.tick(fx, apply=apply)
                self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
                self.assertIn("MC ownership Bead", p.stdout)
                self.assert_mc_untouched(p, log)
        self.assertEqual(self.tickets("mc-1--*.md"), [])

    def test_mc_owner_bead_unlinked_stale_is_never_redispatched(self):
        # invariant: gate open inside --mc-grace + tiny --stale-after + opt-in label + assignee==actor must still leave the MC Bead alone
        b = mc_bead(lease=-30)
        b.update(assignee=ACTOR, labels=["mission-control", "auto-dispatch"])
        p, log = self.tick(self.fx(mc_beads=[b], assignees={"mc-1": ACTOR}), "--stale-after", "1", apply=True)
        self.assertIn("OPEN owner=mc-1", p.stdout)
        self.assert_mc_untouched(p, log)

    def test_mc_labelled_ready_bead_is_never_dispatched(self):
        ready = [bead("mc-2", status="open", labels=["mission-control", "auto-dispatch"])]
        p, log = self.tick(self.fx(ready=ready), apply=True)
        self.assertEqual(self.mutations(log), [], p.stdout)
        self.assertNotIn("mc-2", "".join(l for l in log.splitlines() if not l.startswith("bd-read")))

    def test_closed_mc_bead_tab_is_never_reaped(self):
        old = "2026-01-01T00:00:00Z"
        closed = [bead("mc-old", status="closed", closed_at=old, labels=["mission-control"],
                       metadata={"worker": "mc-old", "tab": "wT:t7"})]
        p, log = self.tick(self.fx(closed=closed, tabs=[{"tab_id": "wT:t7", "pane_count": 1}]), apply=True)
        self.assertEqual(self.mutations(log), [], p.stdout)

    def test_unlabelled_bead_bound_to_mc_pane_or_agent_is_never_mutated(self):
        # no label, but the Bead is wired to the live MC pane/agent: current MC owner by identity, not by label
        for name, meta in {"worker": {"worker": "mc"}, "pane": {"worker": "w9", "pane": "wM:p1"},
                           "tab": {"worker": "w9", "tab": "wM:t1"}}.items():
            with self.subTest(name):
                fx = self.fx(in_progress=[bead("x-1", assignee=ACTOR, metadata=meta)], assignees={"x-1": ACTOR},
                             agents={"mc": agent("mc", "done", pane="wM:p1", tab="wM:t1"),
                                     "w9": agent("w9", "done", pane="wM:p1", tab="wM:t1")})
                p, log = self.tick(fx, apply=True)
                self.assert_mc_untouched(p, log, "x-1")

    def test_mutate_refuses_bd_writes_to_mc_beads_unit(self):
        mod = load_module()
        args = type("A", (), dict(apply=False, repo=str(self.t / "repo"), state_dir=str(self.t / "s"), callback="x",
                                  dispatch_label="", settle=60, reap_grace=120, max_redispatch=2, max_dispatch=3,
                                  default_kind="claude", default_model="sonnet", stale_after=1800, mc_grace=60,
                                  plan_ignoring_mc_gate=False))()
        ctx = mod.Ctx(args)
        ctx.workspaces = {"wM": {"workspace_id": "wM", "label": "mission-control"}}
        ctx.tabs = {"wM:t1": MC_TAB}
        ctx.panes = {"wM:p1": MC_PANE}
        ctx.agents = {"mc": agent("mc", "idle", pane="wM:p1", tab="wM:t1")}
        ctx.mc_beads = [mc_bead()]
        self.assertTrue(mod.evaluate_gate(ctx))
        other = bead("o-1", metadata={"worker": "w1"})
        ctx.bead_index = {b["id"]: b for b in ctx.mc_beads + [other, bead("mc-9", labels=["mission-control"])]}
        for bid in ("mc-1", "mc-9"):
            for argv in (["close", bid, "--reason", "x"], ["update", bid, "--set-metadata", "worker=r-x"],
                         ["update", bid, "--claim"]):
                with self.subTest(argv=argv), self.assertRaises(mod.GuardViolation):
                    mod.mutate(ctx, argv, tool="bd")
        with contextlib.redirect_stdout(io.StringIO()):
            mod.mutate(ctx, ["close", "o-1", "--reason", "x"], tool="bd")  # ordinary Beads still pass

    # ---------------------------------------------------------------- in_progress without metadata.worker
    def stale_bead(self, id_="u-1", **kw):
        d = dict(assignee=ACTOR, labels=["auto-dispatch"], lease_expires_at=iso(-7200), heartbeat_at=iso(-7500),
                 updated_at=iso(-7500), started_at=iso(-7800), metadata={"worktree": str(self.t / "repo")})
        d.update(kw)
        return bead(id_, **d)

    def test_unlinked_stale_no_agent_optin_assignee_redispatches_in_new_tab(self):
        wt = self.t / "wt"
        wt.mkdir()
        b = self.stale_bead(metadata={"worktree": str(wt)}, description="finish it")
        p, log = self.tick(self.fx(in_progress=[b], assignees={"u-1": ACTOR}), apply=True)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("REDISPATCH", p.stdout)
        self.assertIn("herdr tab create --workspace wT --cwd %s --label u-1" % wt, log)
        stamp = [l for l in log.splitlines() if l.startswith("bd update u-1")]
        self.assertEqual(len(stamp), 1, log)
        self.assertIn("worker=r-u-1-1", stamp[0])
        self.assertIn("redispatch=1", stamp[0])
        self.assertIn("##BEADS_ACTOR=" + ACTOR, stamp[0])
        self.assertNotIn("--claim", log)
        self.assertIn("herdr agent start r-u-1-1 --kind claude --pane wT:p9", log)
        self.assertIn("claimant left no worker link", log)

    def test_unlinked_stale_rule_blockers_become_attention_only(self):
        wt = str(self.t / "repo")
        cases = {
            "no-optin-label": self.stale_bead(labels=[]),
            "assignee-differs": self.stale_bead(assignee="someone-else"),
            "budget-exhausted": self.stale_bead(metadata={"worktree": wt, "redispatch": "2"}),
            "epic": self.stale_bead(issue_type="epic"),
        }
        cases.pop("epic")  # epics are skipped outright, never ticketed
        for name, b in cases.items():
            with self.subTest(name):
                p, log = self.tick(self.fx(in_progress=[b]), apply=True)
                self.assertEqual(self.mutations(log), [], p.stdout)
                self.assertEqual(len(self.tickets("u-1--STALE_UNLINKED--*.md")), 1, self.tickets())
                shutil.rmtree(self.t / "state", ignore_errors=True)

    def test_unlinked_live_lease_or_recent_activity_is_left_alone(self):
        live = self.stale_bead("u-live", lease_expires_at=iso(+120), heartbeat_at=iso(-60), updated_at=iso(-60))
        recent = self.stale_bead("u-recent", lease_expires_at=iso(-300), heartbeat_at=iso(-600), updated_at=iso(-300))
        p, log = self.tick(self.fx(in_progress=[live, recent]), apply=True)
        self.assertEqual(self.mutations(log), [])
        self.assertIn("lease live", p.stdout)
        self.assertIn("not stale", p.stdout)
        self.assertEqual(self.tickets("u-*"), [])

    def test_unlinked_with_live_agent_is_never_redispatched(self):
        wt = self.t / "wt2"
        wt.mkdir()
        cases = {  # every way an agent can be tied to the Bead without metadata.worker
            "name": ({"worker-u-1": agent("worker-u-1", "working", pane="wT:p3", tab="wT:t3")}, [], {}),
            "tab-label": ({"x": agent("x", "working", pane="wT:p3", tab="wT:t3")},
                          [{"tab_id": "wT:t3", "label": "u-1", "workspace_id": "wT"}], {}),
            "worktree-cwd": ({"y": agent("y", "working", pane="wT:p3", tab="wT:t3", cwd=str(wt))}, [],
                             {"worktree": str(wt)}),
            "recorded-pane": ({"z": agent("z", "working", pane="wT:p3", tab="wT:t3")}, [], {"pane": "wT:p3"}),
        }
        for name, (agents, tabs, meta) in cases.items():
            with self.subTest(name):
                b = self.stale_bead(metadata=dict({"worktree": str(self.t / "repo")}, **meta))
                p, log = self.tick(self.fx(in_progress=[b], agents=agents, tabs=tabs), apply=True)
                self.assertEqual(self.mutations(log), [], p.stdout)
                self.assertIn("unlinked but live agent associated", p.stdout)

    def test_unlinked_blocked_or_idle_agent_is_attention(self):
        b = self.stale_bead()
        p, log = self.tick(self.fx(in_progress=[b], agents={"worker-u-1": agent("worker-u-1", "blocked", tab="wT:t3")}), apply=True)
        self.assertEqual(self.mutations(log), [])
        self.assertEqual(len(self.tickets("u-1--WORKER_BLOCKED--*.md")), 1)
        p, log = self.tick(self.fx(in_progress=[b], agents={"worker-u-1": agent("worker-u-1", "idle", tab="wT:t3")}), apply=True)
        self.assertEqual(self.mutations(log), [])
        self.assertEqual(len(self.tickets("u-1--UNLINKED_WORKER_IDLE--*.md")), 1)

    def test_shared_dispatch_budget_bounds_redispatch_plus_ready(self):
        fx = self.fx(in_progress=[self.stale_bead("u-1"), self.stale_bead("u-2")],
                     ready=[bead("r-1", status="open", labels=["auto-dispatch"])],
                     assignees={"u-1": ACTOR, "u-2": ACTOR})
        p, log = self.tick(fx, "--max-dispatch", "1", apply=True)
        self.assertEqual(len([l for l in log.splitlines() if l.startswith("herdr tab create")]), 1, p.stdout)
        self.assertEqual(p.stdout.count("DEFER"), 2)


if __name__ == "__main__":
    unittest.main()
