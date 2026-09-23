#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import pty
import select
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Sequence


ROOT = Path(__file__).resolve().parents[3]
SKILL = ROOT / "skills" / "beads-loop" / "SKILL.md"
LOAD_MARKER = "Beads Autonomous Loop"
MAX_TRANSCRIPT_BYTES = 64 * 1024
TIMEOUT_SECONDS = 120
TERMINAL_KINDS = {
    "no_ready",
    "not_beads_repo",
    "doctor_failed",
    "claim_lost",
    "blocked",
    "invalid_evidence",
}
PRINT_COMMAND = [
    "pi",
    "-p",
    "--no-session",
    "--approve",
    "--no-context-files",
    "--no-extensions",
    "--skill",
    str(SKILL),
    (
        "Use the beads-loop skill now. Execute its adapter prime command in the "
        "current repository, preserve the exact envelope, and stop on a terminal "
        "envelope. Print that exact envelope as the final stdout line with no "
        "Markdown, backticks, code fences, or commentary. Do not make changes."
    ),
]
HEADED_COMMAND = [
    "pi",
    "--no-session",
    "--approve",
    "--no-context-files",
    "--no-extensions",
    "--skill",
    str(SKILL),
]


def _environment() -> dict[str, str]:
    return {**os.environ, "PI_OFFLINE": "1"}


def _valid_terminal_envelope(payload: object) -> bool:
    return (
        isinstance(payload, dict)
        and type(payload.get("schema_version")) is int
        and isinstance(payload.get("kind"), str)
        and payload.get("kind") in TERMINAL_KINDS
        and isinstance(payload.get("details"), dict)
    )


def run_print() -> int:
    with tempfile.TemporaryDirectory(prefix="beads-loop-pi-print-") as temporary:
        log_root = Path(temporary)
        target = log_root / "target"
        target.mkdir()
        try:
            subprocess.run(
                ["git", "init", "-q"],
                cwd=target,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=True,
                timeout=TIMEOUT_SECONDS,
            )
            result = subprocess.run(
                PRINT_COMMAND,
                cwd=target,
                env=_environment(),
                text=True,
                capture_output=True,
                check=False,
                timeout=TIMEOUT_SECONDS,
            )
        except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            print(f"Pi print probe could not complete: {type(exc).__name__}", file=sys.stderr)
            return 2

        (log_root / "stdout.log").write_text(result.stdout, encoding="utf-8")
        (log_root / "stderr.log").write_text(result.stderr, encoding="utf-8")
        if result.returncode != 0:
            print(f"Pi print probe exited {result.returncode}.", file=sys.stderr)
            return 1

        lines = [line for line in result.stdout.splitlines() if line.strip()]
        if not lines:
            print("Pi print probe returned no stdout envelope.", file=sys.stderr)
            return 1
        try:
            payload = json.loads(lines[-1])
        except json.JSONDecodeError:
            print("Pi print probe final stdout line is not JSON.", file=sys.stderr)
            return 1
        if not _valid_terminal_envelope(payload):
            print("Pi print probe did not return a terminal adapter envelope.", file=sys.stderr)
            return 1

        print(json.dumps(payload, separators=(",", ":"), sort_keys=True))
        return 0


def _stop_process(process: subprocess.Popen[bytes], master_fd: int) -> int | None:
    if process.poll() is None:
        try:
            os.write(master_fd, b"\x03\x03")
        except OSError:
            pass
    try:
        return process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        # Newer Pi keymaps use Ctrl-D to exit after the required double Ctrl-C.
        try:
            os.write(master_fd, b"\x04")
        except OSError:
            pass
    try:
        return process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.terminate()
        try:
            return process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            return process.wait(timeout=5)


def run_headed() -> int:
    transcript = bytearray()
    observed = False
    returncode: int | None = None

    with tempfile.TemporaryDirectory(prefix="beads-loop-pi-headed-") as temporary:
        log_path = Path(temporary) / "transcript.log"
        master_fd, slave_fd = pty.openpty()
        try:
            try:
                process = subprocess.Popen(
                    HEADED_COMMAND,
                    cwd=ROOT,
                    env=_environment(),
                    stdin=slave_fd,
                    stdout=slave_fd,
                    stderr=slave_fd,
                    close_fds=True,
                )
            except OSError as exc:
                print(f"Pi headed probe could not start: {type(exc).__name__}", file=sys.stderr)
                return 2
            finally:
                os.close(slave_fd)

            startup_deadline = time.monotonic() + 10
            quiet_polls = 0
            while time.monotonic() < startup_deadline and quiet_polls < 2:
                readable, _, _ = select.select([master_fd], [], [], 0.25)
                if not readable:
                    quiet_polls += 1
                    continue
                try:
                    chunk = os.read(master_fd, 4096)
                except OSError:
                    break
                if not chunk:
                    break
                transcript.extend(chunk)
                quiet_polls = 0

            os.write(master_fd, b"/skill:beads-loop\n")
            # Raw-mode TUIs commonly represent Enter as CR even when a PTY line is LF-ended.
            time.sleep(0.1)
            os.write(master_fd, b"\r")
            # Current Pi builds collapse skill bodies; expand output so the declared title is observable.
            time.sleep(0.5)
            os.write(master_fd, b"\x0f")
            deadline = time.monotonic() + TIMEOUT_SECONDS
            while time.monotonic() < deadline:
                readable, _, _ = select.select([master_fd], [], [], 0.25)
                if not readable:
                    if process.poll() is not None:
                        break
                    continue
                try:
                    chunk = os.read(master_fd, 4096)
                except OSError:
                    break
                if not chunk:
                    break
                transcript.extend(chunk)
                if len(transcript) > MAX_TRANSCRIPT_BYTES:
                    break
                if LOAD_MARKER in transcript.decode("utf-8", errors="replace"):
                    observed = True
                    break

            returncode = _stop_process(process, master_fd)
        finally:
            os.close(master_fd)
            log_path.write_bytes(bytes(transcript))

    if not observed:
        print(
            f"Pi headed probe did not observe {LOAD_MARKER!r} "
            f"within {len(transcript)} transcript bytes (exit {returncode}).",
            file=sys.stderr,
        )
        return 1
    print(
        f"observed={LOAD_MARKER!r} transcript_bytes={len(transcript)} "
        f"exit={returncode}"
    )
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only Pi dispatch smoke probe")
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--print", action="store_true", dest="print_mode")
    modes.add_argument("--headed", action="store_true")
    args = parser.parse_args(argv)
    if args.print_mode:
        return run_print()
    return run_headed()


if __name__ == "__main__":
    raise SystemExit(main())
