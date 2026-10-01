from __future__ import annotations

import re
import unittest
from datetime import date
from pathlib import Path


ROOT = Path(__file__).parents[1]
SKILL = ROOT / "SKILL.md"
METHOD = ROOT / "references" / "method.md"
FIXTURES = ROOT / "tests" / "fixtures"


def discover_fixture_records(repository: Path) -> tuple[Path, list[Path]]:
    """Apply the documented root selection to a disposable fixture."""
    config = repository / ".workspace" / "config.yaml"
    if config.exists():
        match = re.search(r"(?<![\w/])(\.[\w./-]+/docs/)", config.read_text(encoding="utf-8"))
        if match is None:
            raise AssertionError("adopted fixture does not declare a documentation root")
        root = repository / match.group(1)
    else:
        root = repository / "docs"
    records = sorted(path.relative_to(repository) for path in root.rglob("*.md"))
    return root.relative_to(repository), records


class DocsNorthstarContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.skill = SKILL.read_text(encoding="utf-8")
        cls.method = METHOD.read_text(encoding="utf-8")
        cls.bundle = f"{cls.skill}\n{cls.method}"

    def test_public_metadata_and_method_link_remain_valid(self) -> None:
        self.assertIn("name: docs-northstar", self.skill)
        self.assertIn('author: "pablontiv"', self.skill)
        updated = re.search(r'(?m)^  updated: "([0-9]{4}-[0-9]{2}-[0-9]{2})"$', self.skill)
        self.assertIsNotNone(updated)
        self.assertEqual(date.fromisoformat(updated.group(1)).isoformat(), updated.group(1))
        self.assertIn("`references/method.md`", self.skill)

    def test_adopted_fixture_discovers_workspace_records_without_docs(self) -> None:
        repository = FIXTURES / "adopted"
        self.assertTrue((repository / ".workspace" / "config.yaml").is_file())
        self.assertFalse((repository / "docs").exists())
        root, records = discover_fixture_records(repository)
        self.assertEqual(Path(".workspace/docs"), root)
        self.assertEqual(
            [
                Path(".workspace/docs/adr/0001-product-direction.md"),
                Path(".workspace/docs/specs/north-star.md"),
            ],
            records,
        )

    def test_non_adopted_fixture_preserves_docs_fallback(self) -> None:
        repository = FIXTURES / "legacy-docs"
        self.assertFalse((repository / ".workspace" / "config.yaml").exists())
        root, records = discover_fixture_records(repository)
        self.assertEqual(Path("docs"), root)
        self.assertEqual(
            [
                Path("docs/adr/0001-product-direction.md"),
                Path("docs/specs/north-star.md"),
            ],
            records,
        )

    def test_skill_and_method_define_authority_aware_root_selection(self) -> None:
        for text in (self.skill, self.method):
            self.assertIn("`.workspace/config.yaml`", text)
            self.assertIn("`.workspace/docs/**`", text)
            self.assertIn("`docs/**`", text)
            self.assertRegex(text, r"(?is)config.*(?:absent|ausente).*docs/\*\*")
        self.assertIn("read it before excavation", self.skill)
        self.assertIn("Do not infer roots or policy from records", self.method)

    def test_records_are_provenance_until_owner_confirmation(self) -> None:
        for text in (self.skill, self.method):
            self.assertRegex(text, r"(?is)evidence/provenance.*confirm.*owner")
            self.assertRegex(text, r"(?is)record.*(?:not authority|never as current authority)")
        self.assertIn("do not let the record stand in for confirmation", self.skill)
        self.assertNotIn("It is the SOURCE", self.bundle)
        self.assertNotIn("It is the source", self.bundle)

    def test_supersession_is_append_only(self) -> None:
        for text in (self.skill, self.method):
            self.assertRegex(text, r"(?is)new record.*(?:declares|names).*supersed")
            self.assertRegex(text, r"(?is)(?:existing|older|old|historical).*record.*(?:unchanged|never edited)")
        self.assertNotIn("gets marked superseded", self.bundle)
        self.assertNotIn("mark the spec superseded", self.bundle)

    def test_skill_adds_no_unconditional_delivery_gate(self) -> None:
        lowered = self.bundle.lower()
        for forbidden in ("pre-push", "same-push", "docs-sync"):
            self.assertNotIn(forbidden, lowered)
        self.assertIn("this method does not add synchronization hooks or delivery gates", lowered)

    def test_narrative_and_evidence_tracks_remain_separate(self) -> None:
        self.assertIn("Evidence track", self.skill)
        self.assertIn("Narrative track", self.skill)
        self.assertIn("evidence gathering is owner-independent", self.skill)
        self.assertIn("No file edited, no commit, no push", self.skill)


if __name__ == "__main__":
    unittest.main()
