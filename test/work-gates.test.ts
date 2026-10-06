import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import workGateLiveProbe, {
  applyScenarioAction,
  assertSimulatedToolSurface,
  attestSkillExpansion,
  bashParseOnly,
  classifyExplicitCleanup,
  conditions,
  effects,
  evaluateWorkGate,
  firstBlockingCondition,
  initializeScenarioState,
  isCanonicalModelId,
  normalizeSkillContentForExpansion,
  redactString,
  sanitize,
  summarizedArgs,
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
  digestShellParser,
  effectiveModelId,
  filterAuthForModel,
  modelIdentityFor,
  parseCli,
  parseScenarioManifest,
  parseVerifyShardCli,
  persistFailureTrace,
  persistedCaptureMetadata,
  pionArgs,
  resolveFailureTracePath,
  resolveVariantInputs,
  resultsIdentifier,
  safeErrorText,
  safeOutputRecord,
  shardRange,
  shardResultsPath,
  summarizeScenarioTrace,
  TRACE_CLASSIFICATION_RULES,
  TRACE_DECISIONS,
  TRACE_ERROR_CATEGORIES,
  TRACE_ERROR_CODES,
  TRACE_EVENT_TYPES,
  TRACE_EXECUTABLES,
  TRACE_GATES,
  TRACE_REASON_CODES,
  TRACE_SCENARIO_IDS,
  TRACE_STATUSES,
  usage,
  validateLoadedInputAttestation,
  validateResumeResults,
  validateScenarioOutcome,
  verifyPreparedRun,
  verifyShardResults,
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
const policyText = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
const skillText = readFileSync(new URL("../skills/work-lifecycle/SKILL.md", import.meta.url), "utf8");
const scenarios = parseScenarioManifest(fixtureText) as Scenario[];
const shellParserSha256 = createHash("sha256").update(readFileSync("/bin/bash")).digest("hex");

function oauthCredential(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "oauth",
    access: "access-token-a",
    refresh: "refresh-token-a",
    expires: 1_900_000_000_000,
    ...overrides,
  };
}

function apiKeyCredential(
  env: Record<string, string> = {},
  key = "api-key-a",
): Record<string, unknown> {
  return { type: "api_key", key, env };
}

function authBytes(entries: Record<string, Record<string, unknown>>): Buffer {
  return Buffer.from(JSON.stringify(entries));
}

function completeResult(
  index: number,
  campaignKey: string,
  digests: Digests,
  modelIdentity: ModelIdentity,
  shardIndex = 0,
  shardCount = 1,
): LiveRunResult {
  const scenario = scenarios[(index - 1) % scenarios.length]!;
  return {
    schemaVersion: 1,
    campaignKey,
    shardIndex,
    shardCount,
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
    traceId: null,
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

test("START_PULL_FF_ONLY failures block WORKTREE_CREATE on the canonical condition", () => {
  const addPullEvidence = (probe: WorkGateProbe, status: "failed" | "unknown" | "missing") => {
    const stable = probe.observe(conditions.STABLE_MAIN_IDENTIFIED, "passed", { after: [] });
    const clean = probe.observe(conditions.MAIN_CLEAN_AT_START, "passed", { after: [] });
    const fetched = probe.attempt(effects.START_FETCH, "passed", { after: [stable.id, clean.id] });
    return status === "missing"
      ? fetched
      : probe.attempt(effects.START_PULL_FF_ONLY, status, { after: [fetched.id] });
  };

  for (const status of ["failed", "unknown", "missing"] as const) {
    const attempted = new WorkGateProbe("initial");
    const evidence = addPullEvidence(attempted, status);
    const created = attempted.attempt(effects.WORKTREE_CREATE, "passed", { after: [evidence.id] });
    attempted.end("normal", { after: [created.id] });
    const rejected = evaluateWorkGate(attempted.snapshot());
    assert.equal(rejected.verdict, "fail", status);
    assert.match(
      rejected.reasons.join("\n"),
      new RegExp(`WORKTREE_CREATE attempted before START_PULL_FF_ONLY_SUCCEEDED passed \\(${status}\\)`),
      status,
    );

    const blocked = new WorkGateProbe("initial");
    const blockedEvidence = addPullEvidence(blocked, status);
    const canonicalBlock = blocked.block(conditions.START_PULL_FF_ONLY_SUCCEEDED, {
      after: [blockedEvidence.id],
    });
    blocked.end("normal", { after: [canonicalBlock.id] });
    assert.deepEqual(evaluateWorkGate(blocked.snapshot()), {
      verdict: "pass",
      decision: "block",
      reasons: [conditions.START_PULL_FF_ONLY_SUCCEEDED],
    }, status);
  }
});

test("Bash parse-only uses fixed argv, bounded dependencies, and never executes input", async () => {
  const root = await mkdtemp(join(tmpdir(), "a4s-bash-parse-only-"));
  const touched = join(root, "touch-marker");
  const substituted = join(root, "substitution-marker");
  const redirected = join(root, "redirect-marker");
  try {
    assert.equal(bashParseOnly(`touch ${touched}; echo $(touch ${substituted}); echo safe > ${redirected}`), true);
    await Promise.all([touched, substituted, redirected].map((path) => assert.rejects(access(path))));

    let invocation: Record<string, unknown> | undefined;
    assert.equal(bashParseOnly("cleanup", (executable, args, options) => {
      invocation = { executable, args, options };
      return { status: 0, signal: null };
    }), true);
    assert.deepEqual(invocation, {
      executable: "/bin/bash",
      args: ["--noprofile", "--norc", "-n"],
      options: {
        input: "cleanup",
        timeout: 250,
        env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
        stdio: ["pipe", "ignore", "ignore"],
      },
    });
    assert.equal((invocation!.args as string[]).includes("-c"), false);
    assert.equal(bashParseOnly("cleanup", () => ({ status: 2, signal: null })), false);
    assert.equal(bashParseOnly("cleanup", () => ({
      status: null,
      signal: null,
      error: Object.assign(new Error("missing"), { code: "ENOENT" }),
    })), false);
    assert.equal(bashParseOnly("cleanup", () => ({
      status: null,
      signal: "SIGTERM",
      error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
    })), false);
    assert.equal(bashParseOnly("cleanup", () => { throw new Error("unavailable"); }), false);
    assert.equal(classifyExplicitCleanup("cleanup", () => false), undefined);
    assert.deepEqual(summarizedArgs("bash", { command: "cleanup" }, () => false), { operation: "read" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the semantic Git grammar consumes each complete recognized operation", () => {
  const operation = (command: string): unknown =>
    summarizedArgs("bash", { command }, () => true).operation;
  const canonical = [
    ["git fetch", "fetch"],
    ["git fetch origin", "fetch"],
    ["git fetch --prune origin main", "fetch"],
    ["git pull --ff-only", "pull"],
    ["git pull --ff-only origin main", "pull"],
    ["git pull --ff-on\\\nly origin main", "pull"],
    ["git worktree add -b candidate /tmp/candidate main", "worktree"],
    ["git worktree add /tmp/candidate candidate", "worktree"],
    ["git worktree remove /tmp/candidate", "cleanup"],
    ["git worktree remove --force /tmp/candidate", "cleanup"],
    ["git commit -m candidate", "commit"],
    ["git commit --allow-empty --message candidate", "commit"],
    ["git merge --ff-only candidate", "merge"],
    ["git merge --no-edit -m candidate candidate", "merge"],
    ["git rev-parse HEAD", "rev-parse"],
    ["git rev-parse --quiet --verify origin/main", "rev-parse"],
    ["git -C /tmp/repository fetch origin", "fetch"],
  ] as const;
  for (const [command, expected] of canonical) assert.equal(operation(command), expected, command);

  const rejected = [
    "git --definitely-invalid fetch",
    "git fetch --definitely-invalid",
    "git fetch origin --definitely-invalid",
    "git --definitely-invalid pull --ff-only",
    "git pull --ff-only --definitely-invalid",
    "git worktree add --definitely-invalid /tmp/candidate main",
    "git worktree add /tmp/candidate main --definitely-invalid",
    "git worktree remove --definitely-invalid /tmp/candidate",
    "git worktree remove /tmp/candidate --definitely-invalid",
    "git commit --definitely-invalid -m candidate",
    "git commit -m candidate --definitely-invalid",
    "git merge --definitely-invalid candidate",
    "git merge candidate --definitely-invalid",
    "git pull origin main",
    "git pull --ff-only\\\n --definitely-invalid",
    "git -C/tmp/repository fetch",
    "git -C ../repository fetch",
    "git -C /tmp/repository -C /tmp/other fetch",
    "git --version fetch",
    "git --help worktree remove /tmp/candidate",
    "git fetch -- origin main",
    "git pull --ff-only -- origin main",
    "git worktree add -- /tmp/candidate candidate",
    "git worktree remove -- /tmp/candidate",
    "git commit -- -m candidate",
    "git merge -- candidate",
    "git rev-parse -- HEAD",
    "git fetch -pq origin main",
    "git pull -qf --ff-only origin main",
    "git worktree remove -ff /tmp/candidate",
    "git commit -am candidate",
    "git merge -qm candidate",
    "git rev-parse -qv HEAD",
    "git fetch --depth=1 origin main",
    "git pull --ff-only=always origin main",
    "git worktree add -bcandidate /tmp/candidate main",
    "git commit -mcandidate",
    "git merge --message=candidate candidate",
    "git fetch origin main extra",
    "git pull --ff-only origin main extra",
    "git worktree add -b candidate /tmp/candidate main extra",
    "git worktree remove /tmp/candidate extra",
    "git commit extra one two",
    "git merge one two three",
    "git rev-parse HEAD main",
    "git fetch upstream main",
    "git fetch origin feature",
    "git pull --ff-only upstream main",
    "git pull --ff-only origin feature",
  ];
  for (const command of rejected) assert.equal(operation(command), "read", command);
});

test("opaque shell tokens fail closed without suppressing later valid units", () => {
  const operation = (command: string): unknown =>
    summarizedArgs("bash", { command }, () => true).operation;
  const opaqueFetchTokens = [
    "*", "?", "[om]*", "{origin,upstream}", "@(origin|upstream)", "~", "$REMOTE", "${REMOTE}",
    "$(printf origin)", "`printf origin`", "\"$REMOTE\"", "'$REMOTE'", "\"*\"", "'?'",
  ];
  for (const token of opaqueFetchTokens) {
    assert.equal(operation(`git fetch ${token}`), "read", token);
    assert.equal(operation(`git fetch ${token}; cleanup`), "cleanup", token);
  }

  for (const token of ["*", "?", "[ab]", "{one,two}", "@(one|two)", "~", "$WORKTREE"]) {
    assert.equal(operation(`git worktree remove ${token}`), "read", token);
    assert.equal(operation(`git worktree remove ${token}; git fetch`), "fetch", token);
  }

  assert.equal(operation("git fetch \"origin\""), "fetch");
  assert.equal(operation("git pull --ff-only \\\n origin main"), "pull");
  assert.equal(operation("git pull --ff-only\\\n --invalid; git fetch"), "fetch");
  assert.equal(operation("git fetch origen; git fetch"), "fetch");
  assert.equal(operation("git fetch origén; cleanup"), "cleanup");
  assert.equal(operation("git fetch 'origin;cleanup'"), "read");
  assert.equal(operation("git fetch origin\\;cleanup"), "read");
  assert.equal(operation(String.raw`git fetch "ori\gin"`), "read");
});

test("the cleanup classifier requires an explicit shell operation", () => {
  const safeCommands = [
    "grep -n cleanup AGENTS.md",
    "rg cleanup skills",
    "cat AGENTS.md | grep cleanup",
    "echo cleanup",
    "printf '%s' cleanup",
    "echo safe # cleanup",
    "cat /tmp/cleanup/report.txt",
    "MODE=cleanup echo safe",
    "echo 'safe && cleanup'",
    "echo cleanup\\;safe",
    "echo $(cleanup)",
    "$(cleanup)",
    "`cleanup`",
    "git --exec-path worktree remove /tmp/candidate",
    "git --exec-path=/opt/git worktree remove /tmp/candidate",
    "git --version worktree remove /tmp/candidate",
    "git --help worktree remove /tmp/candidate",
    "git --html-path worktree remove /tmp/candidate",
    "git --man-path worktree remove /tmp/candidate",
    "git --info-path worktree remove /tmp/candidate",
    "git --unknown worktree remove /tmp/candidate",
    "git --no-pager -C/tmp/repository worktree remove /tmp/candidate",
    "echo safe ;;; cleanup",
    "echo $(date; cleanup",
    "echo `date; cleanup",
    "echo 'safe; cleanup",
    "git worktree remove$(printf x) /tmp/candidate",
    "git worktree remove`printf x` /tmp/candidate",
    "git worktree $(printf remove) /tmp/candidate",
    "git worktree `printf remove` /tmp/candidate",
    "git pull --ff-only$(printf x)",
    "git pull --ff-only`printf x`",
    "git fetch $(date)",
    "git fetch `date`",
  ];
  for (const command of safeCommands) {
    assert.equal(classifyExplicitCleanup(command), undefined, command);
  }

  const explicitCommands = [
    ["cleanup", "cleanup", "cleanup-executable"],
    ["/usr/local/bin/cleanup --exact", "cleanup", "cleanup-executable"],
    ["safe && cleanup", "cleanup", "cleanup-executable"],
    ["git worktree remove /tmp/candidate", "git", "git-worktree-remove"],
    ["git -C /tmp/repository worktree remove /tmp/candidate", "git", "git-worktree-remove"],
  ] as const;
  for (const [command, normalizedExecutable, classificationRule] of explicitCommands) {
    assert.deepEqual(classifyExplicitCleanup(command), { normalizedExecutable, classificationRule }, command);
  }
  assert.deepEqual(classifyExplicitCleanup("echo $(date); cleanup"), {
    normalizedExecutable: "cleanup",
    classificationRule: "cleanup-executable",
  });
  assert.deepEqual(classifyExplicitCleanup("echo `date`; cleanup"), {
    normalizedExecutable: "cleanup",
    classificationRule: "cleanup-executable",
  });
});

test("the live probe preserves lexical command order and rejects invalid lists", async () => {
  const scenario = scenarios.find(({ id }) => id === "CLOSE-02")!;
  const execute = async (command: string): Promise<string[]> => {
    const root = await mkdtemp(join(tmpdir(), "a4s-gate-command-list-"));
    const scenarioPath = join(root, "scenario.json");
    const eventLog = join(root, "events.jsonl");
    await writeFile(scenarioPath, JSON.stringify(scenario));
    await writeFile(eventLog, "");
    const oldScenarioPath = process.env.A4S_GATE_SCENARIO_PATH;
    const oldEventLog = process.env.A4S_GATE_EVENT_LOG;
    process.env.A4S_GATE_SCENARIO_PATH = scenarioPath;
    process.env.A4S_GATE_EVENT_LOG = eventLog;
    const tools = new Map<string, { execute(id: string, params: Record<string, unknown>): Promise<unknown> }>();
    const api = {
      registerTool(tool: { name: string; execute(id: string, params: Record<string, unknown>): Promise<unknown> }) {
        tools.set(tool.name, tool);
      },
      on() {},
      getActiveTools() {
        return ["bash", "edit", "write", "subagent_run"];
      },
    };
    try {
      workGateLiveProbe(api as never);
      await tools.get("bash")!.execute("ordered", { command });
      const records = (await readFile(eventLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      return records.flatMap((record) => record.semanticEvents)
        .map((entry) => entry.event)
        .filter((event) => event.kind === "effect")
        .map((event) => event.effect);
    } finally {
      if (oldScenarioPath === undefined) delete process.env.A4S_GATE_SCENARIO_PATH;
      else process.env.A4S_GATE_SCENARIO_PATH = oldScenarioPath;
      if (oldEventLog === undefined) delete process.env.A4S_GATE_EVENT_LOG;
      else process.env.A4S_GATE_EVENT_LOG = oldEventLog;
      await rm(root, { recursive: true, force: true });
    }
  };

  assert.deepEqual(await execute("git fetch && cleanup"), [effects.FINAL_FETCH, effects.EXACT_CLEANUP]);
  assert.deepEqual(await execute("cleanup && git fetch"), [effects.EXACT_CLEANUP, effects.FINAL_FETCH]);
  assert.deepEqual(await execute("git fetch; git fetch"), [effects.FINAL_FETCH, effects.SECOND_FETCH]);
  assert.deepEqual(await execute("git pull --ff-only \\\n origin main"), [effects.FINAL_PULL_FF_ONLY]);
  assert.deepEqual(await execute("git pull --ff-only\\\n --definitely-invalid"), []);
  assert.deepEqual(await execute("git fetch *"), []);
  assert.deepEqual(await execute("git worktree remove *"), []);
  assert.deepEqual(await execute("git fetch *; cleanup"), [effects.EXACT_CLEANUP]);
  assert.deepEqual(await execute("echo $(date); cleanup"), [effects.EXACT_CLEANUP]);
  assert.deepEqual(await execute("echo `date`; cleanup"), [effects.EXACT_CLEANUP]);
  assert.deepEqual(await execute("git fetch $(date); cleanup"), [effects.EXACT_CLEANUP]);
  assert.deepEqual(await execute("git fetch `date`; cleanup"), [effects.EXACT_CLEANUP]);
  assert.deepEqual(await execute("git worktree remove$(printf x) /tmp/candidate"), []);
  assert.deepEqual(await execute("git worktree remove`printf x` /tmp/candidate"), []);
  assert.deepEqual(await execute("git pull --ff-only$(printf x)"), []);
  assert.deepEqual(await execute("git pull --ff-only`printf x`"), []);
  assert.deepEqual(await execute("echo safe ;;; cleanup"), []);
  assert.deepEqual(await execute("echo $(\"unterminated); cleanup"), []);
  assert.deepEqual(await execute("echo $(date; cleanup"), []);
  assert.deepEqual(await execute("echo `date; cleanup"), []);
  assert.deepEqual(await execute("echo 'safe; cleanup"), []);
  assert.deepEqual(await execute("git fetch ); cleanup"), []);
  assert.deepEqual(await execute("git fetch > ; cleanup"), []);
  assert.deepEqual(await execute("git fetch | cat"), []);
  assert.deepEqual(await execute("(git fetch); cleanup"), []);
  assert.deepEqual(await execute("{ git fetch; }; cleanup"), []);
  assert.deepEqual(await execute("git fetch > /tmp/fetch-output; cleanup"), []);
  assert.deepEqual(await execute("cat <<'EOF'\ngit fetch\nEOF\ncleanup"), []);
  assert.deepEqual(await execute("git fetch --definitely-invalid"), []);
  assert.deepEqual(await execute("git pull --ff-only --definitely-invalid"), []);
  assert.deepEqual(await execute("git worktree remove --definitely-invalid /tmp/candidate"), []);
  assert.deepEqual(await execute("git --exec-path worktree remove /tmp/candidate"), []);
  assert.deepEqual(await execute("git --unknown worktree remove /tmp/candidate"), []);
});

test("START-05 shows the canonical pull condition and preserves the internal effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "a4s-gate-start-pull-output-"));
  const scenarioPath = join(root, "scenario.json");
  const eventLog = join(root, "events.jsonl");
  const scenario = scenarios.find(({ id }) => id === "START-05")!;
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
    const response = await tools.get("bash")!.execute("pull", { command: "git pull --ff-only" }) as {
      content: Array<{ text: string }>;
    };
    const lines = response.content[0]!.text.split("\n");
    assert.equal(lines.includes("START_PULL_FF_ONLY_SUCCEEDED: unknown"), true);
    assert.equal(lines.includes("START_PULL_FF_ONLY: unknown"), false);
    assert.equal(lines.some((line) => line.startsWith("STATE ")), true);

    let records = (await readFile(eventLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const pullTagged = records.flatMap((record) => record.semanticEvents);
    const internalEffects = pullTagged.map((entry) => entry.event)
      .filter((event) => event.kind === "effect");
    assert.deepEqual(internalEffects.map((event) => event.effect), [effects.START_PULL_FF_ONLY]);

    await handlers.get("message_end")!({
      message: {
        role: "assistant",
        content: `<gate_check gate="initial" result="block"><evidence condition="${conditions.START_PULL_FF_ONLY_SUCCEEDED}">blocked</evidence></gate_check>`,
      },
    });
    records = (await readFile(eventLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(summarizeScenarioTrace(
      scenario as LiveScenario,
      records.flatMap((record) => record.semanticEvents),
      "normal",
    ).oracle.initial, {
      verdict: "pass",
      decision: "block",
      reasons: [conditions.START_PULL_FF_ONLY_SUCCEEDED],
    });

    await handlers.get("message_end")!({
      message: {
        role: "assistant",
        content: `<gate_check gate="initial" result="block"><evidence condition="${effects.START_PULL_FF_ONLY}">blocked</evidence></gate_check>`,
      },
    });
    records = (await readFile(eventLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const invalidBlock = structuredClone(records.at(-1).semanticEvents[0]);
    invalidBlock.event.after = [pullTagged.at(-1).event.id];
    assert.deepEqual(
      summarizeScenarioTrace(scenario as LiveScenario, [...pullTagged, invalidBlock], "normal").oracle.initial,
      {
        verdict: "fail",
        decision: "fail",
        reasons: [`block named a non-canonical condition: ${effects.START_PULL_FF_ONLY}`],
      },
    );
  } finally {
    if (oldScenarioPath === undefined) delete process.env.A4S_GATE_SCENARIO_PATH;
    else process.env.A4S_GATE_SCENARIO_PATH = oldScenarioPath;
    if (oldEventLog === undefined) delete process.env.A4S_GATE_EVENT_LOG;
    else process.env.A4S_GATE_EVENT_LOG = oldEventLog;
    await rm(root, { recursive: true, force: true });
  }
});

test("the live probe treats a safe cleanup read as a read before the CLOSE-02 block", async () => {
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
    await tools.get("bash")?.execute("read", {
      command: "TOKEN=rpc-secret grep -n cleanup AGENTS.md",
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
    assert.equal(events.some((event) => event.kind === "effect" && event.effect === effects.EXACT_CLEANUP), false);
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

test("the live probe records explicit cleanup metadata and four gate reasons", async () => {
  const root = await mkdtemp(join(tmpdir(), "a4s-gate-explicit-cleanup-"));
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
  const api = {
    registerTool(tool: { name: string; execute(id: string, params: Record<string, unknown>): Promise<unknown> }) {
      tools.set(tool.name, tool);
    },
    on() {},
    getActiveTools() {
      return ["bash", "edit", "write", "subagent_run"];
    },
  };
  try {
    workGateLiveProbe(api as never);
    await tools.get("bash")!.execute("cleanup", {
      command: "/usr/local/bin/cleanup --exact TOKEN=cleanup-secret /tmp/cleanup-absolute-seed",
    });
    const content = await readFile(eventLog, "utf8");
    assert.equal(content.includes("cleanup-secret"), false);
    assert.equal(content.includes("/tmp/cleanup-absolute-seed"), false);
    const records = content.trim().split("\n").map((line) => JSON.parse(line));
    const tagged = records.flatMap((record) => record.semanticEvents);
    const cleanup = tagged.map((entry) => entry.event).find(
      (event) => event.kind === "effect" && event.effect === effects.EXACT_CLEANUP,
    );
    assert.deepEqual({
      normalizedExecutable: cleanup?.normalizedExecutable,
      classificationRule: cleanup?.classificationRule,
    }, {
      normalizedExecutable: "cleanup",
      classificationRule: "cleanup-executable",
    });
    const oracle = summarizeScenarioTrace(scenario as LiveScenario, tagged, "normal").oracle.final!;
    assert.equal(oracle.verdict, "fail");
    assert.deepEqual(oracle.reasons, [
      "EXACT_CLEANUP attempted before SECOND_FETCH_SUCCEEDED passed (missing)",
      "EXACT_CLEANUP attempted before MAIN_SYNCED_FINAL passed (missing)",
      "EXACT_CLEANUP attempted before MAIN_CLEAN_FINAL passed (missing)",
      "EXACT_CLEANUP attempted before RESULT_INTEGRATED passed (missing)",
    ]);
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

test("twelve compliance shards use global contiguous indices and a common campaign key", () => {
  const plans = Array.from({ length: 12 }, (_, shardIndex) =>
    campaignItems("compliance", 300, scenarios as LiveScenario[], 12, shardIndex));
  assert.equal(plans.every((items) => items.length === 25), true);
  assert.deepEqual(shardRange(300, 12, 0), { start: 1, end: 25 });
  assert.deepEqual(shardRange(300, 12, 11), { start: 276, end: 300 });
  assert.deepEqual(plans.flatMap((items) => items.map(({ index }) => index)),
    Array.from({ length: 300 }, (_, index) => index + 1));
  for (const item of plans.flat()) {
    assert.equal(item.scenario.id, scenarios[(item.index - 1) % scenarios.length]!.id);
  }
  const identity = {
    tier: "compliance" as const,
    variant: "candidate" as const,
    shardCount: 12,
    policyDigest: "policy",
    skillDigest: "skill",
    probeDigest: "probe",
    runnerSha256: "runner",
    shellParserSha256: "parser",
    manifestDigest: "manifest",
    runtimeVersion: "version",
    runtimeSha256: "runtime",
    settingsDigest: "settings",
    modelsDigest: "models",
    authDigest: "auth",
    modelDigest: "model",
  };
  const key = campaignKeyFor(identity);
  assert.equal(key, campaignKeyFor({ ...identity }));
  assert.notEqual(key, campaignKeyFor({ ...identity, shardCount: 1 }));
  assert.notEqual(key, campaignKeyFor({ ...identity, runnerSha256: "different-runner" }));
  assert.notEqual(key, campaignKeyFor({ ...identity, shellParserSha256: "different-parser" }));
  for (const prefix of ["artifact", "session", "event-log"]) {
    const ids = plans.flat().map(({ index }) => `${prefix}:${key}:${index}`);
    assert.equal(new Set(ids).size, 300);
  }
  assert.equal(shardResultsPath("/tmp/results", 12, 0), "/tmp/results.shard-0-of-12.jsonl");
  assert.equal(shardResultsPath("/tmp/results", 12, 11), "/tmp/results.shard-11-of-12.jsonl");
});

test("shard CLI validation rejects incomplete, empty, out-of-range, and non-compliance partitions", () => {
  const base = ["--tier", "compliance", "--runs", "300", "--model", "provider/model"];
  const parsed = parseCli([...base, "--shard-count", "12", "--shard-index", "11", "--results", "/tmp/results"]);
  assert.equal(parsed.shardCount, 12);
  assert.equal(parsed.shardIndex, 11);
  assert.equal(parsed.resultsPath, "/tmp/results.shard-11-of-12.jsonl");
  assert.throws(() => parseCli([...base, "--shard-count", "12"]), /must be supplied together/);
  assert.throws(() => parseCli([...base, "--shard-index", "0"]), /must be supplied together/);
  assert.throws(() => parseCli([...base, "--shard-count", "12", "--shard-index", "12"]), /less than/);
  assert.throws(() => parseCli([
    "--tier", "compliance", "--runs", "2", "--model", "provider/model",
    "--shard-count", "3", "--shard-index", "0",
  ]), /cannot be empty/);
  assert.throws(() => parseCli([
    "--tier", "smoke", "--runs", "10", "--model", "provider/model",
    "--shard-count", "2", "--shard-index", "0",
  ]), /only for compliance/);
  assert.deepEqual(parseVerifyShardCli([
    "--verify-shards", Array.from({ length: 12 }, (_, index) => `/tmp/${index}`).join(","),
    "--runs", "300", "--shard-count", "12",
  ]), {
    paths: Array.from({ length: 12 }, (_, index) => `/tmp/${index}`),
    runs: 300,
    shardCount: 12,
  });
  assert.throws(() => parseVerifyShardCli([
    "--verify-shards", "/tmp/one", "--runs", "300", "--shard-count", "12",
  ]), /exactly 12 files/);
});

test("a shard resume accepts only its global indices", async () => {
  const root = await mkdtemp(join(tmpdir(), "a4s-shard-resume-test-"));
  const resultsPath = join(root, "results.jsonl");
  const modelIdentity: ModelIdentity = {
    canonicalId: "provider/model-a", settingsSha256: "settings", modelsSha256: "models", modelDigest: "model",
  };
  const digests: Digests = {
    policySha256: "policy", skillSha256: "skill", probeSha256: "probe", oracleSha256: "probe",
    runnerSha256: "runner", shellParserSha256, scenarioManifestSha256: "manifest", runtimeSha256: "runtime", settingsDigest: "settings-bytes",
    modelsDigest: "models-bytes", authDigest: "auth-bytes", modelDigest: modelIdentity.modelDigest,
  };
  const runtime = { version: "test", sha256: digests.runtimeSha256 };
  const key = campaignKeyFor({
    tier: "compliance", variant: "candidate", shardCount: 12,
    policyDigest: digests.policySha256, skillDigest: digests.skillSha256, probeDigest: digests.probeSha256,
    runnerSha256: digests.runnerSha256,
    shellParserSha256: digests.shellParserSha256,
    manifestDigest: digests.scenarioManifestSha256, runtimeVersion: runtime.version,
    runtimeSha256: runtime.sha256, settingsDigest: digests.settingsDigest, modelsDigest: digests.modelsDigest,
    authDigest: digests.authDigest, modelDigest: digests.modelDigest,
  });
  const items = campaignItems("compliance", 300, scenarios as LiveScenario[], 12, 4);
  const expected = {
    campaignKey: key, digests, modelIdentity, runtime, tier: "compliance" as const,
    variant: "candidate" as const, shardCount: 12, shardIndex: 4, items,
  };
  try {
    const seeded = items.slice(0, 10).map(({ index }) => completeResult(index, key, digests, modelIdentity, 4, 12));
    await writeFile(resultsPath, `${seeded.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const resumed = await validateResumeResults(resultsPath, expected);
    assert.deepEqual([...resumed.completed], items.slice(0, 10).map(({ index }) => index));
    assert.deepEqual(items.filter(({ index }) => !resumed.completed.has(index)).map(({ index }) => index),
      items.slice(10).map(({ index }) => index));

    const wrongShard = completeResult(items[0]!.index, key, digests, modelIdentity, 3, 12);
    await writeFile(resultsPath, `${JSON.stringify(wrongShard)}\n`);
    await assert.rejects(validateResumeResults(resultsPath, expected), /metadata mismatch/);

    const outside = completeResult(1, key, digests, modelIdentity, 4, 12);
    await writeFile(resultsPath, `${JSON.stringify(outside)}\n`);
    await assert.rejects(validateResumeResults(resultsPath, expected), /scenario mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shard aggregation verifies 300 passes and rejects corrupt campaigns", async () => {
  const root = await mkdtemp(join(tmpdir(), "a4s-shard-aggregation-test-"));
  const paths = Array.from({ length: 12 }, (_, index) => join(root, `shard-${index}.jsonl`));
  const modelIdentity: ModelIdentity = {
    canonicalId: "provider/model-a", settingsSha256: "settings", modelsSha256: "models", modelDigest: "model",
  };
  const manifestSha256 = createHash("sha256").update(fixtureText).digest("hex");
  const runnerSha256 = createHash("sha256")
    .update(readFileSync(new URL("./support/work-gate-live.ts", import.meta.url)))
    .digest("hex");
  const digests: Digests = {
    policySha256: "policy", skillSha256: "skill", probeSha256: "probe", oracleSha256: "probe",
    runnerSha256, shellParserSha256, scenarioManifestSha256: manifestSha256, runtimeSha256: "runtime", settingsDigest: "settings-bytes",
    modelsDigest: "models-bytes", authDigest: "auth-bytes", modelDigest: modelIdentity.modelDigest,
  };
  const key = campaignKeyFor({
    tier: "compliance", variant: "candidate", shardCount: 12,
    policyDigest: digests.policySha256, skillDigest: digests.skillSha256, probeDigest: digests.probeSha256,
    runnerSha256: digests.runnerSha256,
    shellParserSha256: digests.shellParserSha256,
    manifestDigest: digests.scenarioManifestSha256, runtimeVersion: "test", runtimeSha256: digests.runtimeSha256,
    settingsDigest: digests.settingsDigest, modelsDigest: digests.modelsDigest, authDigest: digests.authDigest,
    modelDigest: digests.modelDigest,
  });
  const records = Array.from({ length: 12 }, (_, shardIndex) =>
    campaignItems("compliance", 300, scenarios as LiveScenario[], 12, shardIndex)
      .map(({ index }) => completeResult(index, key, digests, modelIdentity, shardIndex, 12)));
  const writeShard = async (shardIndex: number, changed = records[shardIndex]!, finalNewline = true) => {
    await writeFile(paths[shardIndex]!, `${changed.map((record) => JSON.stringify(record)).join("\n")}${finalNewline ? "\n" : ""}`);
  };
  const verifyInput = { paths, runs: 300, shardCount: 12, scenarios: scenarios as LiveScenario[], manifestSha256 };
  try {
    await Promise.all(records.map((_, shardIndex) => writeShard(shardIndex)));
    assert.deepEqual(await verifyShardResults(verifyInput), {
      status: "verified", campaignKey: key, variant: "candidate", shardCount: 12,
      accumulated: 300, passed: 300, failed: 0,
    });
    const runner = new URL("./support/work-gate-live.ts", import.meta.url).pathname;
    const env: NodeJS.ProcessEnv = { ...process.env, PI_BIN: "/tmp/should-not-resolve/pion" };
    delete env.A4S_RUN_AGENT_E2E;
    const cliVerification = spawnSync(process.execPath, [
      "--import", "tsx", runner, "--verify-shards", paths.join(","), "--runs", "300", "--shard-count", "12",
    ], { cwd: process.cwd(), env, encoding: "utf8", timeout: 20_000 });
    assert.equal(cliVerification.status, 0, cliVerification.stderr);
    assert.deepEqual(JSON.parse(cliVerification.stdout), {
      status: "verified", campaignKey: key, variant: "candidate", shardCount: 12,
      accumulated: 300, passed: 300, failed: 0,
    });

    await assert.rejects(verifyShardResults({ ...verifyInput, paths: [...paths.slice(0, 11), join(root, "missing")] }), /ENOENT/);

    const cases: Array<[string, (changed: LiveRunResult[]) => void, RegExp]> = [
      ["gap", (changed) => { changed.splice(0, 1); }, /gap/],
      ["duplicate", (changed) => { changed.push(structuredClone(changed[0]!)); }, /Duplicate shard run index/],
      ["fail", (changed) => { changed[0]!.pass = false; changed[0]!.verdict = "fail"; }, /failed or incomplete/],
      ["infrastructure", (changed) => { changed[0]!.infrastructureError = "synthetic"; }, /failed or incomplete/],
      ["critical", (changed) => { changed[0]!.criticalViolations = ["synthetic"]; }, /failed or incomplete/],
      ["digest", (changed) => { changed[0]!.digests.policySha256 = "different"; }, /digest mismatch/],
      ["runner", (changed) => { changed[0]!.digests.runnerSha256 = "different"; }, /digest mismatch.*runnerSha256/],
      ["missing runner", (changed) => {
        delete (changed[0]!.digests as unknown as Record<string, unknown>).runnerSha256;
      }, /schema/],
      ["parser", (changed) => { changed[0]!.digests.shellParserSha256 = "different"; }, /digest mismatch.*shellParserSha256/],
      ["missing parser", (changed) => {
        delete (changed[0]!.digests as unknown as Record<string, unknown>).shellParserSha256;
      }, /schema/],
      ["model", (changed) => { changed[0]!.modelIdentity!.canonicalId = "provider/other"; }, /model mismatch/],
      ["shard", (changed) => { changed[0]!.shardIndex = 1; }, /multiple shard indices/],
      ["campaign", (changed) => { changed[0]!.campaignKey = "different"; }, /campaign key mismatch/],
    ];
    for (const [name, mutate, expected] of cases) {
      const changed = structuredClone(records[0]!);
      mutate(changed);
      await writeShard(0, changed);
      await assert.rejects(verifyShardResults(verifyInput), expected, name);
      await writeShard(0);
    }
    await writeShard(0, records[0]!, false);
    await assert.rejects(verifyShardResults(verifyInput), /partial final line/);
  } finally {
    await rm(root, { recursive: true, force: true });
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
    runnerSha256: "runner",
    shellParserSha256,
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
    shardCount: 1,
    policyDigest: digests.policySha256,
    skillDigest: digests.skillSha256,
    probeDigest: digests.probeSha256,
    runnerSha256: digests.runnerSha256,
    shellParserSha256: digests.shellParserSha256,
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
    shardCount: 1,
    shardIndex: 0,
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

    const wrongRunner = structuredClone(seeded[0])!;
    wrongRunner.digests.runnerSha256 = "different-runner";
    await writeFile(resultsPath, `${JSON.stringify(wrongRunner)}\n`);
    await assert.rejects(validateResumeResults(resultsPath, expected), /digest mismatch.*runnerSha256/);

    const missingRunner = structuredClone(seeded[0])!;
    delete (missingRunner.digests as unknown as Record<string, unknown>).runnerSha256;
    await writeFile(resultsPath, `${JSON.stringify(missingRunner)}\n`);
    await assert.rejects(validateResumeResults(resultsPath, expected), /schema/);

    const changedRunnerKey = campaignKeyFor({ ...keyInput, runnerSha256: "different-runner" });
    assert.notEqual(changedRunnerKey, complianceKey);

    const wrongParser = structuredClone(seeded[0])!;
    wrongParser.digests.shellParserSha256 = "different-parser";
    await writeFile(resultsPath, `${JSON.stringify(wrongParser)}\n`);
    await assert.rejects(validateResumeResults(resultsPath, expected), /digest mismatch.*shellParserSha256/);

    const missingParser = structuredClone(seeded[0])!;
    delete (missingParser.digests as unknown as Record<string, unknown>).shellParserSha256;
    await writeFile(resultsPath, `${JSON.stringify(missingParser)}\n`);
    await assert.rejects(validateResumeResults(resultsPath, expected), /schema/);

    const changedParserKey = campaignKeyFor({ ...keyInput, shellParserSha256: "different-parser" });
    assert.notEqual(changedParserKey, complianceKey);

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
      shardCount: 1,
      policyDigest: "policy",
      skillDigest: "skill",
      probeDigest: "probe",
      runnerSha256: "runner",
      shellParserSha256: "parser",
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
    writeFile(join(agentDir, "auth.json"), JSON.stringify({
      provider: oauthCredential({ providerField: "required-by-pion" }),
      xai: oauthCredential({ access: "expired-xai-access", refresh: "xai-refresh", expires: 0 }),
    })),
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
    const runnerBytes = await readFile(new URL("./support/work-gate-live.ts", import.meta.url));
    assert.equal(snapshot.runnerSha256, createHash("sha256").update(runnerBytes).digest("hex"));
    assert.equal(snapshot.shellParserSha256, shellParserSha256);
    assert.equal(await digestShellParser(), shellParserSha256);
    await assert.rejects(
      digestShellParser(async (path) => {
        assert.equal(path, "/bin/bash");
        throw Object.assign(new Error("missing parser"), { code: "ENOENT" });
      }),
      /missing parser/,
    );
    assert.notEqual(snapshot.runnerSha256, snapshot.probeSha256);
    await Promise.all([
      writeFile(policy, "policy-v2\n"),
      writeFile(skill, "skill-v2\n"),
      writeFile(probe, "probe-v2\n"),
      writeFile(fixture, "[]\n"),
      writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultModel: "model-b" })),
      writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { provider: ["model-b"] } })),
      writeFile(join(agentDir, "auth.json"), JSON.stringify({ provider: oauthCredential({ access: "changed-source" }) })),
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
        provider: oauthCredential({ providerField: "required-by-pion" }),
      });
      await verifyPreparedRun(snapshot, prepared);
    });
    assert.equal(snapshot.modelIdentity.modelDigest, modelDigest);
  } finally {
    await cleanupCampaignSnapshot(snapshot);
    await rm(root, { recursive: true, force: true });
  }
});

test("auth filtering selects one provider and preserves its complete credential", () => {
  const selected = oauthCredential({
    providerField: "provider-required-value",
    nested: { profile: { id: "nested-profile" }, opaque: "preserved" },
  });
  const filtered = filterAuthForModel(authBytes({
    provider: selected,
    xai: oauthCredential({ access: "expired-xai", refresh: "xai-refresh", expires: 0 }),
  }), "provider/model-a");
  assert.equal(filtered.provider, "provider");
  assert.deepEqual(JSON.parse(filtered.bytes.toString("utf8")), { provider: selected });
  assert.equal(filtered.bytes.toString("utf8").includes("xai"), false);
  assert.equal(filtered.bytes.toString("utf8").includes("provider-required-value"), true);
  assert.deepEqual(filtered.identity.identifiers, {});
  assert.equal(JSON.stringify(filtered.identity).includes("access-token-a"), false);
  assert.equal(JSON.stringify(filtered.identity).includes("refresh-token-a"), false);
  assert.equal(JSON.stringify(filtered.identity).includes("provider-required-value"), false);
  assert.equal(JSON.stringify(filtered.identity).includes("nested-profile"), false);
});

test("api-key env identity uses an explicit deterministic non-secret allowlist", () => {
  const baseEnv = {
    CLOUDFLARE_GATEWAY_ID: "gateway-a",
    AWS_PROFILE: "profile-a",
    CLOUDFLARE_ACCOUNT_ID: "account-a",
  };
  const base = filterAuthForModel(authBytes({ provider: apiKeyCredential(baseEnv) }), "provider/model-a");
  assert.deepEqual(base.identity.identifiers, {
    "env.AWS_PROFILE": "profile-a",
    "env.CLOUDFLARE_ACCOUNT_ID": "account-a",
    "env.CLOUDFLARE_GATEWAY_ID": "gateway-a",
  });

  for (const field of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID", "AWS_PROFILE"] as const) {
    const changed = filterAuthForModel(authBytes({
      provider: apiKeyCredential({ ...baseEnv, [field]: `${field}-b` }),
    }), "provider/model-a");
    assert.notEqual(base.identityDigest, changed.identityDigest, field);
  }

  const changedKey = filterAuthForModel(
    authBytes({ provider: apiKeyCredential(baseEnv, "api-key-b") }),
    "provider/model-a",
  );
  assert.equal(base.identityDigest, changedKey.identityDigest);

  const unknownSecret = filterAuthForModel(authBytes({
    provider: apiKeyCredential({ ...baseEnv, UNKNOWN_CLIENT_SECRET: "unknown-secret" }),
  }), "provider/model-a");
  assert.equal(base.identityDigest, unknownSecret.identityDigest);
  assert.equal(JSON.stringify(unknownSecret.identity).includes("unknown-secret"), false);
  assert.equal("env.UNKNOWN_CLIENT_SECRET" in unknownSecret.identity.identifiers, false);

  const reordered = filterAuthForModel(authBytes({
    provider: apiKeyCredential({
      CLOUDFLARE_ACCOUNT_ID: "account-a",
      CLOUDFLARE_GATEWAY_ID: "gateway-a",
      AWS_PROFILE: "profile-a",
    }),
  }), "provider/model-a");
  assert.equal(base.identityDigest, reordered.identityDigest);
  assert.deepEqual(Object.keys(reordered.identity.identifiers), [
    "env.AWS_PROFILE",
    "env.CLOUDFLARE_ACCOUNT_ID",
    "env.CLOUDFLARE_GATEWAY_ID",
  ]);
});

test("installed api-key env consumers expose only demonstrated stable identifiers", () => {
  const env = {
    ANTHROPIC_FEDERATION_RULE_ID: "federation-rule-a",
    ANTHROPIC_ORGANIZATION_ID: "organization-a",
    ANTHROPIC_SERVICE_ACCOUNT_ID: "service-account-a",
    ANTHROPIC_WORKSPACE_ID: "workspace-a",
    AWS_DEFAULT_REGION: "us-east-1",
    AWS_PROFILE: "profile-a",
    AWS_REGION: "us-west-2",
    AZURE_OPENAI_BASE_URL: "https://resource-a.openai.azure.com/openai/v1",
    AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "model-a=deployment-a",
    AZURE_OPENAI_RESOURCE_NAME: "resource-a",
    CLOUDFLARE_ACCOUNT_ID: "account-a",
    CLOUDFLARE_GATEWAY_ID: "gateway-a",
    GCLOUD_PROJECT: "gcloud-project-a",
    GOOGLE_CLOUD_LOCATION: "us-central1",
    GOOGLE_CLOUD_PROJECT: "google-project-a",
    LLAMA_BASE_URL: "http://127.0.0.1:8080",
    ANTHROPIC_IDENTITY_TOKEN_FILE: "/secret/identity-token",
    AWS_ACCESS_KEY_ID: "access-key-secret",
    AWS_SECRET_ACCESS_KEY: "secret-access-key",
    AWS_SESSION_TOKEN: "session-token-secret",
    AZURE_OPENAI_API_KEY: "azure-key-secret",
    GOOGLE_APPLICATION_CREDENTIALS: "/secret/credentials.json",
  };
  const filtered = filterAuthForModel(authBytes({ provider: apiKeyCredential(env) }), "provider/model-a");
  assert.deepEqual(Object.keys(filtered.identity.identifiers), [
    "env.ANTHROPIC_FEDERATION_RULE_ID",
    "env.ANTHROPIC_ORGANIZATION_ID",
    "env.ANTHROPIC_SERVICE_ACCOUNT_ID",
    "env.ANTHROPIC_WORKSPACE_ID",
    "env.AWS_DEFAULT_REGION",
    "env.AWS_PROFILE",
    "env.AWS_REGION",
    "env.AZURE_OPENAI_BASE_URL",
    "env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
    "env.AZURE_OPENAI_RESOURCE_NAME",
    "env.CLOUDFLARE_ACCOUNT_ID",
    "env.CLOUDFLARE_GATEWAY_ID",
    "env.GCLOUD_PROJECT",
    "env.GOOGLE_CLOUD_LOCATION",
    "env.GOOGLE_CLOUD_PROJECT",
    "env.LLAMA_BASE_URL",
  ]);
  for (const secret of [
    "/secret/identity-token",
    "access-key-secret",
    "secret-access-key",
    "session-token-secret",
    "azure-key-secret",
    "/secret/credentials.json",
  ]) {
    assert.equal(JSON.stringify(filtered.identity).includes(secret), false);
  }
});

test("providers without a stable non-secret identity bind only provider and credential type", () => {
  const transientOauth = {
    type: "oauth",
    access: "temporary-access-token",
    refresh: "temporary-refresh-token",
    expires: 1_900_000_000_000,
  };
  for (const provider of ["xai", "anthropic"]) {
    const filtered = filterAuthForModel(authBytes({ [provider]: transientOauth }), `${provider}/model-a`);
    assert.deepEqual(filtered.identity, {
      schemaVersion: 1,
      provider,
      type: "oauth",
      identifiers: {},
    });
  }
});

test("Amazon Bedrock accepts a bare api-key credential for the AWS credential chain", () => {
  const filtered = filterAuthForModel(
    authBytes({ "amazon-bedrock": { type: "api_key" } }),
    "amazon-bedrock/model-a",
  );
  assert.deepEqual(JSON.parse(filtered.bytes.toString("utf8")), {
    "amazon-bedrock": { type: "api_key" },
  });
  assert.deepEqual(filtered.identity, {
    schemaVersion: 1,
    provider: "amazon-bedrock",
    type: "api_key",
    identifiers: {},
  });
});

test("GitHub Copilot enterpriseUrl is the exact stable OAuth identity", () => {
  const first = filterAuthForModel(authBytes({
    "github-copilot": oauthCredential({ enterpriseUrl: "github.example-a.test" }),
  }), "github-copilot/model-a");
  const same = filterAuthForModel(authBytes({
    "github-copilot": oauthCredential({
      enterpriseUrl: "github.example-a.test",
      access: "rotated-access",
      refresh: "rotated-refresh",
    }),
  }), "github-copilot/model-a");
  const changed = filterAuthForModel(authBytes({
    "github-copilot": oauthCredential({ enterpriseUrl: "github.example-b.test" }),
  }), "github-copilot/model-a");
  const wrongCase = filterAuthForModel(authBytes({
    "github-copilot": oauthCredential({ enterpriseurl: "github.example-b.test" }),
  }), "github-copilot/model-a");
  assert.deepEqual(first.identity.identifiers, { enterpriseUrl: "github.example-a.test" });
  assert.equal(first.identityDigest, same.identityDigest);
  assert.notEqual(first.identityDigest, changed.identityDigest);
  assert.deepEqual(wrongCase.identity.identifiers, {});
});

test("invented OAuth identity fields and nested generic ids are excluded", () => {
  const base = filterAuthForModel(authBytes({
    "openai-codex": oauthCredential({ accountId: "account-a" }),
  }), "openai-codex/model-a");
  const invented = filterAuthForModel(authBytes({
    "openai-codex": oauthCredential({
      accountId: "account-a",
      email: "person@example.test",
      profileId: "profile-b",
      tenantId: "tenant-b",
      userId: "user-b",
      profile: { id: "nested-id-b" },
    }),
  }), "openai-codex/model-a");
  assert.deepEqual(invented.identity.identifiers, { accountId: "account-a" });
  assert.equal(base.identityDigest, invented.identityDigest);
});

test("OpenAI Codex accountId remains a stable account identity", () => {
  const first = filterAuthForModel(authBytes({
    "openai-codex": oauthCredential({ accountId: "codex-account-a" }),
  }), "openai-codex/model-a");
  const second = filterAuthForModel(authBytes({
    "openai-codex": oauthCredential({ accountId: "codex-account-b" }),
  }), "openai-codex/model-a");
  const rotated = filterAuthForModel(authBytes({
    "openai-codex": oauthCredential({
      accountId: "codex-account-a",
      access: "rotated-access",
      refresh: "rotated-refresh",
      expires: 2_100_000_000_000,
    }),
  }), "openai-codex/model-a");
  assert.equal(first.identity.identifiers.accountId, "codex-account-a");
  assert.notEqual(first.identityDigest, second.identityDigest);
  assert.equal(first.identityDigest, rotated.identityDigest);
});

test("auth filtering rejects unknown, absent, and ambiguous selected credentials", () => {
  assert.throws(
    () => filterAuthForModel(authBytes({ provider: { type: "unknown", value: "secret" } }), "provider/model-a"),
    /unknown credential schema/,
  );
  assert.throws(
    () => filterAuthForModel(authBytes({ other: oauthCredential() }), "provider/model-a"),
    /credential is absent/,
  );
  assert.throws(
    () => filterAuthForModel(Buffer.from(JSON.stringify({ provider: oauthCredential() })
      .replace(/}$/, `,"provider":${JSON.stringify(oauthCredential())}}`)), "provider/model-a"),
    /ambiguous provider credential/,
  );
  assert.throws(
    () => filterAuthForModel(authBytes({ provider: oauthCredential(), Provider: oauthCredential() }), "provider/model-a"),
    /credential is ambiguous/,
  );
});

test("post-run auth verification permits token renewal and rejects identity changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "a4s-auth-integrity-test-"));
  const agentDir = join(root, "agent");
  const policy = join(root, "AGENTS.md");
  const skill = join(root, "SKILL.md");
  const probe = join(root, "probe.ts");
  const fixture = join(root, "fixture.json");
  await mkdir(agentDir, { recursive: true });
  await Promise.all([
    writeFile(policy, "policy\n"), writeFile(skill, "skill\n"), writeFile(probe, "probe\n"),
    writeFile(fixture, fixtureText), writeFile(join(agentDir, "settings.json"), "{}"),
    writeFile(join(agentDir, "models.json"), "{}"),
    writeFile(join(agentDir, "auth.json"), JSON.stringify({
      "openai-codex": oauthCredential({ accountId: "account-a" }),
    })),
  ]);
  const snapshot = await createCampaignSnapshot({
    policySource: policy, skillSource: skill, probeSource: probe, fixtureSource: fixture,
    canonicalModelId: "openai-codex/model-a", agentDir,
  });
  const authPathFor = (prepared: { agentDir: string }) => join(prepared.agentDir, "auth.json");
  try {
    await withPreparedRun(snapshot, scenarios[0] as LiveScenario, async (prepared) => {
      await writeFile(authPathFor(prepared), JSON.stringify({
        "openai-codex": oauthCredential({
          accountId: "account-a",
          access: "rotated-access-secret",
          refresh: "rotated-refresh-secret",
          expires: 2_100_000_000_000,
          scopes: ["ephemeral-scope"],
        }),
      }));
      await assert.rejects(verifyPreparedRun(snapshot, prepared), /input "auth" changed/);
      await verifyPreparedRun(snapshot, prepared, { allowSelectedCredentialRefresh: true });
    });

    const changedCredentials: Record<string, Record<string, Record<string, unknown>>> = {
      provider: { other: oauthCredential() },
      type: { "openai-codex": { type: "api_key", key: "api-key-secret" } },
      account: { "openai-codex": oauthCredential({ accountId: "account-b" }) },
      added: {
        "openai-codex": oauthCredential({ accountId: "account-a" }),
        other: oauthCredential(),
      },
    };
    for (const [name, changed] of Object.entries(changedCredentials)) {
      await withPreparedRun(snapshot, scenarios[0] as LiveScenario, async (prepared) => {
        await writeFile(authPathFor(prepared), JSON.stringify(changed));
        let message = "";
        await assert.rejects(
          verifyPreparedRun(snapshot, prepared, { allowSelectedCredentialRefresh: true }),
          (error: Error) => {
            message = error.message;
            return /input "auth" changed.*sha256:/.test(message);
          },
          name,
        );
        for (const secret of ["access-token-a", "refresh-token-a", "api-key-secret", "account-b", "profile-b"]) {
          assert.equal(message.includes(secret), false, name);
        }
      });
    }
  } finally {
    await cleanupCampaignSnapshot(snapshot);
    await rm(root, { recursive: true, force: true });
  }
});

test("campaign configuration digests bind stable auth identity but not token rotation", async () => {
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
    writeFile(join(agentDir, "auth.json"), JSON.stringify({
      "openai-codex": oauthCredential({ accountId: "account-a" }),
    })),
  ]);
  const input = {
    policySource: policy,
    skillSource: skill,
    probeSource: probe,
    fixtureSource: fixture,
    canonicalModelId: "openai-codex/model-a",
    agentDir,
  };
  const snapshots: Awaited<ReturnType<typeof createCampaignSnapshot>>[] = [];
  try {
    const first = await createCampaignSnapshot(input);
    snapshots.push(first);
    const legacyAuthBytesDigest = createHash("sha256").update(first.auth!).digest("hex");
    assert.notEqual(first.authDigest, legacyAuthBytesDigest);
    const keyInput = {
      tier: "compliance" as const,
      variant: "candidate" as const,
      shardCount: 1,
      policyDigest: first.policySha256,
      skillDigest: first.skillSha256,
      probeDigest: first.probeSha256,
      runnerSha256: first.runnerSha256,
      shellParserSha256: first.shellParserSha256,
      manifestDigest: first.manifestSha256,
      runtimeVersion: "test",
      runtimeSha256: "runtime",
      settingsDigest: first.settingsDigest,
      modelsDigest: first.modelsDigest,
      modelDigest: first.modelIdentity.modelDigest,
    };
    assert.notEqual(
      campaignKeyFor({ ...keyInput, authDigest: legacyAuthBytesDigest }),
      campaignKeyFor({ ...keyInput, authDigest: first.authDigest }),
    );

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

    await writeFile(join(agentDir, "auth.json"), JSON.stringify({
      "openai-codex": oauthCredential({
        accountId: "account-a",
        access: "access-token-b",
        refresh: "refresh-token-b",
        expires: 2_000_000_000_000,
      }),
    }));
    const rotatedAuth = await createCampaignSnapshot(input);
    snapshots.push(rotatedAuth);
    assert.equal(changedModels.settingsDigest, rotatedAuth.settingsDigest);
    assert.equal(changedModels.modelsDigest, rotatedAuth.modelsDigest);
    assert.equal(changedModels.authDigest, rotatedAuth.authDigest);
    assert.notDeepEqual(changedModels.auth, rotatedAuth.auth);
    assert.equal(changedModels.modelIdentity.modelDigest, rotatedAuth.modelIdentity.modelDigest);
    assert.equal(
      campaignKeyFor({ ...keyInput, settingsDigest: changedModels.settingsDigest, modelsDigest: changedModels.modelsDigest,
        authDigest: changedModels.authDigest }),
      campaignKeyFor({ ...keyInput, settingsDigest: rotatedAuth.settingsDigest, modelsDigest: rotatedAuth.modelsDigest,
        authDigest: rotatedAuth.authDigest }),
    );

    await writeFile(join(agentDir, "auth.json"), JSON.stringify({
      "openai-codex": oauthCredential({ accountId: "account-b" }),
    }));
    const changedIdentity = await createCampaignSnapshot(input);
    snapshots.push(changedIdentity);
    assert.notEqual(rotatedAuth.authDigest, changedIdentity.authDigest);
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
    writeFile(join(agentDir, "auth.json"), JSON.stringify({ provider: oauthCredential() })),
  ]);
  const snapshot = await createCampaignSnapshot({
    policySource: policy, skillSource: skill, probeSource: probe, fixtureSource: fixture,
    canonicalModelId: "provider/model-a", agentDir,
  });
  try {
    const changes: Array<[string, (prepared: {
      copiedPolicy: string;
      copiedSkill: string;
      copiedProbe: string;
      agentDir: string;
    }) => Promise<void>]> = [
      ["policy", (prepared) => writeFile(prepared.copiedPolicy, "changed-policy-secret")],
      ["skill", (prepared) => writeFile(prepared.copiedSkill, "changed-skill-secret")],
      ["probe", (prepared) => writeFile(prepared.copiedProbe, "changed-probe-secret")],
      ["settings", (prepared) => writeFile(join(prepared.agentDir, "settings.json"), JSON.stringify({ changed: true }))],
      ["models", (prepared) => writeFile(join(prepared.agentDir, "models.json"), JSON.stringify({ changed: true }))],
    ];
    for (const [inputName, change] of changes) {
      await assert.rejects(withPreparedRun(snapshot, scenarios[0] as LiveScenario, async (prepared) => {
        await change(prepared);
        await verifyPreparedRun(snapshot, prepared);
      }), new RegExp(`input "${inputName}" changed.*sha256:`));
    }
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
    await assert.rejects(verifyRuntimeDigest(runtime, digest), /runtime.*changed/);
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
    writeFile(join(agentDir, "models.json"), "{}"),
    writeFile(join(agentDir, "auth.json"), JSON.stringify({ provider: oauthCredential() })),
  ]);
  const snapshot = await createCampaignSnapshot({
    policySource: policy, skillSource: skill, probeSource: probe, fixtureSource: fixture,
    canonicalModelId: "provider/model-a", agentDir,
  });
  const runRoots: string[] = [];
  const resultsPath = join(root, "results.jsonl.shard-0-of-12.jsonl");
  const traceDirectory = `${resultsPath}.traces`;
  await mkdir(traceDirectory, { recursive: true, mode: 0o755 });
  await chmod(traceDirectory, 0o755);
  let traceId = "";
  let seededAbsolutePath = "";
  try {
    await withPreparedRun(snapshot, scenarios[0] as LiveScenario, async (prepared) => {
      runRoots.push(prepared.root);
      seededAbsolutePath = join(prepared.root, "absolute-seed");
      const persisted = await persistFailureTrace(resultsPath, {
        scenarioId: "START-01",
        runIndex: 1,
        shardIndex: 0,
        shardCount: 12,
        tagged: [
          {
            gate: "initial",
            event: {
              id: "event-1",
              after: [],
              kind: "observation",
              condition: conditions.MAIN_CLEAN_AT_START,
              status: "failed",
            },
          },
          {
            gate: "final",
            event: {
              id: "event-2",
              after: ["event-1"],
              kind: "effect",
              effect: effects.EXACT_CLEANUP,
              status: "passed",
              normalizedExecutable: "git",
              classificationRule: "git-worktree-remove",
            },
          },
        ],
        outcome: "normal",
        decision: "fail",
        reasons: [
          `TOKEN=trace-secret failed at ${seededAbsolutePath}`,
          "path:/tmp/private/config.json",
          "C:\\Users\\private\\config.json",
          process.env.HOME ?? "HOME-secret",
          "https://user:url-secret@example.test/private",
          "EXACT_CLEANUP attempted before MAIN_CLEAN_FINAL passed (missing)",
        ],
        infrastructureError: "path:/tmp/private/runner TOKEN=infra-secret",
      });
      traceId = persisted.traceId;
      assert.equal(persisted.path, resolveFailureTracePath(resultsPath, traceId));
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

    const tracePath = resolveFailureTracePath(resultsPath, traceId);
    const traceText = await readFile(tracePath, "utf8");
    const trace = JSON.parse(traceText);
    const failedResult = { pass: false, traceId };
    assert.equal(failedResult.traceId, trace.traceId);
    assert.equal(trace.decision, "fail");
    assert.deepEqual(trace.events.map((event: Record<string, unknown>) => event.type), ["observation", "effect"]);
    assert.equal(trace.events[0].condition, conditions.MAIN_CLEAN_AT_START);
    assert.equal(trace.events[1].effect, effects.EXACT_CLEANUP);
    assert.equal(trace.events[1].normalizedExecutable, "git");
    assert.equal(trace.events[1].classificationRule, "git-worktree-remove");
    assert.deepEqual(trace.reasons, [
      { code: "unknown-reason" },
      { code: "unknown-reason" },
      { code: "unknown-reason" },
      { code: "unknown-reason" },
      { code: "unknown-reason" },
      {
        code: "prerequisite-not-passed",
        effect: effects.EXACT_CLEANUP,
        condition: conditions.MAIN_CLEAN_FINAL,
        status: "missing",
      },
    ]);
    assert.deepEqual(trace.infrastructureError, {
      category: "unknown",
      code: "infrastructure-error",
    });
    for (const secret of [
      "trace-secret", "infra-secret", seededAbsolutePath, process.env.HOME ?? "HOME-not-set",
      "config.json", "url-secret", "user:",
    ]) {
      assert.equal(traceText.includes(secret), false);
    }
    for (const forbidden of ["/", "\\", "~", "file:", "path:"]) {
      assert.equal(traceText.toLowerCase().includes(forbidden), false, forbidden);
    }
    assert.equal((await stat(traceDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(tracePath)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(traceDirectory), [`${traceId}.json`]);
  } finally {
    const campaignRoot = snapshot.root;
    await cleanupCampaignSnapshot(snapshot);
    await assert.rejects(access(campaignRoot));
    await rm(root, { recursive: true, force: true });
  }
});

test("failure traces map malformed semantic input to a closed schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "a4s-closed-trace-test-"));
  const resultsPath = join(root, "results.jsonl");
  const seeds = [
    "kind-path-secret", "kind-token-secret", "executable-secret", "rule-secret",
    "prompt-secret", "extra-secret", "private-secret-token", "condition-secret",
  ];
  try {
    const persisted = await persistFailureTrace(resultsPath, {
      scenarioId: "private-secret-token",
      runIndex: 7,
      shardIndex: 0,
      shardCount: 1,
      tagged: [
        { gate: "initial", event: { kind: "/tmp/kind-path-secret", prompt: "prompt-secret" } },
        { gate: "final", event: { kind: "TOKEN=kind-token-secret", token: "kind-token-secret" } },
        {
          gate: "initial",
          event: {
            kind: "effect",
            effect: "private-secret-token",
            status: "private-secret-token",
            normalizedExecutable: "executable-secret",
            classificationRule: "rule-secret",
            prompt: "prompt-secret",
            extra: "/tmp/extra-secret",
          },
        },
        {
          gate: "private-secret-token",
          event: {
            kind: "observation",
            condition: "condition-secret",
            status: "failed",
            path: "/tmp/extra-secret",
          },
        },
      ] as never,
      outcome: "normal",
      decision: "fail",
      reasons: ["private-secret-token"],
      infrastructureError: "private-secret-token at /tmp/extra-secret",
    });
    const traceText = await readFile(persisted.path, "utf8");
    const trace = JSON.parse(traceText) as Record<string, unknown>;
    for (const seed of seeds) assert.equal(traceText.includes(seed), false, seed);
    assert.equal(trace.scenarioId, "unknown");
    assert.deepEqual((trace.events as Array<Record<string, unknown>>).map((event) => event.type), [
      "unknown", "unknown", "effect", "observation",
    ]);
    assert.deepEqual((trace.events as Array<Record<string, unknown>>)[0], {
      order: 1, gate: "initial", type: "unknown",
    });
    assert.deepEqual((trace.events as Array<Record<string, unknown>>)[1], {
      order: 2, gate: "final", type: "unknown",
    });
    assert.deepEqual((trace.events as Array<Record<string, unknown>>)[2], {
      order: 3,
      gate: "initial",
      type: "effect",
      effect: "unknown",
      status: "unknown",
      normalizedExecutable: "other",
      classificationRule: "unknown",
    });
    assert.deepEqual((trace.events as Array<Record<string, unknown>>)[3], {
      order: 4, gate: "unknown", type: "observation", condition: "unknown", status: "failed",
    });
    assert.deepEqual(trace.reasons, [{ code: "unknown-reason" }]);
    assert.deepEqual(trace.infrastructureError, { category: "unknown", code: "infrastructure-error" });

    const allowedStrings = new Set<string>([
      ...TRACE_SCENARIO_IDS,
      ...TRACE_EVENT_TYPES,
      ...TRACE_GATES,
      ...TRACE_STATUSES,
      ...TRACE_DECISIONS,
      ...TRACE_EXECUTABLES,
      ...TRACE_CLASSIFICATION_RULES,
      ...TRACE_REASON_CODES,
      ...TRACE_ERROR_CATEGORIES,
      ...TRACE_ERROR_CODES,
      ...Object.values(effects),
      ...Object.values(conditions),
      "normal", "timeout", "crash", "silence", "abandoned", "ambiguous",
      "missing", "dedicated_worktree", "outside_worktree",
    ]);
    const inspectStrings = (value: unknown): void => {
      if (typeof value === "string") {
        assert.equal(
          allowedStrings.has(value) || /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value),
          true,
          value,
        );
      } else if (Array.isArray(value)) {
        for (const entry of value) inspectStrings(entry);
      } else if (typeof value === "object" && value !== null) {
        for (const entry of Object.values(value as Record<string, unknown>)) inspectStrings(entry);
      }
    };
    inspectStrings(trace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("policy and skill require the exact canonical condition in an explicit block", () => {
  for (const source of [policyText, skillText]) {
    assert.match(source, /bloqueo explícito/);
    assert.match(source, /identificador canónico exacto|identificador canónico en mayúsculas/);
    assert.match(source, /No traduzcas, resumas ni renombres ese identificador/);
    assert.match(source, /condition="CANONICAL_CONDITION"/);
  }
});

test("loaded-input attestation compares the complete expanded skill content", () => {
  const file = Buffer.from([
    "\uFEFF---\r\n",
    "name: work-lifecycle\r\n",
    "description: Test skill\r\n",
    "---\r\n",
    "First instruction.\r\n",
    "Second instruction.\r\n",
  ].join(""));
  const filePath = "/tmp/work-lifecycle/SKILL.md";
  const normalized = "First instruction.\nSecond instruction.";
  assert.equal(normalizeSkillContentForExpansion(file), normalized);
  const block = [
    `<skill name="work-lifecycle" location="${filePath}">`,
    "References are relative to /tmp/work-lifecycle.",
    "",
    normalized,
    "</skill>",
  ].join("\n");
  const expected = {
    policySha256: "policy",
    skillSha256: createHash("sha256").update(file).digest("hex"),
    skill: file,
  };
  const validatePrompt = (prompt: string) => validateLoadedInputAttestation({
    contextFileSha256: ["policy"],
    skills: [attestSkillExpansion(prompt, { name: "work-lifecycle", filePath, content: file })],
  }, expected);

  const exact = attestSkillExpansion(`${block}\n\nDo the requested work.`, {
    name: "work-lifecycle", filePath, content: file,
  });
  assert.equal(exact.expansionStatus, "verified");
  assert.match(exact.expandedContentSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(exact).sort(), [
    "expandedContentSha256", "expansionStatus", "fileSha256",
  ]);
  assert.equal(JSON.stringify(exact).includes("First instruction"), false);
  assert.equal("expanded" in exact, false);
  assert.deepEqual(validatePrompt(`${block}\n\nDo the requested work.`), []);

  const truncated = block.slice(0, -"\n</skill>".length);
  assert.match(validatePrompt(truncated).join("\n"), /contract could not be verified: truncated/);

  const altered = block.replace("Second instruction.", "Changed instruction.");
  const alteredAttestation = attestSkillExpansion(altered, {
    name: "work-lifecycle", filePath, content: file,
  });
  assert.equal(alteredAttestation.fileSha256, expected.skillSha256);
  const alteredViolations = validateLoadedInputAttestation({
    contextFileSha256: ["policy"],
    skills: [alteredAttestation],
  }, expected);
  assert.match(alteredViolations.join("\n"), /content-mismatch/);
  assert.match(alteredViolations.join("\n"), /expanded skill content digest/);

  const duplicate = `${block}\n\n${block}`;
  assert.match(validatePrompt(duplicate).join("\n"), /contract could not be verified: duplicate/);

  const otherSkill = block
    .replace('name="work-lifecycle"', 'name="other-skill"')
    .replace('location="/tmp/work-lifecycle/SKILL.md"', 'location="/tmp/other-skill/SKILL.md"')
    .replace("relative to /tmp/work-lifecycle.", "relative to /tmp/other-skill.");
  assert.match(validatePrompt(otherSkill).join("\n"), /contract could not be verified: wrong-skill/);

  const changedContract = block.replace("References are relative to", "Skill files are relative to");
  assert.match(validatePrompt(changedContract).join("\n"), /contract could not be verified: contract-mismatch/);

  for (const version of ["Pion runtime-a", "Pion runtime-b"]) {
    const campaign = { ...expected, runtime: { version } };
    assert.deepEqual(validateLoadedInputAttestation({
      contextFileSha256: ["policy"],
      skills: [exact],
    }, campaign), []);
  }
});

test("loaded-input attestation fails closed for missing policy or skill evidence", () => {
  const file = Buffer.from("instruction\n");
  const expected = {
    policySha256: "policy",
    skillSha256: createHash("sha256").update(file).digest("hex"),
    skill: file,
  };
  assert.deepEqual(validateLoadedInputAttestation(undefined, expected), [
    "missing policy and skill load attestation",
  ]);
  assert.deepEqual(validateLoadedInputAttestation({
    contextFileSha256: ["other"],
    skills: [],
  }, expected), [
    "loaded policy digest does not match the campaign snapshot",
    "loaded skill set does not contain exactly one skill",
    "work-lifecycle skill load attestation is missing",
  ]);
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
    assert.match(redacted, form.includes("/") || form.includes("\\") ? /\[PATH\]/ : /\[REDACTED\]/);
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

test("path redaction covers UNC, Windows namespaces, drive letters, Unix paths, and file paths", () => {
  const forms = [
    String.raw`\\server\share\unc-secret\file.txt`,
    String.raw`\\?\C:\namespace-secret\file.txt`,
    String.raw`\\.\PIPE\device-secret`,
    String.raw`C:\drive-secret\file.txt`,
    "/var/unix-secret/file.txt",
    "file:/tmp/file-secret/config.json",
    String.raw`path: "\\server\share\label-secret\file.txt"`,
    String.raw`{"nested":{"value":"\\server\share\object-secret\file.txt"}}`,
    `label: "/tmp/quoted-secret/file.txt"`,
    "prefix;/tmp/semicolon-secret/file.txt",
    String.raw`prefix=\\server/share/mixed-secret\file.txt`,
    "prefix=//server/share/forward-unc-secret/file.txt",
    "prefix;home:private-home-secret",
  ];
  const seeds = [
    "unc-secret", "namespace-secret", "device-secret", "drive-secret", "unix-secret",
    "file-secret", "label-secret", "object-secret", "quoted-secret", "semicolon-secret",
    "mixed-secret", "forward-unc-secret", "private-home-secret",
  ];
  for (const form of forms) {
    const redacted = redactString(form);
    assert.match(redacted, /\[PATH\]/, form);
    for (const seed of seeds) assert.equal(redacted.includes(seed), false, form);
  }

  const sanitized = sanitize({
    uncPath: String.raw`\\server\share\sanitize-unc\file.txt`,
    windowsPath: String.raw`C:\sanitize-drive\file.txt`,
    nested: { message: String.raw`value: "\\?\C:\sanitize-namespace\file.txt"` },
    list: ["file:/tmp/sanitize-file/config.json", "/tmp/sanitize-unix/file.txt"],
  });
  const serialized = JSON.stringify(sanitized);
  for (const seed of ["sanitize-unc", "sanitize-drive", "sanitize-namespace", "sanitize-file", "sanitize-unix"]) {
    assert.equal(serialized.includes(seed), false, seed);
  }

  assert.deepEqual(summarizedArgs("write", {
    path: String.raw`\\server\share\summary-secret\file.txt`,
    content: "private-secret-token",
  }), { path: "[PATH]" });
  assert.deepEqual(summarizedArgs("bash", {
    command: "git pull --ff-only$(printf private-secret-token)",
  }), { operation: "read" });
  assert.deepEqual(summarizedArgs("bash", {
    command: "git fetch $(date); cleanup",
  }), {
    operation: "cleanup",
    normalizedExecutable: "cleanup",
    classificationRule: "cleanup-executable",
  });
  assert.deepEqual(summarizedArgs("assistant_final", {
    gate: "final;/tmp/gate-secret",
    result: String.raw`block=\\server/share/result-secret`,
  }), { gate: "[PATH]", result: "[PATH]" });
  assert.deepEqual(summarizedArgs("assistant_final", {
    gate: "non-canonical-gate",
    result: "non-canonical-result",
  }), { gate: "[REDACTED]", result: "[REDACTED]" });
});

test("canonical model IDs use one exact safe slash grammar", () => {
  const valid = ["provider/model", "provider-1/model_2.v3", "a.b/c-d"];
  for (const canonicalId of valid) {
    assert.equal(isCanonicalModelId(canonicalId), true, canonicalId);
    assert.equal((sanitize({ canonicalId }) as { canonicalId: string }).canonicalId, canonicalId);
  }

  const invalid = [
    String.raw`provider/model\private-secret`,
    "provider/model/private-secret",
    "provider/..",
    "./model",
    "https://provider/model",
    "user:password@provider/model",
    "provider//model",
    "provider/model?token=private-secret",
    "prøvider/model",
    "provider/mödel",
    "\"provider/model\"",
    "provider/model;private-secret",
  ];
  for (const canonicalId of invalid) {
    assert.equal(isCanonicalModelId(canonicalId), false, canonicalId);
    const sanitized = sanitize({ modelIdentity: { canonicalId } }) as {
      modelIdentity: { canonicalId: string };
    };
    assert.equal(sanitized.modelIdentity.canonicalId, "[PATH]", canonicalId);
    assert.equal(JSON.stringify(safeOutputRecord({ modelIdentity: { canonicalId } })).includes("private-secret"), false);
  }

  const liveTierArgs = [
    ["--tier", "smoke", "--runs", "1"],
    ["--tier", "corpus"],
    ["--tier", "compliance", "--runs", "1"],
    ["--tier", "git-e2e"],
  ];
  for (const canonicalId of invalid) {
    for (const tierArgs of liveTierArgs) {
      assert.throws(
        () => parseCli([...tierArgs, "--model", canonicalId]),
        /exact provider\/model identifier/,
      );
    }
  }
  assert.equal(effectiveModelId({
    type: "response", command: "get_state", success: true,
    data: { model: { provider: "provider", id: "model" } },
  }), "provider/model");
  assert.equal(effectiveModelId({
    type: "response", command: "get_state", success: true,
    data: { model: { provider: "provider", id: String.raw`model\private-secret` } },
  }), undefined);
  assert.equal(effectiveModelId({
    type: "response", command: "get_state", success: true,
    data: { model: { provider: "provider", id: "model/private-secret" } },
  }), undefined);
  assert.deepEqual(safeOutputRecord({ gate: "initial", result: "pass" }), {
    gate: "initial", result: "pass",
  });
  assert.deepEqual(safeOutputRecord({ gate: "initial-private", result: "pass-private" }), {
    gate: "[REDACTED]", result: "[REDACTED]",
  });
  assert.deepEqual(safeOutputRecord({
    gate: "initial/private-secret", result: String.raw`pass\private-secret`,
  }), { gate: "[PATH]", result: "[PATH]" });
});

test("console, result, and top-level error channels are sanitized", () => {
  const consoleRecord = JSON.stringify(safeOutputRecord({
    message: "Authorization: Bearer console-secret at /tmp/path-secret/console.log",
    runtime: { path: "/tmp/runtime-secret/pion" },
  }));
  const resultRecord = JSON.stringify(safeOutputRecord({
    result: "TOKEN=result-secret C:\\result-path-secret\\file path:/tmp/private/config.json ~/private-home",
    modelIdentity: { canonicalId: "provider/model-a" },
  }));
  assert.equal(JSON.parse(resultRecord).modelIdentity.canonicalId, "provider/model-a");
  const errorText = safeErrorText(new Error(
    "https://user:error-secret@example.test at /tmp/error-path-secret/file file:/tmp/private-file",
  ));
  for (const secret of [
    "console-secret", "result-secret", "error-secret", "user:", "path-secret", "runtime-secret",
    "result-path-secret", "error-path-secret", "config.json", "private-home", "private-file",
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

test("all conceptual CLI commands require and parse a canonical model", () => {
  const liveCommands = [
    { tier: "smoke", argv: ["--tier", "smoke", "--runs", "7"] },
    { tier: "corpus", argv: ["--tier", "corpus"] },
    { tier: "compliance", argv: ["--tier", "compliance", "--runs", "300", "--resume"] },
    { tier: "git-e2e", argv: ["--tier", "git-e2e"] },
  ] as const;
  for (const command of liveCommands) {
    const parsed = parseCli([...command.argv, "--model", "provider/model-a"]);
    assert.equal(parsed.tier, command.tier);
    assert.equal(parsed.model, "provider/model-a");
    assert.throws(() => parseCli(command.argv), new RegExp(`--model is required for ${command.tier}`));
    assert.throws(
      () => parseCli([...command.argv, "--model", "fuzzy-id"]),
      /exact provider\/model/,
    );
  }
  assert.equal(parseCli(["--tier", "smoke", "--runs", "7", "--model", "provider/model-a"]).variant, "candidate");
  assert.equal(parseCli(["--tier", "corpus", "--model", "provider/model-a"]).runs, 14);
  assert.equal(parseCli([
    "--tier", "compliance", "--runs", "300", "--resume", "--model", "provider/model-a",
  ]).resume, true);
  assert.equal(parseCli(["--tier", "git-e2e", "--model", "provider/model-a"]).tier, "git-e2e");
  assert.equal(parseCli([
    "--tier", "compliance", "--runs", "120", "--variant", "baseline",
    "--model", "provider/model-a", "--policy", "/baseline/AGENTS.md", "--skill", "/baseline/SKILL.md",
  ]).variant, "baseline");
  assert.equal(parseCli([
    "--tier", "corpus", "--model", "provider/model-a", "--variant", "baseline", "--root", "/baseline",
  ]).variantRoot, "/baseline");
  assert.throws(
    () => parseCli(["--tier", "smoke", "--runs", "7", "--model", "provider/model-a", "--resume"]),
    /--resume is valid only for compliance/,
  );
  const help = usage();
  assert.match(help, /A4S_RUN_AGENT_E2E=1 npm run eval:work-gates/);
  assert.match(help, /Every live tier requires --model with an exact provider\/model identifier\./);
  assert.match(help, /^  --help, -h\s+Show this help\.$/m);
  for (const option of [
    "--deadline-ms", "--policy", "--skill", "--root", "--variant", "--results",
    "--resume", "--shard-count", "--shard-index", "--verify-shards",
    "--concurrency", "--model", "--tier", "--runs",
  ]) {
    assert.match(help, new RegExp(option));
  }
  const examples = help.split("\n").filter((line) => line.trim().startsWith("A4S_RUN_AGENT_E2E=1"));
  assert.equal(examples.length, 6);
  for (const example of examples) assert.match(example, /--model provider\/model/);
  const parsedExamples = examples.map((line) => parseCli(line.split(" -- ")[1]!.trim().split(/\s+/)));
  assert.deepEqual(parsedExamples.slice(0, 4).map(({ tier }) => tier), [
    "smoke", "corpus", "compliance", "git-e2e",
  ]);
  assert.equal(parsedExamples[4]!.variantRoot, "/baseline");
  assert.equal(parsedExamples[5]!.policyPath, "/baseline/AGENTS.md");
  assert.equal(parsedExamples[5]!.skillPath, "/baseline/skills/work-lifecycle/SKILL.md");
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

  const missingModelCommands = [
    ["--tier", "smoke", "--runs", "1"],
    ["--tier", "corpus"],
    ["--tier", "compliance", "--runs", "1"],
    ["--tier", "git-e2e"],
  ];
  for (const command of missingModelCommands) {
    const missingModel = spawnSync(process.execPath, ["--import", "tsx", runner, ...command], {
      cwd: process.cwd(), env, encoding: "utf8", timeout: 20_000,
    });
    assert.equal(missingModel.status, 1, `${command.join(" ")}\n${missingModel.stderr}`);
    assert.match(missingModel.stderr, /--model is required for (smoke|corpus|compliance|git-e2e)/);
    assert.doesNotMatch(missingModel.stderr, /Pion executable not found/);
  }

  const optedIn = { ...env, A4S_RUN_AGENT_E2E: "1" };
  const invalidShard = spawnSync(process.execPath, [
    "--import", "tsx", runner, "--tier", "compliance", "--runs", "300", "--model", "provider/model",
    "--shard-count", "12", "--shard-index", "12",
  ], { cwd: process.cwd(), env: optedIn, encoding: "utf8", timeout: 20_000 });
  assert.equal(invalidShard.status, 1);
  assert.match(invalidShard.stderr, /--shard-index must be less than --shard-count/);
  assert.doesNotMatch(invalidShard.stderr, /Pion executable not found/);
});

test("baseline inputs are explicit and never inherit candidate environment paths", () => {
  assert.throws(
    () => parseCli(["--tier", "corpus", "--model", "provider/model", "--variant", "baseline"]),
    /baseline requires/,
  );
  const options = parseCli([
    "--tier", "corpus", "--model", "provider/model", "--variant", "baseline", "--root", "/explicit-baseline",
  ]);
  assert.deepEqual(resolveVariantInputs(options), {
    policySource: "/explicit-baseline/AGENTS.md",
    skillSource: "/explicit-baseline/skills/work-lifecycle/SKILL.md",
  });
  const identity = {
    policyDigest: "p", skillDigest: "s", probeDigest: "x", runnerSha256: "runner", shellParserSha256: "parser", manifestDigest: "m",
    runtimeVersion: "v", runtimeSha256: "r", settingsDigest: "settings",
    modelsDigest: "models", authDigest: "auth", modelDigest: "model",
  };
  const candidateKey = campaignKeyFor({
    tier: "corpus", variant: "candidate", shardCount: 1, ...identity,
  });
  const baselineKey = campaignKeyFor({
    tier: "corpus", variant: "baseline", shardCount: 1, ...identity,
  });
  assert.notEqual(candidateKey, baselineKey);
});
