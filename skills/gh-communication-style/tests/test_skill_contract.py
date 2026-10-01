from __future__ import annotations

import re
import unittest
from datetime import date
from pathlib import Path

import yaml


SKILL_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
SKILL_PATH = SKILL_ROOT / "SKILL.md"
CONFIG_PATH = REPOSITORY_ROOT / ".workspace" / "config.yaml"


def section(text: str, heading: str, next_heading: str) -> str:
    return text.split(heading, 1)[1].split(next_heading, 1)[0]


class GitHubCommunicationStyleContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.skill = SKILL_PATH.read_text(encoding="utf-8")
        cls.config = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))
        cls.communication = cls.config["workspace"]["do_work"]["communication"]

    def test_metadata_records_behavior_change(self) -> None:
        self.assertRegex(self.skill, r'(?m)^\s*author: "pablontiv"$')
        match = re.search(r'(?m)^\s*updated: "(\d{4}-\d{2}-\d{2})"$', self.skill)
        self.assertIsNotNone(match)
        assert match is not None
        updated = date.fromisoformat(match.group(1))
        self.assertEqual(updated.isoformat(), "2026-09-30")

    def test_publication_authority_is_explicitly_derived_from_config(self) -> None:
        authority = section(self.skill, "## Publication Authority", "## Style and Evidence Rules")
        for phrase in (
            "applicable integrated `.workspace/config.yaml`",
            "only authority",
            "this skill adds no gate and grants no authorization",
            "this skill cannot infer, cache, or expand publication authority",
        ):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, authority)

    def test_standing_instruction_never_replaces_config_gate(self) -> None:
        authority = section(self.skill, "## Publication Authority", "## Style and Evidence Rules")
        execution = section(self.skill, "## Execution Steps", "## Output Contract")
        self.assertIn("Never treat a standing instruction as authorization beyond what config permits", authority)
        self.assertIn("A standing instruction never replaces an approval required by config", execution)
        self.assertNotIn("standing instruction pre-authorizes", self.skill)

    def test_current_issue_and_comment_gate_matches_config(self) -> None:
        for phrase in (
            "approval before publishing a new issue or a substantive comment",
            "changes commitments, scope, authority",
            "Routine factual status, evidence, and closure updates",
            "without a separate approval",
        ):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, self.communication)

        authority = section(self.skill, "## Publication Authority", "## Style and Evidence Rules")
        execution = section(self.skill, "## Execution Steps", "## Output Contract")
        for content in (authority, execution):
            self.assertIn("complete exact", content)
            self.assertIn("substantive issue/PR comment", content)
            self.assertIn("explicit approval", content)
            self.assertIn("Routine factual status, evidence, and closure updates", content)

    def test_current_pull_request_exception_adds_no_gate(self) -> None:
        self.assertIn("Pull requests and their descriptions need no prior approval", self.communication)

        authority = section(self.skill, "## Publication Authority", "## Style and Evidence Rules")
        execution = section(self.skill, "## Execution Steps", "## Output Contract")
        self.assertIn("including their titles and descriptions, need no prior approval", authority)
        self.assertIn("Do not add a presentation or approval gate to them", authority)
        self.assertIn("do not add that gate for a pull request, its title, or its description", execution.lower())

    def test_writing_and_evidence_technique_is_preserved(self) -> None:
        for phrase in (
            "GitHub artifacts default to English",
            "Read the TARGET repo's real `.github/ISSUE_TEMPLATE/*`",
            "Every claim verified before posting",
            "Honest checklists",
            "A defect report names the SYMPTOM",
            "Search existing issues/PRs for duplicates and related work",
            "Measure blast radius",
            "verify linkage",
        ):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, self.skill)


if __name__ == "__main__":
    unittest.main()
