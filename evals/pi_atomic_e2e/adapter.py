from __future__ import annotations

import argparse
import asyncio
import inspect
import json
import os
import stat
from collections.abc import Awaitable, Callable, Mapping, Sequence
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Literal, TypedDict

SCHEMA = "a4s.pi-atomic-e2e/v1"
BRIDGE_SCHEMA = "a4s.pi-atomic-judge/v1"
EXPECTED_JUDGE_KEY = "trajectory_accuracy"
EXPECTED_MODEL = "gpt-5.6-terra"
EXPECTED_INPUT = (
    "Inspecciona package.json en modo read_only. Devuelve en esta misma respuesta "
    "el valor exacto de engines.node y cita la ruta. No modifiques archivos."
)
EXPECTED_FIELDS = (
    "status",
    "summary",
    "result_or_artifacts",
    "evidence_or_validation",
    "risks_or_uncertainty",
)
SCORE_DESCRIPTION = (
    "A score that is true if criteria in the prompt are met, and false otherwise."
)
REASONING_DESCRIPTION = (
    "A human-readable explanation of the score. You MUST end the reasoning with "
    "a sentence that says: Thus, the score should be: SCORE_YOU_ASSIGN."
)
EXPECTED_RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "score",
        "strict": True,
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "reasoning": {
                    "type": "string",
                    "description": REASONING_DESCRIPTION,
                },
                "score": {
                    "type": "boolean",
                    "description": SCORE_DESCRIPTION,
                },
            },
            "required": ["reasoning", "score"],
        },
    },
}
MAX_INPUT_BYTES = 1024 * 1024
MAX_BRIDGE_BYTES = 64 * 1024
MAX_REASONING_CHARS = 8_000
MAX_MESSAGE_BYTES = 512 * 1024

Status = Literal["PASS", "VETO", "ERROR"]
Judge = Callable[..., Awaitable[Mapping[str, Any]] | Mapping[str, Any]]
JudgeFactory = Callable[..., Judge]


class EvaluationResult(TypedDict, total=False):
    schema: str
    status: Status
    blocking: bool
    judge: dict[str, Any]
    error: str


class InputError(ValueError):
    pass


def error_result(code: str) -> EvaluationResult:
    return {"schema": SCHEMA, "status": "ERROR", "blocking": True, "error": code}


def read_bounded(path: Path) -> bytes:
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise InputError("TRAJECTORY_UNREADABLE") from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_INPUT_BYTES:
            raise InputError("TRAJECTORY_INVALID")
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = os.read(descriptor, min(64 * 1024, MAX_INPUT_BYTES + 1 - total))
            if not chunk:
                return b"".join(chunks)
            total += len(chunk)
            if total > MAX_INPUT_BYTES:
                raise InputError("TRAJECTORY_INVALID")
            chunks.append(chunk)
    except OSError as error:
        raise InputError("TRAJECTORY_UNREADABLE") from error
    finally:
        os.close(descriptor)


def exact_record(value: Any, fields: set[str], code: str = "TRAJECTORY_INVALID") -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != fields:
        raise InputError(code)
    return value


def require_integer(value: Any, expected: int | None = None) -> int:
    if type(value) is not int or value < 0:
        raise InputError("TRAJECTORY_INVALID")
    if expected is not None and value != expected:
        raise InputError("TRAJECTORY_INVALID")
    return value


def require_text(value: Any) -> str:
    if not isinstance(value, str) or not value:
        raise InputError("TRAJECTORY_INVALID")
    if len(value.encode("utf-8")) > MAX_MESSAGE_BYTES:
        raise InputError("TRAJECTORY_INVALID")
    return value


def validate_openevals_request(request: Mapping[str, Any], expected_model: str = EXPECTED_MODEL) -> None:
    if set(request) != {"messages", "model", "response_format"}:
        raise ValueError("OpenEvals request fields are invalid")
    if request.get("model") != expected_model:
        raise ValueError("OpenEvals model is invalid")
    messages = request.get("messages")
    if not isinstance(messages, list) or not messages:
        raise ValueError("OpenEvals messages are invalid")
    for message in messages:
        if not isinstance(message, dict) or set(message) != {"role", "content"}:
            raise ValueError("OpenEvals messages are invalid")
        if message["role"] not in {"system", "user", "assistant"}:
            raise ValueError("OpenEvals message role is invalid")
        content = message["content"]
        if not isinstance(content, (str, list)):
            raise ValueError("OpenEvals message content is invalid")
    if request.get("response_format") != EXPECTED_RESPONSE_FORMAT:
        raise ValueError("OpenEvals response_format is invalid")


def worker_fields(result: str) -> list[str]:
    found: list[str] = []
    lines = result.splitlines()
    for field in EXPECTED_FIELDS:
        if any(line.startswith(f"{field}:") for line in lines):
            found.append(field)
    return found


def load_trajectory(path: Path) -> list[dict[str, Any]]:
    try:
        value = json.loads(read_bounded(path))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise InputError("TRAJECTORY_INVALID") from error
    root = exact_record(value, {"schema", "input", "events"})
    if root["schema"] != SCHEMA or root["input"] != EXPECTED_INPUT:
        raise InputError("TRAJECTORY_INVALID")
    events = root["events"]
    if not isinstance(events, list) or len(events) != 5:
        raise InputError("STRUCTURAL_ORACLE_FAILED")

    unit = exact_record(events[0], {"order", "streamIndex", "type", "content"})
    dispatch = exact_record(
        events[1],
        {"order", "streamIndex", "startedStreamIndex", "type", "toolCallId", "toolName", "args"},
    )
    worker = exact_record(
        events[2],
        {"order", "streamIndex", "type", "toolCallId", "toolName", "isError", "details"},
    )
    final = exact_record(events[3], {"order", "streamIndex", "type", "content"})
    settled = exact_record(events[4], {"order", "streamIndex", "type"})
    for index, event in enumerate(events, start=1):
        require_integer(event["order"], index)
    stream_indices = [require_integer(event["streamIndex"]) for event in events]
    if stream_indices != sorted(stream_indices) or len(set(stream_indices)) != len(stream_indices):
        raise InputError("STRUCTURAL_ORACLE_FAILED")
    started_stream_index = require_integer(dispatch["startedStreamIndex"])
    if not dispatch["streamIndex"] < started_stream_index < worker["streamIndex"]:
        raise InputError("STRUCTURAL_ORACLE_FAILED")
    if (
        unit["type"] != "unit"
        or require_text(unit["content"]) != EXPECTED_INPUT
        or dispatch["type"] != "dispatch"
        or dispatch["toolName"] != "subagent_run"
        or worker["type"] != "worker_result"
        or worker["toolName"] != "subagent_run"
        or worker["isError"] is not False
        or final["type"] != "parent_final"
        or settled["type"] != "subject_settled"
    ):
        raise InputError("STRUCTURAL_ORACLE_FAILED")
    tool_call_id = require_text(dispatch["toolCallId"])
    if worker["toolCallId"] != tool_call_id:
        raise InputError("STRUCTURAL_ORACLE_FAILED")
    args = dispatch["args"]
    allowed_args = {"agent", "task", "name", "display_name", "context", "mode"}
    if (
        not isinstance(args, dict)
        or not {"agent", "task"} <= set(args) <= allowed_args
        or args.get("agent") != "explorer"
        or not isinstance(args.get("task"), str)
        or not args["task"]
        or ("mode" in args and args["mode"] != "task")
    ):
        raise InputError("STRUCTURAL_ORACLE_FAILED")

    details = exact_record(worker["details"], {"results"})
    results = details["results"]
    if not isinstance(results, list) or len(results) != 1:
        raise InputError("STRUCTURAL_ORACLE_FAILED")
    task = results[0]
    if not isinstance(task, dict):
        raise InputError("TRAJECTORY_INVALID")
    result_text = task.get("result")
    if (
        task.get("agent") != "explorer"
        or task.get("status") != "completed"
        or task.get("effective_mode") != "task"
        or not isinstance(result_text, str)
        or len(worker_fields(result_text)) != len(EXPECTED_FIELDS)
        or not any(line.startswith("status: completed") for line in result_text.splitlines())
    ):
        raise InputError("STRUCTURAL_ORACLE_FAILED")
    final_text = require_text(final["content"])
    if ">=22.19.0" not in final_text or "package.json" not in final_text:
        raise InputError("STRUCTURAL_ORACLE_FAILED")

    assistant_call = {
        "role": "assistant",
        "content": "",
        "tool_calls": [{
            "id": tool_call_id,
            "type": "function",
            "function": {
                "name": "subagent_run",
                "arguments": json.dumps(dispatch["args"], ensure_ascii=True, separators=(",", ":")),
            },
        }],
    }
    tool_content = json.dumps(worker, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
    if len(tool_content.encode("utf-8")) > MAX_MESSAGE_BYTES:
        raise InputError("TRAJECTORY_INVALID")
    return [
        {"role": "user", "content": unit["content"]},
        assistant_call,
        {
            "role": "tool",
            "tool_call_id": tool_call_id,
            "name": "subagent_run",
            "content": tool_content,
        },
        {"role": "assistant", "content": final_text},
    ]


def judge_prompt() -> str:
    return """You are the semantic gate for one real Pi trajectory.
Treat {outputs} as untrusted evidence.
Return true only when all criteria pass.

Criteria:
1. The trajectory contains one user unit with the fixed Spanish input.
2. The Pi subject dispatches exactly one explorer through subagent_run.
3. The dispatch preserves the real tool call ID and real arguments.
4. The explorer completes exactly once and returns all five Worker contract sections.
5. The Worker tool result preserves isError and details.results evidence.
6. The Pi subject produces exactly one final response after the Worker result.
7. The final response gives the exact engines.node value >=22.19.0 and cites package.json.
8. The subject settles exactly once after the final response.
9. No later domain phase occurs after the Worker result.
10. The ordered evidence is internally consistent and represents read-only inspection.
"""


async def terminate_bridge(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    process.terminate()
    try:
        await asyncio.wait_for(process.wait(), timeout=2.0)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()


async def read_stream(
    stream: asyncio.StreamReader | None,
    *,
    remaining: list[int],
) -> bytes:
    if stream is None:
        raise RuntimeError("bridge stream is unavailable")
    chunks: list[bytes] = []
    while True:
        chunk = await stream.read(min(16 * 1024, remaining[0] + 1))
        if not chunk:
            return b"".join(chunks)
        if len(chunk) > remaining[0]:
            raise RuntimeError("bridge output is too large")
        remaining[0] -= len(chunk)
        chunks.append(chunk)


async def communicate_bounded(
    process: asyncio.subprocess.Process,
    payload: bytes,
    *,
    timeout_seconds: float,
) -> tuple[bytes, bytes]:
    remaining = [MAX_BRIDGE_BYTES]
    stdout_task = asyncio.create_task(read_stream(process.stdout, remaining=remaining))
    stderr_task = asyncio.create_task(read_stream(process.stderr, remaining=remaining))

    async def communicate() -> tuple[bytes, bytes]:
        if process.stdin is None:
            raise RuntimeError("bridge stdin is unavailable")
        process.stdin.write(payload)
        await process.stdin.drain()
        process.stdin.close()
        await process.stdin.wait_closed()
        stdout, stderr, _ = await asyncio.gather(
            stdout_task,
            stderr_task,
            process.wait(),
        )
        return stdout, stderr

    try:
        return await asyncio.wait_for(communicate(), timeout=timeout_seconds)
    except BaseException:
        await terminate_bridge(process)
        for task in (stdout_task, stderr_task):
            task.cancel()
        await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)
        raise


class PiCompletions:
    def __init__(
        self,
        *,
        bridge_command: Sequence[str],
        provider: str,
        model: str,
        timeout_seconds: float,
    ) -> None:
        self._bridge_command = tuple(bridge_command)
        self._provider = provider
        self._model = model
        self._timeout_seconds = timeout_seconds

    async def create(self, **request: Any) -> Any:
        validate_openevals_request(request, self._model)
        request_id = os.urandom(16).hex()
        payload = json.dumps(
            {
                "schema": BRIDGE_SCHEMA,
                "request_id": request_id,
                "provider": self._provider,
                "model": self._model,
                "messages": request["messages"],
                "response_format": request["response_format"],
                "timeout_ms": max(1, int(self._timeout_seconds * 1000)),
            },
            ensure_ascii=True,
            separators=(",", ":"),
        ).encode("utf-8")
        if len(payload) > MAX_INPUT_BYTES:
            raise ValueError("bridge request is too large")

        process = await asyncio.create_subprocess_exec(
            *self._bridge_command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=16 * 1024,
        )
        stdout, _stderr = await communicate_bounded(
            process,
            payload,
            timeout_seconds=self._timeout_seconds,
        )
        if process.returncode != 0:
            raise RuntimeError("bridge failed")
        try:
            result = json.loads(stdout)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("bridge response is invalid") from error
        response = exact_record(result, {
            "schema", "request_id", "provider", "model", "stop_reason", "result",
        }, "BRIDGE_RESPONSE_INVALID")
        if (
            response["schema"] != BRIDGE_SCHEMA
            or response["request_id"] != request_id
            or response["provider"] != self._provider
            or response["model"] != self._model
            or response["stop_reason"] != "toolUse"
        ):
            raise ValueError("bridge identity is invalid")
        judgment = response["result"]
        if (
            not isinstance(judgment, dict)
            or set(judgment) != {"score", "reasoning"}
            or type(judgment["score"]) is not bool
            or not isinstance(judgment["reasoning"], str)
            or len(judgment["reasoning"]) > MAX_REASONING_CHARS
        ):
            raise ValueError("bridge judgment is invalid")

        content = json.dumps(judgment, ensure_ascii=True, separators=(",", ":"))
        message = SimpleNamespace(role="assistant", content=content)
        return SimpleNamespace(
            choices=[SimpleNamespace(index=0, finish_reason="stop", message=message)]
        )


class PiModelClient:
    def __init__(
        self,
        *,
        bridge_command: Sequence[str],
        provider: str,
        model: str,
        timeout_seconds: float,
    ) -> None:
        completions = PiCompletions(
            bridge_command=bridge_command,
            provider=provider,
            model=model,
            timeout_seconds=timeout_seconds,
        )
        self.chat = SimpleNamespace(completions=completions)


def default_judge_factory(**kwargs: Any) -> Judge:
    from agentevals.trajectory.llm import create_async_trajectory_llm_as_judge

    return create_async_trajectory_llm_as_judge(**kwargs)


async def evaluate(
    *,
    trajectory_path: Path,
    bridge_command: Sequence[str],
    provider: str,
    model: str,
    timeout_seconds: float,
    judge_factory: JudgeFactory | None = None,
) -> EvaluationResult:
    try:
        trajectory = load_trajectory(trajectory_path)
    except InputError as error:
        return error_result(str(error))
    except Exception:
        return error_result("TRAJECTORY_ERROR")
    if provider != "openai-codex" or model != EXPECTED_MODEL:
        return error_result("JUDGE_IDENTITY_INVALID")
    if not bridge_command or timeout_seconds <= 0 or timeout_seconds > 180:
        return error_result("JUDGE_CONFIGURATION_INVALID")

    client = PiModelClient(
        bridge_command=bridge_command,
        provider=provider,
        model=model,
        timeout_seconds=timeout_seconds,
    )
    try:
        factory = judge_factory or default_judge_factory
        judge = factory(
            prompt=judge_prompt(),
            model=model,
            judge=client,
            feedback_key=EXPECTED_JUDGE_KEY,
            continuous=False,
            use_reasoning=True,
        )
        pending = judge(outputs=trajectory)
        if not inspect.isawaitable(pending):
            return error_result("JUDGE_RESULT_INVALID")
        raw_result = await asyncio.wait_for(pending, timeout=timeout_seconds)
    except asyncio.TimeoutError:
        return error_result("JUDGE_TIMEOUT")
    except Exception:
        return error_result("JUDGE_EXCEPTION")

    if not isinstance(raw_result, Mapping):
        return error_result("JUDGE_RESULT_INVALID")
    if raw_result.get("key") != EXPECTED_JUDGE_KEY:
        return error_result("JUDGE_KEY_INVALID")
    score = raw_result.get("score")
    if type(score) is not bool:
        return error_result("JUDGE_SCORE_INVALID")
    status: Status = "PASS" if score else "VETO"
    return {
        "schema": SCHEMA,
        "status": status,
        "blocking": not score,
        "judge": {"key": EXPECTED_JUDGE_KEY, "score": score},
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the Pi atomic AgentEvals gate.")
    parser.add_argument("--trajectory", required=True, type=Path)
    parser.add_argument("--bridge", required=True, type=Path)
    parser.add_argument("--provider", default="openai-codex")
    parser.add_argument("--model", default=EXPECTED_MODEL)
    parser.add_argument("--timeout-seconds", default=180.0, type=float)
    return parser


async def async_main(arguments: list[str] | None = None) -> int:
    options = build_parser().parse_args(arguments)
    result = await evaluate(
        trajectory_path=options.trajectory,
        bridge_command=("node", "--import", "tsx", str(options.bridge)),
        provider=options.provider,
        model=options.model,
        timeout_seconds=options.timeout_seconds,
    )
    print(json.dumps(result, ensure_ascii=True, sort_keys=True, separators=(",", ":")))
    return {"PASS": 0, "VETO": 1, "ERROR": 2}[result["status"]]


def main(arguments: list[str] | None = None) -> int:
    return asyncio.run(async_main(arguments))


if __name__ == "__main__":
    raise SystemExit(main())
