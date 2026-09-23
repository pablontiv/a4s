from __future__ import annotations

import unittest
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parents[1]
SKILL = SKILL_ROOT / "SKILL.md"


class BeadsLoopTests(unittest.TestCase):
    def test_skill_materializes_snapshot_into_todos_without_claims(self) -> None:
        text = SKILL.read_text(encoding="utf-8")
        required_in_order = (
            "beads_todo_loop.py snapshot",
            "one `todo` for every",
            "second deterministic pass",
            "detail --bead",
            "`backscroll`",
            "`systematic-debugging`",
            "`test-driven-development`",
            "`executing-plans`",
            "`verification-before-completion`",
            "finalize --bead",
            "final `snapshot`",
        )
        previous = -1
        for phrase in required_in_order:
            found = text.find(phrase)
            self.assertGreater(found, previous, phrase)
            previous = found
        for forbidden in ("--claim", "lease", "heartbeat", "timer", "roadmapctl", "brainstorming"):
            self.assertNotIn(forbidden, text)


if __name__ == "__main__":
    unittest.main()
