#!/usr/bin/env python3
"""Opt-in pre-pilot triage roles; run+generation binding still needs operator acceptance."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys


MAX_TIME = 120
GUARD_TIME = 135


def last_object(text):
    result = None
    for line in text.splitlines():
        try:
            value = json.loads(line)
            if isinstance(value, dict):
                result = value
        except ValueError:
            pass
    return result


def context():
    run, version = os.environ["RUN"], os.environ["VERSION"]
    if run in (".", "..") or not re.fullmatch(r"[\w.-]+", run) or not re.fullmatch(r"\d+", version):
        raise ValueError("invalid RUN or VERSION")
    root = Path(os.environ["STATE_ROOT"])
    if not root.is_absolute():
        raise ValueError("STATE_ROOT must be an absolute private directory")
    root.mkdir(parents=True, exist_ok=True)
    if root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o077:
        raise ValueError("STATE_ROOT must be owned by this user with mode 0700")
    return run, version, root / run / ("version-" + version)


def run_role(role):
    if role not in ("triage", "reviewer"):
        raise ValueError("unknown triage role")
    run, version, state = context()
    directory = state / role
    directory.mkdir(parents=True)  # A generation may never reuse an earlier role's transcript.
    sessions = directory / "sessions"
    sessions.mkdir()
    if role == "triage":
        (state / "triage-start.json").write_text(json.dumps({"at": datetime.now(timezone.utc).isoformat()}))
        assignment = "Decide whether this scope needs a PoC before implementation. "
        assignment += "A PoC exercises an unproven external/runtime behavior that could change the implementation path; reproducing a bug is not a PoC.\n"
        assignment += os.environ["SCOPE"]
    else:
        assignment = "Independently review this triage. Set agree=true only if POC=no is justified by already exercised behavior.\n"
        assignment += os.environ["SCOPE"] + "\nTriage decision:\n"
        assignment += (state / "triage" / "decision.json").read_text()
    assignment += "\nOperator feedback: " + os.environ.get("FEEDBACK", "")
    prompt = f"RUN={run} VERSION={version}\n{assignment}\nReturn exactly one single-line JSON object with poc (yes/no), behavior, question, reason, run and version (strings)"
    prompt += ", and agree (boolean)." if role == "reviewer" else "."
    (directory / "prompt.txt").write_text(prompt)
    config = directory / "config.yaml"
    config.write_text(json.dumps({"features": {"unexpectedStopDetection": "none"}}))
    command = ["omp", "-p", "--mode", "text", "--wait-async", "--max-time", f"{MAX_TIME}s",
               "--max-cost", os.environ.get("MAX_COST", "0.50"), "--config", str(config),
               "--session-dir", str(sessions), "--no-extensions", "--no-context-files",
               "--no-skills", "--no-rules", "--no-title", "--no-lsp", "--no-tools", "--thinking", "off",
               "--model", os.environ["MODEL"], "--system-prompt", "Return only the requested JSON object.", prompt]
    guard = Path(__file__).with_name("role-guard.py")
    with (directory / "stdout.txt").open("w") as stdout, (directory / "stderr.txt").open("w") as stderr:
        code = subprocess.call([sys.executable, str(guard), "--runtime-seconds", str(GUARD_TIME),
                                "--log", str(directory / "cleanup.json"), "--", *command], stdout=stdout, stderr=stderr)
    decision = last_object((directory / "stdout.txt").read_text())
    if decision is not None:
        (directory / "decision.json").write_text(json.dumps(decision))
        print(json.dumps(decision))
    transcripts = list(sessions.glob("*.jsonl"))
    if role == "reviewer" and len(transcripts) == 1:
        (state / "reviewer-binding.json").write_text(json.dumps({"session_dir": str(sessions), "session": str(transcripts[0])}))
    return code if code >= 0 else 128 - code


def timestamp(value):
    date = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if date.tzinfo is None:
        raise ValueError("a timezone is required")
    return date.timestamp()


def check_review():
    run, version, state = context()
    triage = json.loads((state / "triage" / "decision.json").read_text())
    triage_checks = {"triage_run": triage.get("run") == run, "triage_version": triage.get("version") == version}
    # POC=yes never needs a reviewer or a binding, even if stale review artifacts exist.
    if triage.get("poc") == "yes":
        print(json.dumps({**triage_checks, "poc_yes_bypass": True}))
        return 0 if all(triage_checks.values()) else 1
    try:
        review = json.loads((state / "reviewer" / "decision.json").read_text())
        binding = json.loads((state / "reviewer-binding.json").read_text())
        directory = state / "reviewer" / "sessions"
        transcripts = list(directory.glob("*.jsonl"))
        unique = len(transcripts) == 1 and Path(binding["session_dir"]).resolve() == directory.resolve()
        unique = unique and Path(binding["session"]).resolve() == transcripts[0].resolve()
        records = [json.loads(line) for line in transcripts[0].read_text().splitlines()] if unique else []
        session = next((entry for entry in records if entry.get("type") == "session"), {})
        users = [entry["message"].get("content", "") for entry in records
                 if entry.get("type") == "message" and entry.get("message", {}).get("role") == "user"]
        content = users[0] if users else ""
        if isinstance(content, list):
            content = "".join(block.get("text", "") for block in content if block.get("type") == "text")
        marker = re.fullmatch(r"RUN=([\w.-]+) VERSION=(\d+)", content.splitlines()[0] if content else "")
        started = timestamp(json.loads((state / "triage-start.json").read_text())["at"])
        checks = {**triage_checks,
                  "poc_no": triage.get("poc") == "no" and review.get("poc") == "no",
                  "agree": review.get("agree") is True,
                  "review_run": review.get("run") == run, "review_version": review.get("version") == version,
                  "transcript_unique": unique,
                  "created_after_triage": bool(session) and timestamp(session["timestamp"]) > started,
                  "mtime_after_triage": unique and transcripts[0].stat().st_mtime > started,
                  "prompt_run": bool(marker) and marker[1] == run,
                  "prompt_version": bool(marker) and marker[2] == version}
    except (OSError, ValueError, KeyError, TypeError, IndexError):
        checks = {"review_artifacts_valid": False}
    print(json.dumps(checks))
    return 0 if all(checks.values()) else 1


def main():
    os.umask(0o077)
    if sys.argv[1:] == ["extract"]:
        value = last_object(sys.stdin.read())
        if value is not None:
            print(json.dumps(value))
        return 0
    if sys.argv[1:] == ["check"]:
        return check_review()
    if len(sys.argv) == 3 and sys.argv[1] == "run":
        return run_role(sys.argv[2])
    raise ValueError("usage: triage-role.py run triage|reviewer / check / extract")


if __name__ == "__main__":
    sys.exit(main())
