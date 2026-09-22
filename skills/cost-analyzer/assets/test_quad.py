#!/usr/bin/env python3
"""Regresión: los logs Pi legacy representan spawn como toolCall subagent_run."""
import datetime as dt
import unittest
from unittest.mock import patch

import quad
from dataset import SessionRecord


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


if __name__ == '__main__':
    unittest.main()
