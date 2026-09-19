#!/usr/bin/env python3
"""H2 heartbeat reconciler: a wake is only a PASS if it leaves evidence.

H1 (launchd -> `herdr agent prompt`) proves the prompt was accepted, nothing
else. This helper runs once per tick, compares the current Beads/Herdr state
with the previous tick, and classifies the tick from observable evidence:

  PASS_HARVEST   a WORK_RESULT/ATTENTION callback reached the Project
                 Orchestrator (PO) and an assistant turn followed it.
  PASS_PROGRESS  a Bead was claimed or closed since the previous tick.
  PASS_STALE     concrete STALE_WORK/ATTENTION with pane_id + bead_id emitted.
  NOOP           nothing claimable and nothing in flight (not a PASS).
  WORKING        in-flight Beads all bound to live working panes (not a PASS).
  BASELINE       first tick, no previous state to compare (not a PASS).
  FAIL           none of the above, or the state could not be observed.

It is read-only by default. `--live` additionally sends one `herdr agent
prompt` wake to the PO and one visible `herdr notification show` on FAIL or
new stale evidence. It never claims, closes, retries, waits, or polls, and it
holds no lifecycle: state is one JSON file plus an append-only tick log.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

CALLBACK_PREFIXES = ("WORK_RESULT", "ATTENTION")
IDLE_STATES = {"idle", "done", "unknown"}
MAX_EVENTS = 5
NOTIFY_REPEAT_SECONDS = 3600
WAKE_TEXT = (
    "HEARTBEAT: cosecha callbacks pendientes, avanza bd ready, revisa peers idle "
    "con Mission abierta y emite estado. No permanezcas silencioso: usa WORK_RESULT "
    "SUBMITTED o ATTENTION type=QUESTION|DECISION|APPROVAL|RISK|CONFLICT|"
    "VERIFICATION_FAILED|RESULT_READY|STALE_WORK|BUDGET_EXCEEDED. "
    "No uses wait, timeout ni polling bloqueante."
)

Runner = Callable[[list[str]], Any]


class ObserveError(RuntimeError):
    pass


class StateError(RuntimeError):
    pass


def parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def run_json(argv: list[str], cwd: str | None = None) -> Any:
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, cwd=cwd, check=False)
    except OSError as exc:
        raise ObserveError(f"{argv[0]}: {exc}") from exc
    if proc.returncode != 0:
        raise ObserveError(f"{' '.join(argv[:3])}: exit {proc.returncode}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise ObserveError(f"{' '.join(argv[:3])}: invalid json") from exc


def scan_callbacks(path: str | None, offset: int | None) -> tuple[int, dict]:
    """Count callbacks and answering turns appended to a pi session record.

    Returns (new_offset, {"seen", "answered"}). The first scan (offset None)
    starts at the end so history is never replayed; a partial trailing line is
    left for the next tick. Unsupported or missing records yield seen=None.
    """
    if not path or not os.path.isfile(path):
        return 0, {"seen": None, "answered": None}
    size = os.path.getsize(path)
    if offset is None or offset > size:
        return size, {"seen": 0, "answered": 0}
    with open(path, "rb") as handle:
        handle.seek(offset)
        chunk = handle.read()
    end = chunk.rfind(b"\n") + 1
    seen = answered = 0
    pending = False
    for raw in chunk[:end].splitlines():
        try:
            record = json.loads(raw)
        except json.JSONDecodeError:
            continue
        message = record.get("message") if record.get("type") == "message" else None
        if not isinstance(message, dict):
            continue
        if message.get("role") == "user":
            content = message.get("content")
            text = "".join(
                part.get("text", "")
                for part in (content if isinstance(content, list) else [])
                if isinstance(part, dict)
            ) if isinstance(content, list) else str(content or "")
            if text.lstrip().startswith(CALLBACK_PREFIXES):
                seen += 1
                pending = True
        elif message.get("role") == "assistant" and pending:
            answered += 1
            pending = False
    return offset + end, {"seen": seen, "answered": answered}


def observe(po_pane: str, repo: str | None, since: str | None, run: Runner | None = None) -> dict:
    run = run or (lambda argv: run_json(argv, cwd=repo if argv[0] == "bd" else None))
    po = run(["herdr", "agent", "get", po_pane])["result"]["agent"]
    workspace = po["workspace_id"]
    agents = run(["herdr", "agent", "list"])["result"]["agents"]
    tabs = run(["herdr", "tab", "list", "--workspace", workspace])["result"]["tabs"]
    labels = {tab["tab_id"]: tab.get("label", "") for tab in tabs}
    panes = [
        {
            "pane_id": agent["pane_id"],
            "label": labels.get(agent.get("tab_id"), ""),
            "cwd": agent.get("cwd", ""),
            "agent_status": agent.get("agent_status", "unknown"),
        }
        for agent in agents
        if agent.get("workspace_id") == workspace and agent["pane_id"] != po_pane
    ]
    ready = run(["bd", "ready", "--json"])
    in_progress = run(["bd", "list", "--status", "in_progress", "--limit", "0", "--json"])
    closed = []
    if since:
        closed = run(["bd", "list", "--status", "closed", "--closed-after", since, "--limit", "0", "--json"])
    session = po.get("agent_session") or {}
    return {
        "at": iso(datetime.now(timezone.utc)),
        "po": {
            "pane_id": po_pane,
            "agent_status": po.get("agent_status", "unknown"),
            "state_change_seq": po.get("state_change_seq"),
            "session_path": session.get("value") if session.get("kind") == "path" else None,
        },
        "ready": [{"id": b["id"], "issue_type": b.get("issue_type")} for b in ready],
        "in_progress": [
            {"id": b["id"], "updated_at": b["updated_at"], "issue_type": b.get("issue_type")}
            for b in in_progress
        ],
        "closed": [{"id": b["id"], "issue_type": b.get("issue_type")} for b in closed],
        "panes": panes,
    }


def bind_pane(bead_id: str, panes: list[dict]) -> dict | None:
    for pane in panes:
        if bead_id in pane["label"] or bead_id in pane["cwd"]:
            return pane
    return None


def event(kind: str, pane_id: str, bead_id: str, reason: str, **extra: object) -> dict:
    return {"kind": kind, "pane_id": pane_id, "bead_id": bead_id, "reason": reason, **extra}


def render_event(item: dict) -> str:
    head = "STALE_WORK" if item["kind"] == "STALE_WORK" else f"ATTENTION type={item['kind']}"
    tail = f" age_min={item['age_min']}" if "age_min" in item else ""
    return f"{head} pane_id={item['pane_id']} bead_id={item['bead_id']} reason={item['reason']}{tail}"


def evaluate(prev: dict | None, obs: dict, stale_seconds: int = 1800) -> dict:
    now = parse_ts(obs["at"])
    po = obs["po"]
    work = [b for b in obs["in_progress"] if b["issue_type"] != "epic"]
    ready = [b for b in obs["ready"] if b["issue_type"] != "epic"]
    prev_ip = (prev or {}).get("in_progress", {})
    claims = sorted(b["id"] for b in work if prev and b["id"] not in prev_ip)
    closes = sorted(b["id"] for b in obs["closed"] if b["issue_type"] != "epic")
    responded = bool(prev) and po["state_change_seq"] != prev["po"]["state_change_seq"]
    callbacks = obs.get("callbacks", {"seen": None, "answered": None})
    events: list[dict] = []
    live_beads = 0

    for bead in work:
        age = int((now - parse_ts(bead["updated_at"])).total_seconds())
        pane = bind_pane(bead["id"], obs["panes"])
        status = pane["agent_status"] if pane else None
        if status == "working":
            live_beads += 1
        elif age < stale_seconds:
            continue
        elif pane and status == "blocked":
            events.append(event("QUESTION", pane["pane_id"], bead["id"], "worker_blocked", age_min=age // 60))
        elif pane:
            events.append(event("STALE_WORK", pane["pane_id"], bead["id"], "worker_idle_bead_open", age_min=age // 60))
        elif po["agent_status"] != "working":
            events.append(event("STALE_WORK", po["pane_id"], bead["id"], "bead_open_no_worker", age_min=age // 60))

    if prev and ready and po["agent_status"] in IDLE_STATES and not claims and not closes:
        events.append(event("STALE_WORK", po["pane_id"], ready[0]["id"], "ready_unclaimed", ready=len(ready)))

    facts = {
        "po_status": po["agent_status"],
        "po_responded": responded,
        "wake_sent_prev": bool((prev or {}).get("wake_sent")),
        "ready": len(ready),
        "in_progress": len(work),
        "live_beads": live_beads,
        "claims": claims,
        "closes": closes,
        "callbacks": callbacks,
    }
    if callbacks["seen"] and callbacks["answered"]:
        verdict, reason = "PASS_HARVEST", "callback_answered"
    elif claims or closes:
        verdict, reason = "PASS_PROGRESS", "bead_claimed_or_closed"
    elif events:
        verdict, reason = "PASS_STALE", "typed_stale_or_attention"
    elif not prev:
        verdict, reason = "BASELINE", "no_previous_tick"
    elif not ready and not work:
        verdict, reason = "NOOP", "nothing_claimable_or_in_flight"
    elif not ready and live_beads == len(work):
        verdict, reason = "WORKING", "in_flight_beads_bound_to_working_panes"
    else:
        verdict, reason = "FAIL", "no_evidence_after_wake" if facts["wake_sent_prev"] else "no_evidence"
    return {"verdict": verdict, "reason": reason, "facts": facts, "events": events[:MAX_EVENTS]}


def wake_prompt(result: dict) -> str:
    parts = [WAKE_TEXT, f"H2 verdict={result['verdict']}"]
    parts += [render_event(item) for item in result["events"]]
    return " ; ".join(parts)


def next_state(obs: dict, wake_sent: bool, notified: dict, offset: int) -> dict:
    return {
        "at": obs["at"],
        "po": {
            "agent_status": obs["po"]["agent_status"],
            "state_change_seq": obs["po"]["state_change_seq"],
        },
        "ready": [b["id"] for b in obs["ready"]],
        "in_progress": {b["id"]: b["updated_at"] for b in obs["in_progress"]},
        "session_offset": offset,
        "wake_sent": wake_sent,
        "notified": notified,
    }


def write_state(state_dir: Path, state: dict, tick: dict) -> None:
    state_dir.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=state_dir, prefix=".state-")
    with os.fdopen(fd, "w") as handle:
        json.dump(state, handle, indent=1)
    os.replace(tmp, state_dir / "state.json")
    with open(state_dir / "ticks.jsonl", "a") as handle:
        handle.write(json.dumps(tick, sort_keys=True) + "\n")


def check_state(state: Any) -> dict:
    """Return state if it has the shape `evaluate` reads, else raise StateError."""
    notified = state.get("notified", {}) if isinstance(state, dict) else None
    offset = state.get("session_offset") if isinstance(state, dict) else None
    ok = (
        isinstance(state, dict)
        and isinstance(state.get("po"), dict)
        and "state_change_seq" in state["po"]
        and isinstance(state.get("in_progress"), dict)
        and isinstance(notified, dict)
        and (offset is None or (isinstance(offset, int) and not isinstance(offset, bool)))
    )
    try:
        if ok:
            parse_ts(state["at"])
            for stamp in notified.values():
                parse_ts(stamp)
    except (TypeError, ValueError, AttributeError, KeyError):
        ok = False
    if not ok:
        raise StateError("unexpected shape")
    return state


def load_state(state_dir: Path) -> dict | None:
    """A missing state file is the first tick; an unreadable or malformed one is an error."""
    path = state_dir / "state.json"
    try:
        raw = path.read_text()
    except FileNotFoundError:
        return None
    except (OSError, UnicodeDecodeError) as exc:
        raise StateError(f"{path}: {exc}") from exc
    try:
        return check_state(json.loads(raw))
    except (json.JSONDecodeError, StateError) as exc:
        raise StateError(f"{path}: {exc}") from exc


def notification_keys(result: dict) -> list[str]:
    keys = [f"{e['kind']}:{e['pane_id']}:{e['bead_id']}:{e['reason']}" for e in result["events"]]
    return keys + (["FAIL"] if result["verdict"] == "FAIL" else [])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="H2 heartbeat reconciler (read-only unless --live)")
    parser.add_argument("--po-pane", required=True, help="Project Orchestrator pane id, e.g. w4J:p3")
    parser.add_argument("--repo", default=None, help="repo root used as cwd for bd (default: current directory)")
    parser.add_argument("--state-dir", type=Path, default=Path.home() / ".local/state/a4s/heartbeat-h2")
    parser.add_argument("--stale-minutes", type=int, default=30)
    parser.add_argument("--record", action="store_true", help="persist state.json and ticks.jsonl in --state-dir")
    parser.add_argument("--live", action="store_true", help="send the wake prompt and notifications (implies --record)")
    args = parser.parse_args(argv)
    record = args.record or args.live

    def fail(reason: str) -> int:
        result = {"verdict": "FAIL", "reason": reason, "facts": {}, "events": []}
        print(json.dumps(result, sort_keys=True))
        if args.live:
            subprocess.run(["herdr", "notification", "show", "A4S heartbeat H2 FAIL", "--body", reason], check=False)
        return 2

    try:
        prev = load_state(args.state_dir) if record else None
    except StateError as exc:
        return fail(f"state_error: {exc}")
    try:
        obs = observe(args.po_pane, args.repo, prev["at"] if prev else None)
    except (ObserveError, KeyError, TypeError) as exc:
        return fail(f"observe_error: {exc}")

    offset, obs["callbacks"] = scan_callbacks(obs["po"]["session_path"], prev.get("session_offset") if prev else None)
    result = evaluate(prev, obs, args.stale_minutes * 60)

    wake_sent = False
    notified = dict((prev or {}).get("notified", {}))
    if args.live:
        wake = subprocess.run(["herdr", "agent", "prompt", args.po_pane, wake_prompt(result)], capture_output=True, check=False)
        wake_sent = wake.returncode == 0
        if not wake_sent:
            result["verdict"], result["reason"] = "FAIL", "wake_undelivered"
        now = parse_ts(obs["at"])
        fresh = [
            k for k in notification_keys(result)
            if k not in notified or (now - parse_ts(notified[k])).total_seconds() >= NOTIFY_REPEAT_SECONDS
        ]
        if fresh:
            body = " ; ".join([render_event(e) for e in result["events"]] or [result["reason"]])
            subprocess.run(["herdr", "notification", "show", f"A4S heartbeat H2 {result['verdict']}", "--body", body], check=False)
            notified.update({k: obs["at"] for k in fresh})
    if record:
        tick = {"at": obs["at"], **result, "wake_sent": wake_sent}
        write_state(args.state_dir, next_state(obs, wake_sent, notified, offset), tick)

    print(json.dumps({"at": obs["at"], **result, "wake_sent": wake_sent}, sort_keys=True))
    return 2 if result["verdict"] == "FAIL" else 0


if __name__ == "__main__":
    sys.exit(main())
