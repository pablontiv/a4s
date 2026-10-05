from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path



from tests.pressure import assert_pressure


ROOT = Path(__file__).parents[1]
SCENARIOS = ROOT / "tests" / "pressure" / "scenarios.json"




class PressureHarnessTests(unittest.TestCase):

    def test_assertion_runner_accepts_contract_and_rejects_missing_markers(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            scenarios = root / "scenarios.json"
            output = root / "run.jsonl"
            scenarios.write_text(json.dumps({
                "scenarios": [{
                    "id": "pressure",
                    "prompt": "diagnose",
                    "required": ["Verdict:", "PRIMARY"],
                    "forbidden": ["ask the user"],
                }]
            }), encoding="utf-8")
            output.write_text(json.dumps({
                "scenario": "pressure",
                "returncode": 0,
                "stdout": "Verdict: established\nVerified factors: PRIMARY transcript",
                "stderr": "",
            }) + "\n", encoding="utf-8")
            self.assertEqual(assert_pressure.validate(scenarios, output), [])
            output.write_text(json.dumps({
                "scenario": "pressure",
                "returncode": 0,
                "stdout": "Verdict: ask the user",
                "stderr": "",
            }) + "\n", encoding="utf-8")
            failures = assert_pressure.validate(scenarios, output)
            self.assertTrue(any("missing required marker" in failure for failure in failures))
            self.assertTrue(any("forbidden marker" in failure for failure in failures))


if __name__ == "__main__":
    unittest.main()
