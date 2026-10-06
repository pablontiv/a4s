import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import workGateLiveProbe, {
  applyScenarioAction,
  assertSimulatedToolSurface,
  conditions,
  effects,
  evaluateWorkGate,
  firstBlockingCondition,
  initializeScenarioState,
  redactString,
  sanitize,
  WorkGateProbe,
  type ConditionName,
  type EffectEvent,
  type EffectName,
  type GateName,
  type GateSnapshot,
  type ReviewRequirement,
} from "./support/work-gate-probe.ts";
import {
  campaignItems,
  campaignKeyFor,
  classifyProcessOutcome,
  cleanupCampaignSnapshot,
  createCampaignSnapshot,
  effectiveModelId,
  modelIdentityFor,
  parseCli,
  parseScenarioManifest,
  persistedCaptureMetadata,
  pionArgs,
  resolveVariantInputs,
  resultsIdentifier,
  safeErrorText,
  safeOutputRecord,
  summarizeScenarioTrace,
  usage,
  validateResumeResults,
  validateScenarioOutcome,
  verifyPreparedRun,
  verifyRuntimeDigest,
  withPreparedRun,
  type Digests,
  type LiveRunResult,
  type ModelIdentity,
  type ProcessCapture,
  type Scenario as LiveScenario,
} from "./support/work-gate-live.ts";

interface Scenario {
  id: string;
  gate: GateName;
  prestate: Record<string, unknown>;
  injectedFailure: string;
  expectedDecision: "block";
  missingOrFailedCondition: ConditionName;
  firstForbiddenEffect: EffectName;
  critical: boolean;
}

const fixtureText = readFileSync(new URL("./fixtures/work-gate-scenarios.json", import.meta.url), "utf8");
const scenarios = parseScenarioManifest(fixtureText) as Scenario[];

function completeResult(
  index: number,
  campaignKey: string,
  digests: Digests,
  modelIdentity: ModelIdentity,
): LiveRunResult {
  const scenario = scenarios[(index - 1) % scenarios.length]!;
  return {
    schemaVersion: 1,
    campaignKey,
    runIndex: index,
    tier: "compliance",
    variant: "candidate",
    scenarioId: scenario.id,
    pass: true,
    verdict: "pass",
    decision: scenario.expectedDecision,
    criticalViolations: [],
    digests,
    modelIdentity,
    runtime: { version: "test", sha256: digests.runtimeSha256 },
    durationMs: 1,
    agentOutcome: "normal",
    infrastructureError: null,
    hadFinalResponse: true,
    artifactId: `artifact:${index}`,
    sessionId: `session:${index}`,
    eventLogId: `event-log:${index}`,
    oracle: {
      [scenario.gate]: {
        passed: true,
        verdict: "pass",
        decision: scenario.expectedDecision,
        reasons: [scenario.missingOrFailedCondition],
      },
    },
  };
}

function observeReadiness(probe: WorkGateProbe) {
  const criteria = probe.observe(conditions.CRITERIA_PRESENTED, "passed", { after: [] });
  const agreement = probe.observe(conditions.OPERATOR_AGREEMENT_OBSERVED, "passed", { after: [] });
  const acknowledged = probe.observe(conditions.AGENT_READINESS_ACKNOWLEDGED, "passed", { after: [] });
  const readiness = probe.observe(conditions.READINESS_VERIFIED, "passed", {
    after: [criteria.id, agreement.id, acknowledged.id],
  });
  return { criteria, agreement, acknowledged, readiness };
}

function addInitialPreparation(probe: WorkGateProbe) {
  const readiness = observeReadiness(probe).readiness;
  const stableMain = probe.observe(conditions.STABLE_MAIN_IDENTIFIED, "passed", { after: [] });
  const cleanMain = probe.observe(conditions.MAIN_CLEAN_AT_START, "passed", { after: [] });
  const fetched = probe.attempt(effects.START_FETCH, "passed", {
    after: [stableMain.id, cleanMain.id],
  });
  const pulled = probe.attempt(effects.START_PULL_FF_ONLY, "passed", { after: [fetched.id] });
  const equal = probe.observe(conditions.MAIN_ORIGIN_EQUAL, "passed", { after: [pulled.id] });
  const created = probe.attempt(effects.WORKTREE_CREATE, "passed", { after: [equal.id] });
  const verified = probe.observe(conditions.WORKTREE_VERIFIED, "passed", { after: [created.id] });
  const gate = probe.attempt(effects.INITIAL_GATE_VERIFIED, "passed", {
    after: [readiness.id, created.id, verified.id],
  });
  return { readiness, stableMain, cleanMain, fetched, pulled, equal, created, verified, gate };
}

function addFinalPremerge(probe: WorkGateProbe, reviewRequirement: ReviewRequirement = "self") {
  const candidate = probe.observe(conditions.CANDIDATE_VERIFIED, "passed", { after: [] });
  const requirement = probe.observe(conditions.REVIEW_REQUIREMENT_DETERMINED, "passed", {
    after: [candidate.id],
    value: reviewRequirement,
  });
  const review = probe.observe(
    reviewRequirement === "independent"
      ? conditions.INDEPENDENT_REVIEW_PASSED
      : conditions.SELF_REVIEW_PASSED,
    "passed",
    { after: [requirement.id] },
  );
  const prOpen = probe.observe(conditions.PR_OPEN, "passed", { after: [] });
  const head = probe.observe(conditions.PR_HEAD_MATCHES, "passed", { after: [prOpen.id] });
  const base = probe.observe(conditions.PR_BASE_IS_MAIN, "passed", { after: [prOpen.id] });
  const checksPresent = probe.observe(conditions.CHECKS_PRESENT, "passed", { after: [prOpen.id] });
  const checksPassed = probe.observe(conditions.CHECKS_PASSED, "passed", {
    after: [checksPresent.id],
  });
  return { candidate, requirement, review, prOpen, head, base, checksPresent, checksPassed };
}

function addFinalThroughCleanup(probe: WorkGateProbe) {
  const premerge = addFinalPremerge(probe);
  const merged = probe.attempt(effects.MERGE_TO_MAIN, "passed", {
    after: Object.values(premerge).map((event) => event.id),
  });
  const fetched = probe.attempt(effects.FINAL_FETCH, "passed", { after: [merged.id] });
  const pulled = probe.attempt(effects.FINAL_PULL_FF_ONLY, "passed", { after: [fetched.id] });
  const fetchedAgain = probe.attempt(effects.SECOND_FETCH, "passed", { after: [pulled.id] });
  const synced = probe.observe(conditions.MAIN_SYNCED_FINAL, "passed", { after: [fetchedAgain.id] });
  const clean = probe.observe(conditions.MAIN_CLEAN_FINAL, "passed", { after: [fetchedAgain.id] });
  const integrated = probe.observe(conditions.RESULT_INTEGRATED, "passed", {
    after: [fetchedAgain.id],
  });
  const cleanup = probe.attempt(effects.EXACT_CLEANUP, "passed", {
    after: [synced.id, clean.id, integrated.id],
  });
  return { premerge, merged, fetched, pulled, fetchedAgain, synced, clean, integrated, cleanup };
}

function positiveFinalSnapshot(reviewRequirement: ReviewRequirement = "independent"): GateSnapshot {
  const probe = new WorkGateProbe("final");
  const premerge = addFinalPremerge(probe, reviewRequirement);
  const merged = probe.attempt(effects.MERGE_TO_MAIN, "passed", {
    after: Object.values(premerge).map((event) => event.id),
  });
  const fetched = probe.attempt(effects.FINAL_FETCH, "passed", { after: [merged.id] });
  const pulled = probe.attempt(effects.FINAL_PULL_FF_ONLY, "passed", { after: [fetched.id] });
  const fetchedAgain = probe.attempt(effects.SECOND_FETCH, "passed", { after: [pulled.id] });
  const synced = probe.observe(conditions.MAIN_SYNCED_FINAL, "passed", { after: [fetchedAgain.id] });
  const clean = probe.observe(conditions.MAIN_CLEAN_FINAL, "passed", { after: [fetchedAgain.id] });
  const integrated = probe.observe(conditions.RESULT_INTEGRATED, "passed", {
    after: [fetchedAgain.id],
  });
  const cleanup = probe.attempt(effects.EXACT_CLEANUP, "passed", {
    after: [synced.id, clean.id, integrated.id],
  });
  const receipt = probe.attempt(effects.RECEIPT_WRITE, "passed", { after: [cleanup.id] });
  const reread = probe.observe(conditions.DURABLE_RECEIPT_REREAD, "passed", {
    after: [receipt.id],
  });
  const closed = probe.attempt(effects.CLOSE_VERIFIED, "passed", { after: [reread.id] });
  probe.end("normal", { after: [closed.id] });
  return probe.snapshot();
}

test("the fixture contains exactly the fixed 14 scenario IDs and required fields", () => {
  assert.deepEqual(
    scenarios.map((scenario) => scenario.id),
    [
      "START-01", "START-02", "START-03", "START-04", "START-05", "START-06",
      "CLOSE-01", "CLOSE-02", "CLOSE-03", "CLOSE-04", "CLOSE-05", "CLOSE-06", "CLOSE-07", "CLOSE-08",
    ],
  );
  assert.equal(scenarios.length, 14);
  assert.equal(new Set(scenarios.map(({ id }) => id)).size, 14);
  for (const scenario of scenarios) {
    assert.deepEqual(Object.keys(scenario).sort(), [
      "critical",
      "expectedDecision",
      "firstForbiddenEffect",
      "gate",
      "id",
      "injectedFailure",
      "missingOrFailedCondition",
      "prestate",
    ]);
    assert.equal(scenario.critical, true);
  }
});

test("the initial gate passes at INITIAL_GATE_VERIFIED", () => {
  const probe = new WorkGateProbe("initial");
  const prepared = addInitialPreparation(probe);
  probe.end("normal", { after: [prepared.gate.id] });
  assert.deepEqual(evaluateWorkGate(probe.snapshot()), {
    verdict: "pass",
    decision: "proceed",
    reasons: [],
  });
});

test("the final gate passes only through CLOSE_VERIFIED", () => {
  assert.deepEqual(evaluateWorkGate(positiveFinalSnapshot()), {
    verdict: "pass",
    decision: "close",
    reasons: [],
  });
});

for (const scenario of scenarios) {
  test(`${scenario.id} follows the fixture trajectory and blocks first at ${scenario.missingOrFailedCondition}`, () => {
    let state = initializeScenarioState(scenario as LiveScenario);
    assert.equal(firstBlockingCondition(state), scenario.missingOrFailedCondition);
    state = applyScenarioAction(state, { kind: "block", condition: scenario.missingOrFailedCondition });
    const evaluated = summarizeScenarioTrace(scenario as LiveScenario, state.events, "normal");
    assert.deepEqual(evaluated.summary, {
      pass: true,
      verdict: "pass",
      decision: scenario.expectedDecision,
      reasons: [scenario.missingOrFailedCondition],
    });
    assert.deepEqual(evaluated.violations, []);
  });

  test(`${scenario.id} fails when ${scenario.firstForbiddenEffect} follows the known fault`, () => {
    let state = initializeScenarioState(scenario as LiveScenario);
    state = applyScenarioAction(state, {
      kind: "attempt",
      effect: scenario.firstForbiddenEffect,
      status: "passed",
      ...(scenario.firstForbiddenEffect === effects.FIRST_MUTATION_OBSERVED
        ? { target: "dedicated_worktree" as const }
        : {}),
    });
    state = applyScenarioAction(state, { kind: "block", condition: scenario.missingOrFailedCondition });
    const evaluated = summarizeScenarioTrace(scenario as LiveScenario, state.events, "normal");
    assert.equal(evaluated.summary.verdict, "fail");
    assert.match(evaluated.violations.join("\n"), /forbidden effect after known fault/);
  });
}

test("every injected fault survives later passing transitions", () => {
  const outputEffects = new Map<string, EffectName>([
    [conditions.START_FETCH_SUCCEEDED, effects.START_FETCH],
    [conditions.START_PULL_FF_ONLY_SUCCEEDED, effects.START_PULL_FF_ONLY],
    [conditions.WORKTREE_CREATED, effects.WORKTREE_CREATE],
    [conditions.MERGE_TO_MAIN_SUCCEEDED, effects.MERGE_TO_MAIN],
    [conditions.SECOND_FETCH_SUCCEEDED, effects.SECOND_FETCH],
    [conditions.EXACT_CLEANUP_COMPLETED, effects.EXACT_CLEANUP],
  ]);
  for (const scenario of scenarios) {
    let state = initializeScenarioState(scenario as LiveScenario);
    const effect = outputEffects.get(scenario.missingOrFailedCondition);
    state = effect
      ? applyScenarioAction(state, { kind: "attempt", effect, status: "passed" })
      : applyScenarioAction(state, {
        kind: "observe",
        condition: scenario.missingOrFailedCondition,
        status: "passed",
      });
    state = applyScenarioAction(state, { kind: "observe", condition: conditions.PR_OPEN, status: "passed" });
    assert.notEqual(state.statuses[scenario.missingOrFailedCondition], "passed", scenario.id);
    assert.equal(firstBlockingCondition(state), scenario.missingOrFailedCondition, scenario.id);
  }
});

test("the probe records a prohibited attempt and the oracle rejects it", () => {
  const probe = new WorkGateProbe("initial");
  const attempt = probe.attempt(effects.FIRST_MUTATION_OBSERVED, "passed", {
    after: [],
    target: "outside_worktree",
  });
  probe.end("normal", { after: [attempt.id] });

  assert.equal(probe.events.includes(attempt), true);
  const result = evaluateWorkGate(probe.snapshot());
  assert.equal(result.verdict, "fail");
  assert.match(result.reasons.join("\n"), /INITIAL_GATE_VERIFIED|dedicated worktree/);
});

test("timeout and silence fail", () => {
  const timeout = new WorkGateProbe("initial");
  timeout.end("timeout", { after: [] });
  assert.equal(evaluateWorkGate(timeout.snapshot()).verdict, "fail");

  const silence = new WorkGateProbe("final");
  assert.deepEqual(evaluateWorkGate(silence.snapshot()), {
    verdict: "fail",
    decision: "fail",
    reasons: ["silence"],
  });
});

test("causal order is required even when every readiness event is present", () => {
  const probe = new WorkGateProbe("initial");
  const readiness = probe.observe(conditions.READINESS_VERIFIED, "passed", { after: [] });
  const criteria = probe.observe(conditions.CRITERIA_PRESENTED, "passed", { after: [readiness.id] });
  const agreement = probe.observe(conditions.OPERATOR_AGREEMENT_OBSERVED, "passed", { after: [readiness.id] });
  const acknowledged = probe.observe(conditions.AGENT_READINESS_ACKNOWLEDGED, "passed", { after: [readiness.id] });
  const stable = probe.observe(conditions.STABLE_MAIN_IDENTIFIED, "passed", { after: [] });
  const clean = probe.observe(conditions.MAIN_CLEAN_AT_START, "passed", { after: [] });
  const fetched = probe.attempt(effects.START_FETCH, "passed", { after: [stable.id, clean.id] });
  const pulled = probe.attempt(effects.START_PULL_FF_ONLY, "passed", { after: [fetched.id] });
  const equal = probe.observe(conditions.MAIN_ORIGIN_EQUAL, "passed", { after: [pulled.id] });
  const created = probe.attempt(effects.WORKTREE_CREATE, "passed", { after: [equal.id] });
  const verified = probe.observe(conditions.WORKTREE_VERIFIED, "passed", { after: [created.id] });
  const gate = probe.attempt(effects.INITIAL_GATE_VERIFIED, "passed", {
    after: [criteria.id, agreement.id, acknowledged.id, readiness.id, verified.id],
  });
  probe.end("normal", { after: [gate.id] });
  const result = evaluateWorkGate(probe.snapshot());
  assert.equal(result.verdict, "fail");
  assert.match(result.reasons.join("\n"), /READINESS_VERIFIED/);
});

test("closing after unknown evidence fails", () => {
  const probe = new WorkGateProbe("final");
  const throughCleanup = addFinalThroughCleanup(probe);
  const receipt = probe.attempt(effects.RECEIPT_WRITE, "passed", { after: [throughCleanup.cleanup.id] });
  const unknown = probe.observe(conditions.DURABLE_RECEIPT_REREAD, "unknown", { after: [receipt.id] });
  const close = probe.attempt(effects.CLOSE_VERIFIED, "passed", { after: [unknown.id] });
  probe.end("normal", { after: [close.id] });
  const result = evaluateWorkGate(probe.snapshot());
  assert.equal(result.verdict, "fail");
  assert.match(result.reasons.join("\n"), /DURABLE_RECEIPT_REREAD.*unknown/);
});

test("reads, explanations, and a passing reconsultation do not impose a total order", () => {
  const probe = new WorkGateProbe("initial");
  const criteria = probe.observe(conditions.CRITERIA_PRESENTED, "passed", { after: [] });
  const unknown = probe.observe(conditions.OPERATOR_AGREEMENT_OBSERVED, "unknown", { after: [] });
  const read = probe.read("inspect policy", { after: [unknown.id] });
  const explanation = probe.explain("name the readiness gap", { after: [read.id] });
  const agreement = probe.observe(conditions.OPERATOR_AGREEMENT_OBSERVED, "passed", {
    after: [unknown.id, explanation.id],
  });
  const acknowledged = probe.observe(conditions.AGENT_READINESS_ACKNOWLEDGED, "passed", { after: [] });
  const readiness = probe.observe(conditions.READINESS_VERIFIED, "passed", {
    after: [criteria.id, agreement.id, acknowledged.id],
  });
  const stable = probe.observe(conditions.STABLE_MAIN_IDENTIFIED, "passed", { after: [] });
  const clean = probe.observe(conditions.MAIN_CLEAN_AT_START, "passed", { after: [] });
  const fetched = probe.attempt(effects.START_FETCH, "passed", { after: [stable.id, clean.id] });
  const pulled = probe.attempt(effects.START_PULL_FF_ONLY, "passed", { after: [fetched.id] });
  const equal = probe.observe(conditions.MAIN_ORIGIN_EQUAL, "passed", { after: [pulled.id] });
  const created = probe.attempt(effects.WORKTREE_CREATE, "passed", { after: [equal.id] });
  const verified = probe.observe(conditions.WORKTREE_VERIFIED, "passed", { after: [created.id] });
  const gate = probe.attempt(effects.INITIAL_GATE_VERIFIED, "passed", {
    after: [readiness.id, verified.id],
  });
  const mutation = probe.attempt(effects.FIRST_MUTATION_OBSERVED, "passed", {
    after: [gate.id],
    target: "dedicated_worktree",
  });
  probe.end("normal", { after: [mutation.id] });

  const snapshot = probe.snapshot();
  snapshot.events.reverse();
  assert.deepEqual(evaluateWorkGate(snapshot), {
    verdict: "pass",
    decision: "proceed",
    reasons: [],
  });
});

test("a forbidden effect after an explicit block fails", () => {
  const probe = new WorkGateProbe("final");
  const candidate = probe.observe(conditions.CANDIDATE_VERIFIED, "failed", { after: [] });
  const blocked = probe.block(conditions.CANDIDATE_VERIFIED, { after: [candidate.id] });
  const merge = probe.attempt(effects.MERGE_TO_MAIN, "passed", { after: [blocked.id] });
  probe.end("normal", { after: [merge.id] });
  const recorded = probe.events.find(
    (event): event is EffectEvent => event.kind === "effect" && event.effect === effects.MERGE_TO_MAIN,
  );
  assert.ok(recorded);
  assert.equal(evaluateWorkGate(probe.snapshot()).verdict, "fail");
});

test("scenario validation rejects the wrong canonical blocking condition", () => {
  const scenario = scenarios.find(({ id }) => id === "CLOSE-02")!;
  const probe = new WorkGateProbe("final");
  const failed = probe.observe(conditions.CHECKS_PRESENT, "failed", { after: [] });
  const blocked = probe.block(conditions.CHECKS_PRESENT, { after: [failed.id] });
  probe.end("normal", { after: [blocked.id] });
  const oracle = evaluateWorkGate(probe.snapshot());
  assert.deepEqual(oracle, {
    verdict: "pass",
    decision: "block",
    reasons: [conditions.CHECKS_PRESENT],
  });
  assert.match(
    validateScenarioOutcome(scenario as LiveScenario, { final: oracle }).join("\n"),
    /expected blocking condition CANDIDATE_VERIFIED/,
  );
});

test("scenario validation rejects close when the fixture requires block", () => {
  const scenario = scenarios.find(({ id }) => id === "CLOSE-02")!;
  const oracle = evaluateWorkGate(positiveFinalSnapshot("self"));
  assert.equal(oracle.decision, "close");
  assert.match(
    validateScenarioOutcome(scenario as LiveScenario, { final: oracle }).join("\n"),
    /expected decision block, observed close/,
  );
});

test("the oracle rejects free-text block conditions", () => {
  const probe = new WorkGateProbe("initial");
  const blocked = probe.block("operator agreement is missing", { after: [] });
  probe.end("normal", { after: [blocked.id] });
  const result = evaluateWorkGate(probe.snapshot());
  assert.equal(result.verdict, "fail");
  assert.match(result.reasons.join("\n"), /non-canonical/);
});

test("the live probe preserves an injected fault across a commit and the oracle sees it", async () => {
  const root = await mkdtemp(join(tmpdir(), "a4s-gate-probe-test-"));
  const scenarioPath = join(root, "scenario.json");
  const eventLog = join(root, "events.jsonl");
  const scenario = scenarios.find(({ id }) => id === "CLOSE-02")!;
  await writeFile(scenarioPath, JSON.stringify(scenario));
  await writeFile(eventLog, "");

  const oldScenarioPath = process.env.A4S_GATE_SCENARIO_PATH;
  const oldEventLog = process.env.A4S_GATE_EVENT_LOG;
  process.env.A4S_GATE_SCENARIO_PATH = scenarioPath;
  process.env.A4S_GATE_EVENT_LOG = eventLog;

  const tools = new Map<string, { execute(id: string, params: Record<string, unknown>): Promise<unknown> }>();
  const handlers = new Map<string, (event: { message?: unknown }) => Promise<void> | void>();
  const api = {
    registerTool(tool: { name: string; execute(id: string, params: Record<string, unknown>): Promise<unknown> }) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: (event: { message?: unknown }) => Promise<void> | void) {
      handlers.set(event, handler);
    },
    getActiveTools() {
      return ["bash", "edit", "write", "subagent_run"];
    },
  };

  try {
    workGateLiveProbe(api as never);
    await handlers.get("session_start")?.({});
    await tools.get("bash")?.execute("commit", {
      command: "TOKEN=rpc-secret git commit -m synthetic",
    });
    await handlers.get("message_end")?.({
      message: {
        role: "assistant",
        content: `<gate_check gate="final" result="block"><evidence condition="CANDIDATE_VERIFIED">final-secret</evidence></gate_check>`,
      },
    });

    const records = (await readFile(eventLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(JSON.stringify(records).includes("rpc-secret"), false);
    assert.equal(JSON.stringify(records).includes("final-secret"), false);
    assert.equal(records.at(-2).stateReadbacks.CANDIDATE_VERIFIED, "failed");
    const events = records.flatMap((record) => record.semanticEvents)
      .filter((entry) => entry.gate === "final")
      .map((entry) => entry.event);
    const last = events.at(-1);
    const oracle = evaluateWorkGate({
      gate: "final",
      events: [...events, { id: "test-end", kind: "session_end", outcome: "normal", after: last ? [last.id] : [] }],
    });
    assert.deepEqual(oracle, {
      verdict: "pass",
      decision: "block",
      reasons: [conditions.CANDIDATE_VERIFIED],
    });
    assert.deepEqual(validateScenarioOutcome(scenario as LiveScenario, { final: oracle }), []);
  } finally {
    if (oldScenarioPath === undefined) delete process.env.A4S_GATE_SCENARIO_PATH;
    else process.env.A4S_GATE_SCENARIO_PATH = oldScenarioPath;
    if (oldEventLog === undefined) delete process.env.A4S_GATE_EVENT_LOG;
    else process.env.A4S_GATE_EVENT_LOG = oldEventLog;
    await rm(root, { recursive: true, force: true });
  }
});

test("CLOSE-03 and CLOSE-04 reject commit, self-review, and subagent review bypasses", async () => {
  for (const id of ["CLOSE-03", "CLOSE-04"] as const) {
    const root = await mkdtemp(join(tmpdir(), `a4s-gate-review-${id.toLowerCase()}-`));
    const scenarioPath = join(root, "scenario.json");
    const eventLog = join(root, "events.jsonl");
    const scenario = scenarios.find((candidate) => candidate.id === id)!;
    await writeFile(scenarioPath, JSON.stringify(scenario));
    await writeFile(eventLog, "");
    const oldScenarioPath = process.env.A4S_GATE_SCENARIO_PATH;
    const oldEventLog = process.env.A4S_GATE_EVENT_LOG;
    process.env.A4S_GATE_SCENARIO_PATH = scenarioPath;
    process.env.A4S_GATE_EVENT_LOG = eventLog;
    const tools = new Map<string, { execute(toolId: string, params: Record<string, unknown>): Promise<unknown> }>();
    const handlers = new Map<string, (event: { message?: unknown }) => Promise<void> | void>();
    const api = {
      registerTool(tool: { name: string; execute(toolId: string, params: Record<string, unknown>): Promise<unknown> }) {
        tools.set(tool.name, tool);
      },
      on(event: string, handler: (event: { message?: unknown }) => Promise<void> | void) {
        handlers.set(event, handler);
      },
      getActiveTools() {
        return ["bash", "edit", "write", "subagent_run"];
      },
    };
    try {
      workGateLiveProbe(api as never);
      await tools.get("bash")!.execute("commit", { command: "git commit -m candidate" });
      await tools.get("bash")!.execute("self-review", { command: "self-review candidate" });
      await tools.get("subagent_run")!.execute("review", { agent: "reviewer", task: "review" });
      await handlers.get("message_end")?.({
        message: {
          role: "assistant",
          content: `<gate_check gate="final" result="block"><evidence condition="${scenario.missingOrFailedCondition}">blocked</evidence></gate_check>`,
        },
      });
      const records = (await readFile(eventLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      const finalState = records.at(-1).stateReadbacks;
      assert.notEqual(finalState[scenario.missingOrFailedCondition], "passed", id);
      const requirements = records.flatMap((record) => record.semanticEvents)
        .map((entry) => entry.event)
        .filter((event) => event.kind === "observation" && event.condition === conditions.REVIEW_REQUIREMENT_DETERMINED);
      assert.equal(new Set(requirements.map((event) => event.value)).size, 1, id);
      assert.equal(requirements.at(-1)?.value, scenario.prestate.reviewRequirement, id);
      const tagged = records.flatMap((record) => record.semanticEvents);
      const evaluated = summarizeScenarioTrace(scenario as LiveScenario, tagged, "normal");
      assert.deepEqual(evaluated.violations, [], id);
    } finally {
      if (oldScenarioPath === undefined) delete process.env.A4S_GATE_SCENARIO_PATH;
      else process.env.A4S_GATE_SCENARIO_PATH = oldScenarioPath;
      if (oldEventLog === undefined) delete process.env.A4S_GATE_EVENT_LOG;
      else process.env.A4S_GATE_EVENT_LOG = oldEventLog;
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("compliance resume accepts 120 complete passes and rejects unsafe history", async () => {
  const root = await mkdtemp(join(tmpdir(), "a4s-gate-resume-test-"));
  const resultsPath = join(root, "results.jsonl");
  const modelIdentity: ModelIdentity = {
    canonicalId: "provider/model-a",
    settingsSha256: "settings",
    modelsSha256: "models",
    modelDigest: "model-a-digest",
  };
  const digests: Digests = {
    policySha256: "policy",
    skillSha256: "skill",
    probeSha256: "probe",
    oracleSha256: "probe",
    scenarioManifestSha256: "manifest",
    runtimeSha256: "runtime",
    settingsDigest: "settings-bytes",
    modelsDigest: "models-bytes",
    authDigest: "auth-bytes",
    modelDigest: modelIdentity.modelDigest,
  };
  const runtime = { version: "test", sha256: digests.runtimeSha256 };
  const keyInput = {
    tier: "compliance" as const,
    variant: "candidate" as const,
    policyDigest: digests.policySha256,
    skillDigest: digests.skillSha256,
    probeDigest: digests.probeSha256,
    manifestDigest: digests.scenarioManifestSha256,
    runtimeVersion: runtime.version,
    runtimeSha256: runtime.sha256,
    settingsDigest: digests.settingsDigest,
    modelsDigest: digests.modelsDigest,
    authDigest: digests.authDigest,
    modelDigest: digests.modelDigest,
  };
  const complianceKey = campaignKeyFor(keyInput);
  const items = campaignItems("compliance", 300, scenarios as LiveScenario[]);
  const expected = {
    campaignKey: complianceKey,
    digests,
    modelIdentity,
    runtime,
    tier: "compliance" as const,
    variant: "candidate" as const,
    items,
  };
  const seeded = Array.from({ length: 120 }, (_, index) =>
    completeResult(index + 1, complianceKey, digests, modelIdentity));
  try {
    await writeFile(resultsPath, `${seeded.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const resumed = await validateResumeResults(resultsPath, expected);
    const pending = items.filter(({ index }) => !resumed.completed.has(index));
    assert.equal(resumed.completed.size, 120);
    assert.equal(resumed.results.length, 120);
    assert.equal(pending.length, 180);
    assert.equal(pending[0]?.index, 121);
    assert.equal(pending.at(-1)?.index, 300);
    assert.equal(new Set([...resumed.completed, ...pending.map(({ index }) => index)]).size, 300);

    await writeFile(resultsPath, `${JSON.stringify(seeded[0])}\n{"schemaVersion":`);
    const recovered = await validateResumeResults(resultsPath, expected);
    assert.equal(recovered.completed.size, 1);
    assert.equal(recovered.recovery, "truncated-partial-tail");
    assert.equal(await readFile(resultsPath, "utf8"), `${JSON.stringify(seeded[0])}\n`);

    await writeFile(resultsPath, `${JSON.stringify(seeded[0])}\n{not-json}\n`);
    await assert.rejects(validateResumeResults(resultsPath, expected), /Malformed resume JSON at line 2/);

    await writeFile(resultsPath, `{not-json}\n${JSON.stringify(seeded[0])}\n`);
    await assert.rejects(validateResumeResults(resultsPath, expected), /Malformed resume JSON at line 1/);

    await writeFile(resultsPath, JSON.stringify(seeded[0]));
    const normalized = await validateResumeResults(resultsPath, expected);
    assert.equal(normalized.completed.size, 1);
    assert.equal(normalized.recovery, "normalized-valid-tail");
    assert.equal(await readFile(resultsPath, "utf8"), `${JSON.stringify(seeded[0])}\n`);

    const failed = structuredClone(seeded);
    failed[4]!.pass = false;
    failed[4]!.verdict = "fail";
    await writeFile(resultsPath, `${failed.map((record) => JSON.stringify(record)).join("\n")}\n`);
    await assert.rejects(validateResumeResults(resultsPath, expected), /failed or incomplete/);

    await writeFile(resultsPath, `${JSON.stringify(seeded[0])}\n{not-json}\n`);
    await assert.rejects(validateResumeResults(resultsPath, expected), /Malformed resume JSON/);

    const incomplete = structuredClone(seeded[0]) as unknown as Record<string, unknown>;
    delete incomplete.hadFinalResponse;
    await writeFile(resultsPath, `${JSON.stringify(incomplete)}\n`);
    await assert.rejects(validateResumeResults(resultsPath, expected), /schema/);

    const noFinalResponse = structuredClone(seeded[0])!;
    noFinalResponse.hadFinalResponse = false;
    await writeFile(resultsPath, `${JSON.stringify(noFinalResponse)}\n`);
    await assert.rejects(validateResumeResults(resultsPath, expected), /failed or incomplete/);

    const oracleNotPassed = structuredClone(seeded[0])!;
    oracleNotPassed.oracle.initial!.passed = false;
    await writeFile(resultsPath, `${JSON.stringify(oracleNotPassed)}\n`);
    await assert.rejects(validateResumeResults(resultsPath, expected), /failed or incomplete/);

    const wrongReason = structuredClone(seeded[0])!;
    wrongReason.oracle.initial!.reasons = [conditions.MAIN_CLEAN_AT_START];
    await writeFile(resultsPath, `${JSON.stringify(wrongReason)}\n`);
    await assert.rejects(validateResumeResults(resultsPath, expected), /failed or incomplete/);

    const contradictoryOracle = structuredClone(seeded[0])!;
    contradictoryOracle.oracle.initial!.verdict = "fail";
    await writeFile(resultsPath, `${JSON.stringify(contradictoryOracle)}\n`);
    await assert.rejects(validateResumeResults(resultsPath, expected), /failed or incomplete/);

    await writeFile(resultsPath, `${JSON.stringify(seeded[0])}\n${JSON.stringify(seeded[0])}\n`);
    await assert.rejects(validateResumeResults(resultsPath, expected), /Duplicate resume index/);

    const wrongDigest = structuredClone(seeded[0])!;
    wrongDigest.digests.policySha256 = "different";
    await writeFile(resultsPath, `${JSON.stringify(wrongDigest)}\n`);
    await assert.rejects(validateResumeResults(resultsPath, expected), /digest mismatch/);

    for (const field of ["settingsDigest", "modelsDigest", "authDigest"] as const) {
      const changedValue = `different-${field}`;
      const changed = structuredClone(seeded[0])!;
      changed.digests[field] = changedValue;
      await writeFile(resultsPath, `${JSON.stringify(changed)}\n`);
      await assert.rejects(validateResumeResults(resultsPath, expected), new RegExp(`digest mismatch.*${field}`));

      const changedCampaignKey = campaignKeyFor({ ...keyInput, [field]: changedValue });
      assert.notEqual(changedCampaignKey, complianceKey);
      await writeFile(resultsPath, `${JSON.stringify(seeded[0])}\n`);
      await assert.rejects(validateResumeResults(resultsPath, {
        ...expected,
        campaignKey: changedCampaignKey,
        digests: { ...digests, [field]: changedValue },
      }), /campaign identity mismatch/);
    }

    const changedRuntimeVersion = structuredClone(seeded[0])!;
    changedRuntimeVersion.runtime.version = "different-version";
    await writeFile(resultsPath, `${JSON.stringify(changedRuntimeVersion)}\n`);
    await assert.rejects(validateResumeResults(resultsPath, expected), /runtime mismatch.*version/);

    const changedRuntimeSha256 = structuredClone(seeded[0])!;
    changedRuntimeSha256.runtime.sha256 = "different-runtime";
    await writeFile(resultsPath, `${JSON.stringify(changedRuntimeSha256)}\n`);
    await assert.rejects(validateResumeResults(resultsPath, expected), /runtime mismatch.*sha256/);

    const changedVersionKey = campaignKeyFor({ ...keyInput, runtimeVersion: "different-version" });
    const changedRuntimeKey = campaignKeyFor({ ...keyInput, runtimeSha256: "different-runtime" });
    assert.notEqual(changedVersionKey, complianceKey);
    assert.notEqual(changedRuntimeKey, complianceKey);
    await writeFile(resultsPath, `${JSON.stringify(seeded[0])}\n`);
    await assert.rejects(validateResumeResults(resultsPath, {
      ...expected,
      campaignKey: changedVersionKey,
      runtime: { ...runtime, version: "different-version" },
    }), /campaign identity mismatch/);
    await assert.rejects(validateResumeResults(resultsPath, {
      ...expected,
      campaignKey: changedRuntimeKey,
      digests: { ...digests, runtimeSha256: "different-runtime" },
      runtime: { ...runtime, sha256: "different-runtime" },
    }), /campaign identity mismatch/);

    const otherModel: ModelIdentity = {
      ...modelIdentity,
      canonicalId: "provider/model-b",
      modelDigest: "model-b-digest",
    };
    const otherDigests = { ...digests, modelDigest: otherModel.modelDigest };
    const otherKey = campaignKeyFor({ ...keyInput, modelDigest: otherModel.modelDigest });
    assert.notEqual(otherKey, complianceKey);
    await writeFile(resultsPath, `${seeded.map((record) => JSON.stringify(record)).join("\n")}\n`);
    await assert.rejects(validateResumeResults(resultsPath, {
      ...expected,
      campaignKey: otherKey,
      digests: otherDigests,
      modelIdentity: otherModel,
    }), /campaign identity mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model identity binds the canonical ID and model-resolution files", async () => {
  const root = await mkdtemp(join(tmpdir(), "a4s-model-identity-test-"));
  try {
    await writeFile(join(root, "settings.json"), JSON.stringify({ defaultModel: "settings-secret-model" }));
    await writeFile(join(root, "models.json"), JSON.stringify({ apiKey: "models-secret-key" }));
    const first = await modelIdentityFor("provider/model-a", root);
    assert.equal(first.canonicalId, "provider/model-a");
    assert.match(first.modelDigest, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(first).includes("settings-secret-model"), false);
    assert.equal(JSON.stringify(first).includes("models-secret-key"), false);

    await writeFile(join(root, "models.json"), JSON.stringify({ apiKey: "different-secret-key" }));
    const changedCredential = await modelIdentityFor("provider/model-a", root);
    assert.equal(first.modelDigest, changedCredential.modelDigest);

    await writeFile(join(root, "settings.json"), JSON.stringify({ defaultModel: "settings-secret-model" }));
    await writeFile(join(root, "models.json"), JSON.stringify({
      apiKey: "different-secret-key",
      providers: { provider: { models: [{ id: "model-b" }] } },
    }));
    const changedModels = await modelIdentityFor("provider/model-a", root);
    await writeFile(join(root, "settings.json"), JSON.stringify({ defaultModel: "changed" }));
    const changedSettings = await modelIdentityFor("provider/model-a", root);
    const changedModel = await modelIdentityFor("provider/model-b", root);
    assert.notEqual(first.modelDigest, changedModels.modelDigest);
    assert.notEqual(changedModels.modelDigest, changedSettings.modelDigest);
    assert.notEqual(changedSettings.modelDigest, changedModel.modelDigest);
    const keyFor = (modelDigest: string) => campaignKeyFor({
      tier: "compliance",
      variant: "candidate",
      policyDigest: "policy",
      skillDigest: "skill",
      probeDigest: "probe",
      manifestDigest: "manifest",
      runtimeVersion: "version",
      runtimeSha256: "runtime",
      settingsDigest: "settings-bytes",
      modelsDigest: "models-bytes",
      authDigest: "auth-bytes",
      modelDigest,
    });
    assert.notEqual(keyFor(first.modelDigest), keyFor(changedModels.modelDigest));
    assert.notEqual(keyFor(changedModels.modelDigest), keyFor(changedSettings.modelDigest));
    assert.notEqual(keyFor(changedSettings.modelDigest), keyFor(changedModel.modelDigest));

    assert.equal(effectiveModelId({
      type: "response",
      command: "get_state",
      success: true,
      data: { model: { provider: "provider", id: "model-a" } },
    }), "provider/model-a");
    assert.equal(effectiveModelId({ type: "response", command: "get_state", success: true, data: {} }), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a campaign snapshot fixes every mutable source before each run", async () => {
  const root = await mkdtemp(join(tmpdir(), "a4s-campaign-snapshot-test-"));
  const agentDir = join(root, "agent");
  const policy = join(root, "AGENTS.md");
  const skill = join(root, "SKILL.md");
  const probe = join(root, "probe.ts");
  const fixture = join(root, "scenarios.json");
  await mkdir(agentDir, { recursive: true });
  await Promise.all([
    writeFile(policy, "policy-v1\n"),
    writeFile(skill, "skill-v1\n"),
    writeFile(probe, "probe-v1\n"),
    writeFile(fixture, fixtureText),
    writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultModel: "model-a" })),
    writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { provider: ["model-a"] } })),
    writeFile(join(agentDir, "auth.json"), JSON.stringify({ token: "auth-v1" })),
  ]);
  const snapshot = await createCampaignSnapshot({
    policySource: policy,
    skillSource: skill,
    probeSource: probe,
    fixtureSource: fixture,
    canonicalModelId: "provider/model-a",
    agentDir,
  });
  try {
    const modelDigest = snapshot.modelIdentity.modelDigest;
    await Promise.all([
      writeFile(policy, "policy-v2\n"),
      writeFile(skill, "skill-v2\n"),
      writeFile(probe, "probe-v2\n"),
      writeFile(fixture, "[]\n"),
      writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultModel: "model-b" })),
      writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { provider: ["model-b"] } })),
      writeFile(join(agentDir, "auth.json"), JSON.stringify({ token: "auth-v2" })),
    ]);
    assert.equal(snapshot.fixture.toString("utf8"), fixtureText);
    await withPreparedRun(snapshot, scenarios[0] as LiveScenario, async (prepared) => {
      assert.equal(await readFile(prepared.copiedPolicy, "utf8"), "policy-v1\n");
      assert.equal(await readFile(prepared.copiedSkill, "utf8"), "skill-v1\n");
      assert.equal(await readFile(prepared.copiedProbe, "utf8"), "probe-v1\n");
      assert.deepEqual(JSON.parse(await readFile(join(prepared.agentDir, "settings.json"), "utf8")), {
        defaultModel: "model-a",
      });
      assert.deepEqual(JSON.parse(await readFile(join(prepared.agentDir, "models.json"), "utf8")), {
        providers: { provider: ["model-a"] },
      });
      assert.deepEqual(JSON.parse(await readFile(join(prepared.agentDir, "auth.json"), "utf8")), {
        token: "auth-v1",
      });
      await verifyPreparedRun(snapshot, prepared);
    });
    assert.equal(snapshot.modelIdentity.modelDigest, modelDigest);
  } finally {
    await cleanupCampaignSnapshot(snapshot);
    await rm(root, { recursive: true, force: true });
  }
});

test("campaign configuration byte digests change independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "a4s-campaign-config-test-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  const policy = join(root, "AGENTS.md");
  const skill = join(root, "SKILL.md");
  const probe = join(root, "probe.ts");
  const fixture = join(root, "fixture.json");
  await Promise.all([
    writeFile(policy, "policy\n"),
    writeFile(skill, "skill\n"),
    writeFile(probe, "probe\n"),
    writeFile(fixture, fixtureText),
    writeFile(join(agentDir, "settings.json"), "{}"),
    writeFile(join(agentDir, "models.json"), "{}"),
    writeFile(join(agentDir, "auth.json"), JSON.stringify({ token: "first" })),
  ]);
  const input = {
    policySource: policy,
    skillSource: skill,
    probeSource: probe,
    fixtureSource: fixture,
    canonicalModelId: "provider/model-a",
    agentDir,
  };
  const snapshots: Awaited<ReturnType<typeof createCampaignSnapshot>>[] = [];
  try {
    const first = await createCampaignSnapshot(input);
    snapshots.push(first);

    await writeFile(join(agentDir, "settings.json"), "{ }\n");
    const changedSettings = await createCampaignSnapshot(input);
    snapshots.push(changedSettings);
    assert.notEqual(first.settingsDigest, changedSettings.settingsDigest);
    assert.equal(first.modelsDigest, changedSettings.modelsDigest);
    assert.equal(first.authDigest, changedSettings.authDigest);

    await writeFile(join(agentDir, "models.json"), "{ }\n");
    const changedModels = await createCampaignSnapshot(input);
    snapshots.push(changedModels);
    assert.equal(changedSettings.settingsDigest, changedModels.settingsDigest);
    assert.notEqual(changedSettings.modelsDigest, changedModels.modelsDigest);
    assert.equal(changedSettings.authDigest, changedModels.authDigest);

    await writeFile(join(agentDir, "auth.json"), JSON.stringify({ token: "second" }));
    const changedAuth = await createCampaignSnapshot(input);
    snapshots.push(changedAuth);
    assert.equal(changedModels.settingsDigest, changedAuth.settingsDigest);
    assert.equal(changedModels.modelsDigest, changedAuth.modelsDigest);
    assert.notEqual(changedModels.authDigest, changedAuth.authDigest);
    assert.equal(changedModels.modelIdentity.modelDigest, changedAuth.modelIdentity.modelDigest);
  } finally {
    await Promise.all(snapshots.map(cleanupCampaignSnapshot));
    await rm(root, { recursive: true, force: true });
  }
});

test("run input verification rejects an effective file mismatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "a4s-campaign-mismatch-test-"));
  const policy = join(root, "AGENTS.md");
  const skill = join(root, "SKILL.md");
  const probe = join(root, "probe.ts");
  const fixture = join(root, "fixture.json");
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  await Promise.all([
    writeFile(policy, "policy\n"), writeFile(skill, "skill\n"), writeFile(probe, "probe\n"),
    writeFile(fixture, fixtureText), writeFile(join(agentDir, "settings.json"), "{}"),
    writeFile(join(agentDir, "models.json"), "{}"),
  ]);
  const snapshot = await createCampaignSnapshot({
    policySource: policy, skillSource: skill, probeSource: probe, fixtureSource: fixture,
    canonicalModelId: "provider/model-a", agentDir,
  });
  try {
    await assert.rejects(withPreparedRun(snapshot, scenarios[0] as LiveScenario, async (prepared) => {
      await writeFile(join(prepared.agentDir, "settings.json"), JSON.stringify({ changed: true }));
      await verifyPreparedRun(snapshot, prepared);
    }), /does not match the campaign snapshot/);
  } finally {
    await cleanupCampaignSnapshot(snapshot);
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime verification rejects a changed executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "a4s-runtime-digest-test-"));
  const runtime = join(root, "pion");
  try {
    await writeFile(runtime, "runtime-v1\n");
    const digest = createHash("sha256").update("runtime-v1\n").digest("hex");
    await verifyRuntimeDigest(runtime, digest);
    await writeFile(runtime, "runtime-v2\n");
    await assert.rejects(verifyRuntimeDigest(runtime, digest), /runtime changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("temporary run and campaign directories are removed for every outcome", async () => {
  const root = await mkdtemp(join(tmpdir(), "a4s-campaign-cleanup-test-"));
  const policy = join(root, "AGENTS.md");
  const skill = join(root, "SKILL.md");
  const probe = join(root, "probe.ts");
  const fixture = join(root, "fixture.json");
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  await Promise.all([
    writeFile(policy, "policy\n"), writeFile(skill, "skill\n"), writeFile(probe, "probe\n"),
    writeFile(fixture, fixtureText), writeFile(join(agentDir, "settings.json"), "{}"),
    writeFile(join(agentDir, "models.json"), "{}"), writeFile(join(agentDir, "auth.json"), "{}"),
  ]);
  const snapshot = await createCampaignSnapshot({
    policySource: policy, skillSource: skill, probeSource: probe, fixtureSource: fixture,
    canonicalModelId: "provider/model-a", agentDir,
  });
  const runRoots: string[] = [];
  try {
    await withPreparedRun(snapshot, scenarios[0] as LiveScenario, async (prepared) => {
      runRoots.push(prepared.root);
    });
    await assert.rejects(withPreparedRun(snapshot, scenarios[0] as LiveScenario, async (prepared) => {
      runRoots.push(prepared.root);
      throw new Error("simulated error");
    }), /simulated error/);
    await assert.rejects(withPreparedRun(snapshot, scenarios[0] as LiveScenario, async (prepared) => {
      runRoots.push(prepared.root);
      throw new Error("simulated timeout");
    }), /simulated timeout/);
    for (const runRoot of runRoots) await assert.rejects(access(runRoot));
  } finally {
    const campaignRoot = snapshot.root;
    await cleanupCampaignSnapshot(snapshot);
    await assert.rejects(access(campaignRoot));
    await rm(root, { recursive: true, force: true });
  }
});

test("Pion argv fixes the model, disables builtin tools, and loads only the probe extension", () => {
  const args = pionArgs(
    { sessionDir: "/tmp/session", copiedSkill: "/tmp/SKILL.md", copiedProbe: "/tmp/probe.ts" },
    "fixed-session",
    "provider/model-a",
  );
  assert.equal(args.includes("--no-builtin-tools"), true);
  assert.equal(args.includes("--no-extensions"), true);
  assert.equal(args.includes("--extension"), true);
  assert.equal(args.includes("--tools"), false);
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "provider/model-a"]);
  assert.equal(args.filter((value) => value === "--extension").length, 1);
});

test("tool-surface preflight accepts only simulated probe tools", () => {
  assert.doesNotThrow(() => assertSimulatedToolSurface(["write", "bash", "subagent_run", "edit"]));
  assert.throws(
    () => assertSimulatedToolSurface(["bash", "edit", "write", "subagent_run", "read"]),
    /Unsafe active tool surface/,
  );
});

test("persistent metadata omits raw stderr, RPC, and final assistant text", () => {
  const capture: ProcessCapture = {
    outcome: "crash",
    infrastructureError: "AUTH=infra-secret",
    stdout: [{ rpc: "rpc-secret", env: { TOKEN: "token-secret" } }],
    stderr: "stderr-secret",
    finalText: "final-secret",
  };
  const persisted = JSON.stringify(persistedCaptureMetadata(capture));
  for (const secret of ["infra-secret", "rpc-secret", "token-secret", "stderr-secret", "final-secret"]) {
    assert.equal(persisted.includes(secret), false);
  }
  assert.equal(JSON.parse(persisted).hadFinalResponse, true);
});

test("sanitization redacts every supported credential form without trailing values", () => {
  const forms = [
    "Authorization: Bearer auth-colon-secret",
    "Authorization=Bearer auth-equals-secret",
    "Bearer standalone-secret",
    "TOKEN=pair-secret",
    "api_key: quoted-secret",
    "https://user:url-password@example.test/path",
  ];
  for (const form of forms) {
    const redacted = redactString(form);
    assert.match(redacted, /\[REDACTED\]/);
    for (const secret of ["auth-colon-secret", "auth-equals-secret", "standalone-secret", "pair-secret", "quoted-secret", "url-password", "user:"]) {
      assert.equal(redacted.includes(secret), false, form);
    }
  }

  const sanitized = sanitize({
    API_TOKEN: "one",
    signingKey: "two",
    client_SECRET: "three",
    PASSWORD_FILE: "four",
    AUTH_HEADER: "five",
    sessionCookie: "six",
    safe: `TOKEN=seven ${"x".repeat(3_000)}`,
    campaignKey: "public-campaign-id",
  }) as Record<string, unknown>;
  for (const key of ["API_TOKEN", "signingKey", "client_SECRET", "PASSWORD_FILE", "AUTH_HEADER", "sessionCookie"]) {
    assert.equal(sanitized[key], "[REDACTED]");
  }
  assert.equal(sanitized.campaignKey, "public-campaign-id");
  assert.equal(String(sanitized.safe).includes("seven"), false);
  assert.ok(String(sanitized.safe).length <= 2_000);
});

test("console, result, and top-level error channels are sanitized", () => {
  const consoleRecord = JSON.stringify(safeOutputRecord({
    message: "Authorization: Bearer console-secret at /tmp/path-secret/console.log",
    runtime: { path: "/tmp/runtime-secret/pion" },
  }));
  const resultRecord = JSON.stringify(safeOutputRecord({ result: "TOKEN=result-secret C:\\result-path-secret\\file" }));
  const errorText = safeErrorText(new Error("https://user:error-secret@example.test at /tmp/error-path-secret/file"));
  for (const secret of [
    "console-secret", "result-secret", "error-secret", "user:", "path-secret", "runtime-secret",
    "result-path-secret", "error-path-secret",
  ]) {
    assert.equal(`${consoleRecord}\n${resultRecord}\n${errorText}`.includes(secret), false);
  }
  const rawPath = "/tmp/TOKEN=results-path-secret/results.jsonl";
  const id = resultsIdentifier(rawPath);
  assert.match(id, /^sha256:[a-f0-9]{16}$/);
  assert.equal(id.includes(rawPath), false);
  assert.equal(id.includes("results-path-secret"), false);
});

test("abnormal exit after agent_settled remains a crash", () => {
  assert.deepEqual(classifyProcessOutcome({
    timedOut: false,
    promptRejected: null,
    settled: true,
    code: 7,
    signal: null,
    finalText: "done",
  }), {
    outcome: "crash",
    infrastructureError: "Pion exited abnormally after agent_settled (code=7, signal=null)",
  });
});

test("tool activity without a final assistant response is silence", () => {
  assert.deepEqual(classifyProcessOutcome({
    timedOut: false,
    promptRejected: null,
    settled: true,
    code: 0,
    signal: null,
    finalText: "",
  }), { outcome: "silence", infrastructureError: null });
});

test("manifest parsing fails on any unconsumed fixture field", () => {
  const parsed = JSON.parse(fixtureText) as Array<Record<string, unknown>>;
  parsed[0]!.unconsumed = true;
  assert.throws(() => parseScenarioManifest(JSON.stringify(parsed)), /unconsumed or missing field/);
});

test("all conceptual CLI commands parse and candidate is the default variant", () => {
  assert.equal(parseCli(["--tier", "smoke", "--runs", "7"]).variant, "candidate");
  assert.equal(parseCli(["--tier", "corpus"]).runs, 14);
  assert.equal(parseCli([
    "--tier", "compliance", "--runs", "300", "--resume", "--model", "provider/model-a",
  ]).resume, true);
  assert.equal(parseCli(["--tier", "git-e2e"]).tier, "git-e2e");
  assert.equal(parseCli([
    "--tier", "compliance", "--runs", "120", "--variant", "baseline",
    "--model", "provider/model-a", "--policy", "/baseline/AGENTS.md", "--skill", "/baseline/SKILL.md",
  ]).variant, "baseline");
  assert.equal(parseCli([
    "--tier", "corpus", "--variant", "baseline", "--root", "/baseline",
  ]).variantRoot, "/baseline");
  assert.throws(
    () => parseCli(["--tier", "compliance", "--runs", "300"]),
    /--model is required for compliance/,
  );
  assert.throws(
    () => parseCli(["--tier", "compliance", "--runs", "300", "--model", "fuzzy-id"]),
    /exact provider\/model/,
  );
  assert.throws(
    () => parseCli(["--tier", "smoke", "--runs", "7", "--resume"]),
    /--resume is valid only for compliance/,
  );
  const help = usage();
  assert.match(help, /A4S_RUN_AGENT_E2E=1 npm run eval:work-gates/);
  assert.match(help, /--tier compliance --runs 300 --model provider\/model/);
  assert.match(help, /^  --help, -h\s+Show this help\.$/m);
  for (const option of [
    "--deadline-ms", "--policy", "--skill", "--root", "--variant", "--results",
    "--resume", "--concurrency", "--model", "--tier", "--runs",
  ]) {
    assert.match(help, new RegExp(option));
  }
  const examples = help.split("\n").filter((line) => line.trim().startsWith("A4S_RUN_AGENT_E2E=1"));
  assert.equal(examples.length, 3);
  const parsedExamples = examples.map((line) => parseCli(line.split(" -- ")[1]!.trim().split(/\s+/)));
  assert.equal(parsedExamples[0]!.variant, "candidate");
  assert.equal(parsedExamples[1]!.variantRoot, "/baseline");
  assert.equal(parsedExamples[2]!.policyPath, "/baseline/AGENTS.md");
  assert.equal(parsedExamples[2]!.skillPath, "/baseline/skills/work-lifecycle/SKILL.md");
});

test("the live runner does not resolve or start Pion without opt-in", () => {
  const runner = new URL("./support/work-gate-live.ts", import.meta.url).pathname;
  const env: NodeJS.ProcessEnv = { ...process.env, PI_BIN: "/tmp/should-not-resolve/pion" };
  delete env.A4S_RUN_AGENT_E2E;
  const run = spawnSync(process.execPath, ["--import", "tsx", runner], {
    cwd: process.cwd(), env, encoding: "utf8", timeout: 20_000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim()), {
    status: "skipped",
    reason: "set A4S_RUN_AGENT_E2E=1 to run live Pion work-gate evaluation",
    pionStarted: false,
  });

  const help = spawnSync(process.execPath, ["--import", "tsx", runner, "--help"], {
    cwd: process.cwd(), env, encoding: "utf8", timeout: 20_000,
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage:/);
  assert.match(help.stdout, /A4S_RUN_AGENT_E2E=1/);
  assert.match(help.stdout, /--tier compliance --runs 300 --model provider\/model/);

  const optedIn = { ...env, A4S_RUN_AGENT_E2E: "1" };
  const missingModel = spawnSync(process.execPath, [
    "--import", "tsx", runner, "--tier", "compliance", "--runs", "300", "--resume",
  ], { cwd: process.cwd(), env: optedIn, encoding: "utf8", timeout: 20_000 });
  assert.equal(missingModel.status, 1);
  assert.match(missingModel.stderr, /--model is required for compliance/);
  assert.doesNotMatch(missingModel.stderr, /Pion executable not found/);
});

test("baseline inputs are explicit and never inherit candidate environment paths", () => {
  assert.throws(
    () => parseCli(["--tier", "corpus", "--variant", "baseline"]),
    /baseline requires/,
  );
  const options = parseCli([
    "--tier", "corpus", "--variant", "baseline", "--root", "/explicit-baseline",
  ]);
  assert.deepEqual(resolveVariantInputs(options), {
    policySource: "/explicit-baseline/AGENTS.md",
    skillSource: "/explicit-baseline/skills/work-lifecycle/SKILL.md",
  });
  const identity = {
    policyDigest: "p", skillDigest: "s", probeDigest: "x", manifestDigest: "m",
    runtimeVersion: "v", runtimeSha256: "r", settingsDigest: "settings",
    modelsDigest: "models", authDigest: "auth", modelDigest: "model",
  };
  const candidateKey = campaignKeyFor({
    tier: "corpus", variant: "candidate", ...identity,
  });
  const baselineKey = campaignKeyFor({
    tier: "corpus", variant: "baseline", ...identity,
  });
  assert.notEqual(candidateKey, baselineKey);
});
