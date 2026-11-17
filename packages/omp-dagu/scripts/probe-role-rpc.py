#!/usr/bin/env python3
"""Live, opt-in RPC ownership self-check; run inside role-guard.py, never an operator station."""
import argparse
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import time


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True)
    parser.add_argument("--state", required=True)
    args = parser.parse_args()
    state = Path(args.state).resolve()
    state.mkdir(parents=True, exist_ok=True)
    config = state / "config.yaml"
    config.write_text(json.dumps({"features": {"unexpectedStopDetection": "none"}}))
    events = []
    buffer = b""
    deadline = time.monotonic() + 115
    acknowledgements = []
    with (state / "stderr.txt").open("w") as stderr, (state / "events.jsonl").open("w") as log:
        child = subprocess.Popen(["omp", "--mode", "rpc", "--no-ui", "--no-extensions", "--no-context-files",
                                  "--no-skills", "--no-rules", "--no-title", "--no-lsp", "--no-tools", "--offline",
                                  "--max-time", "120s", "--thinking", "off",
                                  "--config", str(config), "--session-dir", str(state / "sessions"),
                                  "--model", args.model, "--system-prompt", "Follow the host's short test instructions exactly."],
                                 cwd=state, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, bufsize=0)
        def send(value):
            child.stdin.write((json.dumps(value) + "\n").encode())
            child.stdin.flush()

        def receive(predicate):
            nonlocal buffer
            while True:
                found = next((event for event in events if predicate(event)), None)
                if found is not None:
                    return found
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("RPC probe deadline; inspect events.jsonl and stderr.txt")
                ready = select.select([child.stdout], [], [], remaining)[0]
                if not ready:
                    raise TimeoutError("RPC child stopped responding")
                data = os.read(child.stdout.fileno(), 65536)
                if not data:
                    raise RuntimeError(f"RPC child closed stdout: {child.poll()}; inspect stderr.txt")
                buffer += data
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    if line.strip():
                        event = json.loads(line)
                        events.append(event)
                        log.write(json.dumps(event) + "\n")
                        log.flush()

        def command(kind, identifier, **values):
            send({"type": kind, "id": identifier, **values})
            response = receive(lambda event: event.get("type") == "response" and event.get("id") == identifier)
            if response.get("success") is not True:
                raise RuntimeError(f"{identifier} rejected: {response}")
            acknowledgements.append(identifier)
            return response.get("data", {})

        try:
            receive(lambda event: event.get("type") == "ready")
            initial = command("get_state", "initial")
            command("set_host_tools", "tools", tools=[{"name": "host_gate", "label": "Host gate",
                    "description": "Wait until the host releases this test gate.",
                    "parameters": {"type": "object", "properties": {}, "additionalProperties": False}}])
            command("prompt", "role", message="Call host_gate exactly once, then reply BASE_DONE. Do not do anything else.")
            gate = receive(lambda event: event.get("type") == "host_tool_call")
            busy = command("get_state", "busy")
            if not busy.get("isStreaming"):
                raise AssertionError("role was not busy while its host tool was pending")
            command("steer", "steer", message="STEER_MARKER: Change the current reply to exactly STEER_SEEN after the gate completes. Do not call any more tools.")
            command("follow_up", "follow-up", message="FOLLOW_UP_MARKER: After the current reply, reply exactly FOLLOW_UP_SEEN. Do not call tools.")
            queued = command("get_state", "queued")
            send({"type": "host_tool_result", "id": gate["id"], "result": {"content": [{"type": "text", "text": "Gate released."}]}})
            completed = receive(lambda event: event.get("type") == "prompt_result" and event.get("id") == "role")
            if completed.get("status") != "completed":
                raise AssertionError(f"role did not complete: {completed}")
            receive(lambda event: event.get("type") == "session_settled")
            settled = command("get_state", "settled")
            records = [json.loads(line) for line in Path(settled["sessionFile"]).read_text().splitlines()]
            replies = [entry["message"]["content"] for entry in records
                       if entry.get("type") == "message" and entry.get("message", {}).get("role") == "assistant"]
            texts = [block.get("text", "") for content in replies for block in content if block.get("type") == "text"]
            if not any("STEER_SEEN" in text for text in texts) or not any("FOLLOW_UP_SEEN" in text for text in texts):
                raise AssertionError(f"steer/follow-up not observed in assistant replies: {texts}")
            command("prompt", "abort-role", message="Call host_gate once again and wait for its result before replying NEVER.")
            second = receive(lambda event: event.get("type") == "host_tool_call" and event.get("id") != gate["id"])
            command("abort", "abort")
            aborted = receive(lambda event: event.get("type") == "prompt_result" and event.get("id") == "abort-role")
            if aborted.get("status") != "aborted":
                raise AssertionError(f"abort did not abort the active role: {aborted}")
            receive(lambda event: event.get("type") == "host_tool_cancel" and event.get("targetId") == second["id"])
            final = command("get_state", "final")
            if initial["sessionId"] != final["sessionId"] or initial["sessionFile"] != final["sessionFile"]:
                raise AssertionError("the owner did not keep the same role session")
            child.stdin.close()
            code = child.wait(timeout=10)
            if code != 0:
                raise AssertionError(f"RPC EOF exit was {code}")
            result = {"pass": True, "model": args.model, "session": initial["sessionId"],
                      "acks": acknowledgements, "queued": queued.get("queuedMessages"),
                      "steer_observed": True, "follow_up_observed": True, "abort_status": aborted["status"],
                      "host_tool_cancelled": True, "same_session": True, "eof_exit": code,
                      "owner": os.getpid(), "rpc_child": child.pid, "dag_run": os.environ.get("DAG_RUN_ID")}
            (state / "result.json").write_text(json.dumps(result, indent=2))
            print(json.dumps(result))
            return 0
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()


if __name__ == "__main__":
    sys.exit(main())
