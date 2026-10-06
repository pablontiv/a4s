#!/usr/bin/env python3
"""Reconciliador Heartbeat H2.

Un wake solo cuenta como PASS si deja evidencia. El helper ejecuta un tick.
Compara el estado actual con el estado anterior. Clasifica el resultado como
PASS_HARVEST, PASS_PROGRESS, PASS_STALE, NOOP, WORKING, BASELINE o FAIL.

El modo inicial solo observa. `--live` envía un wake al PO. También muestra
una notificación ante un fallo o evidencia nueva. Nunca reclama ni cierra un
Bead. No espera, reintenta ni consulta en bucle. Un archivo JSON guarda el
estado. Un journal JSONL guarda el diagnóstico de mejor esfuerzo.
"""

from __future__ import annotations

import argparse
import errno
import fcntl
import json
import os
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, Mapping

CALLBACK_PREFIXES = ("WORK_RESULT", "ATTENTION")
IDLE_STATES = {"idle", "done", "unknown"}
MAX_EVENTS = 5
NOTIFY_REPEAT_SECONDS = 3600
LOG_SCHEMA = "a4s.log/1"
LOG_SERVICE = "a4s-heartbeat-h2"
LOG_SCOPE = "a4s.herdr.heartbeat-h2"
HEALTH_SCHEMA = "a4s.logging-health/1"
MAX_HEALTH_BYTES = 16 * 1024
MAX_DROPPED_COUNT = 2**31 - 1
ERROR_CODES = {
    "evidence_missing",
    "observation_failed",
    "state_invalid",
    "state_io",
    "wake_undelivered",
}
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


class LockBusy(RuntimeError):
    pass


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


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
    """Cuenta callbacks y respuestas nuevas en un registro Pi.

    La primera lectura empieza al final. Así no repite el historial. Conserva
    una línea parcial para el tick siguiente. Un registro ausente produce
    `seen=None`.
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


def next_state(obs: dict, wake_sent: bool, notified: dict, offset: int, correlation_id: str) -> dict:
    return {
        "at": obs["at"],
        "correlation_id": correlation_id,
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


def ensure_private_dir(path: Path) -> None:
    """Crea un directorio privado y rechaza enlaces simbólicos."""
    try:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise StateError("directorio inseguro")
        path.chmod(0o700)
    except OSError as exc:
        raise StateError("no se pudo preparar el directorio") from exc


def _secure_open(path: Path, flags: int, mode: int = 0o600) -> int:
    flags |= getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, mode)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise OSError(errno.EINVAL, "archivo no regular")
        if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT):
            os.fchmod(fd, mode)
        return fd
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        raise


def write_state(state_dir: Path, state: dict) -> bool:
    """Escribe estado. Indica si el directorio confirmó la durabilidad."""
    ensure_private_dir(state_dir)
    target = state_dir / "state.json"
    if target.is_symlink():
        raise StateError("state.json es un enlace simbólico")
    fd, tmp_name = tempfile.mkstemp(dir=state_dir, prefix=".state-")
    tmp = Path(tmp_name)
    dir_fd: int | None = None
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            os.fchmod(handle.fileno(), 0o600)
            json.dump(state, handle, indent=1, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        dir_fd = os.open(state_dir, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        os.replace(tmp, target)
        try:
            os.fsync(dir_fd)
        except OSError:
            return False
        return True
    except OSError as exc:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise StateError("no se pudo escribir state.json") from exc
    finally:
        if dir_fd is not None:
            try:
                os.close(dir_fd)
            except OSError:
                pass


def state_root(environ: Mapping[str, str] | None = None) -> Path:
    env = os.environ if environ is None else environ
    configured = env.get("A4S_STATE_ROOT")
    if configured:
        return Path(configured).expanduser()
    xdg = env.get("XDG_STATE_HOME")
    base = Path(xdg).expanduser() if xdg else Path(env.get("HOME", str(Path.home()))).expanduser() / ".local" / "state"
    return base / "a4s"


def storage_paths(
    explicit_state_dir: Path | None,
    environ: Mapping[str, str] | None = None,
) -> tuple[Path, Path, Path | None]:
    root = state_root(environ)
    if explicit_state_dir is not None:
        return explicit_state_dir.expanduser(), root / "log" / "heartbeat", None
    env = os.environ if environ is None else environ
    home = Path(env.get("HOME", str(Path.home()))).expanduser()
    legacy = home / ".local" / "state" / "a4s" / "heartbeat-h2"
    return root / "state" / "heartbeat", root / "log" / "heartbeat", legacy


@contextmanager
def tick_lock(state_dir: Path) -> Iterator[None]:
    """Mantiene el lock no bloqueante durante todo el tick."""
    ensure_private_dir(state_dir)
    path = state_dir / "tick.lock"
    try:
        fd = _secure_open(path, os.O_RDWR | os.O_CREAT, 0o600)
    except OSError as exc:
        raise StateError("no se pudo abrir tick.lock") from exc
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise LockBusy from exc
        yield
    finally:
        os.close(fd)


def _write_all(fd: int, payload: bytes) -> None:
    pending = memoryview(payload)
    while pending:
        written = os.write(fd, pending)
        if written <= 0 or written > len(pending):
            raise OSError(errno.EIO, "escritura incompleta")
        pending = pending[written:]


def _strict_json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("campo duplicado")
        value[key] = item
    return value


def _load_health_counter(path: Path) -> tuple[int, bool]:
    fd: int | None = None
    try:
        fd = _secure_open(path, os.O_RDONLY, 0o600)
        if os.fstat(fd).st_size > MAX_HEALTH_BYTES:
            raise ValueError("sidecar demasiado grande")
        raw = bytearray()
        while len(raw) <= MAX_HEALTH_BYTES:
            chunk = os.read(fd, MAX_HEALTH_BYTES + 1 - len(raw))
            if not chunk:
                break
            raw.extend(chunk)
        if len(raw) > MAX_HEALTH_BYTES:
            raise ValueError("sidecar demasiado grande")
        value = json.loads(bytes(raw).decode("utf-8"), object_pairs_hook=_strict_json_object)
        if type(value) is not dict or set(value) != {"schema", "dropped_count"}:
            raise ValueError("sidecar inválido")
        count = value["dropped_count"]
        if value["schema"] != HEALTH_SCHEMA or type(count) is not int:
            raise ValueError("sidecar inválido")
        if count < 0 or count > MAX_DROPPED_COUNT:
            raise OverflowError("contador fuera de rango")
        return count, False
    except FileNotFoundError:
        return 0, False
    except Exception:
        return 1, True
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass


def _write_health_counter(state_dir: Path, count: int) -> bool:
    target = state_dir / "logging-health.json"
    if target.is_symlink():
        return False
    try:
        fd, tmp_name = tempfile.mkstemp(dir=state_dir, prefix=".logging-health-")
    except OSError:
        return False
    tmp = Path(tmp_name)
    dir_fd: int | None = None
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            os.fchmod(handle.fileno(), 0o600)
            json.dump({"schema": HEALTH_SCHEMA, "dropped_count": count}, handle, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        dir_fd = os.open(state_dir, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        os.replace(tmp, target)
        try:
            os.fsync(dir_fd)
        except OSError:
            pass
        return True
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass
        return False
    finally:
        if dir_fd is not None:
            try:
                os.close(dir_fd)
            except OSError:
                pass


class Journal:
    """Journal JSONL de mejor esfuerzo. Nunca propaga un fallo."""

    def __init__(self, log_dir: Path, correlation_id: str, operation_id: str, mode: str):
        self.log_dir = log_dir
        self.correlation_id = correlation_id
        self.operation_id = operation_id
        self.mode = mode
        self.health_dir = log_dir.parent.parent / "state" / "heartbeat"
        self.health_path = self.health_dir / "logging-health.json"
        try:
            root = self.health_dir.parent.parent
            ensure_private_dir(root)
            ensure_private_dir(self.health_dir.parent)
            ensure_private_dir(self.health_dir)
            self.dropped_count, self.health_invalid = _load_health_counter(self.health_path)
        except Exception:
            self.dropped_count, self.health_invalid = 1, True
        self.disabled = False

    def _record_loss(self) -> None:
        fallback = min(MAX_DROPPED_COUNT, self.dropped_count + 1)
        lock_fd: int | None = None
        try:
            root = self.health_dir.parent.parent
            ensure_private_dir(root)
            ensure_private_dir(self.health_dir.parent)
            ensure_private_dir(self.health_dir)
            lock_fd = _secure_open(self.health_dir / "logging-health.lock", os.O_RDWR | os.O_CREAT, 0o600)
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            current, invalid = _load_health_counter(self.health_path)
            self.health_invalid = self.health_invalid or invalid
            self.dropped_count = min(MAX_DROPPED_COUNT, max(current, self.dropped_count) + 1)
            _write_health_counter(self.health_dir, self.dropped_count)
        except (OSError, StateError):
            self.dropped_count = fallback
        finally:
            if lock_fd is not None:
                try:
                    fcntl.flock(lock_fd, fcntl.LOCK_UN)
                except OSError:
                    pass
                try:
                    os.close(lock_fd)
                except OSError:
                    pass

    def _append_record(self, path: Path, record: dict[str, object]) -> bool:
        fd = _secure_open(path, os.O_RDWR | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            initial_size = os.fstat(fd).st_size
            if initial_size and os.pread(fd, 1, initial_size - 1) != b"\n":
                self.disabled = True
                self._record_loss()
                return False
            current, invalid = _load_health_counter(self.health_path)
            self.health_invalid = self.health_invalid or invalid
            self.dropped_count = max(self.dropped_count, current)
            record["a4s.logging.lossy"] = self.dropped_count > 0
            record["a4s.logging.dropped_count"] = self.dropped_count
            payload = (json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n").encode()
            try:
                _write_all(fd, payload)
            except (OSError, TypeError):
                try:
                    os.ftruncate(fd, initial_size)
                    os.fsync(fd)
                    if os.fstat(fd).st_size != initial_size:
                        raise OSError(errno.EIO, "rollback incompleto")
                except OSError:
                    self.disabled = True
                self._record_loss()
                return False
            return True
        finally:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            except OSError:
                pass
            try:
                os.close(fd)
            except OSError:
                pass

    def append(
        self,
        event_name: str,
        *,
        severity: str = "INFO",
        at: datetime | None = None,
        attributes: Mapping[str, object] | None = None,
        error_code: str | None = None,
    ) -> bool:
        if self.disabled:
            self._record_loss()
            return False
        try:
            stamp = (at or utc_now()).astimezone(timezone.utc)
            record: dict[str, object] = {
                "schema": LOG_SCHEMA,
                "timestamp": stamp.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "severity_text": severity,
                "severity_number": {"INFO": 9, "WARN": 13, "ERROR": 17}.get(severity, 9),
                "event_name": event_name,
                "body": event_name,
                "resource.service.name": LOG_SERVICE,
                "resource.service.instance.id": "heartbeat-h2",
                "resource.host.id_hash": "unknown",
                "resource.a4s.harness.name": "scheduler",
                "resource.a4s.harness.kind": "python-cli",
                "resource.a4s.harness.role": "scheduler",
                "scope.name": LOG_SCOPE,
                "attributes.a4s.correlation_id": self.correlation_id,
                "attributes.a4s.operation_id": self.operation_id,
                "attributes.a4s.operation": "heartbeat.tick",
                "a4s.logging.flush_status": "not_requested",
                "heartbeat.mode": self.mode,
            }
            if attributes:
                record.update(attributes)
            if error_code:
                if error_code not in ERROR_CODES:
                    error_code = "state_io"
                record.update({
                    "error.type": "heartbeat_error",
                    "error.code": error_code,
                    "error.source": "heartbeat_h2",
                })
            root = self.log_dir.parent.parent
            ensure_private_dir(root)
            ensure_private_dir(self.log_dir.parent)
            ensure_private_dir(self.log_dir)
            path = self.log_dir / f"{stamp:%Y-%m-%d}.jsonl"
            return self._append_record(path, record)
        except (OSError, StateError, TypeError, ValueError):
            self._record_loss()
            return False


def check_state(state: Any) -> dict:
    """Valida la forma que usa `evaluate`. Rechaza otro formato."""
    notified = state.get("notified", {}) if isinstance(state, dict) else None
    offset = state.get("session_offset") if isinstance(state, dict) else None
    correlation = state.get("correlation_id") if isinstance(state, dict) else None
    ok = (
        isinstance(state, dict)
        and isinstance(state.get("po"), dict)
        and "state_change_seq" in state["po"]
        and isinstance(state.get("in_progress"), dict)
        and isinstance(notified, dict)
        and (offset is None or (isinstance(offset, int) and not isinstance(offset, bool)))
        and (correlation is None or (isinstance(correlation, str) and bool(correlation)))
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
    """Carga estado regular. Rechaza enlaces y contenido inválido."""
    path = state_dir / "state.json"
    try:
        fd = _secure_open(path, os.O_RDONLY, 0o600)
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise StateError("no se pudo leer state.json") from exc
    try:
        with os.fdopen(fd, "r", encoding="utf-8") as handle:
            raw = handle.read()
    except (OSError, UnicodeDecodeError) as exc:
        raise StateError("no se pudo leer state.json") from exc
    try:
        return check_state(json.loads(raw))
    except (json.JSONDecodeError, StateError) as exc:
        raise StateError("state.json tiene formato inválido") from exc


def _legacy_dir_is_safe(legacy_dir: Path) -> bool:
    parents = legacy_dir.parents
    if len(parents) < 3:
        raise StateError("ruta legacy inválida")
    for path in (parents[2], parents[1], parents[0], legacy_dir):
        try:
            info = path.lstat()
        except FileNotFoundError:
            return False
        except OSError as exc:
            raise StateError("no se pudo validar el directorio legacy") from exc
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise StateError("directorio legacy inseguro")
    return True


def load_or_copy_legacy_state(state_dir: Path, legacy_dir: Path | None) -> dict | None:
    current = load_state(state_dir)
    if current is not None or legacy_dir is None or legacy_dir == state_dir:
        return current
    if not _legacy_dir_is_safe(legacy_dir):
        return None
    legacy = load_state(legacy_dir)
    if legacy is None:
        return None
    write_state(state_dir, legacy)
    return legacy


def notification_keys(result: dict) -> list[str]:
    keys = [f"{e['kind']}:{e['pane_id']}:{e['bead_id']}:{e['reason']}" for e in result["events"]]
    return keys + (["FAIL"] if result["verdict"] == "FAIL" else [])


def _journal_attributes(
    result: dict,
    *,
    duration_ms: int,
    wake_sent: bool,
    notification_sent: bool,
) -> dict[str, object]:
    facts = result.get("facts", {})
    callbacks = facts.get("callbacks", {}) if isinstance(facts, dict) else {}
    return {
        "heartbeat.verdict": result["verdict"],
        "heartbeat.reason": result["reason"],
        "heartbeat.duration_ms": duration_ms,
        "heartbeat.ready_count": facts.get("ready", 0),
        "heartbeat.in_progress_count": facts.get("in_progress", 0),
        "heartbeat.live_bead_count": facts.get("live_beads", 0),
        "heartbeat.claim_count": len(facts.get("claims", [])),
        "heartbeat.close_count": len(facts.get("closes", [])),
        "heartbeat.callback_seen_count": callbacks.get("seen"),
        "heartbeat.callback_answered_count": callbacks.get("answered"),
        "heartbeat.wake_sent": wake_sent,
        "heartbeat.notification_sent": notification_sent,
    }


def _handle_state_failure(
    *,
    journal: Journal,
    live: bool,
    started: float,
    wake_sent: bool,
    error_code: str,
) -> dict[str, object]:
    result: dict[str, object] = {"verdict": "FAIL", "reason": "state_error", "facts": {}, "events": []}
    notification_sent = False
    if live:
        try:
            notice = subprocess.run(
                ["herdr", "notification", "show", "A4S heartbeat H2 FAIL", "--body", "state_error"],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            notification_sent = notice.returncode == 0
        except OSError:
            notification_sent = False
    journal.append(
        "heartbeat.tick.failed",
        severity="ERROR",
        attributes=_journal_attributes(
            result,
            duration_ms=int((time.monotonic() - started) * 1000),
            wake_sent=wake_sent,
            notification_sent=notification_sent,
        ),
        error_code=error_code,
    )
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Reconciliador Heartbeat H2")
    parser.add_argument("--po-pane", required=True, help="identificador del panel del PO")
    parser.add_argument("--repo", default=None, help="raíz del repositorio para bd")
    parser.add_argument("--state-dir", type=Path, default=None, help="directorio de estado compatible")
    parser.add_argument("--stale-minutes", type=int, default=30)
    parser.add_argument("--record", action="store_true", help="persiste state.json; no escribe ticks.jsonl")
    parser.add_argument("--live", action="store_true", help="envía el wake y notificaciones; implica --record")
    args = parser.parse_args(argv)
    record = args.record or args.live
    mode = "live" if args.live else "record" if record else "read_only"
    state_dir, log_dir, legacy_dir = storage_paths(args.state_dir)
    operation_id = f"op.heartbeat.{uuid.uuid4().hex}"
    generated_correlation = f"corr.heartbeat.{uuid.uuid4().hex}"
    started = time.monotonic()

    try:
        if legacy_dir is not None:
            root = state_dir.parent.parent
            ensure_private_dir(root)
            ensure_private_dir(state_dir.parent)
        with tick_lock(state_dir):
            try:
                prev = load_or_copy_legacy_state(state_dir, legacy_dir) if record else None
            except StateError:
                journal = Journal(log_dir, generated_correlation, operation_id, mode)
                journal.append("heartbeat.tick.started")
                result = _handle_state_failure(
                    journal=journal,
                    live=args.live,
                    started=started,
                    wake_sent=False,
                    error_code="state_invalid",
                )
                print(json.dumps(result, sort_keys=True))
                return 2

            correlation_id = (prev or {}).get("correlation_id") or generated_correlation
            journal = Journal(log_dir, correlation_id, operation_id, mode)
            journal.append("heartbeat.tick.started")
            try:
                obs = observe(args.po_pane, args.repo, prev["at"] if prev else None)
            except (ObserveError, KeyError, TypeError):
                result = {"verdict": "FAIL", "reason": "observe_error", "facts": {}, "events": []}
                notification_sent = False
                if args.live:
                    try:
                        notice = subprocess.run(
                            ["herdr", "notification", "show", "A4S heartbeat H2 FAIL", "--body", "observe_error"],
                            check=False,
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL,
                        )
                        notification_sent = notice.returncode == 0
                    except OSError:
                        pass
                journal.append(
                    "heartbeat.tick.failed",
                    severity="ERROR",
                    attributes=_journal_attributes(
                        result,
                        duration_ms=int((time.monotonic() - started) * 1000),
                        wake_sent=False,
                        notification_sent=notification_sent,
                    ),
                    error_code="observation_failed",
                )
                print(json.dumps(result, sort_keys=True))
                return 2

            offset, obs["callbacks"] = scan_callbacks(
                obs["po"]["session_path"],
                prev.get("session_offset") if prev else None,
            )
            result = evaluate(prev, obs, args.stale_minutes * 60)
            wake_sent = False
            notification_sent = False
            pending_notification: tuple[str, str] | None = None
            notified = dict((prev or {}).get("notified", {}))
            if args.live:
                try:
                    wake = subprocess.run(
                        ["herdr", "agent", "prompt", args.po_pane, wake_prompt(result)],
                        capture_output=True,
                        check=False,
                    )
                    wake_sent = wake.returncode == 0
                except OSError:
                    wake_sent = False
                if not wake_sent:
                    result["verdict"], result["reason"] = "FAIL", "wake_undelivered"
                now = parse_ts(obs["at"])
                fresh = [
                    key for key in notification_keys(result)
                    if key not in notified
                    or (now - parse_ts(notified[key])).total_seconds() >= NOTIFY_REPEAT_SECONDS
                ]
                if fresh:
                    body = " ; ".join([render_event(item) for item in result["events"]] or [result["reason"]])
                    pending_notification = (f"A4S heartbeat H2 {result['verdict']}", body)
                    notified.update({key: obs["at"] for key in fresh})
            if record:
                try:
                    state_durable = write_state(
                        state_dir,
                        next_state(obs, wake_sent, notified, offset, correlation_id),
                    )
                except StateError:
                    result = _handle_state_failure(
                        journal=journal,
                        live=args.live,
                        started=started,
                        wake_sent=wake_sent,
                        error_code="state_io",
                    )
                    print(json.dumps({**result, "wake_sent": wake_sent}, sort_keys=True))
                    return 2
                if not state_durable:
                    journal.append(
                        "heartbeat.state.durability_uncertain",
                        severity="WARN",
                        attributes={"heartbeat.state.durable": False},
                    )

            if pending_notification is not None:
                title, body = pending_notification
                try:
                    notice = subprocess.run(
                        ["herdr", "notification", "show", title, "--body", body],
                        check=False,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                    notification_sent = notice.returncode == 0
                except OSError:
                    notification_sent = False

            report = {"at": obs["at"], **result, "wake_sent": wake_sent}
            attributes = _journal_attributes(
                result,
                duration_ms=int((time.monotonic() - started) * 1000),
                wake_sent=wake_sent,
                notification_sent=notification_sent,
            )
            if result["verdict"] == "FAIL":
                journal.append(
                    "heartbeat.tick.failed",
                    severity="ERROR",
                    attributes=attributes,
                    error_code="wake_undelivered" if result["reason"] == "wake_undelivered" else "evidence_missing",
                )
            else:
                journal.append("heartbeat.tick.completed", attributes=attributes)
            print(json.dumps(report, sort_keys=True))
            return 2 if result["verdict"] == "FAIL" else 0
    except LockBusy:
        print(json.dumps({"status": "lock_contended"}, sort_keys=True))
        return 0
    except StateError:
        result = {"verdict": "FAIL", "reason": "state_error", "facts": {}, "events": []}
        Journal(log_dir, generated_correlation, operation_id, mode).append(
            "heartbeat.tick.failed",
            severity="ERROR",
            attributes=_journal_attributes(
                result,
                duration_ms=int((time.monotonic() - started) * 1000),
                wake_sent=False,
                notification_sent=False,
            ),
            error_code="state_io",
        )
        print(json.dumps(result, sort_keys=True))
        return 2


if __name__ == "__main__":
    sys.exit(main())
