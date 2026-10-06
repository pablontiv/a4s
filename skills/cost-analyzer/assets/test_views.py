#!/usr/bin/env python3
import datetime as dt
import unittest
from dataclasses import replace

from dataset import SessionRecord
from views import CohortSummary, aggregate_harness, aggregate_topology, render_harness_overview, render_topology_overview, render_tokens_breakdown


BASE = SessionRecord(
    id='x', harness='pi', source_path='x', schema_version='test',
    started_at=dt.datetime(2026, 9, 1, tzinfo=dt.timezone.utc),
    ended_at=dt.datetime(2026, 9, 1, tzinfo=dt.timezone.utc), cwd=None,
    model=None, provider=None,
)


class HarnessViewTests(unittest.TestCase):
    def test_zero_sha_cohort_is_not_ranked(self):
        summary = CohortSummary(sessions=2, total_tokens=100)
        self.assertIsNone(summary.tokens_per_sha())

    def test_sha_is_deduped_per_harness(self):
        records = [
            replace(BASE, harness='pi', input_tokens=100, commits=frozenset({'a'})),
            replace(BASE, harness='pi', input_tokens=100, commits=frozenset({'a'})),
        ]
        summary = aggregate_harness(records)['pi']
        self.assertEqual(summary.unique_shas, 1)
        self.assertEqual(summary.tokens_per_sha(), 200)

    def test_topology_crosses_harnesses(self):
        records = [
            replace(BASE, harness='claude', observed_topology='S2', input_tokens=100, commits=frozenset({'a'})),
            replace(BASE, harness='codex', observed_topology='S2', input_tokens=200, commits=frozenset({'b'})),
        ]
        text = render_topology_overview(aggregate_topology(records))
        self.assertIn('claude × S2', text)
        self.assertIn('codex × S2', text)
        self.assertIn('100', text)

    def test_partial_native_cost_does_not_rank_harnesses_by_dollars(self):
        records = [
            replace(BASE, harness='pi', cost_native_usd=4.0, commits=frozenset({'a'})),
            replace(BASE, harness='claude', cost_native_usd=None, commits=frozenset({'b'})),
        ]
        text = render_harness_overview(aggregate_harness(records))
        self.assertIn('winner $/SHA: unavailable', text)
        self.assertIn('pi', text)
        self.assertIn('claude', text)
        self.assertIn('1/1', text)
        self.assertIn('0/1', text)
        self.assertIn('Git', text)

    def test_tokens_breakdown_shows_cache_impact(self):
        records = [
            replace(BASE, harness='pi', input_tokens=1000, output_tokens=500, cache_read_tokens=2000, cache_write_tokens=100),
        ]
        summary = aggregate_harness(records)
        text = render_tokens_breakdown(summary)
        self.assertIn('TOKEN BREAKDOWN', text)
        self.assertIn('cacheRead', text)
        self.assertIn('quota', text)
        self.assertIn('pi', text)
        self.assertIn('1000', text)
        self.assertIn('2000', text)


if __name__ == '__main__':
    unittest.main()
