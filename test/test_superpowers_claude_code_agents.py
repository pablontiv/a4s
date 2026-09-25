from __future__ import annotations

import unittest
from pathlib import Path

# Resolve to the repository root (parent of test directory)
ROOT = Path(__file__).resolve().parents[1]
CANONICAL_DIR = ROOT / "agents" / "superpowers"
ADAPTER_DIR = CANONICAL_DIR / "claude-code"

CANONICAL_NAMES = (
    "superpowers-architecture-reviewer",
    "superpowers-debugger",
    "superpowers-final-reviewer",
    "superpowers-integration-worker",
    "superpowers-mechanical-implementer",
    "superpowers-task-reviewer",
)

TOOL_MAPPING = {
    "read": "Read",
    "grep": "Grep",
    "find": "Glob",
    "edit": "Edit",
    "write": "Write",
    "bash": "Bash",
    "mem_save": "mcp__plugin_engram_engram__mem_save",
}


def load_frontmatter(path: Path) -> dict[str, object]:
    """Load YAML frontmatter from a markdown file.

    Uses manual parsing to handle unquoted colons in values.
    """
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        raise AssertionError(f"{path} must begin with YAML frontmatter")
    _, raw_frontmatter, _ = text.split("---", 2)

    # Manual parsing to handle unquoted colons in values
    result = {}
    for line in raw_frontmatter.strip().split('\n'):
        if not line.strip() or line.startswith('#'):
            continue
        if ':' not in line:
            continue
        key, _, value = line.partition(':')
        result[key.strip()] = value.strip()

    return result


def map_tools(tools_str: str) -> list[str]:
    """Map Pi tool names to Claude Code tool names."""
    pi_tools = [t.strip() for t in tools_str.split(",")]
    return [TOOL_MAPPING.get(t, t) for t in pi_tools]


def get_body(path: Path) -> str:
    """Extract body (everything after closing ---) from markdown file."""
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        raise AssertionError(f"{path} must begin with YAML frontmatter")
    _, _, body = text.split("---", 2)
    return body.lstrip("\n")  # Remove leading newline after closing ---


class SuperpowersClaudeCodeAgentsTest(unittest.TestCase):
    """Test that Claude Code adapters exist and match canonical definitions."""

    def test_all_adapters_exist(self):
        """Verify exactly six adapters exist."""
        adapter_files = sorted(ADAPTER_DIR.glob("superpowers-*.md"))
        adapter_names = [f.stem for f in adapter_files]
        self.assertEqual(len(adapter_names), 6, f"Expected 6 adapters, found {len(adapter_names)}")
        self.assertEqual(set(adapter_names), set(CANONICAL_NAMES))

    def test_adapter_names_match_canonical(self):
        """Verify adapter 'name' field matches canonical."""
        for name in CANONICAL_NAMES:
            canonical_path = CANONICAL_DIR / f"{name}.md"
            adapter_path = ADAPTER_DIR / f"{name}.md"

            self.assertTrue(canonical_path.exists(), f"Canonical {canonical_path} missing")
            self.assertTrue(adapter_path.exists(), f"Adapter {adapter_path} missing")

            canonical_meta = load_frontmatter(canonical_path)
            adapter_meta = load_frontmatter(adapter_path)

            self.assertEqual(adapter_meta.get("name"), canonical_meta.get("name"),
                           f"Adapter name mismatch for {name}")

    def test_adapter_descriptions_match_canonical(self):
        """Verify adapter 'description' field matches canonical."""
        for name in CANONICAL_NAMES:
            canonical_path = CANONICAL_DIR / f"{name}.md"
            adapter_path = ADAPTER_DIR / f"{name}.md"

            canonical_meta = load_frontmatter(canonical_path)
            adapter_meta = load_frontmatter(adapter_path)

            self.assertEqual(adapter_meta.get("description"), canonical_meta.get("description"),
                           f"Adapter description mismatch for {name}")

    def test_adapter_tools_mapped_correctly(self):
        """Verify adapter tools are correctly mapped from canonical."""
        for name in CANONICAL_NAMES:
            canonical_path = CANONICAL_DIR / f"{name}.md"
            adapter_path = ADAPTER_DIR / f"{name}.md"

            canonical_meta = load_frontmatter(canonical_path)
            adapter_meta = load_frontmatter(adapter_path)

            canonical_tools_str = canonical_meta.get("tools", "")
            expected_adapter_tools = ", ".join(map_tools(canonical_tools_str))
            actual_adapter_tools = adapter_meta.get("tools", "")

            self.assertEqual(actual_adapter_tools, expected_adapter_tools,
                           f"Adapter tools mismatch for {name}")

    def test_adapter_bodies_byte_identical_to_canonical(self):
        """Verify adapter body is byte-identical to canonical."""
        for name in CANONICAL_NAMES:
            canonical_path = CANONICAL_DIR / f"{name}.md"
            adapter_path = ADAPTER_DIR / f"{name}.md"

            canonical_body = get_body(canonical_path)
            adapter_body = get_body(adapter_path)

            self.assertEqual(adapter_body, canonical_body,
                           f"Adapter body diverges from canonical for {name}")


if __name__ == "__main__":
    unittest.main()
