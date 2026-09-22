#!/usr/bin/env python3
"""Regresión de la frontera j0k3r → pi-subagents del 4-sept-2026."""
import datetime
import unittest
from unittest.mock import patch

import extensions
from dataset import SessionRecord

UTC = datetime.timezone.utc
CUTOVER = datetime.datetime(2026, 9, 4, 4, 43, 9, tzinfo=UTC)


class ExtensionVariantTests(unittest.TestCase):
    def test_scan_uses_canonical_pi_ledger(self):
        record = SessionRecord(id='x', harness='pi', source_path='/x.jsonl', schema_version='x', started_at=None, ended_at=None, cwd=None, model=None, provider=None, cost_native_usd=3, observed_topology='S2', pi_extension='pi-subagents')
        with patch.object(extensions, 'load_ledger', return_value=[record]):
            rows = extensions.scan_extension_sessions('2026-09-01', base='/fixtures')
        self.assertEqual(rows[0]['scenario'], 'S2')
        self.assertEqual(rows[0]['variant'], 'pi-subagents')
    def test_window_before_cutover_is_j0k3r(self):
        self.assertEqual(
            extensions.variant_for_window(CUTOVER - datetime.timedelta(hours=2), CUTOVER - datetime.timedelta(minutes=1)),
            'pi-subagents-j0k3r',
        )

    def test_cross_table_exposes_tokens_per_sha(self):
        data = extensions.aggregate([{'record': SessionRecord(id='x', harness='pi', source_path='x', schema_version='x', started_at=None, ended_at=None, cwd=None, model=None, provider=None, commits=frozenset({'a'})), 'scenario': 'S2', 'variant': 'pi-subagents', 'cost': 1.0, 'tok': 100}], with_commits=False, progress=False)
        self.assertIn('tok/SHA', extensions.format_report(data))

    def test_window_after_cutover_is_pi_subagents(self):
        self.assertEqual(
            extensions.variant_for_window(CUTOVER + datetime.timedelta(minutes=1), CUTOVER + datetime.timedelta(hours=2)),
            'pi-subagents',
        )

    def test_window_crossing_cutover_is_mixed_and_excluded(self):
        self.assertEqual(
            extensions.variant_for_window(CUTOVER - datetime.timedelta(minutes=1), CUTOVER + datetime.timedelta(minutes=1)),
            'mixed/unknown',
        )


if __name__ == '__main__':
    unittest.main()
