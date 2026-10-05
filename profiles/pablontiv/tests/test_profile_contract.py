from __future__ import annotations

import hashlib
import re
import unittest
from pathlib import Path
from typing import Any, cast

import yaml

PROFILE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PROFILE_ROOT.parents[1]
PROFILE_PATH = PROFILE_ROOT / "PROFILE.md"
BOOTSTRAP_PATH = PROFILE_ROOT / "bootstrap.md"
TEMPLATE_PATH = PROFILE_ROOT / "config.template.yaml"
SOURCE_PATH = REPO_ROOT / ".workspace" / "docs" / "references" / "engineering-handbook-v1.4.md"
SOURCE_SHA256 = "f5455e3eced13690358b02823053a1e00a6c7c06de5f17d9716805bf0a0cff26"
DOGFOOD_CONFIG_PATH = REPO_ROOT / ".workspace" / "config.yaml"
PROFILE_VERSION = 2

PROFILE_SECTIONS = (
    "Propósito",
    "Principios de diseño",
    "Modelo de workspace",
    "Resolución de configuración",
    "Contrato de los controles",
    "Ejes configurables",
    "Valores por defecto",
    "Flujo de trabajo",
    "Invariantes",
    "Configuración mínima por repositorio",
    "Ejemplo no normativo de binding",
    "Precedencia frente a steering y automatización",
    "Seguridad y sistemas externos",
    "Adopción",
    "Criterios de aceptación",
    "Fuera de alcance",
)

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

BASE_CONTRACT_MARKERS = (
    "workspace → group → repository",
    "Los escalares de una capa más específica reemplazan",
    "Los mapas se combinan recursivamente",
    "Las listas se reemplazan completas",
)

INVARIANT_IDS = tuple(f"INV-{number:02d}" for number in range(1, 14))
WORKFLOW_PHASES = tuple(f"Fase {number}" for number in range(9))
CONTROL_STATES = (
    "pending",
    "passed",
    "failed",
    "skipped",
    "unknown",
    "not_applicable",
)
CONDITIONAL_TRIGGER = re.compile(
    r"\bse activa (?:al|como|cuando|después|para|tras|únicamente)\b"
)


def published_artifacts() -> set[str]:
    skills = {path.parent.name for path in (REPO_ROOT / "skills").glob("*/SKILL.md")}
    agents = {path.stem for path in (REPO_ROOT / "skills").glob("*/agents/pi/*.md")}
    methods = {path.parent.name for path in (REPO_ROOT / "methods").glob("*/METHOD.md")}
    styles = {path.stem for path in (REPO_ROOT / "output-styles").glob("*.md")}
    return skills | agents | methods | styles


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


class ProfileContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.profile = PROFILE_PATH.read_text(encoding="utf-8")
        cls.bootstrap = BOOTSTRAP_PATH.read_text(encoding="utf-8")
        cls.template = TEMPLATE_PATH.read_text(encoding="utf-8")
        cls.template_document = parse_yaml_mapping(cls.template)

    def test_source_snapshot_has_approved_digest(self) -> None:
        self.assertEqual(
            hashlib.sha256(SOURCE_PATH.read_bytes()).hexdigest(),
            SOURCE_SHA256,
        )

    def test_profile_preserves_all_base_sections(self) -> None:
        self.assertEqual(section_contract_violations(self.profile), ())

    def test_contract_rejects_reversed_headings(self) -> None:
        mutated = self.profile.replace("## 1. Propósito", "## SWAP", 1)
        mutated = mutated.replace("## 2. Principios de diseño", "## 1. Propósito", 1)
        mutated = mutated.replace("## SWAP", "## 2. Principios de diseño", 1)
        self.assertTrue(section_contract_violations(mutated))

    def test_profile_preserves_contract_categories(self) -> None:
        self.assertEqual(category_contract_violations(self.profile), ())

    def test_contract_rejects_removed_or_extra_categories(self) -> None:
        mutations = (
            ("missing invariant", self.profile.replace("**INV-13", "**RULE-13", 1)),
            ("missing phase", self.profile.replace("### Fase 4", "### Etapa 4", 1)),
            ("missing state", self.profile.replace("- `pending`:", "- `queued`:", 1)),
            (
                "extra state",
                self.profile.replace(
                    "- `passed`:",
                    "- `running`: ejecución iniciada;\n- `passed`:",
                    1,
                ),
            ),
        )
        for label, mutated in mutations:
            with self.subTest(label=label):
                self.assertTrue(category_contract_violations(mutated))

    def test_template_preserves_layers_and_axes(self) -> None:
        for layer in ("workspace", "groups", "repositories"):
            self.assertIn(layer, self.template_document)
        workspace = self.template_document.get("workspace")
        self.assertIsInstance(workspace, dict)
        assert isinstance(workspace, dict)
        workflow = workspace.get("workflow")
        self.assertIsInstance(workflow, dict)
        assert isinstance(workflow, dict)
        axis_keys = set(workspace) | set(workflow)
        for axis in CONFIG_AXES:
            with self.subTest(axis=axis):
                self.assertIn(axis, axis_keys)

    def test_profile_preserves_every_configurable_axis(self) -> None:
        axes = h2_body(self.profile, "Ejes configurables")
        for axis in CONFIG_AXES:
            with self.subTest(axis=axis):
                self.assertIn(f"| `{axis}` |", axes)

    def test_template_rejects_deterministic_control_fields(self) -> None:
        self.assertEqual(forbidden_control_fields(self.template_document), ())
        mutated = self.template.replace(
            "  custom_rules: []",
            "  custom_rules: []\n  executor: shell",
            1,
        )
        self.assertEqual(
            forbidden_control_fields(parse_yaml_mapping(mutated)),
            ("executor",),
        )

    def test_profile_routes_every_published_artifact(self) -> None:
        self.assertEqual(
            routing_contract_violations(self.profile, published_artifacts()), ()
        )

    def test_profile_v2_routes_method_without_retired_edd_skill(self) -> None:
        self.assertIn(f"**Versión del perfil:** {PROFILE_VERSION}", self.profile)
        routes = dict(routed_artifacts(self.profile))
        self.assertIn("empirical-capability-development", routes)
        self.assertNotIn("evidence-driven-development", routes)
        self.assertFalse((REPO_ROOT / "skills" / "evidence-driven-development").exists())

    def test_template_declares_profile_v2(self) -> None:
        profile = self.template_document.get("profile")
        self.assertIsInstance(profile, dict)
        assert isinstance(profile, dict)
        self.assertEqual(profile.get("version"), PROFILE_VERSION)

    def test_contract_rejects_unlisted_and_stale_routes(self) -> None:
        published = published_artifacts()
        stale_route = (
            "\n- `retired-artifact`: se activa cuando aparece una señal retirada.\n"
        )
        mutated = self.profile.replace(
            "\n## 7. Valores por defecto",
            stale_route + "\n## 7. Valores por defecto",
            1,
        )
        cases = (
            (
                "unlisted published artifact",
                self.profile,
                published | {"future-artifact"},
            ),
            ("stale routed artifact", mutated, published),
        )
        for label, profile, artifacts in cases:
            with self.subTest(label=label):
                self.assertTrue(routing_contract_violations(profile, artifacts))

    def test_contract_rejects_triggerless_routes(self) -> None:
        mutated = self.profile.replace(
            "- `adr`: se activa", "- `adr`: está disponible", 1
        )
        self.assertTrue(routing_contract_violations(mutated, published_artifacts()))

    def test_profile_requires_rootline_backscroll_and_pi(self) -> None:
        for required in ("Rootline", "Backscroll", "Pi"):
            self.assertIn(required, self.profile)

    def test_remove_gentle_context_scope_is_bounded(self) -> None:
        paragraph = next(
            block
            for block in self.profile.split("\n\n")
            if "`remove-gentle-context`" in block
        )
        self.assertIn("contexto activo", paragraph)
        self.assertIn("no desinstala", paragraph)

    def test_bootstrap_preserves_safe_order(self) -> None:
        markers = (
            "inspección de solo lectura",
            "configuración candidata",
            "aprobación humana explícita",
            "escritura durable",
            "verificación posterior",
        )
        positions = [self.bootstrap.index(marker) for marker in markers]
        self.assertEqual(positions, sorted(positions))
        self.assertIn("unknown", self.bootstrap)
        self.assertIn("bloquea", self.bootstrap)

    def test_repository_identity_uses_relocatable_origin_locator(self) -> None:
        for document in (self.profile, self.bootstrap, self.template):
            with self.subTest(document=document[:40]):
                self.assertIn("repositorio de origen", document)
                self.assertIn("git remote get-url origin", document)
        self.assertNotIn("ruta física canónica", self.profile)


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

    def test_config_authority_is_scoped_to_project_work(self) -> None:
        source = self.workspace["authority"]["source"]
        self.assertIn("repository-local project-work policy", source)
        self.assertIn("A project-work rule absent from it is not in force", source)
        self.assertNotIn("repository's way of working", source)

        derived = self.workspace["authority"]["derived"]
        self.assertIn("repository README", derived)
        self.assertIn("repository-policy contract tests", derived)
        self.assertIn(
            "no repository-local project-work policy rule of their own",
            self.workspace["authority"]["mechanism"],
        )

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

    def test_agent_entry_point_is_rejected_by_value_not_key(self) -> None:
        document = {
            "workspace": {},
            "repository": {"entry_point": "AGENTS.md"},
        }
        self.assertEqual(
            agent_specific_config_markers(document),
            ("agent runtime terminology",),
        )

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

    def test_post_merge_cleanup_is_mandatory_bounded_and_fail_closed(self) -> None:
        readiness = self.workspace["prepare_work"]["shared_readiness"]
        evidence = self.workspace["accept_work"]["evidence"]
        close = self.workspace["deliver_work"]["close"]
        reserved = self.workspace["deliver_work"]["reserved_authority"]
        cleanup = self.workspace["improve_work"]["cleanup"]

        for marker in ("durable evidence", "reproducible-disposable", "retained local evidence"):
            with self.subTest(surface="readiness", marker=marker):
                self.assertIn(marker, readiness)
        for marker in ("sanitized result", "Raw session or provider output", "disposable"):
            with self.subTest(surface="evidence", marker=marker):
                self.assertIn(marker, evidence)
        # close states the closure-gate invariant; the exact cleanup targets
        # (worktree, branches, PR head) are bounded in improve_work.cleanup.
        for marker in (
            "main equals origin/main",
            "unintegrated change",
            "retained output",
        ):
            with self.subTest(surface="close", marker=marker):
                self.assertIn(marker, close)
        for marker in (
            "mandatory and preauthorized",
            "exact task worktree",
            "integrated PR head",
            "delete nothing",
            "block closure",
            "Every other destructive cleanup",
        ):
            with self.subTest(surface="cleanup", marker=marker):
                self.assertIn(marker, cleanup)
        self.assertIn("bounded post-merge cleanup", reserved)

        for path in (PROFILE_PATH, TEMPLATE_PATH):
            document = path.read_text(encoding="utf-8")
            with self.subTest(path=path.name):
                self.assertIn("integración verificada", document)
                self.assertIn("guardas fail-closed", document)
                self.assertNotIn("nunca eliminar automáticamente", document)

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
