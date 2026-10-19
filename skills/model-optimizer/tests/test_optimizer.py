from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from helper.evaluator import RoleEvalResult, ToolAudit, essential_eval_selection_status
from helper.models import HealthCheck, HealthStatus, ModelRecord, RuntimeKind
from helper.optimizer import (
    BenchmarkObservation,
    CandidateEvidence,
    FixtureEvidence,
    IdentityMatch,
    RoleRequirements,
    RouteKey,
    RunObservation,
    choose_mapping,
    classify_identity,
    discover_agent_contracts,
    gate_candidate,
    parse_agent_definition,
    shortlist_candidates,
)


class SelectionPolicyTests(unittest.TestCase):
    def _role(self, **overrides):
        values = {
            "archetype": "mechanical",
            "required_tools": (),
            "essential_custom_tools": (),
            "requires_vision": False,
            "requires_mutation": False,
            "min_context": None,
            "min_output": None,
            "allowed_efforts": (),
            "structured_output": False,
            "adversarial_against_family": None,
            "priority_order": ("quality", "latency", "cost"),
        }
        values.update(overrides)
        return RoleRequirements(**values)

    def _route(self, model="nan/qwen3.6", effort="medium"):
        return RouteKey(RuntimeKind.PI, "0.84.2", model, effort)

    def _model(self, exact_id="nan/qwen3.6", **overrides):
        values = {
            "exact_id": exact_id,
            "provider": exact_id.split("/", 1)[0],
            "model": exact_id.split("/", 1)[1],
            "family": "qwen",
            "context_window": 128_000,
            "max_output": 16_000,
            "reasoning": True,
            "input_modes": ("text",),
            "tool_call": True,
            "variants": ("minimal", "medium", "high"),
        }
        values.update(overrides)
        return ModelRecord(**values)

    def _health(self, model="nan/qwen3.6", effort="medium", status=HealthStatus.PASS):
        return HealthCheck(model, effort, status, 1000, "live_sentinel_matched", status is HealthStatus.PASS, "ok")

    def _fixture(self, fixture_id, score, *, contract=True, success=True, elapsed=1000, reliable=True, interventions=0, cost=1.0):
        return FixtureEvidence(
            fixture_id,
            "v1",
            success,
            score,
            contract,
            (RunObservation(f"run-{fixture_id}", elapsed, reliable, interventions, cost),),
            (),
        )

    def _candidate(self, route=None, model=None, fixtures=(), incumbent=False, health=None, **metrics):
        route = route or self._route()
        model = model or self._model(route.model)
        health = health or self._health(route.model, route.effort)
        return CandidateEvidence(
            route,
            model,
            health,
            IdentityMatch.EXACT,
            tuple(fixtures),
            metrics.get("benchmark_score"),
            metrics.get("reliability_rate"),
            metrics.get("median_elapsed_ms"),
            metrics.get("metered_cost"),
            incumbent,
            metrics.get("infrastructure_status", "SAFE"),
            metrics.get("infrastructure_reasons", ()),
        )

    def test_gate_candidate_enforces_mandatory_model_health_and_role_requirements(self):
        text_route = self._route("nan/qwen3.6", "medium")
        text_only_model = self._model("nan/qwen3.6", input_modes=("text",))
        passing_health = self._health("nan/qwen3.6", "medium")
        vision_role = self._role(requires_vision=True)
        self.assertEqual(gate_candidate(vision_role, text_route, text_only_model, passing_health), ("required_vision_missing",))

        role = self._role(min_context=200_000, min_output=20_000, adversarial_against_family="qwen")
        self.assertEqual(gate_candidate(role, text_route, text_only_model, passing_health), (
            "context_window_too_small",
            "max_output_too_small",
            "adversarial_family_conflict",
        ))
        failing = self._health("nan/qwen3.6", "medium", HealthStatus.FAIL)
        self.assertEqual(gate_candidate(self._role(), text_route, text_only_model, failing), ("route_live_unavailable",))
        wrong_effort = self._route("nan/qwen3.6", "max")
        self.assertEqual(gate_candidate(self._role(allowed_efforts=("minimal", "medium")), wrong_effort, text_only_model, passing_health), (
            "route_live_effort_mismatch",
            "unsupported_effort",
            "disallowed_effort",
        ))

    def test_gate_candidate_fails_closed_for_unknown_required_capabilities_and_live_effort(self):
        route = self._route("nan/qwen3.6", "high")
        unknown_tool_model = self._model("nan/qwen3.6", tool_call=None, variants=())
        mismatched_health = self._health("nan/qwen3.6", "medium")
        self.assertEqual(gate_candidate(self._role(required_tools=("edit",)), route, unknown_tool_model, mismatched_health), (
            "route_live_effort_mismatch",
            "unsupported_effort",
            "required_tool_call_missing",
        ))
        mutation_role = self._role(requires_mutation=True)
        self.assertEqual(gate_candidate(mutation_role, self._route("nan/qwen3.6", None), unknown_tool_model, self._health("nan/qwen3.6", None)), (
            "required_mutation_missing",
        ))

    def test_shortlist_filters_unavailable_routes_preserves_incumbent_and_effort(self):
        role = self._role()
        current_route = self._route("nan/current", "minimal")
        candidates = [
            self._candidate(self._route("nan/current", "minimal"), self._model("nan/current"), [self._fixture("a", 0.60)], True),
            self._candidate(self._route("nan/new-1", "high"), self._model("nan/new-1"), [self._fixture("a", 0.90)]),
            self._candidate(self._route("nan/new-2", "medium"), self._model("nan/new-2"), [self._fixture("a", 0.80)]),
            self._candidate(self._route("nan/new-3", None), self._model("nan/new-3", variants=()), [self._fixture("a", 0.70)]),
            self._candidate(self._route("nan/new-4", "medium"), self._model("nan/new-4"), [self._fixture("a", 0.65)]),
            self._candidate(
                self._route("nan/failing", "medium"),
                self._model("nan/failing"),
                [self._fixture("a", 1.0)],
                health=self._health("nan/failing", "medium", HealthStatus.FAIL),
            ),
        ]
        shortlist = shortlist_candidates(role, candidates, incumbent=current_route, limit=4)
        self.assertEqual(len(shortlist), 4)
        self.assertIn(current_route, [item.route for item in shortlist])
        self.assertNotIn("nan/failing", [item.route.model for item in shortlist])
        self.assertIn("high", [item.route.effort for item in shortlist])

    def test_shortlist_operational_ordering_honors_role_priority_order(self):
        cheap_slow = self._candidate(
            self._route("nan/cheap-slow", "medium"),
            self._model("nan/cheap-slow"),
            [self._fixture("a", 0.80, elapsed=2000, cost=0.10)],
        )
        fast_expensive = self._candidate(
            self._route("nan/fast-expensive", "medium"),
            self._model("nan/fast-expensive"),
            [self._fixture("a", 0.80, elapsed=500, cost=1.00)],
        )
        self.assertEqual(
            shortlist_candidates(self._role(priority_order=("cost", "latency")), (cheap_slow, fast_expensive), None, limit=1)[0].route,
            cheap_slow.route,
        )
        self.assertEqual(
            shortlist_candidates(self._role(priority_order=("latency", "cost")), (cheap_slow, fast_expensive), None, limit=1)[0].route,
            fast_expensive.route,
        )

    def test_choose_mapping_handles_ties_abstention_and_material_fixture_advantage(self):
        role = self._role()
        current_route = self._route("nan/current", "medium")
        current_one = self._candidate(current_route, self._model("nan/current"), [self._fixture("one", 0.80)], True)
        challenger_one = self._candidate(self._route("nan/challenger", "high"), self._model("nan/challenger"), [self._fixture("one", 0.80)])
        self.assertEqual(choose_mapping(role, (current_one, challenger_one), current_route).status, "NEEDS_MORE_EVIDENCE")

        current_two = self._candidate(current_route, self._model("nan/current"), [self._fixture("one", 0.80), self._fixture("two", 0.80)], True)
        challenger_two = self._candidate(self._route("nan/challenger", "high"), self._model("nan/challenger"), [self._fixture("one", 0.80), self._fixture("two", 0.80)])
        self.assertEqual(choose_mapping(role, (current_two, challenger_two), current_route).status, "NO_CHANGE")

        failing = self._candidate(
            self._route("nan/failing", "medium"),
            self._model("nan/failing"),
            [self._fixture("one", 1.0)],
            health=self._health("nan/failing", "medium", HealthStatus.FAIL),
        )
        self.assertEqual(choose_mapping(role, (failing,), None).status, "ABSTAIN")

        material = self._candidate(self._route("nan/material", "high"), self._model("nan/material"), [self._fixture("one", 0.91), self._fixture("two", 0.92)])
        decision = choose_mapping(role, (current_two, material), current_route)
        self.assertEqual(decision.status, "CHANGE")
        self.assertEqual(decision.selected_route, material.route)
        self.assertEqual(decision.selected_route.effort, "high")

    def test_choose_mapping_abstains_on_essential_unsafe_infrastructure_including_incumbent(self):
        role = self._role()
        current_route = self._route("nan/current", "medium")
        unsafe_current = self._candidate(
            current_route,
            self._model("nan/current"),
            [self._fixture("one", 0.90), self._fixture("two", 0.90)],
            True,
            infrastructure_status="UNAVAILABLE",
            infrastructure_reasons=("eval_sandbox_unavailable",),
        )
        challenger = self._candidate(self._route("nan/challenger", "high"), self._model("nan/challenger"), [self._fixture("one", 0.95), self._fixture("two", 0.95)])
        decision = choose_mapping(role, (unsafe_current, challenger), current_route)
        self.assertEqual(decision.status, "ABSTAIN")
        self.assertEqual(decision.reasons, ("eval_sandbox_unavailable",))

        unsafe_challenger = self._candidate(
            self._route("nan/unsafe", "high"),
            self._model("nan/unsafe"),
            [self._fixture("one", 0.95), self._fixture("two", 0.95)],
            infrastructure_status="INCONCLUSIVE",
            infrastructure_reasons=("eval_opencode_auth_unavailable",),
        )
        decision = choose_mapping(role, (challenger, unsafe_challenger), None)
        self.assertEqual(decision.status, "ABSTAIN")
        self.assertEqual(decision.reasons, ("eval_opencode_auth_unavailable",))

    def test_pi_isolation_result_maps_to_candidate_infrastructure_and_abstains_with_or_without_incumbent(self):
        role = self._role()
        pi_route = self._route("nan/pi", "high")
        pi_result = RoleEvalResult(
            pi_route,
            "fixture",
            "v1",
            "sha256:" + "a" * 64,
            "INCONCLUSIVE",
            10,
            "",
            ToolAudit((), (), (), 0, ()),
            0,
            0,
            0,
            None,
            ("eval_pi_isolation_unavailable",),
        )

        def candidate_from_pi_result(route: RouteKey, incumbent: bool = False) -> CandidateEvidence:
            selection_status, reasons = essential_eval_selection_status((replace(pi_result, route=route),))
            infrastructure_status = "INCONCLUSIVE" if selection_status == "ABSTAIN" else "SAFE"
            return self._candidate(
                route,
                self._model(route.model),
                [self._fixture("one", 0.85), self._fixture("two", 0.86)],
                incumbent,
                infrastructure_status=infrastructure_status,
                infrastructure_reasons=reasons,
            )

        without_incumbent = candidate_from_pi_result(pi_route)
        self.assertEqual(choose_mapping(role, (without_incumbent,), None).status, "ABSTAIN")

        current_route = self._route("nan/current", "medium")
        current = self._candidate(current_route, self._model("nan/current"), [self._fixture("one", 0.80), self._fixture("two", 0.80)], True)
        unsafe_challenger = candidate_from_pi_result(pi_route)
        with_incumbent = choose_mapping(role, (current, unsafe_challenger), current_route)
        self.assertEqual(with_incumbent.status, "ABSTAIN")
        self.assertEqual(with_incumbent.reasons, ("eval_pi_isolation_unavailable",))

    def test_choose_mapping_requires_two_fixture_quality_advantage_not_one_fixture_spike(self):
        role = self._role()
        current_route = self._route("nan/current", "medium")
        current = self._candidate(current_route, self._model("nan/current"), [self._fixture("one", 0.60), self._fixture("two", 0.60)], True)
        one_fixture = self._candidate(self._route("nan/one-fixture", "high"), self._model("nan/one-fixture"), [self._fixture("one", 0.71), self._fixture("two", 0.60)])
        self.assertEqual(choose_mapping(role, (current, one_fixture), current_route).status, "NO_CHANGE")

        two_fixture = self._candidate(self._route("nan/two-fixture", "high"), self._model("nan/two-fixture"), [self._fixture("one", 0.71), self._fixture("two", 0.72)])
        decision = choose_mapping(role, (current, two_fixture), current_route)
        self.assertEqual(decision.status, "CHANGE")
        self.assertEqual(decision.reasons, ("material_quality_advantage",))

    def test_choose_mapping_ignores_unsupported_aggregate_advantage(self):
        role = self._role()
        current_route = self._route("nan/current", "medium")
        current = self._candidate(current_route, self._model("nan/current"), [self._fixture("one", 0.80), self._fixture("two", 0.80)], True, benchmark_score=0.1)
        challenger = self._candidate(self._route("nan/challenger", "high"), self._model("nan/challenger"), [self._fixture("one", 0.80), self._fixture("two", 0.80)], benchmark_score=0.99)
        self.assertEqual(choose_mapping(role, (current, challenger), current_route).status, "NO_CHANGE")

    def test_choose_mapping_accepts_higher_mandatory_tier_without_common_fixtures_only_when_conclusive(self):
        role = self._role()
        current_route = self._route("nan/current", "medium")
        current = self._candidate(current_route, self._model("nan/current"), [self._fixture("incumbent-only", 0.61)], True)
        higher_tier = self._candidate(self._route("nan/higher", "high"), self._model("nan/higher"), [self._fixture("challenger-only", 0.91)])
        decision = choose_mapping(role, (current, higher_tier), current_route)
        self.assertEqual(decision.status, "CHANGE")
        self.assertEqual(decision.reasons, ("higher_mandatory_tier",))

        same_tier = self._candidate(self._route("nan/same", "high"), self._model("nan/same"), [self._fixture("different", 0.69)])
        self.assertNotEqual(choose_mapping(role, (current, same_tier), current_route).status, "CHANGE")

    def test_choose_mapping_uses_pairwise_compatible_fixtures_for_each_challenger(self):
        role = self._role()
        current_route = self._route("nan/current", "medium")
        current = self._candidate(current_route, self._model("nan/current"), [self._fixture("one", 0.80), self._fixture("two", 0.80)], True)
        tied_challenger = self._candidate(self._route("nan/tied", "high"), self._model("nan/tied"), [self._fixture("one", 0.80), self._fixture("two", 0.80)])
        unrelated = self._candidate(self._route("nan/unrelated", "medium"), self._model("nan/unrelated"), [self._fixture("other", 0.50)])
        self.assertEqual(choose_mapping(role, (current, tied_challenger, unrelated), current_route).status, "NO_CHANGE")

    def test_choose_mapping_new_agent_needs_conclusive_local_fixture_evidence_before_change(self):
        role = self._role()
        candidate = self._candidate(self._route("nan/new", "medium"), self._model("nan/new"), [])
        decision = choose_mapping(role, (candidate,), None)
        self.assertEqual(decision.status, "NEEDS_MORE_EVIDENCE")
        self.assertEqual(decision.selected_route, candidate.route)
        self.assertIsNone(decision.next_fixture)

    def test_choose_mapping_operational_advantage_requires_two_comparable_runs_without_regression(self):
        role = self._role(priority_order=("latency", "cost"))
        current_route = self._route("nan/current", "medium")
        current = self._candidate(current_route, self._model("nan/current"), [
            self._fixture("one", 0.80, elapsed=1000, cost=1.0),
            self._fixture("two", 0.80, elapsed=1000, cost=1.0),
        ], True)
        faster = self._candidate(self._route("nan/faster", "high"), self._model("nan/faster"), [
            self._fixture("one", 0.80, elapsed=790, cost=1.0),
            self._fixture("two", 0.80, elapsed=790, cost=1.0),
        ])
        self.assertEqual(choose_mapping(role, (current, faster), current_route).reasons, ("material_operational_advantage",))

        unreliable = self._candidate(self._route("nan/unreliable", "high"), self._model("nan/unreliable"), [
            self._fixture("one", 0.80, elapsed=790, reliable=False),
            self._fixture("two", 0.80, elapsed=790),
        ])
        self.assertEqual(choose_mapping(role, (current, unreliable), current_route).status, "NO_CHANGE")

        intrusive = self._candidate(self._route("nan/intrusive", "high"), self._model("nan/intrusive"), [
            self._fixture("one", 0.80, elapsed=790, interventions=1),
            self._fixture("two", 0.80, elapsed=790),
        ])
        self.assertEqual(choose_mapping(role, (current, intrusive), current_route).status, "NO_CHANGE")

    def test_identity_classification_distinguishes_source_and_model_match_quality(self):
        route = self._route("openai/gpt-5.6-terra", "high")
        self.assertEqual(classify_identity(route, BenchmarkObservation(exact_id="openai/gpt-5.6-terra", effort="high"), True), IdentityMatch.EXACT)
        self.assertEqual(classify_identity(route, BenchmarkObservation(exact_id="azure/gpt-5.6-terra", model="gpt-5.6-terra"), True), IdentityMatch.MODEL_EQUIVALENT)
        self.assertEqual(classify_identity(route, BenchmarkObservation(family="gpt"), True), IdentityMatch.FAMILY_PROXY)
        self.assertEqual(classify_identity(route, None, True), IdentityMatch.ABSENT)
        self.assertEqual(classify_identity(route, BenchmarkObservation(identity_unknown=True), True), IdentityMatch.UNKNOWN)
        self.assertEqual(classify_identity(route, None, False), IdentityMatch.SOURCE_UNAVAILABLE)


class AgentDiscoveryTests(unittest.TestCase):

    def test_pi_discovery_includes_settings_and_environment_assignments_without_silent_omission(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            home = root / "home"
            cwd = root / "project"
            global_root = root / "pi-root"
            home.mkdir()
            cwd.mkdir()
            global_root.mkdir()
            (global_root / "settings.json").write_text(json.dumps({
                "defaultProvider": "openai-codex",
                "defaultModel": "gpt-5.6-terra",
                "defaultThinkingLevel": "high",
            }), encoding="utf-8")

            contracts = discover_agent_contracts(RuntimeKind.PI, home, cwd, {
                "PI_CODING_AGENT_DIR": str(global_root),
                "PI_PROVIDER": "nan",
                "PI_MODEL": "qwen3.6",
                "PI_REASONING_LEVEL": "minimal",
            })
            by_name = {contract.name: contract for contract in contracts}

            self.assertIn("current", by_name)
            self.assertEqual(by_name["current"].model, "nan/qwen3.6")
            self.assertEqual(by_name["current"].effort, "minimal")
            self.assertEqual(by_name["current"].assignment_source, "env")
            self.assertIsNone(by_name["current"].apply_target)
            self.assertIn("default", by_name)
            self.assertEqual(by_name["default"].model, "openai-codex/gpt-5.6-terra")
            self.assertEqual(by_name["default"].effort, "high")
            self.assertEqual(by_name["default"].definition_source, "global:settings.json#default")
            self.assertEqual(by_name["default"].assignment_source, "global:settings.json")
            self.assertEqual(by_name["default"].apply_target, str(global_root / "settings.json"))
