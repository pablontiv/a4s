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


if __name__ == "__main__":
    unittest.main()
