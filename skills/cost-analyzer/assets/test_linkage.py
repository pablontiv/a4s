#!/usr/bin/env python3
"""Tests for D7 (worktree enumeration) and D8 (session-commit linkage)."""
import datetime as dt
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from dataset import SessionRecord
from linkage import (
    parse_timestamp,
    attribute_commit_to_session,
    analyze_linkage,
)


class LinkageTests(unittest.TestCase):
    def test_parse_iso_timestamp(self):
        """Test ISO timestamp parsing."""
        ts = parse_timestamp('2026-08-01T12:30:45Z')
        self.assertIsNotNone(ts)
        self.assertEqual(ts.year, 2026)
        self.assertEqual(ts.month, 8)
        self.assertEqual(ts.day, 1)

    def test_parse_invalid_timestamp_returns_none(self):
        """Test that invalid timestamp returns None."""
        self.assertIsNone(parse_timestamp('not-a-timestamp'))
        self.assertIsNone(parse_timestamp(None))

    def test_attribute_commit_to_session_within_window(self):
        """D8: Commit within session window is attributed."""
        session_windows = [
            {
                'session_id': 's1',
                'start': dt.datetime(2026, 8, 1, 12, 0, 0, tzinfo=dt.timezone.utc),
                'end': dt.datetime(2026, 8, 1, 13, 0, 0, tzinfo=dt.timezone.utc),
                'tokens': 1000,
                'form': 'form-solo',
                'topology': 'S1',
                'harness': 'pi',
            }
        ]
        commit_ts = dt.datetime(2026, 8, 1, 12, 30, 0, tzinfo=dt.timezone.utc)
        window = attribute_commit_to_session(commit_ts, session_windows)
        self.assertIsNotNone(window)
        self.assertEqual(window['session_id'], 's1')

    def test_attribute_commit_outside_window_returns_none(self):
        """D8: Commit outside all session windows is not attributed."""
        session_windows = [
            {
                'session_id': 's1',
                'start': dt.datetime(2026, 8, 1, 12, 0, 0, tzinfo=dt.timezone.utc),
                'end': dt.datetime(2026, 8, 1, 13, 0, 0, tzinfo=dt.timezone.utc),
                'tokens': 1000,
                'form': 'form-solo',
                'topology': 'S1',
                'harness': 'pi',
            }
        ]
        commit_ts = dt.datetime(2026, 8, 1, 14, 0, 0, tzinfo=dt.timezone.utc)
        window = attribute_commit_to_session(commit_ts, session_windows)
        self.assertIsNone(window)

    def test_attribute_commit_with_overlap_chooses_smallest_window(self):
        """D8: On overlap, choose session with minimum duration (specificity)."""
        session_windows = [
            {
                'session_id': 's1',
                'start': dt.datetime(2026, 8, 1, 12, 0, 0, tzinfo=dt.timezone.utc),
                'end': dt.datetime(2026, 8, 1, 14, 0, 0, tzinfo=dt.timezone.utc),
                'tokens': 2000,
                'form': 'form-solo',
                'topology': 'S1',
                'harness': 'pi',
            },
            {
                'session_id': 's2',
                'start': dt.datetime(2026, 8, 1, 12, 15, 0, tzinfo=dt.timezone.utc),
                'end': dt.datetime(2026, 8, 1, 12, 45, 0, tzinfo=dt.timezone.utc),
                'tokens': 1000,
                'form': 'form-orch-hybrid',
                'topology': 'S2',
                'harness': 'pi',
            }
        ]
        commit_ts = dt.datetime(2026, 8, 1, 12, 30, 0, tzinfo=dt.timezone.utc)
        window = attribute_commit_to_session(commit_ts, session_windows)
        self.assertIsNotNone(window)
        self.assertEqual(window['session_id'], 's2')

    def test_analyze_linkage_returns_aggregated_metrics(self):
        """D8: analyze_linkage returns LinkageResult with aggregations."""
        records = [
            SessionRecord(
                id='s1', harness='pi', source_path='/tmp/s1.jsonl',
                schema_version='pi-jsonl-v1',
                started_at=dt.datetime(2026, 8, 1, 12, 0, 0, tzinfo=dt.timezone.utc),
                ended_at=dt.datetime(2026, 8, 1, 12, 30, 0, tzinfo=dt.timezone.utc),
                cwd=None, model=None, provider=None,
                input_tokens=500, output_tokens=300,
                form='form-solo', observed_topology='S1',
            ),
        ]
        with TemporaryDirectory() as tmpdir:
            repo_path = tmpdir
            Path(repo_path).mkdir(exist_ok=True)
            since = dt.date(2026, 8, 1)
            until = dt.date(2026, 8, 2)
            result = analyze_linkage(records, repo_path, since, until)
            self.assertEqual(result.total_sessions, 1)
            self.assertEqual(result.attributed_commits, 0)
            self.assertGreaterEqual(result.attribution_rate_pct, 0)


if __name__ == '__main__':
    unittest.main()
