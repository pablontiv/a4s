from __future__ import annotations

import hashlib
import json
import re
import subprocess
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
PUBLICATION_ROOT = ROOT / ".github" / "publication"
MANIFEST_PATH = PUBLICATION_ROOT / "desired-state.json"
DIGEST_PATH = PUBLICATION_ROOT / "desired-state.json.sha256"
WORKFLOW_ROOT = ROOT / ".github" / "workflows"


class PublicationSecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest_bytes = MANIFEST_PATH.read_bytes()
        cls.manifest = json.loads(cls.manifest_bytes)

    def test_sensitive_local_files_are_ignored(self) -> None:
        ignored = (
            ".env",
            ".env.local",
            ".npmrc",
            ".pypirc",
            ".netrc",
            "private.agekey",
            "id_ed25519",
            "certificate.pem",
            "signing.key",
            "credentials.json",
            "service-account-production.json",
            "secret.decrypted.yaml",
        )
        result = subprocess.run(
            ["git", "check-ignore", "--no-index", "--stdin"],
            cwd=ROOT,
            input=("\n".join(ignored) + "\n").encode("ascii"),
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        self.assertEqual(result.stdout.decode("ascii").splitlines(), list(ignored))

        examples = subprocess.run(
            ["git", "check-ignore", "--no-index", ".env.example"],
            cwd=ROOT,
            capture_output=True,
            check=False,
        )
        self.assertEqual(examples.returncode, 1, examples.stdout.decode(errors="replace"))

    def test_packages_are_private_and_explicitly_unlicensed(self) -> None:
        package_paths = (ROOT / "package.json", *sorted((ROOT / "packages").glob("*/package.json")))
        for path in package_paths:
            with self.subTest(package=path.relative_to(ROOT)):
                package = json.loads(path.read_text(encoding="utf-8"))
                self.assertIs(package.get("private"), True)
                self.assertEqual(package.get("license"), "UNLICENSED")
                self.assertEqual(
                    package.get("repository", {}).get("url"),
                    "git+https://github.com/pablontiv/a4s.git",
                )
                self.assertEqual(
                    package.get("bugs", {}).get("url"),
                    "https://github.com/pablontiv/a4s/issues",
                )

    def test_workflows_are_bounded_and_supply_chain_hardened(self) -> None:
        for path in sorted(WORKFLOW_ROOT.glob("*.yml")):
            workflow = path.read_text(encoding="utf-8")
            parsed = yaml.safe_load(workflow)
            with self.subTest(workflow=path.name):
                self.assertNotIn("pull_request_target", workflow)
                self.assertEqual(parsed.get("permissions"), {"contents": "read"})
                self.assertEqual(parsed.get("concurrency", {}).get("cancel-in-progress"), True)
                self.assertIn("persist-credentials: false", workflow)

                jobs = parsed.get("jobs", {})
                self.assertIsInstance(jobs, dict)
                for job_name, job in jobs.items():
                    with self.subTest(workflow=path.name, job=job_name):
                        self.assertIsInstance(job, dict)
                        self.assertIn("timeout-minutes", job)

                action_refs = re.findall(r"^\s*(?:-\s*)?uses: \S+@([^\s]+)$", workflow, re.MULTILINE)
                self.assertTrue(action_refs)
                for ref in action_refs:
                    self.assertRegex(ref, r"^[0-9a-f]{40}$")

        ci_workflow = (WORKFLOW_ROOT / "ci.yml").read_text(encoding="utf-8")
        self.assertNotIn("go-version: stable", ci_workflow)
        self.assertIn('go-version: "1.27.1"', ci_workflow)

    def test_publication_manifest_is_prepare_only_and_fail_closed(self) -> None:
        self.assertEqual(self.manifest["api_version"], "2026-03-10")
        self.assertEqual(self.manifest["repository"], "pablontiv/a4s")
        self.assertEqual(self.manifest["mode"], "prepare-only")
        self.assertEqual(self.manifest["target_visibility"], "public")
        self.assertGreaterEqual(len(self.manifest["publication_blocked_until"]), 5)

        validation = self.manifest["candidate_validation"]
        self.assertIn("test/ci-local.sh", validation["required"][0])
        self.assertIn("independent reviewer", validation["required"][1])
        exception = validation["temporary_remote_ci_exception"]
        self.assertIn("billing or quota", exception["reason"])
        self.assertIn("not a passing check", exception["limits"])
        self.assertIn("does not weaken the nine checks", exception["limits"])

        requests = self.manifest["requests"]
        expected_requests = [
            ("pre-public", "PATCH", "/repos/pablontiv/a4s"),
            ("pre-public", "PUT", "/repos/pablontiv/a4s/actions/permissions"),
            ("pre-public", "PUT", "/repos/pablontiv/a4s/actions/permissions/selected-actions"),
            ("pre-public", "PUT", "/repos/pablontiv/a4s/actions/permissions/workflow"),
            ("pre-public", "PUT", "/repos/pablontiv/a4s/immutable-releases"),
            ("pre-public", "PUT", "/repos/pablontiv/a4s/branches/main/protection"),
            ("pre-public", "POST", "/repos/pablontiv/a4s/branches/main/protection/required_signatures"),
            ("pre-public", "PUT", "/repos/pablontiv/a4s/vulnerability-alerts"),
            ("pre-public", "PUT", "/repos/pablontiv/a4s/automated-security-fixes"),
            ("publish", "PATCH", "/repos/pablontiv/a4s"),
            ("post-public", "PATCH", "/repos/pablontiv/a4s"),
            ("post-public", "PUT", "/repos/pablontiv/a4s/private-vulnerability-reporting"),
            ("post-public", "PATCH", "/repos/pablontiv/a4s/code-scanning/default-setup"),
            (
                "post-public",
                "PUT",
                "/repos/pablontiv/a4s/actions/permissions/fork-pr-contributor-approval",
            ),
        ]
        self.assertEqual(
            [(request["phase"], request["method"], request["endpoint"]) for request in requests],
            expected_requests,
        )

        publication = [
            request
            for request in requests
            if request["endpoint"] == "/repos/pablontiv/a4s"
            and request.get("body") == {"visibility": "public"}
        ]
        self.assertEqual(len(publication), 1)
        self.assertEqual(publication[0]["phase"], "publish")

        repository_settings = requests[0]["body"]
        self.assertEqual(repository_settings["pull_request_creation_policy"], "collaborators_only")
        self.assertIs(repository_settings["has_issues"], True)
        self.assertIs(repository_settings["has_projects"], False)
        self.assertIs(repository_settings["has_wiki"], False)
        self.assertIs(repository_settings["has_discussions"], False)
        self.assertIs(repository_settings["allow_squash_merge"], True)
        self.assertIs(repository_settings["allow_merge_commit"], False)
        self.assertIs(repository_settings["allow_rebase_merge"], False)

        immutable_releases = next(
            request
            for request in requests
            if request["endpoint"] == "/repos/pablontiv/a4s/immutable-releases"
        )
        self.assertIsNone(immutable_releases["body"])

        actions = next(
            request
            for request in requests
            if request["endpoint"] == "/repos/pablontiv/a4s/actions/permissions"
        )
        self.assertEqual(actions["body"]["allowed_actions"], "selected")
        self.assertIs(actions["body"]["sha_pinning_required"], True)

        protection = next(
            request
            for request in requests
            if request["endpoint"] == "/repos/pablontiv/a4s/branches/main/protection"
        )
        checks = protection["body"]["required_status_checks"]["checks"]
        self.assertEqual(len(checks), 9)
        self.assertTrue(all(check["app_id"] == 15368 for check in checks))
        self.assertIs(protection["body"]["enforce_admins"], True)
        self.assertIs(protection["body"]["allow_force_pushes"], False)
        self.assertIs(protection["body"]["allow_deletions"], False)

        manual = self.manifest["manual_operations"]
        self.assertEqual(len(manual), 1)
        self.assertIn("Issues", manual[0]["surface"])
        self.assertEqual(manual[0]["action"], "Select Collaborators only")

    def test_manifest_digest_is_current(self) -> None:
        expected = hashlib.sha256(self.manifest_bytes).hexdigest()
        digest_line = DIGEST_PATH.read_text(encoding="ascii").strip()
        self.assertEqual(digest_line, f"{expected}  desired-state.json")

    def test_publication_policies_are_present(self) -> None:
        security = (ROOT / ".github" / "SECURITY.md").read_text(encoding="utf-8")
        contributing = (ROOT / ".github" / "CONTRIBUTING.md").read_text(encoding="utf-8")
        notice = (ROOT / "NOTICE").read_text(encoding="utf-8")
        owners = (ROOT / ".github" / "CODEOWNERS").read_text(encoding="utf-8")

        self.assertIn("Report a vulnerability", security)
        self.assertIn("Only the repository administrator", contributing)
        self.assertIn("no license is granted", notice)
        self.assertIn("* @pablontiv", owners)


if __name__ == "__main__":
    unittest.main()
