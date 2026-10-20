#!/usr/bin/env python3

import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def main() -> int:
    argv = json.loads(sys.argv[1])
    cwd = sys.argv[2]
    child_pid, master = pty.fork()
    if child_pid == 0:
        os.chdir(cwd)
        os.execvpe(argv[0], argv, os.environ)

    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 160, 0, 0))

    def forward_signal(signum: int, _frame: object) -> None:
        try:
            os.killpg(child_pid, signum)
        except ProcessLookupError:
            pass

    signal.signal(signal.SIGINT, forward_signal)
    signal.signal(signal.SIGTERM, forward_signal)
    inputs = [master, sys.stdin.fileno()]
    status = 0
    while True:
        ready, _, _ = select.select(inputs, [], [], 0.1)
        if master in ready:
            try:
                data = os.read(master, 65_536)
            except OSError:
                data = b""
            if data:
                os.write(sys.stdout.fileno(), data)
            else:
                break
        if sys.stdin.fileno() in ready:
            data = os.read(sys.stdin.fileno(), 65_536)
            if data:
                os.write(master, data)
            else:
                inputs.remove(sys.stdin.fileno())
        waited, child_status = os.waitpid(child_pid, os.WNOHANG)
        if waited == child_pid:
            status = child_status
            break
        time.sleep(0.01)

    try:
        _, child_status = os.waitpid(child_pid, 0)
        status = child_status
    except ChildProcessError:
        pass
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
