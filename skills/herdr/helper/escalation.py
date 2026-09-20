#!/usr/bin/env python3
"""Worker escalation routing: every blocker/question goes to the Bead's orchestrator_target, and nowhere else.

The dispatcher (a4s-reconcile, or the Project Orchestrator by hand) stamps two structured keys on the Bead before
the agent starts or is prompted:

  orchestrator_target   the Project Orchestrator's pane id or unique agent name
  correlation_id        the one id of this dispatch (see task_ack.py)

A Worker never asks the Human Operator or Mission Control anything. A blocker, question, approval request or
decision need is written to a report and sent as one correlated envelope, only to the stamped target:

  ATTENTION REQUIRED verdict=blocked type=<BLOCKER|QUESTION> artifact_path=<path> bead_id=<id> correlation_id=<id>

If the target is missing, invalid, a Human/Mission Control identity, or the Worker itself, nothing is sent
(REFUSED). If Herdr rejects the delivery, the evidence is persisted on the Bead (`escalation_*` metadata) and
an `ATTENTION DELIVERY_FAILED ...` notice is sent once to the very same target if that is possible. Either way the
Worker stops. There is no `--target` flag and no fallback: the target is read from the Bead, never chosen by the
Worker, and it is never Human/MC.

Exit 0 = delivered. Exit 3 = refused or delivery failed: the Worker STOPS (no work, no Bead close, no retry to
anyone else). Only external commands: `bd` (Bead read/evidence) and `herdr agent prompt <target>` (delivery).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from typing import Callable

import task_ack as ta

KINDS = ("BLOCKER", "QUESTION")
TARGET_KEY = "orchestrator_target"
MC_LABEL = "mission-control"
# Human Operator / Mission Control identities by name. Conservative on purpose: over-matching only refuses a
# delivery (fail closed), it can never send one somewhere it should not go.
FORBIDDEN_TARGET_RE = re.compile(r"^(mc|mission[-_]?control|human([-_]?operator)?|operator|user|owner)([-_.:].*)?$", re.I)
TICKET_PREFIX = "ESCALATION"
TICKET_NOTE = ("Evidence-only. The Worker's escalation was NOT routed to the Human Operator or Mission Control: "
               "the only permitted target is the Bead's orchestrator_target. Bead status is unchanged.")

PATH_RE = re.compile(r"/[A-Za-z0-9_.:@/+=-]{1,255}")  # absolute, same closed alphabet as every envelope value

Deliver = Callable[[str, str], "tuple[int, str, str]"]


# --------------------------------------------------------------------------
# Target rules (pure; shared with a4s-reconcile so dispatcher and Worker agree)
# --------------------------------------------------------------------------
def check_target(target, mc_identities=(), worker_identities=()) -> "tuple[str, str] | None":
    """-> None when `target` may receive escalations, else (code, detail)."""
    if not target:
        return "TARGET_MISSING", "no %s stamped on the Bead" % TARGET_KEY
    target = str(target)
    if not ta.VALUE_RE.fullmatch(target):
        return "TARGET_INVALID", "%s %r is not a pane id or agent name ([A-Za-z0-9][A-Za-z0-9_.:@/+=-]*)" % (
            TARGET_KEY, target[:60])
    if FORBIDDEN_TARGET_RE.match(target):
        return "TARGET_FORBIDDEN", "%s %r names the Human Operator or Mission Control" % (TARGET_KEY, target)
    if target in mc_identities:
        return "TARGET_FORBIDDEN", "%s %r is a Mission Control pane/agent" % (TARGET_KEY, target)
    if target in worker_identities:
        return "TARGET_IS_WORKER", "%s %r is the Worker itself" % (TARGET_KEY, target)
    return None


def attention_envelope(kind: str, artifact_path: str, bead_id: str, correlation_id: str) -> str:
    return "ATTENTION REQUIRED verdict=blocked type=%s artifact_path=%s bead_id=%s correlation_id=%s" % (
        kind, artifact_path, bead_id, correlation_id)


def delivery_failed_envelope(artifact_path: str, bead_id: str, correlation_id: str, target: str) -> str:
    return "ATTENTION DELIVERY_FAILED verdict=blocked artifact_path=%s bead_id=%s correlation_id=%s target=%s" % (
        artifact_path, bead_id, correlation_id, target)


# --------------------------------------------------------------------------
# Bead + Herdr access
# --------------------------------------------------------------------------
def mission_control_identities(beads: ta.Beads) -> set:
    """Panes/tabs/agents recorded on in_progress Beads labelled mission-control. Fail closed if unreadable."""
    rc, out, err = beads.runner([beads.bd_bin, "list", "--label", MC_LABEL, "--status", "in_progress",
                                 "--limit", "0", "--json"], beads.repo, None)
    try:
        data = json.loads(out) if rc == 0 else None
    except ValueError:
        data = None
    if not isinstance(data, list):
        raise ta.ClosedError("TARGET_UNVERIFIABLE", "cannot read the Mission Control Bead to rule it out as a target "
                             "(bd list rc=%s: %s)" % (rc, err.strip()[:200]))
    return {str(ta.meta(b)[k]) for b in data if isinstance(b, dict)
            for k in ("pane", "tab", "worker", "terminal_id") if ta.meta(b).get(k)}


def herdr_prompt(target: str, text: str) -> "tuple[int, str, str]":
    """`herdr agent prompt <target> <text>`: no --wait, no timeout flag, one attempt."""
    argv = [os.environ.get("A4S_HERDR", "herdr"), "agent", "prompt", target, text]
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 127, "", str(exc)
    return p.returncode, p.stdout, p.stderr


def one_line(text: str, n: int = 200) -> str:
    return " ".join(str(text).split())[:n]


# --------------------------------------------------------------------------
# Routing
# --------------------------------------------------------------------------
def escalate(beads: ta.Beads, deliver: Deliver, state_dir: str, bead_id: str, correlation_id: str, kind: str,
             artifact_path: str, now: "str | None" = None) -> "tuple[int, dict]":
    """Route one blocker/question to the Bead's orchestrator_target. Returns (exit_code, json-able result)."""
    request = "escalate type=%s bead_id=%s correlation_id=%s artifact_path=%s" % (
        kind, bead_id, correlation_id, artifact_path)
    bead = None
    target = None
    try:
        if kind not in KINDS:
            raise ta.ClosedError("MALFORMED", "type must be one of %s" % ", ".join(KINDS), bead_id=bead_id)
        for name, value, rx in (("bead_id", bead_id, ta.VALUE_RE), ("correlation_id", correlation_id, ta.VALUE_RE),
                                ("artifact_path", artifact_path, PATH_RE)):
            if not rx.fullmatch(str(value)):
                raise ta.ClosedError("MALFORMED", "%s is empty, not an absolute path, or has characters outside "
                                     "[A-Za-z0-9_.:@/+=-]" % name, bead_id=bead_id)
        bead = ta.check_bead(beads, {"bead_id": bead_id, "correlation_id": correlation_id})
        m = ta.meta(bead)
        target = m.get(TARGET_KEY)
        problem = check_target(target)
        if problem is None:
            problem = check_target(target, mission_control_identities(beads),
                                   {str(m[k]) for k in ("worker", "pane", "tab") if m.get(k)})
        if problem:
            raise ta.ClosedError(problem[0], problem[1], bead_id=bead_id, target=str(target or "none")[:60])
    except ta.ClosedError as err:
        return _refuse(beads, state_dir, bead, err, request, now)

    target = str(target)
    envelope = attention_envelope(kind, artifact_path, bead_id, correlation_id)
    rc, out, err_text = deliver(target, envelope)
    if rc == 0:
        return 0, {"status": "DELIVERED", "bead_id": bead_id, "correlation_id": correlation_id, "type": kind,
                   "target": target, "envelope": envelope}
    return _delivery_failed(beads, deliver, state_dir, bead, target, kind, artifact_path, request,
                            "herdr agent prompt %s rc=%s: %s" % (target, rc, one_line(err_text or out)), now)


def _ticket(state_dir: str, bead_id: str, err: ta.ClosedError, request: str) -> str:
    try:
        return ta.write_ticket(state_dir, bead_id, err, request, prefix=TICKET_PREFIX, note=TICKET_NOTE)
    except OSError as exc:  # evidence could not be persisted: still fail closed, and say so
        return "(ticket unwritable: %s)" % exc


def _persist(beads: ta.Beads, bead: dict, updates: dict) -> "str | None":
    try:
        beads.stamp(bead, updates)
    except ta.ClosedError as exc:
        return exc.detail
    return None


def _refuse(beads, state_dir, bead, err: ta.ClosedError, request: str, now) -> "tuple[int, dict]":
    """Nothing was sent (and nothing could be sent anywhere legitimate): evidence only."""
    bead_id = err.facts.get("bead_id") or "unknown"
    err.facts["protocol"] = "escalate"
    path = _ticket(state_dir, bead_id, err, request)
    evidence = "not written"
    if bead is not None and err.code.startswith("TARGET_"):  # the Bead itself is trustworthy: leave the evidence on it
        problem = _persist(beads, bead, {
            "escalation_delivery": "refused", "escalation_failed_at": now or ta.now_iso(),
            "escalation_target": str(err.facts.get("target", "none")),
            "escalation_correlation_id": str(ta.meta(bead).get("correlation_id", "")),
            "escalation_artifact_path": path, "escalation_error": one_line("%s: %s" % (err.code, err.detail))})
        evidence = "written" if problem is None else "not written: %s" % problem
    return 3, {"status": "REFUSED", "code": err.code, "detail": err.detail, "bead_id": bead_id, "artifact_path": path,
               "bead_evidence": evidence,
               "notice": "not sent: no valid orchestrator_target, and Human/MC is never a fallback", "stop": True}


def _delivery_failed(beads, deliver, state_dir, bead, target, kind, artifact_path, request, detail, now):
    bead_id, corr = bead["id"], ta.meta(bead)["correlation_id"]
    err = ta.ClosedError("DELIVERY_FAILED", detail, bead_id=bead_id, target=target, correlation_id=corr, type=kind,
                         protocol="escalate")
    ticket = _ticket(state_dir, bead_id, err, request)
    persisted = _persist(beads, bead, {
        "escalation_delivery": "failed", "escalation_failed_at": now or ta.now_iso(), "escalation_target": target,
        "escalation_correlation_id": corr, "escalation_artifact_path": ticket, "escalation_error": one_line(detail)})
    notice = delivery_failed_envelope(ticket if PATH_RE.fullmatch(ticket) else artifact_path, bead_id, corr, target)
    rc, out, err_text = deliver(target, notice)  # the same target path, once; never anywhere else
    delivered = rc == 0
    _persist(beads, bead, {"escalation_notice": "delivered" if delivered else "undelivered"})
    return 3, {"status": "DELIVERY_FAILED", "code": "DELIVERY_FAILED", "detail": detail, "bead_id": bead_id,
               "correlation_id": corr, "target": target, "artifact_path": ticket, "bead_evidence": (
                   "written" if persisted is None else "not written: %s" % persisted),
               "notice": "delivered to %s" % target if delivered else "undelivered (%s)" % one_line(err_text or out),
               "notice_envelope": notice, "stop": True}


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def main(argv: "list[str] | None" = None) -> int:
    ap = argparse.ArgumentParser(
        description="Route a Worker blocker/question to the Bead's orchestrator_target only (fail closed; no --target).")
    ap.add_argument("--repo", default=os.getcwd(), help="repo root owning .beads")
    ap.add_argument("--state-dir", default=os.environ.get("A4S_RECONCILE_STATE", ta.STATE_DIR_DEFAULT))
    ap.add_argument("--bead-id", default="")
    ap.add_argument("--correlation-id", default="")
    ap.add_argument("--type", dest="kind", default="", choices=("",) + KINDS, help="BLOCKER or QUESTION")
    ap.add_argument("--artifact-path", default="", help="the report that explains the blocker/question")
    args = ap.parse_args(argv)
    beads = ta.Beads(os.path.abspath(args.repo))
    code, result = escalate(beads, herdr_prompt, args.state_dir, args.bead_id, args.correlation_id, args.kind,
                            args.artifact_path)
    print(json.dumps(result, sort_keys=True))
    return code


if __name__ == "__main__":
    sys.exit(main())
