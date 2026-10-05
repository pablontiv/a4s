from __future__ import annotations

import re
import subprocess
import unittest
from datetime import date
from pathlib import Path
from urllib.parse import unquote, urlsplit

import yaml

ROOT = Path(__file__).resolve().parents[1]
README_PATH = ROOT / "README.md"
AGENTS_PATH = ROOT / "AGENTS.md"
WORKFLOW_PATH = ROOT / ".github" / "workflows" / "ci.yml"
DEPENDABOT_PATH = ROOT / ".github" / "dependabot.yml"
TEST_REQUIREMENTS_PATH = ROOT / "requirements-test.txt"
WORKSPACE_CONFIG_PATH = ROOT / ".workspace" / "config.yaml"
GLOBAL_STEERING_PATH = ROOT / "output-styles" / "mentor-telemetria.assets" / "append-system.md"
ROADMAP_SKILL_PATH = ROOT / "skills" / "roadmap-legacy" / "SKILL.md"
ROADMAP_TREE_PATH = ROOT / "skills" / "roadmap-legacy" / "references" / "tree.md"
ROADMAP_PLAN_PATH = ROOT / "skills" / "roadmap-legacy" / "references" / "plan.md"
ROADMAP_DOCTOR_PATH = ROOT / "skills" / "roadmap-legacy" / "references" / "doctor.md"
LINK_PATTERN = re.compile(r"(?<!!)\[[^]]+\]\(([^)]+)\)")
BACKLOG_DECISIONS_POLICY = (
    "When presenting an existing Bead to the operator, the executor shows its human Description, Bead ID, "
    "observable Result, and Scope together. The human Description is primary; the Bead ID never substitutes for "
    "it. This presentation does not infer a value, affect readiness, mutate, or backfill the Bead; an absent field "
    "is shown as missing or unknown."
)
EXPECTED_AGENT_ENTRY_POINT = (
    "`.workspace/config.yaml` gobierna sólo el workflow y la policy locales de este repositorio. "
    "El contrato runtime aplicable de los agentes es separado y acumulativo; esta referencia no lo sustituye "
    "ni lo subordina."
)
REQUIRED_GLOBAL_STEERING_CLAUSES = (
    "A correction to an instruction is not automatically a durable preference.",
    'Writing "here" or "directly" authorizes a content change, not replacement or retargeting of a symlink.',
    "Run the smallest verification set required by the changed surface and the active repository contract.",
)


def load_skill_frontmatter(path: Path) -> dict[str, object]:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        raise AssertionError(f"{path} must begin with YAML frontmatter")
    _, raw_frontmatter, _ = text.split("---", 2)
    parsed = yaml.safe_load(raw_frontmatter)
    if not isinstance(parsed, dict):
        raise AssertionError(f"{path} frontmatter must be a mapping")
    return parsed


class RepositoryContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.readme = README_PATH.read_text(encoding="utf-8")
        cls.agents = AGENTS_PATH.read_text(encoding="utf-8")
        cls.workflow = WORKFLOW_PATH.read_text(encoding="utf-8")
        cls.dependabot = yaml.safe_load(DEPENDABOT_PATH.read_text(encoding="utf-8"))
        cls.test_requirements = TEST_REQUIREMENTS_PATH.read_text(encoding="utf-8")
        cls.workspace_config = yaml.safe_load(WORKSPACE_CONFIG_PATH.read_text(encoding="utf-8"))
        cls.global_steering = GLOBAL_STEERING_PATH.read_text(encoding="utf-8")

    def test_readme_uses_a4s_identity(self) -> None:
        self.assertTrue(self.readme.startswith("# A4S\n"))
        self.assertNotIn("# Handbook", self.readme)

    def test_published_skills_are_discoverable(self) -> None:
        skills = sorted(path.parent.name for path in (ROOT / "skills").glob("*/SKILL.md"))
        self.assertTrue(skills)
        self.assertIn("(skills/)", self.readme)

    def test_roadmap_names_are_distinct(self) -> None:
        legacy = load_skill_frontmatter(ROADMAP_SKILL_PATH)
        stripped = load_skill_frontmatter(ROOT / "skills" / "roadmap" / "SKILL.md")
        self.assertEqual(legacy.get("name"), "roadmap-legacy")
        self.assertEqual(stripped.get("name"), "roadmap")

    def test_every_published_skill_declares_pablontiv_author(self) -> None:
        skill_paths = sorted((ROOT / "skills").glob("*/SKILL.md"))
        self.assertTrue(skill_paths)
        for path in skill_paths:
            with self.subTest(skill=path.parent.name):
                frontmatter = load_skill_frontmatter(path)
                metadata = frontmatter.get("metadata")
                self.assertIsInstance(metadata, dict, path.relative_to(ROOT))
                if isinstance(metadata, dict):
                    self.assertEqual(metadata.get("author"), "pablontiv")

    def test_every_published_skill_declares_last_update_date(self) -> None:
        skill_paths = sorted((ROOT / "skills").glob("*/SKILL.md"))
        self.assertTrue(skill_paths)
        for path in skill_paths:
            with self.subTest(skill=path.parent.name):
                metadata = load_skill_frontmatter(path).get("metadata")
                self.assertIsInstance(metadata, dict, path.relative_to(ROOT))
                if isinstance(metadata, dict):
                    updated = metadata.get("updated")
                    self.assertIsInstance(updated, str, "metadata.updated must be a quoted YYYY-MM-DD string")
                    assert isinstance(updated, str)
                    parsed = date.fromisoformat(updated)
                    self.assertEqual(parsed.isoformat(), updated)
                    self.assertLessEqual(parsed, date.today())

    def test_artifact_families_are_linked(self) -> None:
        for target in (
            ".workspace/",
            "profiles/",
            "methods/",
            "skills/",
            "agents/",
            "output-styles/",
            "src/",
            "test/",
        ):
            with self.subTest(target=target):
                self.assertIn(f"({target})", self.readme)

    def test_relative_markdown_links_resolve(self) -> None:
        for raw_target in LINK_PATTERN.findall(self.readme):
            target = raw_target.strip().split(maxsplit=1)[0].strip("<>")
            parsed = urlsplit(target)
            if parsed.scheme or parsed.netloc or target.startswith("#"):
                continue
            relative = unquote(parsed.path)
            with self.subTest(target=target):
                self.assertTrue((ROOT / relative).exists(), target)

    def test_agent_entry_point_separates_local_policy_from_runtime_contract(self) -> None:
        self.assertEqual(self.agents.strip(), EXPECTED_AGENT_ENTRY_POINT)

    def test_global_steering_preserves_behavioral_guards(self) -> None:
        normalized_steering = " ".join(self.global_steering.split())
        for clause in REQUIRED_GLOBAL_STEERING_CLAUSES:
            with self.subTest(clause=clause):
                self.assertIn(clause, normalized_steering)

    def test_github_actions_are_pinned_and_do_not_persist_credentials(self) -> None:
        for workflow_path in sorted((ROOT / ".github" / "workflows").glob("*.yml")):
            workflow = workflow_path.read_text(encoding="utf-8")
            action_refs = re.findall(r"^\s*- uses: \S+@([^\s]+)$", workflow, re.MULTILINE)
            self.assertTrue(action_refs, workflow_path.name)
            self.assertIn("persist-credentials: false", workflow)
            for ref in action_refs:
                self.assertRegex(ref, r"^[0-9a-f]{40}$")

    def test_dependabot_covers_consolidated_dependencies(self) -> None:
        updates = self.dependabot.get("updates")
        self.assertIsInstance(updates, list)
        assert isinstance(updates, list)
        ecosystems = {
            (update.get("package-ecosystem"), update.get("directory"))
            for update in updates
        }
        self.assertEqual(
            ecosystems,
            {("npm", "/"), ("pip", "/"), ("github-actions", "/")},
        )

    def test_local_artifacts_are_ignored(self) -> None:
        candidates = (
            "nested/__pycache__/metadata.txt",
            "nested/module.pyc",
            ".workspace/worktrees/example/file.txt",
            "nested/module.py",
        )
        result = subprocess.run(
            ["git", "check-ignore", "--no-index", "--stdin"],
            cwd=ROOT,
            input=("\n".join(candidates) + "\n").encode("ascii"),
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        self.assertEqual(
            result.stdout.decode("ascii").splitlines(),
            list(candidates[:3]),
        )

    def test_profile_test_dependency_is_pinned(self) -> None:
        self.assertEqual(self.test_requirements.strip(), "PyYAML==6.0.3")
        self.assertIn("requirements-test.txt", self.workflow)
        self.assertIn("requirements-test.txt", self.readme)

    def test_ci_validates_governed_knowledge(self) -> None:
        for target in (".workspace/docs", "profiles/pablontiv"):
            with self.subTest(target=target):
                self.assertIn(f"rootline validate --all {target}", self.workflow)

    def test_workspace_sync_and_closure_refresh_main_explicitly(self) -> None:
        # Config states the sync invariant; the literal git commands are
        # procedure and live in the work-lifecycle skill (authority.mechanism).
        workspace = self.workspace_config["workspace"]
        starting_point = workspace["do_work"]["starting_point"]
        closure = workspace["deliver_work"]["close"]

        self.assertIn("synchronized with origin/main", starting_point)
        self.assertIn("main equals origin/main", closure)
        self.assertIn("git status --porcelain", closure)

    def test_workspace_config_existing_bead_presentation_policy_is_exact(self) -> None:
        choose_work = self.workspace_config["workspace"]["choose_work"]
        self.assertEqual(choose_work["backlog_decisions"], BACKLOG_DECISIONS_POLICY)

    def test_roadmap_ui_specializes_existing_bead_presentation_without_state_change(self) -> None:
        for path in (ROADMAP_TREE_PATH, ROADMAP_PLAN_PATH, ROADMAP_DOCTOR_PATH):
            with self.subTest(surface=path.name):
                paragraphs = re.split(r"\n\s*\n", path.read_text(encoding="utf-8"))
                matching = [
                    paragraph
                    for paragraph in paragraphs
                    if "existing Bead" in paragraph
                    and all(field in paragraph for field in ("Description", "Bead ID", "Result", "Scope"))
                ]
                self.assertTrue(matching)
                presentation = " ".join(matching)
                normalized = presentation.lower()
                self.assertRegex(normalized, r"missing|unknown")
                for invariant in ("inference", "readiness", "mutat", "backfill"):
                    self.assertIn(invariant, normalized)

    def test_roadmap_plan_ui_distinguishes_proposals_from_existing_beads(self) -> None:
        plan = ROADMAP_PLAN_PATH.read_text(encoding="utf-8")
        self.assertIn("prospective nodes are not existing Beads", plan)
        self.assertIn("label their ID as unassigned", plan)
        self.assertIn("never invents a literal provider ID", plan)
        self.assertIn("Report each created Bead", plan)
        for field in ("Description", "real Bead ID", "Result", "Scope"):
            self.assertIn(field, plan)

    def test_roadmap_preserves_base_authority_and_payload_flow(self) -> None:
        skill = ROADMAP_SKILL_PATH.read_text(encoding="utf-8")
        self.assertIn("derive their proposal-and-choice behavior", skill)
        self.assertIn("`choose_work.intake` and `choose_work.changed_decision`", skill)
        self.assertIn("show the exact Beads payload", skill)
        self.assertNotIn("with one exception", skill)

        plan = ROADMAP_PLAN_PATH.read_text(encoding="utf-8")
        self.assertIn("This is the exact proposed Beads payload", plan)
        self.assertIn("A revision needs a new approval.", plan)

        doctor = ROADMAP_DOCTOR_PATH.read_text(encoding="utf-8")
        self.assertIn("Report, with literal IDs", doctor)
        self.assertIn("Show the exact Beads payload once", doctor)
        self.assertIn("answers included with approval are explicit operator choices", doctor)
        self.assertIn("corresponding missing values once", doctor)
        self.assertIn("make no other payload revision", doctor)
        self.assertIn("no other material change", doctor)
        self.assertIn("apply without another choice", doctor)
        for dimension in ("Result", "acceptance", "Scope", "authority"):
            self.assertIn(dimension, doctor)
        self.assertIn("`choose_work.changed_decision`", doctor)
        self.assertRegex(
            " ".join(doctor.split()),
            r"show the updated payload.*obtain a new operator choice before mutating",
        )

    def test_roadmap_preserves_tree_and_doctor_diagnostic_semantics(self) -> None:
        tree = ROADMAP_TREE_PATH.read_text(encoding="utf-8")
        for phrase in (
            "<closed>/<closed + non-closed> completados",
            "<closed>/<total> completadas, N pendientes",
            "Findings never hide other executable work.",
            "`BLOQUEADAS`",
            "blocked_by: <ids or gate>",
            "(+ also waits on <ids>)",
            "concrete resolved session value rather than the placeholder",
            "Order branches by score",
        ):
            with self.subTest(surface="tree", phrase=phrase):
                self.assertIn(phrase, tree)

        node_line = next(line for line in tree.splitlines() if line.startswith("Node: "))
        marker_order = ("tipo", "jerarquía", "controller:<session>", "deferred", "contrato", "drift")
        self.assertEqual(sorted(marker_order, key=node_line.index), list(marker_order))

        doctor = ROADMAP_DOCTOR_PATH.read_text(encoding="utf-8")
        for phrase in (
            "mentioned IDs that exist but are not linked",
            "`in_progress` whose owner or checkpoint contradicts Git, comments or notes",
            "checkpoint metadata on a task that is not `in_progress`",
        ):
            with self.subTest(surface="doctor", phrase=phrase):
                self.assertIn(phrase, doctor)

    def test_no_legacy_document_authority_remains(self) -> None:
        self.assertFalse((ROOT / "docs").exists())
        self.assertTrue((ROOT / ".workspace" / "docs" / "adr").is_dir())
        self.assertTrue((ROOT / ".workspace" / "docs" / "specs").is_dir())

    def test_profile_and_empirical_method_are_published(self) -> None:
        self.assertIn("(profiles/)", self.readme)
        self.assertTrue((ROOT / "methods" / "empirical-capability-development" / "METHOD.md").is_file())
        self.assertFalse((ROOT / "skills" / "evidence-driven-development").exists())

    def test_imported_artifacts_retain_license_provenance(self) -> None:
        license_path = ROOT / "LICENSES" / "handbook-MIT.txt"
        self.assertTrue(license_path.is_file())
        self.assertIn("MIT License", license_path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
