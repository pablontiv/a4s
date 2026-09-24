import unittest
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parents[1]
SKILL = SKILL_ROOT / "SKILL.md"


class BeadsLoopTests(unittest.TestCase):
    def test_skill_uses_beads_cli_without_a_python_runner(self) -> None:
        text = SKILL.read_text(encoding="utf-8")
        required_in_order = (
            "`bd list --ready --brief --sort priority --limit 0 --json`",
            "`bd show <bead-id> --json`",
            "`bd dep list <bead-id> --json`",
            "Materialize only eligible work into Pi todos",
            "parallel wave",
            "all eligible ready Beads",
            "`bd update <bead-id> --claim`",
            "`bead:<bead-id> — <title>`",
            "`source=beads-loop`",
            "`bead_id=<bead-id>`",
            "stale Beads-loop todos",
            "recalculate `ready`",
        )
        previous = -1
        for phrase in required_in_order:
            found = text.find(phrase)
            self.assertGreater(found, previous, phrase)
            previous = found
        for forbidden in ("python3", "scripts/", "beads_todo_loop.py", "one sequential Pi session"):
            self.assertNotIn(forbidden, text)


if __name__ == "__main__":
    unittest.main()
