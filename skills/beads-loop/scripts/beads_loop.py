#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence


@dataclass(frozen=True)
class Envelope:
    kind: str
    details: dict[str, object]


def run_bd(cwd: Path, args: Sequence[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bd", *args],
        cwd=cwd,
        text=True,
        capture_output=True,
        check=False,
    )


def repository_root(cwd: Path) -> Path | None:
    try:
        resolved_cwd = cwd.resolve(strict=True)
    except OSError:
        return None
    if not resolved_cwd.is_dir():
        return None

    result = subprocess.run(
        ["git", "-C", str(resolved_cwd), "rev-parse", "--show-toplevel"],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0 or result.stderr.strip() or not result.stdout.strip():
        return None

    try:
        root = Path(result.stdout.strip()).resolve(strict=True)
        resolved_cwd.relative_to(root)
    except (OSError, ValueError):
        return None

    beads = root / ".beads"
    if not beads.is_dir() or beads.is_symlink():
        return None
    return root


def parse_json_output(result: subprocess.CompletedProcess[str]) -> object:
    if result.returncode != 0:
        raise ValueError("command_failed")
    if result.stderr.strip():
        raise ValueError("ambiguous_json_output")
    if not result.stdout.strip():
        raise ValueError("missing_json_output")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError("malformed_json_output") from exc


def _is_doctor_success(payload: object) -> bool:
    if not isinstance(payload, dict):
        return False
    if payload.get("status") == "ok":
        return True
    return isinstance(payload.get("checks"), list) and isinstance(payload.get("overall_ok"), bool)


def _doctor_requires_conventions(result: subprocess.CompletedProcess[str]) -> bool:
    stdout = result.stdout.strip()
    stderr = result.stderr.strip()
    if stdout and stderr:
        raise ValueError("ambiguous_doctor_output")
    body = stderr or stdout
    if not body:
        raise ValueError("missing_doctor_output")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        raise ValueError("malformed_doctor_output") from exc
    if not isinstance(payload, dict):
        raise ValueError("unexpected_doctor_output")
    if payload.get("code") == "embedded_unsupported":
        return True
    if stderr or result.returncode != 0:
        raise ValueError("doctor_failed")
    if not _is_doctor_success(payload):
        raise ValueError("unexpected_doctor_output")
    return False


def _doctor_ok(root: Path) -> bool:
    result = run_bd(root, ["doctor", "--agent", "--json"])
    try:
        needs_conventions = _doctor_requires_conventions(result)
    except ValueError:
        return False
    if not needs_conventions:
        return True

    fallback = run_bd(root, ["doctor", "--check", "conventions", "--agent", "--json"])
    try:
        payload = parse_json_output(fallback)
    except ValueError:
        return False
    return _is_doctor_success(payload)


def prime(cwd: Path) -> Envelope:
    root = repository_root(cwd)
    if root is None:
        return Envelope("not_beads_repo", {})

    try:
        doctor_ok = _doctor_ok(root)
    except OSError:
        doctor_ok = False
    if not doctor_ok:
        return Envelope("doctor_failed", {})

    try:
        prime_result = run_bd(root, ["prime", "--no-memories"])
    except OSError:
        return Envelope("blocked", {"reason": "prime_failed"})
    if prime_result.returncode != 0:
        return Envelope("blocked", {"reason": "prime_failed", "exit_code": prime_result.returncode})

    try:
        ready_result = run_bd(root, ["ready", "--sort", "priority", "--json"])
    except OSError:
        return Envelope("blocked", {"reason": "ready_failed"})
    try:
        ready = parse_json_output(ready_result)
    except ValueError:
        return Envelope("blocked", {"reason": "ready_failed", "exit_code": ready_result.returncode})
    if not isinstance(ready, list) or any(
        not isinstance(item, dict)
        or not isinstance(item.get("id"), str)
        or not item["id"]
        for item in ready
    ):
        return Envelope("blocked", {"reason": "unexpected_ready_output"})
    if not ready:
        return Envelope("no_ready", {"issues": []})
    return Envelope("ready", {"issues": ready})


def main(argv: Sequence[str]) -> int:
    if list(argv) != ["prime"]:
        print("usage: beads_loop.py prime", file=sys.stderr)
        return 2

    envelope = prime(Path.cwd())
    print(
        json.dumps(
            {
                "schema_version": 1,
                "kind": envelope.kind,
                "details": envelope.details,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
