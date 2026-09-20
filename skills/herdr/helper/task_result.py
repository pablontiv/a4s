#!/usr/bin/env python3
"""TASK_RESULT: the Worker's durable, correlated result record, and the harvest gate that reads it.

A `herdr` agent reporting `done` proves a process stopped, not that the work has a verdict. The result is a Bead
write, made by the Worker itself before its final callback, correlated to the dispatch by `correlation_id`:

  TASK_RESULT RECORDED result_id=<id> correlation_id=<id> bead_id=<id> result_by=<agent> verdict=<pass|fail> artifact_path=<abs path>

Same fixed grammar as task_ack.py: fixed prefix, then `key=value` tokens with a closed key set and a closed value
alphabet. Nothing is parsed out of free text or a terminal transcript; nothing is inferred from liveness. Anything
that does not fit fails closed: no Bead write, an evidence-only ticket, and an `ATTENTION REQUIRED` envelope.

Persisted Bead metadata (one atomic `bd update`, as the assignee):
  result_id, result_at, result_by, result_verdict, result_artifact_path, result_correlation_id
`result_correlation_id` is the correlation the Worker echoed (already proven equal to the dispatcher's
`correlation_id`); keeping it apart from the dispatcher's own key is what lets a later reader detect a record that
outlived its dispatch. A re-dispatch clears the whole record (RESULT_FIELDS).

Rules (each one is a ClosedError code):
  * the Bead must be in_progress and carry the dispatcher's correlation_id, echoed exactly
    (missing => MISSING_CORRELATION, different => CORRELATION_MISMATCH);
  * verdict is a closed set (pass|fail): INVALID_VERDICT;
  * artifact_path is an absolute, normalised, closed-alphabet path to an existing regular file that is not a
    symlink: UNSAFE_ARTIFACT / ARTIFACT_MISSING;
  * result_by must be the Bead's dispatcher-stamped worker (and the agent that acked): IDENTITY_MISMATCH,
    IDENTITY_UNVERIFIABLE when no worker is stamped;
  * a result needs a recorded TASK_ACK: RESULT_WITHOUT_ACK;
  * repeating the same record is a no-op that preserves the original result_at (DUPLICATE); any different
    result_id, verdict, artifact or author for an already-recorded result is RESULT_CONFLICT, never an overwrite.

`verify_record()` is the same rule set read back from Bead metadata; a4s-reconcile uses it to gate harvest-close.

Only external command: `bd`. Never touches Herdr.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Callable

import task_ack as ta

PREFIX = ("TASK_RESULT", "RECORDED")
KEYS = ("result_id", "correlation_id", "bead_id", "result_by", "verdict", "artifact_path")
VERDICTS = ("pass", "fail")
RESULT_FIELDS = ("result_id", "result_at", "result_by", "result_verdict", "result_artifact_path",
                 "result_correlation_id")
PATH_RE = re.compile(r"/[A-Za-z0-9_.:@/+=-]{1,255}")  # absolute, same closed alphabet as every envelope value
TIME_RE = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ")
TICKET_PREFIX = "TASK_RESULT"
TICKET_NOTE = "Evidence-only. No Bead metadata was written and no result was inferred."

ArtifactCheck = Callable[[str], bool]


def artifact_exists(path: str) -> bool:
    return os.path.isfile(path) and not os.path.islink(path)


# --------------------------------------------------------------------------
# Envelope
# --------------------------------------------------------------------------
def build_result(result_id: str, correlation_id: str, bead_id: str, result_by: str, verdict: str,
                 artifact_path: str) -> str:
    return ta._build(PREFIX, KEYS, {"result_id": result_id, "correlation_id": correlation_id, "bead_id": bead_id,
                                    "result_by": result_by, "verdict": verdict, "artifact_path": artifact_path})


def callback_envelope(fields: dict) -> str:
    """The Worker's final callback to its orchestrator_target: the record just persisted, verbatim."""
    return "WORK_RESULT SUBMITTED verdict=%s artifact_path=%s bead_id=%s result_id=%s correlation_id=%s" % (
        fields["verdict"], fields["artifact_path"], fields["bead_id"], fields["result_id"], fields["correlation_id"])


def safe_artifact_problem(path: str) -> "str | None":
    if not PATH_RE.fullmatch(path):
        return "not an absolute path within [A-Za-z0-9_.:@/+=-] (max 256 chars)"
    if path.startswith("//") or path.endswith("/") or os.path.normpath(path) != path:
        return "not a normalised path (no '..', '.', '//' or trailing '/')"
    return None


def parse_envelope(line: str) -> dict[str, str]:
    """Strict: fixed prefix, closed key set, closed value alphabet, closed verdict set, no repeats.
    Raises ClosedError(MALFORMED | MISSING_CORRELATION | MISSING_ID | MISSING_FIELD | INVALID_VERDICT | UNSAFE_ARTIFACT)."""
    tokens = str(line).strip().split(" ")
    if tuple(tokens[:2]) != PREFIX:
        raise ta.ClosedError("MALFORMED", "envelope must start with 'TASK_RESULT RECORDED'")
    fields: dict[str, str] = {}
    for tok in tokens[2:]:
        key, sep, value = tok.partition("=")
        if not sep or key not in KEYS:
            raise ta.ClosedError("MALFORMED", "unexpected token %r (allowed keys: %s)" % (tok[:60], ", ".join(KEYS)))
        if key in fields:
            raise ta.ClosedError("MALFORMED", "duplicate key %s" % key)
        if key == "verdict":
            if value not in VERDICTS:
                raise ta.ClosedError("INVALID_VERDICT", "verdict %r is not one of %s" % (value[:60], "|".join(VERDICTS)),
                                     bead_id=fields.get("bead_id"))
        elif key == "artifact_path":
            problem = safe_artifact_problem(value)
            if problem:
                raise ta.ClosedError("UNSAFE_ARTIFACT", "artifact_path %s" % problem, bead_id=fields.get("bead_id"))
        elif not ta.VALUE_RE.match(value):
            raise ta.ClosedError("MALFORMED", "value of %s is empty, starts with a non-alphanumeric, or has characters "
                                 "outside [A-Za-z0-9_.:@/+=-]" % key)
        fields[key] = value
    if "correlation_id" not in fields:
        raise ta.ClosedError("MISSING_CORRELATION", "envelope carries no correlation_id", bead_id=fields.get("bead_id"))
    for key in ("result_id",) + tuple(k for k in KEYS if k not in ("result_id", "correlation_id")):
        if key not in fields:
            raise ta.ClosedError("MISSING_ID" if key == "result_id" else "MISSING_FIELD", "envelope lacks %s" % key,
                                 bead_id=fields.get("bead_id"))
    return fields


# --------------------------------------------------------------------------
# The rule set (pure): used to record and, read back, to gate harvest
# --------------------------------------------------------------------------
def record_of(m: dict) -> dict:
    return {k: m.get(k) for k in RESULT_FIELDS}


def record_problem(m: dict, worker: "str | None", exists: ArtifactCheck = artifact_exists) -> "tuple[str, str, dict] | None":
    """-> None when the result record in Bead metadata `m` is complete, correlated to the current dispatch, in the
    closed verdict set, safe, authored by `worker`, and follows a recorded TASK_ACK; else (code, detail, facts)."""
    rec = record_of(m)
    missing = [k for k, v in rec.items() if not v]
    if missing:
        return "RESULT_INCOMPLETE", "result record lacks %s" % ", ".join(missing), {"missing": missing}
    corr = m.get("correlation_id")
    if not corr:
        return "BEAD_UNCORRELATED", "Bead carries no dispatcher correlation_id; nothing to correlate to", {}
    if rec["result_correlation_id"] != corr:
        return "CORRELATION_MISMATCH", "result_correlation_id differs from the Bead's correlation_id", {
            "recorded": rec["result_correlation_id"], "bead": corr}
    if rec["result_verdict"] not in VERDICTS:
        return "INVALID_VERDICT", "result_verdict %r is not one of %s" % (str(rec["result_verdict"])[:60],
                                                                          "|".join(VERDICTS)), {}
    if not ta.VALUE_RE.match(str(rec["result_id"])) or not ta.VALUE_RE.match(str(rec["result_by"])):
        return "MALFORMED", "result_id/result_by is outside [A-Za-z0-9][A-Za-z0-9_.:@/+=-]*", {}
    if not TIME_RE.fullmatch(str(rec["result_at"])):
        return "MALFORMED", "result_at is not an ISO-8601 UTC timestamp", {}
    path = str(rec["result_artifact_path"])
    problem = safe_artifact_problem(path)
    if problem:
        return "UNSAFE_ARTIFACT", "result_artifact_path %s" % problem, {"artifact_path": path[:160]}
    if not exists(path):
        return "ARTIFACT_MISSING", "result_artifact_path is not an existing regular file (or is a symlink)", {
            "artifact_path": path}
    if not worker:
        return "IDENTITY_UNVERIFIABLE", "Bead carries no dispatcher-stamped worker to attribute the result to", {}
    if rec["result_by"] != str(worker):
        return "IDENTITY_MISMATCH", "result_by differs from the Bead's worker", {
            "recorded": rec["result_by"], "worker": str(worker)}
    if m.get("acknowledged_by") and str(m["acknowledged_by"]) != rec["result_by"]:
        return "IDENTITY_MISMATCH", "result_by differs from the agent that recorded TASK_ACK", {
            "recorded": rec["result_by"], "acknowledged_by": str(m["acknowledged_by"])}
    if not m.get("receipt_id"):
        return "RESULT_WITHOUT_ACK", "result recorded but no TASK_ACK receipt_id; not inferring an ack", {}
    return None


def verify_record(m: dict, worker: "str | None", exists: ArtifactCheck = artifact_exists) -> "tuple[str, dict]":
    """Harvest gate, read-only. -> ('valid', record) | ('missing', {}) | ('invalid', {code, detail, ...facts}).
    Reads only Bead metadata and stats the artifact path; never a terminal, never liveness."""
    if not any(m.get(k) for k in RESULT_FIELDS):
        return "missing", {}
    problem = record_problem(m, worker, exists)
    if problem:
        code, detail, facts = problem
        return "invalid", dict(facts, code=code, detail=detail)
    return "valid", record_of(m)


# --------------------------------------------------------------------------
# Recording
# --------------------------------------------------------------------------
def record_result(beads: ta.Beads, fields: dict[str, str], now: "str | None" = None,
                  exists: ArtifactCheck = artifact_exists) -> dict:
    bead = ta.check_bead(beads, fields)
    m = ta.meta(bead)
    candidate = {"result_id": fields["result_id"], "result_by": fields["result_by"],
                 "result_verdict": fields["verdict"], "result_artifact_path": fields["artifact_path"]}
    if m.get("result_id"):
        same = all(str(m.get(k)) == v for k, v in candidate.items()) and m.get("result_correlation_id") == fields["correlation_id"]
        if same:
            return {"status": "DUPLICATE", "bead_id": bead["id"], "result_id": m["result_id"]}
        raise ta.ClosedError("RESULT_CONFLICT", "a different result is already recorded (never overwritten)",
                             bead_id=bead["id"], recorded=str(m["result_id"]), envelope=fields["result_id"])
    stamp_time = now or ta.now_iso()
    candidate.update(result_at=stamp_time, result_correlation_id=fields["correlation_id"])
    problem = record_problem(dict(m, **candidate), m.get("worker"), exists)
    if problem:
        code, detail, facts = problem
        raise ta.ClosedError(code, detail, bead_id=bead["id"], **facts)
    beads.stamp(bead, candidate)
    return {"status": "RECORDED", "bead_id": bead["id"], "result_id": fields["result_id"]}


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def handle(envelope: str, beads: ta.Beads, state_dir: str, exists: ArtifactCheck = artifact_exists,
           now: "str | None" = None) -> "tuple[int, dict]":
    """Validate + persist one envelope. Returns (exit_code, json-able result)."""
    bead_id = "unknown"
    try:
        fields = parse_envelope(envelope)
        bead_id = fields["bead_id"]
        result = record_result(beads, fields, now, exists)
        result["envelope"] = envelope
        result["callback_envelope"] = callback_envelope(fields)
        return 0, result
    except ta.ClosedError as err:
        err.facts["protocol"] = "result"
        bead_id = err.facts.get("bead_id") or bead_id
        if bead_id == "unknown":
            m = re.search(r"\bbead_id=([A-Za-z0-9][A-Za-z0-9_.:@/+=-]{0,127})", envelope)
            bead_id = m.group(1) if m else "unknown"
        try:
            path = ta.write_ticket(state_dir, bead_id, err, envelope, prefix=TICKET_PREFIX, note=TICKET_NOTE)
        except OSError as exc:  # evidence could not be persisted: still fail closed, and say so
            path = "(ticket unwritable: %s)" % exc
        return 3, {"status": "ATTENTION", "code": err.code, "detail": err.detail, "bead_id": bead_id,
                   "artifact_path": path, "envelope": ta.attention_envelope(path, bead_id)}


def main(argv: "list[str] | None" = None) -> int:
    ap = argparse.ArgumentParser(description="Record TASK_RESULT on a Bead before the final callback (fail closed).")
    ap.add_argument("--repo", default=os.getcwd(), help="repo root owning .beads")
    ap.add_argument("--state-dir", default=os.environ.get("A4S_RECONCILE_STATE", ta.STATE_DIR_DEFAULT))
    for flag in ("bead-id", "correlation-id", "result-id", "result-by"):
        ap.add_argument("--" + flag, default="")
    ap.add_argument("--verdict", default="", help="pass|fail")
    ap.add_argument("--artifact-path", default="", help="absolute path of the finished report")
    args = ap.parse_args(argv)
    beads = ta.Beads(os.path.abspath(args.repo))
    envelope = build_result(args.result_id, args.correlation_id, args.bead_id, args.result_by, args.verdict,
                            args.artifact_path)
    code, result = handle(envelope, beads, args.state_dir)
    print(json.dumps(result, sort_keys=True))
    return code


if __name__ == "__main__":
    sys.exit(main())
