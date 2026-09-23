#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Sequence


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

    try:
        result = subprocess.run(
            ["git", "-C", str(resolved_cwd), "rev-parse", "--show-toplevel"],
            text=True,
            capture_output=True,
            check=False,
        )
    except OSError:
        return None
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
    return (
        isinstance(payload.get("checks"), list)
        or isinstance(payload.get("diagnostics"), list)
    ) and payload.get("overall_ok") is True


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


def _single_issue(payload: object, bead_id: str | None = None) -> dict[str, object] | None:
    if not isinstance(payload, list) or len(payload) != 1 or not isinstance(payload[0], dict):
        return None
    issue = payload[0]
    issue_id = issue.get("id")
    if not isinstance(issue_id, str) or not issue_id:
        return None
    if bead_id is not None and issue_id != bead_id:
        return None
    return issue


def _resolved_actor(root: Path) -> str | None:
    actor = os.environ.get("BEADS_ACTOR", "")
    if actor:
        return actor

    try:
        result = subprocess.run(
            ["git", "-C", str(root), "config", "--get", "user.name"],
            text=True,
            capture_output=True,
            check=False,
        )
    except OSError:
        result = None
    if (
        result is not None
        and result.returncode == 0
        and not result.stderr.strip()
        and result.stdout.strip()
    ):
        return result.stdout.strip()

    actor = os.environ.get("USER", "")
    return actor or None


def claim(cwd: Path) -> Envelope:
    gate = prime(cwd)
    if gate.kind != "ready":
        return gate

    root = repository_root(cwd)
    if root is None:
        return Envelope("claim_lost", {"reason": "repository_changed"})

    try:
        result = run_bd(root, ["ready", "--sort", "priority", "--claim", "--json"])
        payload = parse_json_output(result)
    except (OSError, ValueError):
        return Envelope("claim_lost", {"reason": "claim_failed"})
    if payload == []:
        return Envelope("no_ready", {"issues": []})

    claimed = _single_issue(payload)
    if claimed is None:
        return Envelope("claim_lost", {"reason": "unexpected_claim_output"})
    bead_id = claimed["id"]

    actor = _resolved_actor(root)
    if actor is None:
        return Envelope("claim_lost", {"reason": "actor_unresolved"})
    try:
        shown_result = run_bd(root, ["show", bead_id, "--json"])
        shown = _single_issue(parse_json_output(shown_result), bead_id)
    except (OSError, ValueError):
        shown = None
    if (
        shown is None
        or shown.get("status") != "in_progress"
        or shown.get("assignee") != actor
    ):
        return Envelope("claim_lost", {"reason": "post_claim_mismatch"})
    return Envelope("claimed", {"issue": shown})


def _evidence_reference(root: Path, cwd: Path, evidence: Path) -> str | None:
    try:
        resolved_cwd = cwd.resolve(strict=True)
        lexical_cwd = Path(os.path.abspath(cwd))
        if evidence.is_absolute():
            lexical_evidence = Path(os.path.abspath(evidence))
            try:
                candidate = resolved_cwd / lexical_evidence.relative_to(lexical_cwd)
            except ValueError:
                candidate = lexical_evidence
        else:
            candidate = root / evidence
        lexical_candidate = Path(os.path.abspath(candidate))
        relative_candidate = lexical_candidate.relative_to(root)
    except (OSError, ValueError):
        return None

    current = root
    for part in relative_candidate.parts:
        current /= part
        if current.is_symlink():
            return None

    try:
        resolved_evidence = lexical_candidate.resolve(strict=True)
        relative_evidence = resolved_evidence.relative_to(root)
    except (OSError, ValueError):
        return None
    if not resolved_evidence.is_file():
        return None
    return relative_evidence.as_posix()


def finalize(
    cwd: Path,
    bead_id: str,
    verdict: Literal["pass", "fail"],
    evidence: Path,
) -> Envelope:
    if not bead_id or bead_id != bead_id.strip() or bead_id.startswith("-"):
        return Envelope("blocked", {"reason": "invalid_bead_id"})
    if verdict not in ("pass", "fail"):
        return Envelope("blocked", {"reason": "invalid_verdict"})

    root = repository_root(cwd)
    if root is None:
        return Envelope("not_beads_repo", {})
    evidence_reference = _evidence_reference(root, cwd, evidence)
    if evidence_reference is None:
        return Envelope("invalid_evidence", {})

    actor = _resolved_actor(root)
    if actor is None:
        return Envelope("claim_lost", {"reason": "actor_unresolved"})
    try:
        shown_result = run_bd(root, ["show", bead_id, "--json"])
        shown = _single_issue(parse_json_output(shown_result), bead_id)
    except (OSError, ValueError):
        shown = None
    if (
        shown is None
        or shown.get("status") != "in_progress"
        or shown.get("assignee") != actor
    ):
        return Envelope("claim_lost", {"reason": "ownership_mismatch"})

    expected_status = "closed" if verdict == "pass" else "blocked"
    evidence_label = "PASS" if verdict == "pass" else "FAIL"
    command = [
        "update",
        bead_id,
        "--status",
        expected_status,
        "--if-assignee",
        actor,
        "--if-status",
        "in_progress",
        "--append-notes",
        f"{evidence_label} evidence={evidence_reference}",
    ]

    try:
        mutation = run_bd(root, command)
    except OSError:
        return Envelope("blocked", {"reason": "finalize_failed"})
    if mutation.returncode == 13:
        return Envelope(
            "claim_lost",
            {"reason": "conditional_guard_failed", "exit_code": mutation.returncode},
        )
    if mutation.returncode != 0:
        return Envelope(
            "blocked", {"reason": "finalize_failed", "exit_code": mutation.returncode}
        )

    try:
        shown_result = run_bd(root, ["show", bead_id, "--json"])
        shown = _single_issue(parse_json_output(shown_result), bead_id)
    except (OSError, ValueError):
        shown = None
    if (
        shown is None
        or shown.get("status") != expected_status
        or shown.get("assignee") != actor
    ):
        return Envelope("blocked", {"reason": "final_state_mismatch"})
    return Envelope("finalized", {"issue": shown, "evidence": evidence_reference})


def _print_envelope(envelope: Envelope) -> None:
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


def main(argv: Sequence[str]) -> int:
    args = list(argv)
    if args == ["prime"]:
        envelope = prime(Path.cwd())
    elif args == ["claim"]:
        envelope = claim(Path.cwd())
    elif (
        len(args) == 7
        and args[0] == "finalize"
        and args[1] == "--bead"
        and args[3] == "--verdict"
        and args[4] in ("pass", "fail")
        and args[5] == "--evidence"
    ):
        envelope = finalize(Path.cwd(), args[2], args[4], Path(args[6]))
    else:
        print(
            "usage: beads_loop.py prime | claim | "
            "finalize --bead ID --verdict pass|fail --evidence PATH",
            file=sys.stderr,
        )
        return 2

    _print_envelope(envelope)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
