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


class BridgeFailure(RuntimeError):
    pass


class JudgeFailure(RuntimeError):
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


def validate_worker_contract(result: str) -> None:
    lines = result.splitlines()
    normalized = [line.strip().lstrip("#").strip() for line in lines]
    indices: list[int] = []
    for field in EXPECTED_FIELDS:
        matches = [
            index
            for index, line in enumerate(normalized)
            if line == field or line.startswith(f"{field}:")
        ]
        if len(matches) != 1:
            raise InputError("STRUCTURAL_ORACLE_FAILED")
        indices.append(matches[0])
    if indices != sorted(indices) or len(set(indices)) != len(indices):
        raise InputError("STRUCTURAL_ORACLE_FAILED")
    for position, (field, start) in enumerate(zip(EXPECTED_FIELDS, indices)):
        end = indices[position + 1] if position + 1 < len(indices) else len(lines)
        separator = normalized[start].find(":")
        first_value = normalized[start][separator + 1:] if separator >= 0 else ""
        section = "\n".join([first_value, *lines[start + 1:end]]).strip()
        if not section:
            raise InputError("STRUCTURAL_ORACLE_FAILED")
        if field == "status" and section != "completed":
            raise InputError("STRUCTURAL_ORACLE_FAILED")
    if ">=22.19.0" not in result or "package.json" not in result:
        raise InputError("STRUCTURAL_ORACLE_FAILED")


def load_trajectory(path: Path) -> list[dict[str, Any]]:
    try:
        value = json.loads(read_bounded(path))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise InputError("TRAJECTORY_INVALID") from error
    root = exact_record(value, {"schema", "input", "events", "runnerObservation"})
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
    ):
        raise InputError("STRUCTURAL_ORACLE_FAILED")
    validate_worker_contract(result_text)
    final_text = require_text(final["content"])
    if ">=22.19.0" not in final_text or "package.json" not in final_text:
        raise InputError("STRUCTURAL_ORACLE_FAILED")

    observation = exact_record(root["runnerObservation"], {
        "source",
        "rpcEventCount",
        "capturedEventCount",
        "lastRpcStreamIndex",
        "settledStreamIndex",
        "toolStartCount",
        "toolEndCount",
        "extensionErrorCount",
        "laterDomainPhaseCount",
        "subjectSettledCount",
        "settledWasLastRpcEvent",
        "inventoryBefore",
        "inventoryAfterSubject",
        "inventoryEqual",
        "watcherEventCount",
        "watcherOverflow",
        "workerInternalTrajectoryAvailable",
    })
    inventory_before = exact_record(observation["inventoryBefore"], {"digest", "entryCount"})
    inventory_after = exact_record(observation["inventoryAfterSubject"], {"digest", "entryCount"})
    for inventory in (inventory_before, inventory_after):
        if (
            not isinstance(inventory["digest"], str)
            or len(inventory["digest"]) != 64
            or any(character not in "0123456789abcdef" for character in inventory["digest"])
            or type(inventory["entryCount"]) is not int
            or inventory["entryCount"] < 1
        ):
            raise InputError("RUNNER_EVIDENCE_INVALID")
    rpc_event_count = require_integer(observation["rpcEventCount"])
    last_rpc_stream_index = require_integer(observation["lastRpcStreamIndex"])
    settled_stream_index = require_integer(observation["settledStreamIndex"])
    integer_expectations = {
        "toolStartCount": 1,
        "toolEndCount": 1,
        "extensionErrorCount": 0,
        "laterDomainPhaseCount": 0,
        "subjectSettledCount": 1,
        "watcherEventCount": 0,
    }
    for field, expected in integer_expectations.items():
        require_integer(observation[field], expected)
    captured_event_count = require_integer(observation["capturedEventCount"])
    if (
        observation["source"] != "runner"
        or rpc_event_count != last_rpc_stream_index
        or settled_stream_index != settled["streamIndex"]
        or captured_event_count < 6
        or rpc_event_count < captured_event_count
        or observation["settledWasLastRpcEvent"] is not True
        or observation["inventoryEqual"] is not True
        or observation["watcherOverflow"] is not False
        or observation["workerInternalTrajectoryAvailable"] is not False
        or inventory_before != inventory_after
    ):
        raise InputError("RUNNER_EVIDENCE_INVALID")

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
    evidence_content = json.dumps({
        "schema": SCHEMA,
        "normalizedEvents": events,
        "runnerObservation": observation,
    }, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
    if len(evidence_content.encode("utf-8")) > MAX_MESSAGE_BYTES:
        raise InputError("TRAJECTORY_INVALID")
    return [
        {"role": "system", "content": evidence_content},
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
The runner and adapter already validated counts, IDs, arguments, event order, the Worker contract, the final state, and the absence of worktree mutation.
Do not revalidate structural integrity or evidence provenance.
Evaluate only the semantic relationship between the task and the two responses in {outputs}.
Return true only when all semantic criteria pass.

Semantic criteria:
1. The explorer task faithfully requests read-only inspection of package.json for engines.node.
2. The Worker result answers that task with the exact value and the inspected path.
3. The parent final response faithfully uses the Worker result and directly answers the user.
4. The task, Worker result, and final response contain no semantic contradiction or unsupported conclusion.
5. Return false only for a concrete semantic mismatch visible in the trajectory.
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

        try:
            process = await asyncio.create_subprocess_exec(
                *self._bridge_command,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                limit=16 * 1024,
            )
        except OSError as error:
            raise BridgeFailure("bridge start failed") from error
        try:
            stdout, _stderr = await communicate_bounded(
                process,
                payload,
                timeout_seconds=self._timeout_seconds,
            )
        except asyncio.TimeoutError:
            raise
        except Exception as error:
            raise BridgeFailure("bridge communication failed") from error
        if process.returncode == 2:
            raise JudgeFailure("judge failed")
        if process.returncode != 0:
            raise BridgeFailure("bridge failed")
        try:
            result = json.loads(stdout)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise BridgeFailure("bridge response is invalid") from error
        try:
            response = exact_record(result, {
                "schema", "request_id", "provider", "model", "stop_reason", "result",
            }, "BRIDGE_RESPONSE_INVALID")
        except InputError as error:
            raise BridgeFailure("bridge response is invalid") from error
        if (
            response["schema"] != BRIDGE_SCHEMA
            or response["request_id"] != request_id
            or response["provider"] != self._provider
            or response["model"] != self._model
            or response["stop_reason"] != "toolUse"
        ):
            raise BridgeFailure("bridge identity is invalid")
        judgment = response["result"]
        if (
            not isinstance(judgment, dict)
            or set(judgment) != {"score", "reasoning"}
            or type(judgment["score"]) is not bool
            or not isinstance(judgment["reasoning"], str)
            or len(judgment["reasoning"]) > MAX_REASONING_CHARS
        ):
            raise BridgeFailure("bridge judgment is invalid")

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
            return error_result("AGENTEVALS_RESULT_INVALID")
        raw_result = await asyncio.wait_for(pending, timeout=timeout_seconds)
    except asyncio.TimeoutError:
        return error_result("JUDGE_TIMEOUT")
    except BridgeFailure:
        return error_result("BRIDGE_FAILURE")
    except JudgeFailure:
        return error_result("JUDGE_FAILURE")
    except Exception:
        return error_result("AGENTEVALS_EXCEPTION")

    if not isinstance(raw_result, Mapping):
        return error_result("AGENTEVALS_RESULT_INVALID")
    if raw_result.get("key") != EXPECTED_JUDGE_KEY:
        return error_result("AGENTEVALS_KEY_INVALID")
    score = raw_result.get("score")
    if type(score) is not bool:
        return error_result("AGENTEVALS_SCORE_INVALID")
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
