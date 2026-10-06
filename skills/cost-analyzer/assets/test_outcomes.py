"""Regresión: una sesión sin timestamps conserva el contrato de outcome."""
import os
import tempfile
import unittest
from pathlib import Path

import outcomes  # pyright: ignore[reportMissingImports]
from dataset import SessionRecord  # pyright: ignore[reportMissingImports]
from enrich import enrich_records  # pyright: ignore[reportMissingImports]


class OutcomeContractTests(unittest.TestCase):
    def test_categorize_path_recognizes_root_relative_test_files(self):
        self.assertEqual(outcomes.categorize_path('tests/test_app.py'), 'test')

    def test_canonical_records_aggregate_without_reopening_jsonl(self):
        records = [SessionRecord(id='x', harness='pi', source_path='/not-read.jsonl', schema_version='x', started_at=None, ended_at=None, cwd=None, model=None, provider=None, commits=frozenset({'abc'}))]
        summary = outcomes.aggregate_record_outcomes(records)['pi']
        self.assertEqual(summary['commits'], {'abc'})

    def test_missing_window_has_no_timestamp_coverage(self):
        record = SessionRecord(id='x', harness='pi', source_path='x', schema_version='x', started_at=None, ended_at=None, cwd='/repo', model=None, provider=None)
        self.assertEqual(enrich_records([record])[0].commit_coverage, 'no-timestamps')

    def test_record_outcome_uses_enriched_shas_without_reopening_jsonl(self):
        record = SessionRecord(id='x', harness='pi', source_path='/does-not-exist.jsonl', schema_version='x', started_at=None, ended_at=None, cwd=None, model=None, provider=None, commits=frozenset({'abc'}))
        outcome = outcomes.compute_outcome_for_record(record, with_prs=False, with_beads=False)
        self.assertEqual(outcome['commit_shas'], ['abc'])

    def test_missing_timestamps_still_returns_empty_commit_shas(self):
        with tempfile.NamedTemporaryFile('w', suffix='.jsonl', delete=False) as handle:
            handle.write('{}\n')
            path = handle.name
        try:
            outcome = outcomes.compute_outcome_for_session(path, with_prs=False, with_beads=False)
        finally:
            os.unlink(path)
        self.assertEqual(outcome['commit_shas'], [])

    def test_missing_session_file_returns_empty_outcome(self):
        outcome = outcomes.compute_outcome_for_session('/does-not-exist.jsonl', with_prs=False, with_beads=False)
        self.assertEqual(outcome['commit_shas'], [])

    def test_d7_enumerate_worktrees_returns_empty_for_non_repo(self):
        """D7 FIX: _enumerate_worktrees returns empty list for non-git-repo."""
        with tempfile.TemporaryDirectory() as tmpdir:
            result = outcomes._enumerate_worktrees(tmpdir)
            self.assertEqual(result, [])

    def test_d7_enumerate_worktrees_handles_missing_directory(self):
        """D7 FIX: _enumerate_worktrees handles missing directory gracefully."""
        result = outcomes._enumerate_worktrees('/nonexistent/path')
        self.assertEqual(result, [])


if __name__ == '__main__':
    unittest.main()
