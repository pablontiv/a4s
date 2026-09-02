import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerEvent } from "../daemon/server.ts";
import type { ClientEvent } from "../pi-extension/client.ts";

export type ScenarioId = "S1" | "S2" | "S3" | "S4" | "S5";

export interface ExperimentEvent {
  run_id: string;
  scenario: ScenarioId;
  trial: number;
  timestamp: string;
  monotonic_ms: number;
  component: "driver" | "a4sd" | "pi-extension" | "pi-process";
  event: string;
  message_id?: string;
  delivery_id?: string;
  direction?: "inbound" | "outbound";
  detail?: string;
  endpoint?: string;
}

export interface ScenarioSummary {
  planned: number;
  executed: number;
  passed: number;
  failed: number;
  deliveriesCreated: number;
  physicalSends: number;
  redeliveries: number;
  acknowledged: number;
  logicalProcesses: number;
  duplicateFrames: number;
  minDurationMs: number;
  medianDurationMs: number;
  maxDurationMs: number;
  unhandledErrors: number;
}

export interface EnvironmentRecord {
  run_id: string;
  started_at: string;
  os_version: string;
  architecture: string;
  node_version: string;
  pi_version: string;
  a4s_commit: string;
  endpoint_pattern: string;
  transport: "unix_socket" | "named_pipe";
  trials_per_scenario: number;
}

export interface RunSummary {
  run_id: string;
  verdict: string;
  scenarios: Record<ScenarioId, ScenarioSummary>;
  platforms: Record<"macOS" | "linux" | "windows", string>;
}

export interface EvidenceRecorderOptions {
  artifactRoot: string;
  runId: string;
  platform: NodeJS.Platform;
  trialsPerScenario: number;
  selectedScenarios: ScenarioId[];
  environment: EnvironmentRecord;
}

type RecorderEvent = Omit<ExperimentEvent, "run_id" | "scenario" | "trial" | "timestamp" | "monotonic_ms">;
export type EvidenceInputEvent = ServerEvent | ClientEvent | RecorderEvent;

interface ActiveTrial {
  scenario: ScenarioId;
  trial: number;
  startMs: number;
}

interface ScenarioState {
  planned: number;
  executed: number;
  passed: number;
  failed: number;
  physicalSends: number;
  unhandledErrors: number;
  duplicateDeliveryEvents: number;
  durationsMs: number[];
  deliveryIds: Set<string>;
  sentCounts: Map<string, number>;
  processCounts: Map<string, number>;
  acknowledgedIds: Set<string>;
}

const SCENARIOS = ["S1", "S2", "S3", "S4", "S5"] as const satisfies readonly ScenarioId[];

export class EvidenceRecorder {
  private activeTrial: ActiveTrial | undefined;
  private finished = false;

  private constructor(
    private readonly options: EvidenceRecorderOptions,
    private readonly eventsFd: number,
    private readonly states: Record<ScenarioId, ScenarioState>,
  ) {}

  static async create(options: EvidenceRecorderOptions): Promise<EvidenceRecorder> {
    await mkdir(options.artifactRoot, { recursive: true });
    await writeFile(join(options.artifactRoot, "environment.json"), `${JSON.stringify(options.environment, null, 2)}\n`, "utf8");

    const selected = new Set(options.selectedScenarios);
    const states = Object.fromEntries(
      SCENARIOS.map((scenario) => [scenario, createScenarioState(selected.has(scenario) ? options.trialsPerScenario : 0)]),
    ) as Record<ScenarioId, ScenarioState>;

    const eventsFd = openSync(join(options.artifactRoot, "events.jsonl"), "a");
    return new EvidenceRecorder(options, eventsFd, states);
  }

  beginTrial(scenario: ScenarioId, trial: number): void {
    this.assertOpen();
    if (this.activeTrial) {
      throw new Error(`trial already active: ${this.activeTrial.scenario} #${this.activeTrial.trial}`);
    }

    this.activeTrial = { scenario, trial, startMs: performance.now() };
    this.states[scenario].executed += 1;
    this.writeEvent({ component: "driver", event: "trial_started" });
  }

  record(event: Omit<ExperimentEvent, "run_id" | "scenario" | "trial" | "timestamp" | "monotonic_ms">): void {
    this.assertOpen();
    const trial = this.requireActiveTrial();
    this.applyEvent(trial.scenario, event);
    this.writeEvent(event);
  }

  passTrial(): void {
    this.assertOpen();
    const trial = this.requireActiveTrial();
    this.states[trial.scenario].passed += 1;
    this.recordDuration(trial);
    this.writeEvent({ component: "driver", event: "trial_passed" });
    this.activeTrial = undefined;
  }

  failTrial(detail: string): void {
    this.assertOpen();
    const trial = this.requireActiveTrial();
    this.states[trial.scenario].failed += 1;
    this.recordDuration(trial);
    this.writeEvent({ component: "driver", event: "trial_failed", detail });
    this.activeTrial = undefined;
  }

  async finish(): Promise<RunSummary> {
    this.assertOpen();
    if (this.activeTrial) {
      throw new Error(`cannot finish with active trial: ${this.activeTrial.scenario} #${this.activeTrial.trial}`);
    }

    const scenarios = Object.fromEntries(
      SCENARIOS.map((scenario) => [scenario, summarizeScenario(this.states[scenario])]),
    ) as Record<ScenarioId, ScenarioSummary>;
    const passed = this.selectedScenariosPass(scenarios);
    const currentPlatform = platformLabel(this.options.platform);
    const platforms: RunSummary["platforms"] = { macOS: "NOT RUN", linux: "NOT RUN", windows: "NOT RUN" };
    if (currentPlatform) {
      platforms[currentPlatform] = passed ? "PASS" : "FAIL";
    }

    const summary: RunSummary = {
      run_id: this.options.runId,
      verdict: `${passed ? "PASS" : "FAIL"}-${currentPlatform ?? this.options.platform}`,
      scenarios,
      platforms,
    };

    fsyncSync(this.eventsFd);
    closeSync(this.eventsFd);
    this.finished = true;
    await writeFile(join(this.options.artifactRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    return summary;
  }

  private selectedScenariosPass(scenarios: Record<ScenarioId, ScenarioSummary>): boolean {
    for (const scenario of this.options.selectedScenarios) {
      const state = this.states[scenario];
      const summary = scenarios[scenario];
      if (summary.planned !== this.options.trialsPerScenario) return false;
      if (summary.executed !== this.options.trialsPerScenario) return false;
      if (summary.failed !== 0) return false;
      if (summary.unhandledErrors !== 0) return false;
      if (state.deliveryIds.size !== summary.executed) return false;

      for (const deliveryId of state.deliveryIds) {
        if ((state.processCounts.get(deliveryId) ?? 0) !== 1) return false;
        if (!state.acknowledgedIds.has(deliveryId)) return false;
      }
    }
    return true;
  }

  private applyEvent(scenario: ScenarioId, event: RecorderEvent): void {
    const state = this.states[scenario];
    const deliveryId = event.delivery_id;

    if (event.event === "unhandled_error") {
      state.unhandledErrors += 1;
    }

    if (event.event === "delivery_duplicate") {
      state.duplicateDeliveryEvents += 1;
    }

    if (!deliveryId) return;

    switch (event.event) {
      case "delivery_enqueued":
        state.deliveryIds.add(deliveryId);
        return;
      case "delivery_sent":
        state.deliveryIds.add(deliveryId);
        state.physicalSends += 1;
        state.sentCounts.set(deliveryId, (state.sentCounts.get(deliveryId) ?? 0) + 1);
        return;
      case "delivery_processed":
        state.deliveryIds.add(deliveryId);
        state.processCounts.set(deliveryId, (state.processCounts.get(deliveryId) ?? 0) + 1);
        return;
      case "acknowledged":
        state.deliveryIds.add(deliveryId);
        state.acknowledgedIds.add(deliveryId);
        return;
      default:
        return;
    }
  }

  private recordDuration(trial: ActiveTrial): void {
    this.states[trial.scenario].durationsMs.push(normalizeDurationMs(performance.now() - trial.startMs));
  }

  private writeEvent(event: RecorderEvent): void {
    const trial = this.requireActiveTrial();
    const experimentEvent: ExperimentEvent = {
      run_id: this.options.runId,
      scenario: trial.scenario,
      trial: trial.trial,
      timestamp: new Date().toISOString(),
      monotonic_ms: normalizeMonotonicMs(performance.now() - trial.startMs),
      ...event,
    };
    writeSync(this.eventsFd, `${JSON.stringify(experimentEvent)}\n`, undefined, "utf8");
  }

  private requireActiveTrial(): ActiveTrial {
    if (!this.activeTrial) {
      throw new Error("no active trial");
    }
    return this.activeTrial;
  }

  private assertOpen(): void {
    if (this.finished) {
      throw new Error("evidence recorder already finished");
    }
  }
}

function createScenarioState(planned: number): ScenarioState {
  return {
    planned,
    executed: 0,
    passed: 0,
    failed: 0,
    physicalSends: 0,
    unhandledErrors: 0,
    duplicateDeliveryEvents: 0,
    durationsMs: [],
    deliveryIds: new Set<string>(),
    sentCounts: new Map<string, number>(),
    processCounts: new Map<string, number>(),
    acknowledgedIds: new Set<string>(),
  };
}

function summarizeScenario(state: ScenarioState): ScenarioSummary {
  const redeliveries = [...state.sentCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const durations = [...state.durationsMs].sort((left, right) => left - right);
  return {
    planned: state.planned,
    executed: state.executed,
    passed: state.passed,
    failed: state.failed,
    deliveriesCreated: state.deliveryIds.size,
    physicalSends: state.physicalSends,
    redeliveries,
    acknowledged: state.acknowledgedIds.size,
    logicalProcesses: [...state.processCounts.values()].reduce((sum, count) => sum + count, 0),
    duplicateFrames: Math.max(redeliveries, state.duplicateDeliveryEvents),
    minDurationMs: durations[0] ?? 0,
    medianDurationMs: median(durations),
    maxDurationMs: durations.at(-1) ?? 0,
    unhandledErrors: state.unhandledErrors,
  };
}

function median(sortedValues: readonly number[]): number {
  if (sortedValues.length === 0) return 0;
  const middle = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 1) {
    return sortedValues[middle] ?? 0;
  }
  return ((sortedValues[middle - 1] ?? 0) + (sortedValues[middle] ?? 0)) / 2;
}

function normalizeDurationMs(durationMs: number): number {
  return Math.max(1, Math.round(durationMs));
}

function normalizeMonotonicMs(durationMs: number): number {
  return Math.max(0, Math.round(durationMs));
}

function platformLabel(platform: NodeJS.Platform): "macOS" | "linux" | "windows" | undefined {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      return undefined;
  }
}
