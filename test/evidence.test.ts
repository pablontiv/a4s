import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EvidenceRecorder,
  type EnvironmentRecord,
  type ExperimentEvent,
  type RunSummary,
  type ScenarioSummary,
} from "../src/e0/evidence.ts";

function environmentFixture(runId: string): EnvironmentRecord {
  return {
    run_id: runId,
    started_at: "2026-09-01T00:00:00.000Z",
    os_version: "test",
    architecture: "arm64",
    node_version: process.version,
    pi_version: "0.84.4",
    a4s_commit: "abc123",
    endpoint_pattern: "/tmp/a4s.sock",
    transport: "unix_socket",
    trials_per_scenario: 1,
  };
}

function passingScenario(): ScenarioSummary {
  return {
    planned: 1,
    executed: 1,
    passed: 1,
    failed: 0,
    deliveriesCreated: 1,
    physicalSends: 1,
    redeliveries: 0,
    acknowledged: 1,
    logicalProcesses: 1,
    duplicateFrames: 0,
    minDurationMs: 1,
    medianDurationMs: 1,
    maxDurationMs: 1,
    unhandledErrors: 0,
  };
}

function passingSummaryFixture(): RunSummary {
  return {
    run_id: "run-1",
    verdict: "PASS-macOS",
    scenarios: {
      S1: passingScenario(),
      S2: passingScenario(),
      S3: passingScenario(),
      S4: passingScenario(),
      S5: passingScenario(),
    },
    platforms: { macOS: "PASS", linux: "NOT RUN", windows: "NOT RUN" },
  };
}

async function createRecorder(
  root: string,
  overrides: Partial<Parameters<typeof EvidenceRecorder.create>[0]> = {},
): Promise<EvidenceRecorder> {
  const runId = overrides.runId ?? "run-1";
  return EvidenceRecorder.create({
    artifactRoot: root,
    runId,
    platform: "darwin",
    trialsPerScenario: 1,
    selectedScenarios: ["S1"],
    environment: environmentFixture(runId),
    ...overrides,
  });
}

function recordPassingDelivery(recorder: EvidenceRecorder, deliveryId: string): void {
  recorder.record({ component: "a4sd", event: "delivery_sent", delivery_id: deliveryId });
  recorder.record({ component: "pi-extension", event: "delivery_processed", delivery_id: deliveryId });
  recorder.record({ component: "a4sd", event: "acknowledged", delivery_id: deliveryId });
}

test("EvidenceRecorder writes environment, events, and a PASS summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "a4s-evidence-"));
  const recorder = await createRecorder(root);

  recorder.beginTrial("S1", 1);
  recorder.record({ component: "a4sd", event: "delivery_enqueued", delivery_id: "D1" });
  recorder.record({ component: "pi-extension", event: "delivery_processed", delivery_id: "D1" });
  recorder.record({ component: "a4sd", event: "acknowledged", delivery_id: "D1" });
  recorder.passTrial();
  const summary = await recorder.finish();

  assert.equal(summary.verdict, "PASS-macOS");
  assert.equal(summary.scenarios.S1.passed, 1);
  assert.equal(summary.scenarios.S2.planned, 0);
  assert.equal(summary.platforms.macOS, "PASS");
  assert.equal(summary.platforms.linux, "NOT RUN");
  assert.equal(summary.platforms.windows, "NOT RUN");
  assert.deepEqual(JSON.parse(await readFile(join(root, "environment.json"), "utf8")), environmentFixture("run-1"));
  assert.match(await readFile(join(root, "events.jsonl"), "utf8"), /delivery_processed/);
  assert.deepEqual(JSON.parse(await readFile(join(root, "summary.json"), "utf8")), summary);

  const events = (await readFile(join(root, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as ExperimentEvent);
  assert.deepEqual(events.map((event) => event.event), [
    "trial_started",
    "delivery_enqueued",
    "delivery_processed",
    "acknowledged",
    "trial_passed",
  ]);
  assert.ok(events.every((event) => event.run_id === "run-1" && event.scenario === "S1" && event.trial === 1));
  assert.ok(events.every((event) => typeof event.timestamp === "string" && typeof event.monotonic_ms === "number"));
});

test("one failed trial makes the run fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "a4s-evidence-fail-"));
  const recorder = await createRecorder(root, { runId: "run-fail", environment: environmentFixture("run-fail") });
  recorder.beginTrial("S1", 1);
  recorder.failTrial("unexpected disconnect");
  assert.equal((await recorder.finish()).verdict, "FAIL-macOS");
});

test("duplicate physical sends with one logical process preserve PASS verdict", async () => {
  const root = await mkdtemp(join(tmpdir(), "a4s-evidence-duplicate-"));
  const recorder = await createRecorder(root, { runId: "run-duplicate", environment: environmentFixture("run-duplicate") });

  recorder.beginTrial("S1", 1);
  recorder.record({ component: "a4sd", event: "delivery_sent", delivery_id: "D1" });
  recorder.record({ component: "a4sd", event: "delivery_sent", delivery_id: "D1" });
  recorder.record({ component: "pi-extension", event: "delivery_processed", delivery_id: "D1" });
  recorder.record({ component: "pi-extension", event: "delivery_duplicate", delivery_id: "D1" });
  recorder.record({ component: "a4sd", event: "acknowledged", delivery_id: "D1" });
  recorder.passTrial();
  const summary = await recorder.finish();

  assert.equal(summary.verdict, "PASS-macOS");
  assert.equal(summary.scenarios.S1.deliveriesCreated, 1);
  assert.equal(summary.scenarios.S1.physicalSends, 2);
  assert.equal(summary.scenarios.S1.redeliveries, 1);
  assert.equal(summary.scenarios.S1.logicalProcesses, 1);
  assert.equal(summary.scenarios.S1.duplicateFrames, 1);
});

test("a lost Delivery fails the verdict", async () => {
  const root = await mkdtemp(join(tmpdir(), "a4s-evidence-lost-"));
  const recorder = await createRecorder(root, { runId: "run-lost", environment: environmentFixture("run-lost") });

  recorder.beginTrial("S1", 1);
  recorder.record({ component: "a4sd", event: "delivery_sent", delivery_id: "D1" });
  recorder.record({ component: "a4sd", event: "acknowledged", delivery_id: "D1" });
  recorder.passTrial();
  const summary = await recorder.finish();

  assert.equal(summary.verdict, "FAIL-macOS");
  assert.equal(summary.scenarios.S1.deliveriesCreated, 1);
  assert.equal(summary.scenarios.S1.logicalProcesses, 0);
});

test("an unacknowledged Delivery fails the verdict", async () => {
  const root = await mkdtemp(join(tmpdir(), "a4s-evidence-unack-"));
  const recorder = await createRecorder(root, { runId: "run-unack", environment: environmentFixture("run-unack") });

  recorder.beginTrial("S1", 1);
  recorder.record({ component: "a4sd", event: "delivery_sent", delivery_id: "D1" });
  recorder.record({ component: "pi-extension", event: "delivery_processed", delivery_id: "D1" });
  recorder.passTrial();
  const summary = await recorder.finish();

  assert.equal(summary.verdict, "FAIL-macOS");
  assert.equal(summary.scenarios.S1.deliveriesCreated, 1);
  assert.equal(summary.scenarios.S1.acknowledged, 0);
});

test("summary reports deterministic median trial duration", async () => {
  const originalNow = performance.now;
  let now = 0;
  Object.defineProperty(performance, "now", { value: () => now, configurable: true });
  try {
    const root = await mkdtemp(join(tmpdir(), "a4s-evidence-median-"));
    const recorder = await createRecorder(root, {
      runId: "run-median",
      trialsPerScenario: 3,
      environment: { ...environmentFixture("run-median"), trials_per_scenario: 3 },
    });

    recorder.beginTrial("S1", 1);
    now = 10;
    recordPassingDelivery(recorder, "D1");
    recorder.passTrial();
    recorder.beginTrial("S1", 2);
    now = 40;
    recordPassingDelivery(recorder, "D2");
    recorder.passTrial();
    recorder.beginTrial("S1", 3);
    now = 60;
    recordPassingDelivery(recorder, "D3");
    recorder.passTrial();

    const summary = await recorder.finish();
    assert.equal(summary.scenarios.S1.minDurationMs, 10);
    assert.equal(summary.scenarios.S1.medianDurationMs, 20);
    assert.equal(summary.scenarios.S1.maxDurationMs, 30);
  } finally {
    Object.defineProperty(performance, "now", { value: originalNow, configurable: true });
  }
});

test("verdict enforces 20 of 20 selected scenario trials", async () => {
  const root = await mkdtemp(join(tmpdir(), "a4s-evidence-20-"));
  const recorder = await createRecorder(root, {
    runId: "run-20",
    trialsPerScenario: 20,
    environment: { ...environmentFixture("run-20"), trials_per_scenario: 20 },
  });

  for (let trial = 1; trial <= 19; trial += 1) {
    recorder.beginTrial("S1", trial);
    recordPassingDelivery(recorder, `D${trial}`);
    recorder.passTrial();
  }
  const summary = await recorder.finish();

  assert.equal(summary.verdict, "FAIL-macOS");
  assert.equal(summary.scenarios.S1.planned, 20);
  assert.equal(summary.scenarios.S1.executed, 19);
  assert.equal(summary.scenarios.S1.passed, 19);
  assert.equal(summary.scenarios.S1.failed, 0);
});

test("unexecuted platforms remain NOT RUN in verdict summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "a4s-evidence-platforms-"));
  const recorder = await createRecorder(root, {
    runId: "run-linux",
    platform: "linux",
    environment: environmentFixture("run-linux"),
  });

  recorder.beginTrial("S1", 1);
  recordPassingDelivery(recorder, "D1");
  recorder.passTrial();
  const summary = await recorder.finish();

  assert.equal(summary.verdict, "PASS-linux");
  assert.deepEqual(summary.platforms, { macOS: "NOT RUN", linux: "PASS", windows: "NOT RUN" });
});

