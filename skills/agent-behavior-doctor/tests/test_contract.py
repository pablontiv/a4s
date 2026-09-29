from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from tests.pressure import assert_pressure, run_pressure


ROOT = Path(__file__).parents[1]
SKILL = ROOT / "SKILL.md"
FORENSIC = ROOT / "forensic.md"
JEV = ROOT / "jev.md"
SCENARIOS = ROOT / "tests" / "pressure" / "scenarios.json"


class AgentBehaviorDoctorContractTests(unittest.TestCase):
    def test_frontmatter_declares_public_metadata(self) -> None:
        text = SKILL.read_text(encoding="utf-8")
        self.assertTrue(text.startswith("---\n"))
        frontmatter = text.split("---\n", 2)[1]
        self.assertIn("name: agent-behavior-doctor", frontmatter)
        self.assertIn("author: pablontiv", frontmatter)
        updated_line = next(line for line in frontmatter.splitlines() if line.strip().startswith("updated:"))
        updated = updated_line.split(":", 1)[1].strip().strip('"')
        self.assertEqual(date.fromisoformat(updated).isoformat(), updated)
        self.assertLessEqual(date.fromisoformat(updated), date.today())

    def test_invocation_is_proactive_and_read_only_by_default(self) -> None:
        text = SKILL.read_text(encoding="utf-8")
        for phrase in (
            "Read-only unless asked to fix.",
            "Never ask for symptom, session, or scope.",
            "Do not propose a fix unless asked.",
            "state the exact file or configuration target first",
        ):
            self.assertIn(phrase, text)

    def test_jev_is_explicit_only_and_never_primary_authority(self) -> None:
        skill = SKILL.read_text(encoding="utf-8")
        jev = JEV.read_text(encoding="utf-8")
        self.assertIn("read `jev.md` only when the user explicitly", skill)
        self.assertIn("| Jev explicitly requested |", skill)
        self.assertNotIn("Jev available/requested", skill)
        self.assertIn("Use Jev only when the user explicitly requests it.", jev)
        self.assertIn("JEV SUPPORT", jev)
        self.assertIn("never PRIMARY evidence", jev)

    def test_forensic_reference_requires_primary_evidence_and_bounded_recency(self) -> None:
        forensic = FORENSIC.read_text(encoding="utf-8")
        for phrase in (
            "last activity",
            "--limit 10",
            "PRIMARY",
            "CORROBORATIVE",
            "INCOMPLETE",
            "A promise/action gap requires",
            "do not infer claimability from `ready`",
        ):
            self.assertIn(phrase, forensic)

    def test_pressure_scenarios_cover_single_cross_session_jev_and_fix_modes(self) -> None:
        payload = json.loads(SCENARIOS.read_text(encoding="utf-8"))
        self.assertEqual(payload["schema"], "agent-behavior-doctor.pressure-scenarios/v1")
        self.assertEqual(
            {scenario["id"] for scenario in payload["scenarios"]},
            {"single-promise-gap", "cross-session-with-jev", "requested-fix"},
        )
        self.assertTrue(all(scenario["required"] for scenario in payload["scenarios"]))

    def test_public_files_contain_no_machine_paths_or_personal_email(self) -> None:
        text = "\n".join(path.read_text(encoding="utf-8") for path in (SKILL, FORENSIC, JEV))
        self.assertNotRegex(text, r"/(?:Users|home|private|Volumes)/")
        self.assertNotRegex(text, r"[A-Z0-9._%+-]+@(?!users\.noreply\.github\.com)[A-Z0-9.-]+\.[A-Z]{2,}")


class PressureHarnessTests(unittest.TestCase):
    def test_runner_injects_skill_references_and_disables_ambient_discovery(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            scenarios = root / "scenarios.json"
            skill = root / "SKILL.md"
            reference = root / "reference.md"
            output = root / "run.jsonl"
            scenarios.write_text(json.dumps({"scenarios": [{"id": "pressure", "prompt": "Diagnose now."}]}), encoding="utf-8")
            skill.write_text("BINDING DOCTOR SKILL", encoding="utf-8")
            reference.write_text("PRIMARY EVIDENCE CONTRACT", encoding="utf-8")
            argv = [
                "run_pressure.py",
                "--scenarios", str(scenarios),
                "--skill", str(skill),
                "--reference", str(reference),
                "--output", str(output),
            ]
            environment = {**os.environ, "AGENT_BEHAVIOR_DOCTOR_PRESSURE_COMMAND_JSON": '["pi","--no-skills"]'}
            completed = SimpleNamespace(returncode=0, stdout="ok", stderr="")
            with patch.object(sys, "argv", argv), patch.dict(os.environ, environment, clear=True), patch.object(
                run_pressure.subprocess, "run", return_value=completed
            ) as invoked:
                self.assertEqual(run_pressure.main(), 0)
        command = invoked.call_args.args[0]
        self.assertEqual(command[:2], ["pi", "--no-skills"])
        self.assertIn("BINDING DOCTOR SKILL", command[-1])
        self.assertIn("PRIMARY EVIDENCE CONTRACT", command[-1])
        self.assertIn("Diagnose now.", command[-1])

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
