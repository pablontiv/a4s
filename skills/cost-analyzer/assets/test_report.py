#!/usr/bin/env python3
import io
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

import report
from dataset import SessionRecord


class ReportViewTests(unittest.TestCase):
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
