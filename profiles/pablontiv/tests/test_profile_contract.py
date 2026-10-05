from __future__ import annotations

import re
import unittest
from pathlib import Path
from typing import Any, cast

import yaml

PROFILE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PROFILE_ROOT.parents[1]
TEMPLATE_PATH = PROFILE_ROOT / "config.template.yaml"
DOGFOOD_CONFIG_PATH = REPO_ROOT / ".workspace" / "config.yaml"
PROFILE_VERSION = 2

CONFIG_AXES = (
    "context_sources",
    "base_branch",
    "sync_strategy",
    "isolation_strategy",
    "development_workflow",
    "commit_policy",
    "delivery_mode",
    "delivery_gate",
    "pre_checks",
    "acceptance_checks",
    "review_checks",
    "post_checks",
    "monitoring",
    "external_effects",
    "credential_policy",
    "knowledge_policy",
    "cleanup_policy",
    "custom_rules",
)
FORBIDDEN_CONTROL_FIELDS = (
    "executor",
    "timeout_seconds",
    "success",
    "on_failure",
)
AGENT_RUNTIME_TERM_PATTERN = re.compile(
    r"\b(?:agents?|subagents?|orchestrators?|workers?)\b",
    re.IGNORECASE,
)
AGENT_RUNTIME_POLICY_PATHS = (
    ("workspace", "authority", "derived"),
    ("workspace", "roles", "implementer"),
    ("workspace", "do_work", "knowledge"),
    ("workspace", "accept_work", "end_to_end"),
    ("repository", "entry_point"),
)


def parse_yaml_mapping(text: str) -> dict[str, Any]:
    document = yaml.safe_load(text)
    if not isinstance(document, dict) or not all(
        isinstance(key, str) for key in document
    ):
        raise AssertionError("YAML document must have a string-keyed mapping root")
    return cast(dict[str, Any], document)


def forbidden_control_fields(value: Any) -> tuple[str, ...]:
    found: set[str] = set()

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            for key, child in node.items():
                if key in FORBIDDEN_CONTROL_FIELDS:
                    found.add(key)
                visit(child)
        elif isinstance(node, list):
            for child in node:
                visit(child)

    visit(value)
    return tuple(field for field in FORBIDDEN_CONTROL_FIELDS if field in found)


def agent_specific_config_markers(document: dict[str, Any]) -> tuple[str, ...]:
    found: list[str] = []

    def scalar(path: tuple[str, ...]) -> str | None:
        node: Any = document
        for key in path:
            if not isinstance(node, dict):
                return None
            node = node.get(key)
        if not isinstance(node, str):
            return None
        return node.replace("_", " ").replace("-", " ")

    def mark_when(
        label: str,
        path: tuple[str, ...],
        *patterns: str,
    ) -> None:
        text = scalar(path)
        if text is not None and all(
            re.search(pattern, text, re.IGNORECASE) for pattern in patterns
        ):
            if label not in found:
                found.append(label)

    for path in AGENT_RUNTIME_POLICY_PATHS:
        mark_when("agent runtime terminology", path, AGENT_RUNTIME_TERM_PATTERN.pattern)

    credentials_path = ("workspace", "do_work", "credentials")
    credential_terms = r"\b(?:credentials?|authentication|provider)\b"
    mark_when(
        "TypeSafe credential binding",
        credentials_path,
        r"\bTypeSafe\b",
        credential_terms,
    )
    mark_when(
        "Pi credential binding",
        credentials_path,
        r"\bPi\b",
        credential_terms,
    )
    mark_when(
        "generated-text disclosure",
        ("workspace", "do_work", "communication"),
        r"\b(?:AI|machine generated|model generated|generated text)\b",
        r"\bdisclos(?:e|es|ed|ure)\b",
    )
    mark_when(
        "model/provider reviewer routing",
        ("workspace", "accept_work", "review"),
        r"\bmodel\b",
        r"\b(?:family|lineage|provider)\b",
    )
    mark_when(
        "Pi session binding",
        ("workspace", "track_work", "controller_identity"),
        r"\bPi\b",
        r"\bsession\b",
    )
    return tuple(found)


def h2_body(profile: str, heading: str) -> str:
    match = re.search(
        rf"^## (?:\d+\. )?{re.escape(heading)}\n(?P<body>.*?)(?=^## |\Z)",
        profile,
        re.MULTILINE | re.DOTALL,
    )
    return match.group("body") if match else ""


def section_contract_violations(profile: str) -> tuple[str, ...]:
    headings = tuple(re.findall(r"^## (?:\d+\. )?(.+)$", profile, re.MULTILINE))
    return () if headings == PROFILE_SECTIONS else ("ordered sections",)


def category_contract_violations(profile: str) -> tuple[str, ...]:
    violations = [
        f"missing marker: {marker}"
        for marker in BASE_CONTRACT_MARKERS
        if marker not in profile
    ]

    invariant_ids = tuple(
        re.findall(
            r"^\d+\. \*\*(INV-\d{2})\b",
            h2_body(profile, "Invariantes"),
            re.MULTILINE,
        )
    )
    if invariant_ids != INVARIANT_IDS:
        violations.append("invariant IDs")

    workflow_phases = tuple(
        re.findall(
            r"^### (Fase \d+)\b",
            h2_body(profile, "Flujo de trabajo"),
            re.MULTILINE,
        )
    )
    if workflow_phases != WORKFLOW_PHASES:
        violations.append("workflow phases")

    state_body = h2_body(profile, "Contrato de los controles").partition(
        "Los estados canónicos son:"
    )[2]
    control_states = tuple(re.findall(r"^- `([a-z_]+)`:", state_body, re.MULTILINE))
    if control_states != CONTROL_STATES:
        violations.append("canonical states")

    return tuple(violations)


def routed_artifacts(profile: str) -> tuple[tuple[str, str], ...]:
    routing_body = h2_body(profile, "Ejes configurables").partition(
        "### Routing de artefactos publicados"
    )[2]
    return tuple(
        (match.group("artifact"), match.group("prose"))
        for match in re.finditer(
            r"^(?:- )?`(?P<artifact>[a-z0-9-]+)`(?::)? "
            r"(?P<prose>[^\n]+)$",
            routing_body,
            re.MULTILINE,
        )
    )


def routing_contract_violations(
    profile: str,
    artifacts: set[str],
) -> tuple[str, ...]:
    routes = routed_artifacts(profile)
    routed_names = tuple(artifact for artifact, _ in routes)
    violations = []
    if set(routed_names) != artifacts or len(routed_names) != len(set(routed_names)):
        violations.append("artifact inventory")
    triggerless = sorted(
        artifact
        for artifact, prose in routes
        if CONDITIONAL_TRIGGER.search(prose) is None
    )
    if triggerless:
        violations.append("triggerless routes: " + ", ".join(triggerless))
    return tuple(violations)


class YamlContractParsingTests(unittest.TestCase):
    def test_parser_accepts_comments_and_valid_reindentation(self) -> None:
        parsed = parse_yaml_mapping(
            "workspace:  # logical layer\n"
            "    workflow:\n"
            "        base_branch: main\n"
            "groups: {}\n"
        )
        self.assertEqual(parsed["workspace"]["workflow"]["base_branch"], "main")

    def test_parser_rejects_non_mapping_root(self) -> None:
        with self.assertRaisesRegex(AssertionError, "mapping root"):
            parse_yaml_mapping("- workspace\n- groups\n")

    def test_forbidden_fields_are_found_recursively(self) -> None:
        parsed = parse_yaml_mapping(
            "workspace:\n"
            "  custom_rules:\n"
            "    - executor: shell\n"
            "      nested:\n"
            "        timeout_seconds: 30\n"
            "repositories:\n"
            "  pablontiv/a4s:\n"
            "    success: exit-zero\n"
            "    hooks:\n"
            "      - on_failure: stop\n"
        )
        self.assertEqual(forbidden_control_fields(parsed), FORBIDDEN_CONTROL_FIELDS)




class DogfoodConfigTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.config = DOGFOOD_CONFIG_PATH.read_text(encoding="utf-8")
        cls.document = parse_yaml_mapping(cls.config)
        workspace = cls.document.get("workspace")
        repository = cls.document.get("repository")
        if not isinstance(workspace, dict) or not isinstance(repository, dict):
            raise TypeError("workspace and repository must be mappings")
        cls.workspace = cast(dict[str, Any], workspace)
        cls.repository = cast(dict[str, Any], repository)

    def test_config_has_only_canonical_logical_layers(self) -> None:
        self.assertEqual(set(self.document), {"workspace", "repository"})
        self.assertEqual(
            set(self.workspace),
            {
                "purpose",
                "authority",
                "roles",
                "choose_work",
                "define_work",
                "prepare_work",
                "do_work",
                "accept_work",
                "deliver_work",
                "track_work",
                "improve_work",
                "product",
            },
        )

    def test_delivery_policy_is_risk_based_and_requires_remote_ci(self) -> None:
        deliver = self.workspace["deliver_work"]
        mechanism = deliver["mechanism"]
        merge = deliver["merge"]
        for marker in ("pull request", "conventional commits", "checks"):
            with self.subTest(surface="mechanism", marker=marker):
                self.assertIn(marker, mechanism)
        for marker in (
            "applicable local checks",
            "accept_work.review",
            "no unresolved HIGH",
            "remote CI",
            "history-only rebase",
            "--match-head-commit",
        ):
            with self.subTest(surface="merge", marker=marker):
                self.assertIn(marker, merge)
        review = self.workspace["accept_work"]["review"]
        self.assertIn("one independent review", review)
        self.assertNotIn("different model family or provider", review)
        self.assertNotIn("billing_exception", deliver)

    def test_work_units_and_kinds_preserve_profile_contract(self) -> None:
        define = self.workspace["define_work"]
        self.assertEqual(set(define["units"]), {"epic", "task"})
        self.assertEqual(
            set(define["kinds"]),
            {"research", "experiment", "documentation", "implementation"},
        )
        for label in (
            "kind-research",
            "kind-experiment",
            "kind-documentation",
            "kind-implementation",
        ):
            with self.subTest(label=label):
                self.assertIn(label, define["beads"])

    def test_starting_point_is_observable_and_fail_closed(self) -> None:
        do_work = self.workspace["do_work"]
        starting_point = do_work["starting_point"]
        # The literal git commands are procedure and live in the work-lifecycle
        # skill; config states the sync invariant (authority.mechanism).
        for required in (
            "main branch",
            "clean working tree",
            "synchronized with origin/main",
            "dedicated worktree",
        ):
            with self.subTest(required=required):
                self.assertIn(required, starting_point)
        self.assertIn("Stop any mutation", do_work["safety"])

    def test_config_names_required_security_and_knowledge_authorities(self) -> None:
        for required in (
            "pablontiv/a4s",
            "Rootline",
            ".workspace/docs/",
            ".workspace/secrets/",
            "SOPS",
        ):
            with self.subTest(required=required):
                self.assertIn(required, self.config)
        credentials = self.workspace["do_work"]["credentials"]
        self.assertIn("approved credential mechanism", credentials)

    def test_config_contains_no_agent_specific_policy(self) -> None:
        self.assertEqual(agent_specific_config_markers(self.document), ())

    def test_runtime_neutral_workflow_replacements_are_preserved(self) -> None:
        self.assertIn(
            "One participant may fulfill both the executor and implementer roles",
            self.workspace["roles"]["implementer"],
        )
        self.assertIn(
            "Before an executable integration is released or activated",
            self.workspace["accept_work"]["end_to_end"],
        )
        self.assertIn(
            "A PR the operator did not originate",
            self.workspace["deliver_work"]["external_prs"],
        )
        self.assertIn(
            "PRs authored by repository automation are exempt from the trailer",
            self.workspace["deliver_work"]["mechanism"],
        )
        self.assertIn(
            "A request from the operator for progress information does not stop",
            self.workspace["do_work"]["modes"]["autonomous"],
        )

    def test_agent_specific_policy_detection_covers_semantic_variants(self) -> None:
        cases = (
            (
                "agent runtime terminology",
                ("workspace", "accept_work", "end_to_end"),
                "Dispatch each Worker through the consuming runtime.",
            ),
            (
                "TypeSafe credential binding",
                ("workspace", "do_work", "credentials"),
                "The credential provider approved for TypeSafe supplies authentication.",
            ),
            (
                "Pi credential binding",
                ("workspace", "do_work", "credentials"),
                "Through the configured provider, credentials for Pi are resolved.",
            ),
            (
                "Pi session binding",
                ("workspace", "track_work", "controller_identity"),
                "session identity from PI",
            ),
            (
                "generated-text disclosure",
                ("workspace", "do_work", "communication"),
                "For machine-generated text, no disclosure is needed.",
            ),
            (
                "model/provider reviewer routing",
                ("workspace", "accept_work", "review"),
                "Provider diversity should guide selection across a model lineage.",
            ),
        )
        for expected, path, policy in cases:
            with self.subTest(expected=expected, policy=policy):
                document: dict[str, Any] = {"workspace": {}, "repository": {}}
                target = document
                for key in path[:-1]:
                    target = target.setdefault(key, {})
                target[path[-1]] = policy
                self.assertIn(expected, agent_specific_config_markers(document))

    def test_agent_specific_policy_detection_allows_neutral_config(self) -> None:
        neutral = {
            "workspace": {
                "track_work": {"controller_identity": "lease-holder"},
                "product": {
                    "metadata": {"user_agent": "a4s-client"},
                    "providers": ["TypeSafe"],
                },
            },
            "repository": {"entry_point": "src/main.py"},
        }
        self.assertEqual(agent_specific_config_markers(neutral), ())


    def test_external_effects_and_reserved_authority_are_explicit(self) -> None:
        external = self.workspace["do_work"]["external_effects"]
        reserved = self.workspace["deliver_work"]["reserved_authority"]
        for marker in (
            "read-only",
            "operator authorization",
            "recovery",
            "verify postconditions",
        ):
            with self.subTest(surface="external", marker=marker):
                self.assertIn(marker, external)
        for marker in (
            "every change to this file",
            "live external effect",
            "destructive cleanup",
            "bounded deviation",
        ):
            with self.subTest(surface="reserved", marker=marker):
                self.assertIn(marker, reserved)


    def test_config_rejects_deterministic_control_fields(self) -> None:
        actual = tuple(
            field for field in forbidden_control_fields(self.document) if field != "executor"
        )
        self.assertEqual(actual, ())
        mutated = self.config.replace(
            "  track_work:\n",
            "  track_work:\n"
            "    timeout_seconds: 30\n"
            "    success: exit-zero\n"
            "    on_failure: stop\n",
            1,
        )
        mutated_fields = tuple(
            field
            for field in forbidden_control_fields(parse_yaml_mapping(mutated))
            if field != "executor"
        )
        self.assertEqual(mutated_fields, FORBIDDEN_CONTROL_FIELDS[1:])

    def test_config_contains_no_template_or_local_path_placeholders(self) -> None:
        self.assertNotIn("{" * 2, self.config)
        self.assertNotIn("TO" + "DO", self.config)
        self.assertNotIn("/Users/", self.config)

    def test_repository_binding_is_public_and_source_canonical(self) -> None:
        self.assertEqual(
            self.repository,
            {
                "id": "pablontiv/a4s",
                "url": "https://github.com/pablontiv/a4s.git",
                "base_branch": "main",
            },
        )


if __name__ == "__main__":
    unittest.main()
