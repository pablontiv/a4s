from __future__ import annotations

import argparse
import asyncio
import hashlib
import inspect
import json
import os
import re
import tempfile
import unicodedata
from collections.abc import Awaitable, Callable, Mapping
from pathlib import Path
from typing import Any, Literal, TypedDict

SCHEMA = "a4s.agentevals-veto/v1"
EXPECTED_JUDGE_KEY = "trajectory_accuracy"
MAX_COMMENT_CHARS = 1_000
MAX_INPUT_BYTES = 10 * 1024 * 1024

Status = Literal["PASS", "VETO", "ERROR"]
Judge = Callable[..., Awaitable[Mapping[str, Any]] | Mapping[str, Any]]
JudgeFactory = Callable[..., Judge]


class VetoResult(TypedDict, total=False):
    schema: str
    status: Status
    blocking: bool
    input_hashes: dict[str, str]
    judge: dict[str, Any]
    error: str


class AdapterInputError(ValueError):
    def __init__(self, code: str, input_hashes: dict[str, str] | None = None) -> None:
        super().__init__(code)
        self.input_hashes = input_hashes


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sanitize_comment(value: str) -> str:
    """Return a bounded single-line comment without terminal control characters."""
    normalized = unicodedata.normalize("NFKC", value)
    printable = "".join(
        " " if unicodedata.category(character).startswith("C") else character
        for character in normalized
    )
    single_line = re.sub(r"\s+", " ", printable).strip()
    if len(single_line) <= MAX_COMMENT_CHARS:
        return single_line
    return single_line[: MAX_COMMENT_CHARS - 3].rstrip() + "..."


def _error(code: str, input_hashes: dict[str, str] | None = None) -> VetoResult:
    result: VetoResult = {
        "schema": SCHEMA,
        "status": "ERROR",
        "blocking": True,
        "error": code,
    }
    if input_hashes is not None:
        result["input_hashes"] = input_hashes
    return result


def _read_bounded(path: Path) -> bytes:
    try:
        size = path.stat().st_size
    except OSError as error:
        raise AdapterInputError("INPUT_UNREADABLE") from error
    if size > MAX_INPUT_BYTES:
        raise AdapterInputError("INPUT_TOO_LARGE")
    try:
        value = path.read_bytes()
    except OSError as error:
        raise AdapterInputError("INPUT_UNREADABLE") from error
    if len(value) > MAX_INPUT_BYTES:
        raise AdapterInputError("INPUT_TOO_LARGE")
    return value


def _load_json_object(value: bytes, error_code: str) -> dict[str, Any]:
    try:
        parsed = json.loads(value)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AdapterInputError(error_code) from error
    if not isinstance(parsed, dict):
        raise AdapterInputError(error_code)
    return parsed


def _load_inputs(
    structural_result_path: Path,
    trajectory_path: Path,
    criteria_path: Path,
    expected_criteria_sha256: str,
) -> tuple[dict[str, Any], str, dict[str, str], bool]:
    structural_bytes = _read_bounded(structural_result_path)
    trajectory_bytes = _read_bounded(trajectory_path)
    criteria_bytes = _read_bounded(criteria_path)
    input_hashes = {
        "structural_result_sha256": sha256_bytes(structural_bytes),
        "trajectory_sha256": sha256_bytes(trajectory_bytes),
        "criteria_sha256": sha256_bytes(criteria_bytes),
    }

    try:
        if not re.fullmatch(r"[0-9a-f]{64}", expected_criteria_sha256):
            raise AdapterInputError("CRITERIA_DIGEST_INVALID")
        if input_hashes["criteria_sha256"] != expected_criteria_sha256:
            raise AdapterInputError("CRITERIA_DIGEST_MISMATCH")

        structural_result = _load_json_object(structural_bytes, "STRUCTURAL_RESULT_INVALID")
        structural_passed = structural_result.get("status") == "PASS"

        payload = _load_json_object(trajectory_bytes, "TRAJECTORY_INVALID")
        if not isinstance(payload.get("trajectory"), list):
            raise AdapterInputError("TRAJECTORY_INVALID")
        if not isinstance(payload.get("outputs"), dict):
            raise AdapterInputError("TRAJECTORY_INVALID")
        if "inputs" in payload and not isinstance(payload["inputs"], dict):
            raise AdapterInputError("TRAJECTORY_INVALID")
        extra_keys = set(payload) - {"inputs", "outputs", "trajectory"}
        if extra_keys:
            raise AdapterInputError("TRAJECTORY_INVALID")

        try:
            criteria = criteria_bytes.decode("utf-8")
        except UnicodeDecodeError as error:
            raise AdapterInputError("CRITERIA_INVALID") from error
        if not criteria.strip():
            raise AdapterInputError("CRITERIA_INVALID")
    except AdapterInputError as error:
        error.input_hashes = input_hashes
        raise

    return payload, criteria, input_hashes, structural_passed


def _default_judge_factory(**kwargs: Any) -> Judge:
    from agentevals.trajectory.llm import create_trajectory_llm_as_judge

    return create_trajectory_llm_as_judge(**kwargs)


async def evaluate(
    *,
    structural_result_path: Path,
    trajectory_path: Path,
    criteria_path: Path,
    expected_criteria_sha256: str,
    model: str,
    timeout_seconds: float,
    judge_factory: JudgeFactory | None = None,
) -> VetoResult:
    input_hashes: dict[str, str] | None = None
    try:
        payload, criteria, input_hashes, structural_passed = _load_inputs(
            structural_result_path,
            trajectory_path,
            criteria_path,
            expected_criteria_sha256,
        )
    except AdapterInputError as error:
        return _error(str(error), error.input_hashes)
    except Exception:
        return _error("INPUT_ERROR", input_hashes)

    if not structural_passed:
        return _error("STRUCTURAL_NOT_PASS", input_hashes)
    if not model.strip():
        return _error("MODEL_INVALID", input_hashes)
    if timeout_seconds <= 0:
        return _error("TIMEOUT_INVALID", input_hashes)

    factory = judge_factory or _default_judge_factory
    try:
        judge = factory(model=model, criteria=criteria)
        pending = judge(**payload)
        if not inspect.isawaitable(pending):
            return _error("JUDGE_RESULT_INVALID", input_hashes)
        raw_result = await asyncio.wait_for(pending, timeout=timeout_seconds)
    except asyncio.TimeoutError:
        return _error("JUDGE_TIMEOUT", input_hashes)
    except Exception:
        return _error("JUDGE_EXCEPTION", input_hashes)

    if not isinstance(raw_result, Mapping):
        return _error("JUDGE_RESULT_INVALID", input_hashes)
    if raw_result.get("key") != EXPECTED_JUDGE_KEY:
        return _error("JUDGE_KEY_INVALID", input_hashes)
    score = raw_result.get("score")
    if type(score) is not bool:
        return _error("JUDGE_SCORE_INVALID", input_hashes)
    comment = raw_result.get("comment", "")
    if not isinstance(comment, str):
        return _error("JUDGE_COMMENT_INVALID", input_hashes)

    status: Status = "PASS" if score else "VETO"
    return {
        "schema": SCHEMA,
        "status": status,
        "blocking": not score,
        "input_hashes": input_hashes,
        "judge": {
            "key": EXPECTED_JUDGE_KEY,
            "score": score,
            "comment": sanitize_comment(comment),
        },
    }


def persist_result(path: Path, result: VetoResult) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(result, ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n"
    file_descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(file_descriptor, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(serialized)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_name, path)
    except Exception:
        try:
            os.unlink(temporary_name)
        except OSError:
            pass
        raise


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run AgentEvals as a fail-closed semantic veto.")
    parser.add_argument("--structural-result", type=Path, required=True)
    parser.add_argument("--trajectory", type=Path, required=True)
    parser.add_argument("--criteria", type=Path, required=True)
    parser.add_argument("--criteria-sha256", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--timeout-seconds", type=float, default=60.0)
    parser.add_argument("--output", type=Path, required=True)
    return parser


async def _async_main(arguments: list[str] | None = None) -> int:
    options = build_parser().parse_args(arguments)
    result = await evaluate(
        structural_result_path=options.structural_result,
        trajectory_path=options.trajectory,
        criteria_path=options.criteria,
        expected_criteria_sha256=options.criteria_sha256,
        model=options.model,
        timeout_seconds=options.timeout_seconds,
    )
    try:
        persist_result(options.output, result)
    except Exception:
        result = _error("OUTPUT_WRITE_FAILED", result.get("input_hashes"))
        print(json.dumps(result, ensure_ascii=True, sort_keys=True, separators=(",", ":")))
        return 2
    print(json.dumps(result, ensure_ascii=True, sort_keys=True, separators=(",", ":")))
    return {"PASS": 0, "VETO": 1, "ERROR": 2}[result["status"]]


def main(arguments: list[str] | None = None) -> int:
    return asyncio.run(_async_main(arguments))


if __name__ == "__main__":
    raise SystemExit(main())
