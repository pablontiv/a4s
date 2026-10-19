import hashlib
import json
import unittest
from pathlib import Path



ROOT = Path(__file__).parents[1]
LICENSE = ROOT / "LICENSE"
SCENARIOS = ROOT / "tests" / "pressure" / "scenarios.json"


class SkillContractTests(unittest.TestCase):





    def test_pressure_schema_covers_all_required_boundaries(self):
        payload = json.loads(SCENARIOS.read_text(encoding="utf-8"))
        self.assertEqual(payload["schema"], "systemic-issue-triage.pressure-scenarios/v1")
        self.assertEqual(len(payload["scenarios"]), 7)
        required = {item for scenario in payload["scenarios"] for item in scenario["required"]}
        self.assertTrue(
            {
                "one-root-cluster",
                "mechanism-is-hypothesis",
                "brainstorming-handoff",
                "no-implementation",
                "cwd-git-root",
                "sole-repository-scope",
                "fail-closed-outside-git",
                "automatic-open-issue-inventory",
                "infer-tracker-from-origin",
                "no-request-for-identifiers",
                "complete-triage-output",
            }
            <= required
        )

    def test_apache_license_is_canonical(self):
        content = LICENSE.read_bytes()
        self.assertIn(b"Apache License", content)
        self.assertIn(b"Version 2.0, January 2004", content)
        self.assertEqual(hashlib.sha256(content).hexdigest(), "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30")
