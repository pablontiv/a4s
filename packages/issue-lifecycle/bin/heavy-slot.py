#!/usr/bin/env python3
"""Run a full suite or feature gate in the station's single heavy-test slot."""
import fcntl
import json
import os
import subprocess
import sys
import time


def main():
    args = sys.argv[1:]
    gate = args[:1] == ["--gate"]
    run = args[1] if gate else os.environ.get("RUN", "npm-test")
    body = args[2:] if gate else args
    if not body:
        raise SystemExit("heavy-slot: command required")

    def acquired():
        if gate and os.environ.get("A4S_GATE_JOURNAL"):
            with open(os.environ["A4S_GATE_JOURNAL"], "a") as journal:
                journal.write(json.dumps({"id": "lock_wait", "endedAt": time.time_ns() // 1000000, "exitCode": 0}) + "\n")

    # Resolve through the launcher-owned reader, never parse a second contract.
    package = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    reader = ([os.environ["A4S_BIN"]] if os.environ.get("A4S_BIN") else
              ["node", "--import", "tsx", os.path.join(package, "src", "cli.ts")])
    service = json.loads(subprocess.check_output(
        [*reader, "service-environment"], cwd=package, text=True))
    os.environ.update(service)
    home = service["DAGU_HOME"]
    if os.environ.get("A4S_HEAVY_SLOT_HELD") == "1":
        print("slot: reenter marker=A4S_HEAVY_SLOT_HELD", file=sys.stderr, flush=True)
        acquired()
        os.execvp(body[0], body)

    path = os.path.join(os.path.abspath(home), "a4s", "heavy-slot.lock")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    os.set_inheritable(fd, True)
    while True:
        previous = None
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                holder = os.pread(fd, 4096, 0).decode("utf-8", errors="replace") or "unknown"
                if holder != previous:
                    print(f"gate: waiting lock={path} run={run} pid={os.getpid()} holder={holder}", file=sys.stderr, flush=True)
                    previous = holder
                time.sleep(0.1)
        owner = json.dumps({"run": run, "role": "gate" if gate else "npm-test", "pid": os.getpid()})
        os.ftruncate(fd, 0)
        os.pwrite(fd, owner.encode(), 0)
        acquired()
        print(f"gate: acquired lock={path} holder={owner}", file=sys.stderr, flush=True)
        env = {**os.environ, "A4S_HEAVY_SLOT_HELD": "1"}
        status = subprocess.run(body, pass_fds=(fd,), env=env).returncode
        if not gate or status != 86:
            raise SystemExit(status if status >= 0 else 128 - status)
        # Integration protection must not monopolize the station while waiting.
        fcntl.flock(fd, fcntl.LOCK_UN)
        try:
            pause = float(os.environ.get("A4S_INTEGRATION_POLL_SEC", "1"))
        except ValueError:
            pause = 1.0
        time.sleep(pause if pause >= 0 else 1.0)


if __name__ == "__main__":
    main()
