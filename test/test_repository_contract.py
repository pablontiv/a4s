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
LINK_PATTERN = re.compile(r"(?<!!)\[[^]]+\]\(([^)]+)\)")
REQUIRED_AGENT_CLAUSES = (
    "configuración de orquestación",
    "Mantén configuración y runtime como capas del mismo producto",
    "Mantén cada skill autocontenido bajo `skills/<name>/`",
    "Trata runtimes y herramientas externas como providers integrados",
    "Preserva ADRs, specs y planes históricos",
    "Rootline gobierna Markdown durable bajo `.workspace/docs/`",
    "Aplica DRY y KISS",
    "no conviertas reorganizaciones ordinarias en experimentos",
    "Exige autorización explícita y acotada antes de efectos externos destructivos",
    "Usa conventional commits y pull requests",
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

    def test_agent_contract_matches_consolidated_product(self) -> None:
        for clause in REQUIRED_AGENT_CLAUSES:
            with self.subTest(clause=clause):
                self.assertIn(clause, self.agents)

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
        workspace = self.workspace_config["workspace"]
        sync_strategy = workspace["workflow"]["sync_strategy"]
        closure = next(
            item for item in workspace["post_checks"] if "Cierre obligatorio" in item
        )

        for command in ("git fetch origin main", "git pull --ff-only origin main"):
            with self.subTest(surface="sync_strategy", command=command):
                self.assertIn(command, sync_strategy)
            with self.subTest(surface="post_checks", command=command):
                self.assertIn(command, closure)

        self.assertGreaterEqual(closure.count("git fetch origin main"), 2)
        self.assertIn("git rev-parse main", closure)
        self.assertIn("git rev-parse origin/main", closure)
        self.assertIn("git status --porcelain", closure)

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
