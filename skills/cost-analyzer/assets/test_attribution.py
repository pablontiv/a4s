#!/usr/bin/env python3
import datetime as dt
import unittest

from attribution import _cwds_related, _worktree_key, build_attribution_from_records
from dataset import SessionRecord


class CanonicalAttributionTests(unittest.TestCase):
    def test_related_s1_started_in_s3_window_is_attributed(self):
        start = dt.datetime(2026, 9, 1, 10, tzinfo=dt.timezone.utc)
        orchestrator = SessionRecord(id='s3', harness='pi', source_path='s3', schema_version='x', started_at=start, ended_at=start + dt.timedelta(hours=1), cwd='/srv/agent/repo-worktrees/task', model=None, provider=None, cost_native_usd=5, observed_topology='S3')
        worker = SessionRecord(id='s1', harness='pi', source_path='s1', schema_version='x', started_at=start + dt.timedelta(minutes=5), ended_at=start + dt.timedelta(minutes=30), cwd='/srv/agent/repo-worktrees/task', model=None, provider=None, cost_native_usd=1, observed_topology='S1')
        result = build_attribution_from_records([orchestrator, worker])
        self.assertEqual(result['s3']['n_spawned'], 1)
        self.assertEqual(result['s3']['cost_s1_spawned'], 1)

    def test_worktree_identity_does_not_depend_on_home_prefix(self):
        self.assertEqual(
            _worktree_key('/srv/build/product-worktrees/change-1'),
            'product/worktrees/change-1',
        )
        self.assertEqual(
            _worktree_key('/opt/runner/product/.workspace/worktrees/change-1'),
            'product/worktrees/change-1',
        )
        self.assertTrue(
            _cwds_related(
                '/srv/build/product-worktrees/change-1',
                '/another/root/product',
            )
        )
        self.assertFalse(
            _cwds_related(
                '/srv/build/product-worktrees/change-1',
                '/another/root/different-product',
            )
        )


if __name__ == '__main__':
    unittest.main()
