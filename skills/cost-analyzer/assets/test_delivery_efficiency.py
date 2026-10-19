import os
import subprocess
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory

import delivery_efficiency
from dataset import SessionRecord


TODAY = date(2026, 9, 24)
OLD = "2026-09-10T12:00:00+00:00"


class DeliveryEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.repo = Path(self.temp.name)
        self.git("init", "-b", "main")
        self.git("config", "user.email", "test@example.com")
        self.git("config", "user.name", "Test User")
        self.commit("src/bootstrap.py", "BOOT = True\n", "bootstrap")

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args, when=None):
        environment = os.environ.copy()
        if when:
            environment["GIT_AUTHOR_DATE"] = when
            environment["GIT_COMMITTER_DATE"] = when
        return subprocess.run(
            ["git", "-C", str(self.repo), *args],
            check=True,
            capture_output=True,
            text=True,
            env=environment,
        )

    def commit(self, relative_path, content, subject, when=OLD):
        path = self.repo / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        self.git("add", relative_path, when=when)
        self.git("commit", "-m", subject, when=when)
        return self.git("rev-parse", "HEAD").stdout.strip()

    def test_mature_code_commit_on_main_is_durable(self):
        sha = self.commit("src/app.py", "print('ok')\n", "feature")

        evidence = delivery_efficiency.inspect_commit(self.repo, sha, TODAY)

        self.assertEqual(evidence.maturity, "mature")
        self.assertEqual(evidence.durability, "durable")
        self.assertEqual(evidence.path_categories, frozenset({"code"}))


    def test_commit_inside_maturity_horizon_is_immature(self):
        sha = self.commit(
            "src/new.py",
            "x = 1\n",
            "new",
            when="2026-09-22T12:00:00+00:00",
        )

        self.assertEqual(
            delivery_efficiency.inspect_commit(self.repo, sha, TODAY).maturity,
            "immature",
        )

    def test_explicit_revert_is_not_durable(self):
        sha = self.commit("src/reverted.py", "VALUE = 1\n", "revert me")
        self.git("revert", "--no-edit", sha, when=OLD)

        self.assertEqual(
            delivery_efficiency.inspect_commit(self.repo, sha, TODAY).durability,
            "reverted",
        )

    def test_missing_default_ref_is_unknown_history(self):
        sha = self.commit("src/orphan.py", "VALUE = 1\n", "orphan")
        self.git("update-ref", "-d", "refs/heads/main")

        self.assertEqual(
            delivery_efficiency.inspect_commit(self.repo, sha, TODAY).durability,
            "unknown-history",
        )

    def test_side_branch_commit_is_not_on_default_branch(self):
        self.git("checkout", "-b", "side")
        sha = self.commit("src/side.py", "VALUE = 1\n", "side")
        self.git("checkout", "main")

        self.assertEqual(
            delivery_efficiency.inspect_commit(self.repo, sha, TODAY).durability,
            "not-on-default",
        )


class DeliveryAttributionTests(DeliveryEvidenceTests):
    def setUp(self):
        super().setUp()
        self.sha = self.commit("src/app.py", "VALUE = 1\n", "first")
        self.other_sha = self.commit("src/other.py", "VALUE = 2\n", "second")

    def record(self, scenario, cost, shas):
        return SessionRecord(
            id=f"{scenario}-{cost}", harness="pi", source_path="fixture", schema_version="x",
            started_at=datetime(2026, 9, 10, 11, tzinfo=timezone.utc),
            ended_at=datetime(2026, 9, 10, 13, tzinfo=timezone.utc),
            cwd=str(self.repo), model="test", provider="test", cost_native_usd=cost,
            commits=frozenset(shas), observed_topology=scenario,
        )

    def cohort(self, rows, name):
        return next(row for row in rows if row.cohort == name)

    def test_shared_sha_is_mixed_and_absent_from_scenario_denominators(self):
        rows = delivery_efficiency.analyze_delivery_efficiency([
            self.record("S1", 10.0, {self.sha}),
            self.record("S4", 20.0, {self.sha}),
        ], TODAY)

        self.assertEqual(self.cohort(rows, "mixed").durable_shas, frozenset({self.sha}))
        self.assertFalse(any(row.cohort in {"S1", "S4"} and self.sha in row.durable_shas for row in rows))

    def test_session_cost_is_split_across_its_durable_changes(self):
        rows = delivery_efficiency.analyze_delivery_efficiency([
            self.record("S3", 30.0, {self.sha, self.other_sha}),
        ], TODAY)

        row = self.cohort(rows, "S3")
        self.assertEqual(row.attributable_cost, 30.0)
        self.assertEqual(row.cdpc, 15.0)

    def test_unattributable_session_lowers_coverage(self):
        rows = delivery_efficiency.analyze_delivery_efficiency([
            self.record("S3", 100.0, {self.sha}),
            self.record("S3", 100.0, set()),
        ], TODAY)

        row = self.cohort(rows, "S3")
        self.assertEqual(row.coverage, 0.5)
        self.assertEqual(row.status, "insufficient-coverage")


if __name__ == "__main__":
    unittest.main()
