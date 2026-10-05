from __future__ import annotations

import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
ROLES = ("explorer", "implementer", "reviewer", "debugger", "generalist")
READ_ONLY_ROLES = {"explorer", "reviewer"}
TOOLS_BY_HARNESS = {
    "pi": {
        "read_only": {"read", "grep", "find", "bash"},
        "mutable": {"read", "grep", "find", "edit", "write", "bash"},
    },
    "claude": {
        "read_only": {"Read", "Grep", "Glob", "Bash"},
        "mutable": {"Read", "Grep", "Glob", "Edit", "Write", "Bash"},
    },
}
DELEGATION_TOOLS = {"agent", "task", "subagent", "subagent_run"}
ORCHESTRATOR_PATH = ROOT / "agents" / "common" / "AGENTS.md"
AGENTS_README_PATH = ROOT / "agents" / "README.md"


def load_frontmatter(path: Path) -> dict[str, object]:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        raise AssertionError(f"{path} must begin with YAML frontmatter")
    _, raw_frontmatter, _ = text.split("---", 2)
    parsed = yaml.safe_load(raw_frontmatter)
    if not isinstance(parsed, dict):
        raise AssertionError(f"{path} frontmatter must be a mapping")
    return parsed


def parse_tools(value: object, path: Path) -> set[str]:
    if not isinstance(value, str):
        raise AssertionError(f"{path} tools must be a comma-separated string")
    return {tool.strip() for tool in value.split(",") if tool.strip()}


class AgentOperatingModelContractTests(unittest.TestCase):
    def test_orchestrator_is_pi_root_runtime_authority(self) -> None:
        contract = ORCHESTRATOR_PATH.read_text(encoding="utf-8")
        readme = AGENTS_README_PATH.read_text(encoding="utf-8")

        for marker in (
            "Pi's root runtime entry point",
            "authoritative runtime contract",
            "You are Pi, the user-facing Orchestrator",
            "This runtime contract and repository policy are separate, cumulative authorities.",
            "Neither replaces or extends the other",
            "Carry applicable repository policy into each dispatch",
        ):
            with self.subTest(marker=marker):
                self.assertIn(marker, contract)

        for marker in (
            "Pi's root runtime entry point",
            "Repository-local policy remains the authority",
            "The two contracts are cumulative",
            "Pi loads `AGENTS.md` there as its root entry point",
        ):
            with self.subTest(readme_marker=marker):
                self.assertIn(marker, readme)

    def test_orchestrator_requires_atomic_units_and_ready_concurrency(self) -> None:
        contract = ORCHESTRATOR_PATH.read_text(encoding="utf-8")

        for marker in (
            "An independently adjudicable unit produces exactly one result",
            "has exactly one primary Worker specialization",
            "Do not enlarge a unit merely to reduce dispatch count",
            "Dispatch all ready work units concurrently.",
            "a concrete ordering dependency",
            "a conflicting mutation of the same artifact",
            "an explicit user or applicable-policy restriction",
            "an actual runtime worker limit",
            "No other reason is an exception.",
            "The same closed exception list governs every decision not to dispatch candidates separately and concurrently.",
            "For every grouping of candidate work or sequencing of otherwise ready candidates, state the concrete exception",
            "Only an explicit restriction may require grouping",
            "a runtime worker limit creates waves of unchanged work units",
            "None permits larger units.",
            "Shared sources, a shared primary specialization, or a shared report do not justify combining",
        ):
            with self.subTest(marker=marker):
                self.assertIn(marker, contract)

    def test_orchestrator_preserves_transferred_runtime_behaviors(self) -> None:
        contract = ORCHESTRATOR_PATH.read_text(encoding="utf-8")
        readme = AGENTS_README_PATH.read_text(encoding="utf-8")

        for marker in (
            "A status question does not pause or cancel authorized work.",
            "use the operator's voice and do not add an AI disclosure solely because of the text's origin",
            "dispatch one fresh, independent Reviewer for the complete candidate",
            "The Reviewer must not be the implementing Worker.",
            "Prefer a different model family or provider when readily available, but that preference is non-blocking",
            "exercise the representative entry point through its consuming harness",
            "static contract tests alone are not end-to-end evidence",
        ):
            with self.subTest(marker=marker):
                self.assertIn(marker, contract)

        self.assertIn(
            "its representative end-to-end path must invoke it through the consuming harness",
            readme,
        )

    def test_pi_and_claude_publish_exact_five_role_rosters(self) -> None:
        for harness in TOOLS_BY_HARNESS:
            directory = ROOT / "agents" / harness
            with self.subTest(harness=harness):
                self.assertEqual(
                    {path.stem for path in directory.glob("*.md")},
                    set(ROLES),
                )

    def test_frontmatter_and_tool_boundaries(self) -> None:
        for harness, expected_tools in TOOLS_BY_HARNESS.items():
            for role in ROLES:
                path = ROOT / "agents" / harness / f"{role}.md"
                with self.subTest(harness=harness, role=role):
                    frontmatter = load_frontmatter(path)
                    self.assertEqual(set(frontmatter), {"name", "description", "tools"})
                    self.assertEqual(frontmatter["name"], role)
                    self.assertIsInstance(frontmatter["description"], str)
                    self.assertTrue(frontmatter["description"])

                    tools = parse_tools(frontmatter["tools"], path)
                    boundary = "read_only" if role in READ_ONLY_ROLES else "mutable"
                    self.assertEqual(tools, expected_tools[boundary])
                    self.assertTrue(DELEGATION_TOOLS.isdisjoint(tool.lower() for tool in tools))

    def test_workers_remain_direct_leaves(self) -> None:
        leaf_contract = (
            "You are a direct Worker child of the Orchestrator. "
            "Execute exactly one bounded work unit."
        )
        no_delegation_contract = (
            "Do not delegate, create child agents, coordinate other Workers, "
            "or invoke subagent tools."
        )

        for harness in TOOLS_BY_HARNESS:
            for role in ROLES:
                path = ROOT / "agents" / harness / f"{role}.md"
                body = path.read_text(encoding="utf-8")
                with self.subTest(harness=harness, role=role):
                    self.assertIn(leaf_contract, body)
                    self.assertIn(no_delegation_contract, body)


if __name__ == "__main__":
    unittest.main()
