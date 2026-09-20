#!/usr/bin/env python3
"""TASK_ACK / TASK_STARTED: durable, correlated acknowledgement of a dispatched task.

A `herdr agent prompt` that returns success proves only that Herdr accepted the
text (transport acceptance). It never proves a Worker read the task. The
acknowledgement is a Bead write, made by the Worker itself, correlated to the
dispatch by `correlation_id`:

  TASK_ACK RECEIVED receipt_id=<id> correlation_id=<id> bead_id=<id> acknowledged_by=<agent>
  TASK_STARTED start_id=<id> correlation_id=<id> bead_id=<id> worker=<agent> pane=<pane> tab=<tab>

Envelopes are a fixed grammar (fixed keyword prefix, then `key=value` tokens
with a closed key set and a closed value alphabet). Nothing is parsed out of
free text; nothing is inferred. Anything that does not fit fails closed:
no Bead write, an evidence-only ticket, and an `ATTENTION REQUIRED` envelope.

Persisted Bead metadata:
  ack    receipt_id, received_at, acknowledged_at, acknowledged_by
  start  start_id, started_at, worker, pane, tab
`correlation_id` itself is stamped by the dispatcher (a4s-reconcile or the
Project Orchestrator) before the prompt is sent.

Rules (each one is a ClosedError code):
  * the Bead must be in_progress and carry the dispatcher's correlation_id;
  * the envelope must carry the same correlation_id (missing => MISSING_CORRELATION,
    different => CORRELATION_MISMATCH);
  * repeating the same receipt_id / start_id is a no-op: logical state and the
    original timestamps are preserved (DUPLICATE);
  * a different id for an already-recorded ack/start is a conflict, never an overwrite;
  * TASK_STARTED requires a recorded ack (START_WITHOUT_ACK);
  * worker/pane/tab in TASK_STARTED must match any dispatcher-stamped values.

Only external command: `bd`. Never touches Herdr.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable

ACK_PREFIX = ("TASK_ACK", "RECEIVED")
START_PREFIX = ("TASK_STARTED",)
ACK_KEYS = ("receipt_id", "correlation_id", "bead_id", "acknowledged_by")
START_KEYS = ("start_id", "correlation_id", "bead_id", "worker", "pane", "tab")
ACK_FIELDS = ("receipt_id", "received_at", "acknowledged_at", "acknowledged_by")
START_FIELDS = ("start_id", "started_at", "worker", "pane", "tab")
# cleared when a Bead is re-dispatched (worker/pane/tab are re-stamped by the dispatcher instead)
RESET_FIELDS = ACK_FIELDS + ("start_id", "started_at")
VALUE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:@/+=-]{0,127}$")
STATE_DIR_DEFAULT = os.path.join(
    os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state"), "a4s", "reconcile"
)

Runner = Callable[[list[str], "str | None", "dict | None"], "tuple[int, str, str]"]


class ClosedError(Exception):
    """The protocol fails closed: no Bead write, evidence only."""

    def __init__(self, code: str, detail: str, **facts: Any) -> None:
        super().__init__("%s: %s" % (code, detail))
        self.code, self.detail, self.facts = code, detail, facts


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# --------------------------------------------------------------------------
# Envelopes
# --------------------------------------------------------------------------
def build_ack(receipt_id: str, correlation_id: str, bead_id: str, acknowledged_by: str) -> str:
    return _build(ACK_PREFIX, ACK_KEYS, {"receipt_id": receipt_id, "correlation_id": correlation_id,
                                         "bead_id": bead_id, "acknowledged_by": acknowledged_by})


def build_start(start_id: str, correlation_id: str, bead_id: str, worker: str, pane: str, tab: str) -> str:
    return _build(START_PREFIX, START_KEYS, {"start_id": start_id, "correlation_id": correlation_id,
                                             "bead_id": bead_id, "worker": worker, "pane": pane, "tab": tab})


def _build(prefix: tuple[str, ...], keys: tuple[str, ...], values: dict) -> str:
    return " ".join(list(prefix) + ["%s=%s" % (k, values[k]) for k in keys if values.get(k)])


def parse_envelope(line: str) -> tuple[str, dict[str, str]]:
    """-> ('ack'|'start', fields). Strict: fixed prefix, closed key set, closed value alphabet, no repeats.
    Raises ClosedError(MALFORMED | MISSING_CORRELATION | MISSING_ID | MISSING_FIELD)."""
    tokens = str(line).strip().split(" ")
    if tuple(tokens[:2]) == ACK_PREFIX:
        kind, keys, body = "ack", ACK_KEYS, tokens[2:]
    elif tokens[:1] == list(START_PREFIX):
        kind, keys, body = "start", START_KEYS, tokens[1:]
    else:
        raise ClosedError("MALFORMED", "envelope must start with 'TASK_ACK RECEIVED' or 'TASK_STARTED'")
    fields: dict[str, str] = {}
    for tok in body:
        key, sep, value = tok.partition("=")
        if not sep or key not in keys:
            raise ClosedError("MALFORMED", "unexpected token %r (allowed keys: %s)" % (tok[:60], ", ".join(keys)))
        if key in fields:
            raise ClosedError("MALFORMED", "duplicate key %s" % key)
        if not VALUE_RE.match(value):
            raise ClosedError("MALFORMED", "value of %s is empty, starts with a non-alphanumeric, or has characters outside [A-Za-z0-9_.:@/+=-]" % key)
        fields[key] = value
    if "correlation_id" not in fields:
        raise ClosedError("MISSING_CORRELATION", "envelope carries no correlation_id", bead_id=fields.get("bead_id"))
    id_key = "receipt_id" if kind == "ack" else "start_id"
    for key in (id_key,) + tuple(k for k in keys if k not in (id_key, "correlation_id")):
        if key not in fields:
            raise ClosedError("MISSING_ID" if key == id_key else "MISSING_FIELD", "envelope lacks %s" % key,
                              bead_id=fields.get("bead_id"))
    return kind, fields


# --------------------------------------------------------------------------
# Bead access (bd only)
# --------------------------------------------------------------------------
def _run(argv: list[str], cwd: str | None = None, env: dict | None = None) -> tuple[int, str, str]:
    try:
        p = subprocess.run(argv, cwd=cwd, env=env, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 127, "", str(exc)
    return p.returncode, p.stdout, p.stderr


class Beads:
    def __init__(self, repo: str, bd_bin: str | None = None, runner: Runner | None = None) -> None:
        self.repo, self.bd_bin, self.runner = repo, bd_bin or os.environ.get("A4S_BD", "bd"), runner or _run

    def show(self, bead_id: str) -> dict:
        rc, out, err = self.runner([self.bd_bin, "show", bead_id, "--json"], self.repo, None)
        try:
            data = json.loads(out) if rc == 0 else None
        except ValueError:
            data = None
        if isinstance(data, list):
            data = data[0] if len(data) == 1 else None
        if not isinstance(data, dict) or data.get("id") != bead_id:
            raise ClosedError("BEAD_UNREADABLE", "bd show %s failed rc=%s: %s" % (bead_id, rc, err.strip()[:200]),
                              bead_id=bead_id)
        return data

    def stamp(self, bead: dict, updates: dict[str, str], unset: tuple[str, ...] = ()) -> None:
        """One atomic `bd update`, as the assignee (bd's assignee guard refuses any other actor)."""
        argv = [self.bd_bin, "update", bead["id"]]
        for key, value in updates.items():
            argv += ["--set-metadata", "%s=%s" % (key, value)]
        for key in unset:
            argv += ["--unset-metadata", key]
        env = dict(os.environ)
        if bead.get("assignee"):
            env["BEADS_ACTOR"] = bead["assignee"]
        rc, out, err = self.runner(argv, self.repo, env)
        if rc != 0:
            raise ClosedError("WRITE_FAILED", "bd update %s failed rc=%s: %s" % (bead["id"], rc, (err or out).strip()[:200]),
                              bead_id=bead["id"])


def meta(bead: dict) -> dict:
    m = bead.get("metadata")
    return m if isinstance(m, dict) else {}


# --------------------------------------------------------------------------
# Recording (pure given a Beads-like object)
# --------------------------------------------------------------------------
def check_bead(beads: Beads, fields: dict[str, str]) -> dict:
    bead = beads.show(fields["bead_id"])
    m = meta(bead)
    if bead.get("status") != "in_progress":
        raise ClosedError("BEAD_NOT_IN_PROGRESS", "Bead status is %r" % bead.get("status"), bead_id=bead["id"])
    if not m.get("correlation_id"):
        raise ClosedError("BEAD_UNCORRELATED", "Bead carries no dispatcher correlation_id; nothing to correlate to",
                          bead_id=bead["id"])
    if fields["correlation_id"] != m["correlation_id"]:
        raise ClosedError("CORRELATION_MISMATCH", "envelope correlation_id differs from the Bead's",
                          bead_id=bead["id"], envelope=fields["correlation_id"], bead=m["correlation_id"])
    return bead


def record_ack(beads: Beads, fields: dict[str, str], received_at: str | None = None, now: str | None = None) -> dict:
    bead = check_bead(beads, fields)
    m = meta(bead)
    if m.get("receipt_id"):
        if m["receipt_id"] == fields["receipt_id"]:
            return {"status": "DUPLICATE", "bead_id": bead["id"], "receipt_id": m["receipt_id"]}
        raise ClosedError("ACK_CONFLICT", "a different receipt_id is already recorded", bead_id=bead["id"],
                          recorded=m["receipt_id"], envelope=fields["receipt_id"])
    stamp_time = now or now_iso()
    beads.stamp(bead, {"receipt_id": fields["receipt_id"], "received_at": received_at or stamp_time,
                       "acknowledged_at": stamp_time, "acknowledged_by": fields["acknowledged_by"]})
    return {"status": "RECORDED", "bead_id": bead["id"], "receipt_id": fields["receipt_id"]}


def record_start(beads: Beads, fields: dict[str, str], now: str | None = None) -> dict:
    bead = check_bead(beads, fields)
    m = meta(bead)
    if not m.get("receipt_id"):
        raise ClosedError("START_WITHOUT_ACK", "TASK_STARTED before any recorded TASK_ACK; not inferring an ack",
                          bead_id=bead["id"], start_id=fields["start_id"])
    for key in ("worker", "pane", "tab"):
        if m.get(key) and str(m[key]) != fields[key]:
            raise ClosedError("IDENTITY_MISMATCH", "%s differs from the dispatcher-stamped value" % key,
                              bead_id=bead["id"], envelope=fields[key], bead=str(m[key]))
    if m.get("start_id"):
        if m["start_id"] == fields["start_id"]:
            return {"status": "DUPLICATE", "bead_id": bead["id"], "start_id": m["start_id"]}
        raise ClosedError("START_CONFLICT", "a different start_id is already recorded", bead_id=bead["id"],
                          recorded=m["start_id"], envelope=fields["start_id"])
    beads.stamp(bead, {"start_id": fields["start_id"], "started_at": now or now_iso(), "worker": fields["worker"],
                       "pane": fields["pane"], "tab": fields["tab"]})
    return {"status": "RECORDED", "bead_id": bead["id"], "start_id": fields["start_id"]}


# --------------------------------------------------------------------------
# Evidence-only ticket (same layout/keying as a4s-reconcile's AttentionTicket)
# --------------------------------------------------------------------------
SAFE_KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


class TicketPathError(OSError):
    """A ticket path could not be proven to lie directly inside <state_dir>/attention (handled like any unwritable ticket)."""


def ticket_key(raw: str) -> str:
    """Filename-safe key for a ticket name component.

    Well-formed ids (alphanumeric start, then [A-Za-z0-9_.-], no `..`) pass through unchanged so ticket names keep the
    a4s-reconcile layout. Anything else (path separators, `..`, NUL, spaces, empty, over-long) is flattened to
    [A-Za-z0-9_-] and suffixed with a digest of the raw value, so hostile ids are neutralised and never collide."""
    raw = str(raw)
    if SAFE_KEY_RE.match(raw) and ".." not in raw:
        return raw
    flat = re.sub(r"[^A-Za-z0-9_-]+", "_", raw).strip("_")[:48] or "id"
    return "unsafe_%s_%s" % (flat, hashlib.sha256(raw.encode("utf-8", "backslashreplace")).hexdigest()[:8])


def ticket_path(state_dir: str, key: str, kind: str, digest: str) -> Path:
    """<state_dir>/attention/<key>--<kind>--<digest>.md; key and kind are already ticket_key()-safe (no separators)."""
    base = Path(state_dir) / "attention"
    name = "%s--%s--%s.md" % (key, kind, digest)
    path = base / name
    if path.parent != base or path.name != name:
        raise TicketPathError("ticket path %s is not directly inside %s" % (path, base))
    return path


def write_ticket(state_dir: str, bead_id: str, err: ClosedError, envelope: str, prefix: str = "TASK_ACK",
                 note: str = "Evidence-only. No Bead metadata was written and no state was inferred.") -> str:
    kind = ticket_key("%s_%s" % (prefix, err.code))
    facts = {k: v for k, v in dict(err.facts, code=err.code).items() if v is not None}
    digest = hashlib.sha256(json.dumps([bead_id, kind, facts], sort_keys=True).encode()).hexdigest()[:8]
    key = ticket_key(bead_id)
    raw = [] if key == bead_id else ["raw_bead_id: %s" % json.dumps(bead_id)]
    path = ticket_path(state_dir, key, kind, digest)
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        body = ["---", "bead_id: %s" % key, "kind: %s" % kind, "detected_at: %s" % now_iso(),
                "facts: %s" % json.dumps(facts, sort_keys=True), "lifecycle_mutation: none", *raw, "---", "",
                "# AttentionTicket %s %s" % (key, kind), "",
                note, "",
                "## Evidence", "", "```", "code=%s" % err.code, "detail=%s" % err.detail,
                "envelope=%s" % envelope, "```", ""]
        tmp = path.with_suffix(".tmp")
        tmp.unlink(missing_ok=True)  # never write through a planted symlink
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o644)
        with os.fdopen(fd, "w") as fh:
            fh.write("\n".join(body))
        os.replace(tmp, path)
    return str(path)


def attention_envelope(path: str, bead_id: str) -> str:
    return "ATTENTION REQUIRED verdict=blocked artifact_path=%s bead_id=%s" % (path, bead_id)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def handle(kind: str, envelope: str, beads: Beads, state_dir: str, received_at: str | None = None) -> tuple[int, dict]:
    """Validate + persist one envelope. Returns (exit_code, json-able result)."""
    bead_id = "unknown"
    try:
        parsed_kind, fields = parse_envelope(envelope)
        bead_id = fields["bead_id"]
        if parsed_kind != kind:
            raise ClosedError("MALFORMED", "envelope is a %s envelope, expected %s" % (parsed_kind, kind), bead_id=bead_id)
        result = record_ack(beads, fields, received_at) if kind == "ack" else record_start(beads, fields)
        result["envelope"] = envelope
        return 0, result
    except ClosedError as err:
        err.facts["protocol"] = kind  # ack and start violations of one code must not collapse into one ticket
        bead_id = err.facts.get("bead_id") or bead_id
        if bead_id == "unknown":
            m = re.search(r"\bbead_id=([A-Za-z0-9][A-Za-z0-9_.:@/+=-]{0,127})", envelope)
            bead_id = m.group(1) if m else "unknown"
        try:
            path = write_ticket(state_dir, bead_id, err, envelope)
        except OSError as exc:  # evidence could not be persisted: still fail closed, and say so
            path = "(ticket unwritable: %s)" % exc
        return 3, {"status": "ATTENTION", "code": err.code, "detail": err.detail, "bead_id": bead_id,
                   "artifact_path": path, "envelope": attention_envelope(path, bead_id)}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Record TASK_ACK RECEIVED / TASK_STARTED on a Bead (fail closed).")
    ap.add_argument("--repo", default=os.getcwd(), help="repo root owning .beads")
    ap.add_argument("--state-dir", default=os.environ.get("A4S_RECONCILE_STATE", STATE_DIR_DEFAULT))
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("ack", help="record TASK_ACK RECEIVED")
    for flag in ("bead-id", "correlation-id", "receipt-id", "acknowledged-by"):
        a.add_argument("--" + flag, default="")
    a.add_argument("--received-at", default=None, help="ISO-8601 UTC time the task was received (default: now)")
    s = sub.add_parser("start", help="record TASK_STARTED (requires a recorded ack)")
    for flag in ("bead-id", "correlation-id", "start-id", "worker", "pane", "tab"):
        s.add_argument("--" + flag, default="")
    args = ap.parse_args(argv)
    beads = Beads(os.path.abspath(args.repo))
    if args.cmd == "ack":
        envelope = build_ack(args.receipt_id, args.correlation_id, args.bead_id, args.acknowledged_by)
    else:
        envelope = build_start(args.start_id, args.correlation_id, args.bead_id, args.worker, args.pane, args.tab)
    code, result = handle(args.cmd, envelope, beads, args.state_dir, getattr(args, "received_at", None))
    print(json.dumps(result, sort_keys=True))
    return code


if __name__ == "__main__":
    sys.exit(main())
