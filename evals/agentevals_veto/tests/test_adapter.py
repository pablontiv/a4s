from __future__ import annotations

import asyncio
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from evals.agentevals_veto.adapter import (
    EXPECTED_JUDGE_KEY,
    evaluate,
    persist_result,
)


class Fixture:
    def __init__(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.structural = self.root / "structural.json"
        self.trajectory = self.root / "trajectory.json"
        self.criteria = self.root / "criteria.txt"
        self.structural.write_text('{"status":"PASS"}\n', encoding="utf-8")
        self.trajectory.write_text(
            json.dumps(
                {
                    "inputs": {"request": "check"},
                    "outputs": {"response": "done"},
                    "trajectory": [{"role": "assistant", "content": "done"}],
                }
            )
            + "\n",
            encoding="utf-8",
        )
        self.criteria.write_text("The response must satisfy the trusted rule.\n", encoding="utf-8")

    def close(self) -> None:
        self.temporary_directory.cleanup()

    @property
    def criteria_sha256(self) -> str:
        return hashlib.sha256(self.criteria.read_bytes()).hexdigest()

    async def evaluate(self, factory: Any, **overrides: Any) -> dict[str, Any]:
        options = {
            "structural_result_path": self.structural,
            "trajectory_path": self.trajectory,
            "criteria_path": self.criteria,
            "expected_criteria_sha256": self.criteria_sha256,
            "model": "fake:model",
            "timeout_seconds": 1.0,
            "judge_factory": factory,
        }
        options.update(overrides)
        return await evaluate(**options)


class FakeFactory:
    def __init__(self, result: Any = None, *, exception: Exception | None = None) -> None:
        self.result = result
        self.exception = exception
        self.factory_calls: list[dict[str, Any]] = []
        self.judge_calls: list[dict[str, Any]] = []

    def __call__(self, **kwargs: Any) -> Any:
        self.factory_calls.append(kwargs)

        async def judge(**payload: Any) -> Any:
            self.judge_calls.append(payload)
            if self.exception is not None:
                raise self.exception
            return self.result

        return judge


class AgentEvalsVetoTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.fixture = Fixture()

    def tearDown(self) -> None:
        self.fixture.close()

    async def test_true_score_passes_and_hashes_every_input(self) -> None:
        factory = FakeFactory(
            {"key": EXPECTED_JUDGE_KEY, "score": True, "comment": "accepted"}
        )

        result = await self.fixture.evaluate(factory)

        self.assertEqual(result["status"], "PASS")
        self.assertIs(result["blocking"], False)
        self.assertEqual(factory.factory_calls, [{
            "model": "fake:model",
            "criteria": "The response must satisfy the trusted rule.\n",
        }])
        self.assertEqual(len(factory.judge_calls), 1)
        self.assertEqual(
            result["input_hashes"],
            {
                "structural_result_sha256": hashlib.sha256(
                    self.fixture.structural.read_bytes()
                ).hexdigest(),
                "trajectory_sha256": hashlib.sha256(
                    self.fixture.trajectory.read_bytes()
                ).hexdigest(),
                "criteria_sha256": self.fixture.criteria_sha256,
            },
        )

    async def test_false_score_vetoes_and_sanitizes_comment(self) -> None:
        comment = " first\nsecond\x00\x1b[31m  " + ("x" * 1_100)
        factory = FakeFactory(
            {"key": EXPECTED_JUDGE_KEY, "score": False, "comment": comment}
        )

        result = await self.fixture.evaluate(factory)
        output = self.fixture.root / "result.json"
        persist_result(output, result)
        persisted = json.loads(output.read_text(encoding="utf-8"))

        self.assertEqual(persisted["status"], "VETO")
        self.assertIs(persisted["blocking"], True)
        sanitized = persisted["judge"]["comment"]
        self.assertNotIn("\n", sanitized)
        self.assertNotIn("\x00", sanitized)
        self.assertNotIn("\x1b", sanitized)
        self.assertEqual(len(sanitized), 1_000)
        self.assertTrue(sanitized.endswith("..."))

    async def test_structural_fail_blocks_without_creating_judge(self) -> None:
        self.fixture.structural.write_text('{"status":"FAIL"}\n', encoding="utf-8")
        factory = FakeFactory(
            {"key": EXPECTED_JUDGE_KEY, "score": True, "comment": "must not run"}
        )

        result = await self.fixture.evaluate(factory)

        self.assertEqual(result["status"], "ERROR")
        self.assertIs(result["blocking"], True)
        self.assertEqual(result["error"], "STRUCTURAL_NOT_PASS")
        self.assertEqual(factory.factory_calls, [])
        self.assertEqual(factory.judge_calls, [])

    async def test_untrusted_criteria_blocks_without_creating_judge(self) -> None:
        factory = FakeFactory(
            {"key": EXPECTED_JUDGE_KEY, "score": True, "comment": "must not run"}
        )

        result = await self.fixture.evaluate(
            factory,
            expected_criteria_sha256="0" * 64,
        )

        self.assertEqual(result["status"], "ERROR")
        self.assertEqual(result["error"], "CRITERIA_DIGEST_MISMATCH")
        self.assertIs(result["blocking"], True)
        self.assertEqual(
            result["input_hashes"]["criteria_sha256"],
            self.fixture.criteria_sha256,
        )
        self.assertEqual(factory.factory_calls, [])

    async def test_timeout_is_a_blocking_error(self) -> None:
        calls = 0

        def factory(**kwargs: Any) -> Any:
            nonlocal calls
            calls += 1

            async def judge(**payload: Any) -> Any:
                await asyncio.sleep(10)
                return {"key": EXPECTED_JUDGE_KEY, "score": True, "comment": "late"}

            return judge

        result = await self.fixture.evaluate(factory, timeout_seconds=0.01)

        self.assertEqual(calls, 1)
        self.assertEqual(result["status"], "ERROR")
        self.assertEqual(result["error"], "JUDGE_TIMEOUT")
        self.assertIs(result["blocking"], True)

    async def test_judge_exception_is_a_blocking_error(self) -> None:
        result = await self.fixture.evaluate(
            FakeFactory(exception=RuntimeError("secret detail must not persist"))
        )

        self.assertEqual(result["status"], "ERROR")
        self.assertEqual(result["error"], "JUDGE_EXCEPTION")
        self.assertIs(result["blocking"], True)
        self.assertNotIn("secret", json.dumps(result))

    async def test_wrong_key_is_a_blocking_error(self) -> None:
        result = await self.fixture.evaluate(
            FakeFactory({"key": "other", "score": True, "comment": "ignored"})
        )

        self.assertEqual(result["status"], "ERROR")
        self.assertEqual(result["error"], "JUDGE_KEY_INVALID")
        self.assertIs(result["blocking"], True)

    async def test_non_boolean_scores_are_blocking_errors(self) -> None:
        for score in (1, 0, "true", None, 0.5):
            with self.subTest(score=score):
                result = await self.fixture.evaluate(
                    FakeFactory(
                        {"key": EXPECTED_JUDGE_KEY, "score": score, "comment": "ignored"}
                    )
                )
                self.assertEqual(result["status"], "ERROR")
                self.assertEqual(result["error"], "JUDGE_SCORE_INVALID")
                self.assertIs(result["blocking"], True)

    async def test_non_awaitable_judge_result_is_a_blocking_error(self) -> None:
        def factory(**kwargs: Any) -> Any:
            def judge(**payload: Any) -> Any:
                return {"key": EXPECTED_JUDGE_KEY, "score": True, "comment": "sync"}

            return judge

        result = await self.fixture.evaluate(factory)

        self.assertEqual(result["status"], "ERROR")
        self.assertEqual(result["error"], "JUDGE_RESULT_INVALID")
        self.assertIs(result["blocking"], True)


if __name__ == "__main__":
    unittest.main()
