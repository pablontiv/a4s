#!/usr/bin/env python3
import io
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

import report
from dataset import SessionRecord
from delivery_efficiency import DeliveryCohort


class ReportViewTests(unittest.TestCase):
    def test_delivery_efficiency_view_renders_guardrails(self):
        row = DeliveryCohort(
            repository="/repo", cohort="S3", session_cost=100.0, attributable_cost=50.0,
            durable_shas=frozenset({"abc"}), immature_count=1, reverted_count=0,
            unknown_count=0, coverage=0.5, median_lead_seconds=60.0,
            status="insufficient-coverage",
        )
        stdout = io.StringIO()
        with patch.object(report, 'load_ledger', return_value=[]), \
             patch.object(report, 'enrich_records', return_value=[]), \
             patch.object(report, 'analyze_delivery_efficiency', return_value=[row]), \
             patch('sys.argv', [
                 'report.py', '--since', '2026-09-01', '--until', '2026-09-16',
                 '--view', 'delivery-efficiency', '--evaluation-date', '2026-09-24',
             ]), redirect_stdout(stdout):
            report.main()
        self.assertIn('COSTE POR CAMBIO DURABLE', stdout.getvalue())
        self.assertIn('insufficient-coverage', stdout.getvalue())

    def test_topology_view_uses_canonical_cross_harness_records(self):
        records = [
            SessionRecord(id='c', harness='claude', source_path='c', schema_version='x', started_at=None, ended_at=None, cwd=None, model=None, provider=None, observed_topology='S2'),
            SessionRecord(id='x', harness='codex', source_path='x', schema_version='x', started_at=None, ended_at=None, cwd=None, model=None, provider=None, observed_topology='S2'),
        ]
        stdout = io.StringIO()
        with patch.object(report, 'load_ledger', return_value=records), patch('sys.argv', ['report.py', '--since', '2026-09-01', '--view', 'topology']), redirect_stdout(stdout):
            report.main()
        self.assertIn('claude × S2', stdout.getvalue())
        self.assertIn('codex × S2', stdout.getvalue())


if __name__ == '__main__':
    unittest.main()
