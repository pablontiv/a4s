import os
import subprocess
import unittest
from datetime import date
from pathlib import Path
from tempfile import TemporaryDirectory

import delivery_efficiency


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

    def test_doc_and_test_only_commits_are_excluded(self):
        doc_sha = self.commit("README.md", "docs\n", "docs")
        test_sha = self.commit("tests/test_app.py", "assert True\n", "test")

        self.assertEqual(
            delivery_efficiency.inspect_commit(self.repo, doc_sha, TODAY).eligibility,
            "excluded-noncode",
        )
        self.assertEqual(
            delivery_efficiency.inspect_commit(self.repo, test_sha, TODAY).eligibility,
            "excluded-noncode",
        )

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


if __name__ == "__main__":
    unittest.main()
