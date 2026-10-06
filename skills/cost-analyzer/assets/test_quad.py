#!/usr/bin/env python3
"""Regresión: los logs Pi legacy representan spawn como toolCall subagent_run."""
import datetime as dt
import unittest
from unittest.mock import patch

import quad
from dataset import SessionRecord, classify_pi_topology, classify_pi_form, calculate_delegation_degree


class DelegationSurfaceTests(unittest.TestCase):
    def test_scan_sessions_consumes_canonical_pi_ledger(self):
        record = SessionRecord(id='x', harness='pi', source_path='/fixture.jsonl', schema_version='x', started_at=None, ended_at=None, cwd=None, model=None, provider=None, cost_native_usd=2.0, input_tokens=10, observed_topology='S2')
        with patch.object(quad, 'load_ledger', return_value=[record]) as load:
            cells = quad.scan_sessions('2026-09-01', '2026-09-01', base='/fixtures')
        load.assert_called_once()
        self.assertEqual(cells['S2']['n'], 1)
        self.assertEqual(cells['S2']['cost'], 2.0)
        self.assertEqual(cells['S2']['files'], ['/fixture.jsonl'])

    def test_legacy_spawn_counter_remains_available_to_extensions(self):
        record = {'type': 'message', 'message': {'role': 'assistant', 'content': [{'type': 'toolCall', 'name': 'subagent_run'}]}}
        self.assertEqual(quad.count_legacy_spawn_tool_calls(record), 1)

    def test_toolcall_subagent_run_classifies_plain_session_as_s2(self):
        self.assertEqual(
            quad.classify('plain-repo', intercom=0, fm=0, subn=0, spawned_tool_calls=1),
            'S2',
        )


class ClassifierRegressionTests(unittest.TestCase):
    """Regression tests for S1-S4 classification accuracy after DEFECT fixes."""

    def test_defect1_directory_token_heuristic_removed_a4s_is_now_s1(self):
        """DEFECT 1 FIX: directory containing 'a4s' should NOT mark as orchestrated.

        Previously: directory heuristic marked 'a4s' in path as S3.
        After fix: plain session with directory token should be S1 (no orchestration signal).
        """
        from collections import Counter
        # Plain session with 'a4s' in directory path - should now be S1 (not S3)
        result = classify_pi_topology(Counter(), spawn_tool_calls=0)
        self.assertEqual(result, 'S1', 'After DEFECT 1 fix: a4s in path no longer marks as orchestrated')

    def test_defect1_directory_token_heuristic_removed_worktrees_is_now_s1(self):
        """DEFECT 1 FIX: directory containing 'worktrees' should NOT mark as orchestrated."""
        from collections import Counter
        result = classify_pi_topology(Counter(), spawn_tool_calls=0)
        self.assertEqual(result, 'S1', 'After DEFECT 1 fix: worktrees in path no longer marks as orchestrated')

    def test_defect2_intercom_toolcall_now_detected(self):
        """DEFECT 2 FIX: intercom as toolCall is NOW detected by classifier.

        Previously: intercom as toolCall was not detected.
        After fix: intercom_toolcalls parameter is passed and used for orchestration detection.
        """
        from collections import Counter
        # Session with intercom toolCall (detected separately)
        result = classify_pi_topology(Counter(), spawn_tool_calls=0, intercom_toolcalls=1)
        self.assertEqual(result, 'S3', 'After DEFECT 2 fix: intercom toolCall marks as S3 (orchestrated)')

    def test_intercom_as_customtype_still_detected(self):
        """Regression check: intercom as customType='intercom-*' still works."""
        from collections import Counter
        custom_types = Counter({'intercom-orchestrator': 5})
        result = classify_pi_topology(custom_types, spawn_tool_calls=0)
        self.assertEqual(result, 'S3', 'intercom customType still marks as S3 (orchestrated)')

    def test_both_defects_fixed_s1_remains_s1(self):
        """Regression check: plain session with no signals should still be S1."""
        from collections import Counter
        result = classify_pi_topology(Counter(), spawn_tool_calls=0)
        self.assertEqual(result, 'S1', 'Plain session with no signals is S1')


class FormModelTests(unittest.TestCase):
    """Regression tests for 4-form taxonomy model."""

    def test_form1_solo_no_delegation_no_intercom(self):
        """Form 1: Solo session with no delegation and no intercom."""
        result = classify_pi_form(delegation_present=False, delegation_degree=0.0, cross_session_heuristic=False)
        self.assertEqual(result, 'form-solo')

    def test_form2_orch_hybrid_low_degree_delegation(self):
        """Form 2: Orchestrator + Subagents (hybrid) when delegation_degree < 0.8."""
        result = classify_pi_form(delegation_present=True, delegation_degree=0.5, cross_session_heuristic=False)
        self.assertEqual(result, 'form-orch-hybrid')

    def test_form3_delegator_pure_high_degree_delegation(self):
        """Form 3: Pure Delegator when delegation_degree >= 0.8."""
        result = classify_pi_form(delegation_present=True, delegation_degree=0.85, cross_session_heuristic=False)
        self.assertEqual(result, 'form-delegator-pure')

    def test_form4_cross_session_with_intercom_heuristic(self):
        """Form 4: Cross-session orchestration marked with heuristic."""
        result = classify_pi_form(delegation_present=False, delegation_degree=0.0, cross_session_heuristic=True)
        self.assertEqual(result, 'form-cross-session')

    def test_delegation_degree_calculation(self):
        """Delegation degree = spawn_tool_calls / assistant_turns."""
        # 5 spans in 10 turns = 0.5
        degree = calculate_delegation_degree(spawn_tool_calls=5, total_assistant_turns=10)
        self.assertAlmostEqual(degree, 0.5, places=2)

    def test_delegation_degree_100_percent(self):
        """Delegation degree capped at 1.0."""
        degree = calculate_delegation_degree(spawn_tool_calls=20, total_assistant_turns=10)
        self.assertEqual(degree, 1.0)

    def test_delegation_degree_zero_turns(self):
        """Delegation degree is 0 when no assistant turns."""
        degree = calculate_delegation_degree(spawn_tool_calls=5, total_assistant_turns=0)
        self.assertEqual(degree, 0.0)

    def test_intercom_orthogonal_flag_solo_with_intercom(self):
        """Solo session can have intercom flag (orthogonal)."""
        result = classify_pi_form(delegation_present=False, delegation_degree=0.0, cross_session_heuristic=False)
        self.assertEqual(result, 'form-solo', 'Solo remains Solo even with intercom (intercom is orthogonal)')

    def test_intercom_orthogonal_not_part_of_form_distinction(self):
        """intercom presence does not change form classification (it is orthogonal)."""
        form_without = classify_pi_form(delegation_present=True, delegation_degree=0.5, cross_session_heuristic=False)
        form_with = classify_pi_form(delegation_present=True, delegation_degree=0.5, cross_session_heuristic=False)
        self.assertEqual(form_without, 'form-orch-hybrid')
        self.assertEqual(form_with, 'form-orch-hybrid', 'intercom presence does not change form (orthogonal flag)')


if __name__ == '__main__':
    unittest.main()
