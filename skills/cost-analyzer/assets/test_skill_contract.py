#!/usr/bin/env python3
import unittest
from pathlib import Path


class SkillContractTests(unittest.TestCase):
    def test_skill_frontmatter_uses_cost_analyzer_name(self):
        skill = Path(__file__).parents[1] / 'SKILL.md'
        self.assertEqual(skill.read_text().splitlines()[1], 'name: cost-analyzer')

    def test_skill_runtime_instructions_are_self_contained(self):
        text = (Path(__file__).parents[1] / 'SKILL.md').read_text()
        self.assertIn('assets/quad.py', text)
        self.assertNotIn('/private/tmp/', text)


if __name__ == '__main__':
    unittest.main()
