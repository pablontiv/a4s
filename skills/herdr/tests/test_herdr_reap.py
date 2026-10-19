#!/usr/bin/env python3
"""Guard tests for herdr-reap (bead a4s-1to.2).

Exercises the pure fail-closed decision core with representative tab states.
Run: python3 skills/herdr/tests/test_herdr_reap.py

Zero third-party deps: a tiny assert harness so the reaper stays runnable on a
vanilla launchd/cron python3.
"""
import importlib.util
import importlib.machinery
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "scripts", "herdr-reap")

_loader = importlib.machinery.SourceFileLoader("herdr_reap", SCRIPT)
_spec = importlib.util.spec_from_loader("herdr_reap", _loader)
assert _spec is not None
reap = importlib.util.module_from_spec(_spec)
sys.modules["herdr_reap"] = reap  # dataclasses (py3.14) resolves via sys.modules
_loader.exec_module(reap)

Unit = reap.Unit
classify = reap.classify
THRESH = 3600

_failures = []


def check(name, cond, detail=""):
    status = "ok" if cond else "FAIL"
    print(f"[{status}] {name}" + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        _failures.append(name)


def reapable_unit(**over):
    """A unit that passes every guard; override fields to break one guard."""
    base = dict(
        tab_id="w4J:t42", pane_id="w4J:p42", workspace_id="w4J", label="a4s-xyz",
        focused=False, agent_present=True, agent_status="done",
        idle_age=THRESH * 2, cwd="/tmp/wt",
        bead={"id": "a4s-xyz", "status": "closed"},
        worktree_state=reap.WORKTREE_CLEAN_MERGED,
        protected=False, protected_reason="",
    )
    base.update(over)
    return Unit(**base)


# --- happy path -----------------------------------------------------------
d = classify(reapable_unit(), THRESH)
check("all guards pass => REAP", d.decision == reap.REAP, d.reasons)
check("REAP carries bead id", d.bead_id == "a4s-xyz")

# --- guard 1: agent status ------------------------------------------------
check("no agent => KEEP",
      classify(reapable_unit(agent_present=False, agent_status=""), THRESH).decision == reap.KEEP)
check("working agent => KEEP",
      classify(reapable_unit(agent_status="working"), THRESH).decision == reap.KEEP)
check("blocked agent => KEEP",
      classify(reapable_unit(agent_status="blocked"), THRESH).decision == reap.KEEP)
check("idle(not done) agent => KEEP",
      classify(reapable_unit(agent_status="idle"), THRESH).decision == reap.KEEP)

# --- guard 2: focus -------------------------------------------------------
check("focused => KEEP",
      classify(reapable_unit(focused=True), THRESH).decision == reap.KEEP)

# --- guard 3: protected ---------------------------------------------------
check("protected => KEEP (even if otherwise reapable)",
      classify(reapable_unit(protected=True, protected_reason="mission-control"),
               THRESH).decision == reap.KEEP)

# --- guard 4: idle age ----------------------------------------------------
check("idle unknown => KEEP",
      classify(reapable_unit(idle_age=None), THRESH).decision == reap.KEEP)
check("idle below threshold => KEEP",
      classify(reapable_unit(idle_age=THRESH - 1), THRESH).decision == reap.KEEP)
check("idle exactly threshold => REAP",
      classify(reapable_unit(idle_age=THRESH), THRESH).decision == reap.REAP)

# --- guard 5: callback harvested (bead binding) ---------------------------
check("no bead binding => ATTENTION (orphan, never closed)",
      classify(reapable_unit(bead=None), THRESH).decision == reap.ATTENTION)
check("open bead => KEEP (work in flight)",
      classify(reapable_unit(bead={"id": "a4s-xyz", "status": "open"}),
               THRESH).decision == reap.KEEP)
check("in_progress bead => KEEP",
      classify(reapable_unit(bead={"id": "a4s-xyz", "status": "in_progress"}),
               THRESH).decision == reap.KEEP)

# --- guard 6: worktree ----------------------------------------------------
check("dirty worktree => ATTENTION",
      classify(reapable_unit(worktree_state=reap.WORKTREE_DIRTY),
               THRESH).decision == reap.ATTENTION)
check("unknown worktree => ATTENTION",
      classify(reapable_unit(worktree_state=reap.WORKTREE_UNKNOWN),
               THRESH).decision == reap.ATTENTION)

# --- precedence: protected beats everything, focus beats status -----------
check("protected outranks focus+status",
      classify(reapable_unit(protected=True, protected_reason="own tab",
                             focused=True, agent_status="done"),
               THRESH).decision == reap.KEEP)

# --- worktree_state IO helper (real git, fail-closed on non-repo) ---------
check("worktree_state on non-dir => unknown",
      reap.worktree_state("/nonexistent/path/xyz") == reap.WORKTREE_UNKNOWN)

# --- binding regex --------------------------------------------------------
line = "2026-09-19: worker=rev pane=w4J:pA tab=w4J:tA kind=claude model=sonnet"
handles = reap.BINDING_RE.findall(line)
check("binding regex extracts pane+tab handles",
      handles == ["w4J:pA", "w4J:tA"], handles)

# --------------------------------------------------------------------------
print()
if _failures:
    print(f"FAILED: {len(_failures)} check(s): {', '.join(_failures)}")
    sys.exit(1)
print("all checks passed")
