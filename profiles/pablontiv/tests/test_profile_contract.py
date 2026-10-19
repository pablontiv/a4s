from __future__ import annotations

import re
import unittest
from pathlib import Path
from typing import Any, cast

import yaml

PROFILE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PROFILE_ROOT.parents[1]
TEMPLATE_PATH = PROFILE_ROOT / "config.template.yaml"
WORKFLOW_REFERENCE_PATH = REPO_ROOT / ".workspace" / "docs" / "workflow-reference.md"
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




class WorkflowReferenceTests(unittest.TestCase):
    def test_reference_is_informative_and_not_operational_config(self) -> None:
        self.assertFalse((REPO_ROOT / ".workspace" / "config.yaml").exists())
        reference = WORKFLOW_REFERENCE_PATH.read_text(encoding="utf-8")
        self.assertIn(
            "documentación informativa sin autoridad operativa",
            reference,
        )


if __name__ == "__main__":
    unittest.main()
