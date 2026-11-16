#!/usr/bin/env python3
"""Bound a Linux role's entire descendant tree to a user-service cgroup."""
import argparse
import ctypes
import json
import os
from pathlib import Path
import re
import select
import subprocess
import sys
import uuid


def status(code):
    return code if code >= 0 else 128 - code


def start_time(pid):
    return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]


def guard(parent, expected_start, unit, log, command):
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "PR_SET_CHILD_SUBREAPER failed")
    watch = os.pidfd_open(parent)
    try:
        if start_time(parent) != expected_start or select.select([watch], [], [], 0)[0]:
            return 124
    except FileNotFoundError:
        return 124
    record = {"guard": os.getpid(), "launcher": parent, "unit": unit,
              "cgroup": Path("/proc/self/cgroup").read_text().strip()}
    Path(log).write_text(json.dumps(record))
    child = subprocess.Popen(command)
    while child.poll() is None and not select.select([watch], [], [], 0.05)[0]:
        pass
    code = child.poll()
    record.update(reason="workload-exit" if code is not None else "launcher-death", exit=code)
    Path(log).write_text(json.dumps(record))
    os.close(watch)
    # Exiting the service's main process makes systemd kill even detached and late forks.
    return status(code) if code is not None else 124


def main():
    os.umask(0o077)
    if len(sys.argv) > 1 and sys.argv[1] == "--guard":
        return guard(int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6:])
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-seconds", type=int, required=True)
    parser.add_argument("--log", required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if args.runtime_seconds <= 0 or not command:
        parser.error("a positive runtime and a command are required")
    log = Path(args.log).resolve()
    log.parent.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
    os.environ.setdefault("DBUS_SESSION_BUS_ADDRESS", "unix:path=" + os.environ["XDG_RUNTIME_DIR"] + "/bus")
    unit = "a4s-role-" + uuid.uuid4().hex
    launch = ["systemd-run", "--user", "--quiet", "--wait", "--pipe", "--collect",
              "--service-type=exec", "--unit=" + unit, "--working-directory=" + os.getcwd(),
              "--property=KillMode=control-group", "--property=TimeoutStopSec=1s",
              "--property=SendSIGKILL=yes", f"--property=RuntimeMaxSec={args.runtime_seconds}s",
              "--property=TasksMax=128"]
    # systemd accepts shell identifiers only; pass names, never credential values.
    launch.extend("--setenv=" + name for name in os.environ if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name))
    launch.extend([sys.executable, str(Path(__file__).resolve()), "--guard", str(os.getpid()),
                   start_time(os.getpid()), unit, str(log), *command])
    code = status(subprocess.call(launch))
    if code and log.exists():
        try:
            record = json.loads(log.read_text())
            group = Path("/sys/fs/cgroup") / record["cgroup"].split("::", 1)[1].lstrip("/")
            if record["unit"] == unit and record.get("reason") == "workload-exit" and not group.exists():
                code = status(record["exit"])
        except (ValueError, KeyError, TypeError):
            pass  # Never turn an incomplete teardown record into success.
    return code


if __name__ == "__main__":
    sys.exit(main())
