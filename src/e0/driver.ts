import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { E0Server } from "../daemon/server.ts";
import { createRunEndpoint } from "../daemon/endpoint.ts";
import {
  EvidenceRecorder,
  type EnvironmentRecord,
  type EvidenceInputEvent,
  type ExperimentEvent,
  type RunSummary,
  type ScenarioId,
} from "./evidence.ts";
import { RealPiLauncher, type PiLauncher, type PiProcessHandle } from "./pi-process.ts";

const ALL_SCENARIOS = ["S1", "S2", "S3", "S4", "S5"] as const satisfies readonly ScenarioId[];
const WAIT_DEADLINE_MS = 10_000;
const DEFAULT_TRIALS = 20;
const DEFAULT_ARTIFACT_ROOT = "artifacts/e0";
const DEFAULT_OWNER_ID = "W1";
const BINDING_REVISION = 1 as const;

export interface ExperimentOptions {
  trials: number;
  scenarios: ScenarioId[];
  launcher: PiLauncher;
  artifactRoot: string;
}

interface TrialResources {
  endpoint: string;
  endpointDirectory: string;
  ownerId: string;
  deliveryId: string;
  sessionDir: string;
}

type TrialEvent = Omit<ExperimentEvent, "run_id" | "scenario" | "trial" | "timestamp" | "monotonic_ms">;

type CliResult =
  | { mode: "experiment"; trials: number; scenarios: ScenarioId[]; artifactRoot: string; piBin: string }
  | { mode: "manual"; endpoint: string; ownerId: string; timeoutMs: number }
  | { mode: "invalid"; message: string };

export async function runExperiment(options: ExperimentOptions): Promise<{
  runDir: string;
  summary: RunSummary;
}> {
  validateExperimentOptions(options);

  const runId = createRunId();
  const runDir = resolve(options.artifactRoot, runId);
  await mkdir(runDir, { recursive: true });

  const endpointPattern = endpointPatternFor(runDir, runId, process.platform);
  const environment = await createEnvironmentRecord({
    runId,
    startedAt: new Date().toISOString(),
    endpointPattern,
    trials: options.trials,
  });
  const recorder = await EvidenceRecorder.create({
    artifactRoot: runDir,
    runId,
    platform: process.platform,
    trialsPerScenario: options.trials,
    selectedScenarios: options.scenarios,
    environment,
  });

  for (const scenario of options.scenarios) {
    for (let trial = 1; trial <= options.trials; trial += 1) {
      await runTrial({
        runId,
        runDir,
        scenario,
        trial,
        endpointPattern,
        launcher: options.launcher,
        recorder,
      });
    }
  }

  const summary = await recorder.finish();
  return { runDir, summary };
}

export async function runManualSmoke(options: {
  endpoint: string;
  ownerId: string;
  timeoutMs: number;
}): Promise<void> {
  if (!options.endpoint) throw new Error("manual mode requires an endpoint");
  if (!options.ownerId) throw new Error("manual mode requires an ownerId");
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("manual timeout must be a positive integer");

  const events = new ManualEvents();
  const server = new E0Server({
    endpoint: options.endpoint,
    expectedOwnerId: options.ownerId,
    expectedBindingRevision: BINDING_REVISION,
    onEvent: (event) => events.record(event),
  });

  try {
    await server.start();
    server.enqueueProbe("D-manual", `manual-${randomUUID()}`);
    const sessionDir = await mkdtemp(join(tmpdir(), "a4s-manual-session-"));
    const command = formatManualCommand({
      endpoint: options.endpoint,
      ownerId: options.ownerId,
      sessionDir,
      extensionPath: defaultExtensionPath(),
      piBin: process.env.PI_BIN ?? "pi",
    });
    console.log(`endpoint=${options.endpoint}`);
    console.log(`second_terminal_command=${command}`);
    await events.waitFor(
      (event) => event.component === "a4sd" && event.event === "acknowledged" && event.delivery_id === "D-manual",
      options.timeoutMs,
      "manual ACK",
    );
  } finally {
    await server.stop();
    await removeEndpointPath(options.endpoint);
  }
}

async function runTrial(options: {
  runId: string;
  runDir: string;
  scenario: ScenarioId;
  trial: number;
  endpointPattern: string;
  launcher: PiLauncher;
  recorder: EvidenceRecorder;
}): Promise<void> {
  options.recorder.beginTrial(options.scenario, options.trial);

  const resources = await createTrialResources(options.runDir, options.runId, options.scenario, options.trial);
  const events = new TrialEvents(options.recorder);
  let server: E0Server | undefined;
  let pi: PiProcessHandle | undefined;
  let passed = false;
  let failureDetail = "unknown trial failure";

  try {
    events.record({
      component: "driver",
      event: "endpoint_resolved",
      endpoint: resources.endpoint,
      detail: `endpoint_pattern=${options.endpointPattern}`,
    });

    server = new E0Server({
      endpoint: resources.endpoint,
      expectedOwnerId: resources.ownerId,
      expectedBindingRevision: BINDING_REVISION,
      onEvent: (event) => events.record(event),
    });
    await server.start();

    pi = await executeScenario({
      scenario: options.scenario,
      server,
      launcher: options.launcher,
      events,
      resources,
    });

    assertDeliveryInvariant(events, resources.deliveryId, options.scenario);
    passed = true;
  } catch (error) {
    failureDetail = errorDetail(error);
    safeRecord(events, { component: "driver", event: "unhandled_error", detail: failureDetail });
  } finally {
    const cleanupErrors: string[] = [];
    if (pi) {
      try {
        await pi.stop();
      } catch (error) {
        cleanupErrors.push(`pi_stop: ${errorDetail(error)}`);
      }
    }
    if (server) {
      try {
        await server.stop();
      } catch (error) {
        cleanupErrors.push(`server_stop: ${errorDetail(error)}`);
      }
    }
    try {
      await removeEndpointPath(resources.endpoint);
      await rm(resources.endpointDirectory, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(`endpoint_cleanup: ${errorDetail(error)}`);
    }
    if (cleanupErrors.length > 0) {
      passed = false;
      failureDetail = cleanupErrors.join("; ");
      safeRecord(events, { component: "driver", event: "unhandled_error", detail: failureDetail });
    }
  }

  if (passed) {
    options.recorder.passTrial();
  } else {
    options.recorder.failTrial(failureDetail);
  }
}

async function executeScenario(options: {
  scenario: ScenarioId;
  server: E0Server;
  launcher: PiLauncher;
  events: TrialEvents;
  resources: TrialResources;
}): Promise<PiProcessHandle> {
  switch (options.scenario) {
    case "S1":
      return executeS1(options);
    case "S2":
      return executeS2(options);
    case "S3":
      return executeS3(options);
    case "S4":
      return executeS4(options);
    case "S5":
      return executeS5(options);
  }
}

async function executeS1(options: ScenarioExecutionOptions): Promise<PiProcessHandle> {
  const pi = await startPi(options);
  await waitForAttach(options.events, 1);
  enqueueDelivery(options);
  await waitForDeliveryProcessed(options.events, options.resources.deliveryId);
  await waitForAcknowledged(options.events, options.resources.deliveryId);
  return pi;
}

async function executeS2(options: ScenarioExecutionOptions): Promise<PiProcessHandle> {
  enqueueDelivery(options);
  const pi = await startPi(options);
  await waitForAttach(options.events, 1);
  await waitForDeliveryProcessed(options.events, options.resources.deliveryId);
  await waitForAcknowledged(options.events, options.resources.deliveryId);
  return pi;
}

async function executeS3(options: ScenarioExecutionOptions): Promise<PiProcessHandle> {
  options.server.faults.dropNextAckAndDisconnect();
  options.events.record({ component: "driver", event: "fault_armed", detail: "drop_next_ack_and_disconnect" });
  enqueueDelivery(options);
  const pi = await startPi(options);
  await waitForAttach(options.events, 1);
  await waitForDeliveryProcessed(options.events, options.resources.deliveryId);
  await options.events.waitFor(
    (event) => event.component === "pi-extension" && event.event === "reconnect_scheduled",
    WAIT_DEADLINE_MS,
    "Pi reconnect scheduled after dropped ACK",
  );
  await waitForAttach(options.events, 2);
  await waitForDeliveryDuplicate(options.events, options.resources.deliveryId);
  await waitForAcknowledged(options.events, options.resources.deliveryId);
  return pi;
}

async function executeS4(options: ScenarioExecutionOptions): Promise<PiProcessHandle> {
  const pi = await startPi(options);
  await waitForAttach(options.events, 1);
  options.server.disconnectClient();
  options.events.record({ component: "driver", event: "disconnect_requested", detail: "server_disconnect_before_delivery" });
  await options.events.waitFor(
    (event) => event.component === "pi-extension" && event.event === "reconnect_scheduled",
    WAIT_DEADLINE_MS,
    "Pi reconnect scheduled after server disconnect",
  );
  await waitForAttach(options.events, 2);
  enqueueDelivery(options);
  await waitForDeliveryProcessed(options.events, options.resources.deliveryId);
  await waitForAcknowledged(options.events, options.resources.deliveryId);
  return pi;
}

async function executeS5(options: ScenarioExecutionOptions): Promise<PiProcessHandle> {
  options.server.faults.duplicateNextDelivery();
  options.events.record({ component: "driver", event: "fault_armed", detail: "duplicate_next_delivery" });
  enqueueDelivery(options);
  const pi = await startPi(options);
  await waitForAttach(options.events, 1);
  await waitForDeliveryProcessed(options.events, options.resources.deliveryId);
  await waitForDeliveryDuplicate(options.events, options.resources.deliveryId);
  await waitForAcknowledged(options.events, options.resources.deliveryId);
  return pi;
}

interface ScenarioExecutionOptions {
  scenario: ScenarioId;
  server: E0Server;
  launcher: PiLauncher;
  events: TrialEvents;
  resources: TrialResources;
}

async function startPi(options: ScenarioExecutionOptions): Promise<PiProcessHandle> {
  const pi = await options.launcher.start({
    endpoint: options.resources.endpoint,
    ownerId: options.resources.ownerId,
    bindingRevision: BINDING_REVISION,
    sessionDir: options.resources.sessionDir,
    extensionPath: defaultExtensionPath(),
    onTrace: (event) => options.events.record(normalizeTraceEvent(event)),
  });
  options.events.record({ component: "driver", event: "pi_started", detail: `pid=${pi.pid}` });
  return pi;
}

function enqueueDelivery(options: ScenarioExecutionOptions): void {
  options.server.enqueueProbe(options.resources.deliveryId, `nonce-${randomUUID()}`);
  options.events.record({ component: "driver", event: "delivery_enqueued", delivery_id: options.resources.deliveryId });
}

function waitForAttach(events: TrialEvents, count: number): Promise<void> {
  return events.waitFor(
    () => events.count((event) => event.component === "pi-extension" && event.event === "attached") >= count,
    WAIT_DEADLINE_MS,
    `${count} Pi attach event(s)`,
  ).then(() => undefined);
}

function waitForDeliveryProcessed(events: TrialEvents, deliveryId: string): Promise<void> {
  return events.waitFor(
    () => deliveryProcessedCount(events, deliveryId) === 1,
    WAIT_DEADLINE_MS,
    `one logical process for ${deliveryId}`,
  ).then(() => undefined);
}

function waitForDeliveryDuplicate(events: TrialEvents, deliveryId: string): Promise<void> {
  return events.waitFor(
    () => deliveryDuplicateCount(events, deliveryId) === 1,
    WAIT_DEADLINE_MS,
    `one duplicate event for ${deliveryId}`,
  ).then(() => undefined);
}

function waitForAcknowledged(events: TrialEvents, deliveryId: string): Promise<void> {
  return events.waitFor(
    () => acknowledgedCount(events, deliveryId) === 1,
    WAIT_DEADLINE_MS,
    `one ACK for ${deliveryId}`,
  ).then(() => undefined);
}

function assertDeliveryInvariant(events: TrialEvents, deliveryId: string, scenario: ScenarioId): void {
  const processed = deliveryProcessedCount(events, deliveryId);
  const acknowledged = acknowledgedCount(events, deliveryId);
  if (processed !== 1 || acknowledged !== 1) {
    throw new Error(`invariant failed for ${scenario}/${deliveryId}: processed=${processed} acknowledged=${acknowledged}`);
  }

  const duplicates = deliveryDuplicateCount(events, deliveryId);
  const expectedDuplicates = scenario === "S3" || scenario === "S5" ? 1 : 0;
  if (duplicates !== expectedDuplicates) {
    throw new Error(`duplicate invariant failed for ${scenario}/${deliveryId}: duplicates=${duplicates} expected=${expectedDuplicates}`);
  }
}

function deliveryProcessedCount(events: TrialEvents, deliveryId: string): number {
  return events.count((event) => event.event === "delivery_processed" && event.delivery_id === deliveryId);
}

function deliveryDuplicateCount(events: TrialEvents, deliveryId: string): number {
  return events.count((event) => event.event === "delivery_duplicate" && event.delivery_id === deliveryId);
}

function acknowledgedCount(events: TrialEvents, deliveryId: string): number {
  return events.count((event) => event.event === "acknowledged" && event.delivery_id === deliveryId);
}

class TrialEvents {
  private readonly events: TrialEvent[] = [];
  private readonly waiters = new Set<Waiter>();

  constructor(private readonly recorder: EvidenceRecorder) {}

  record(event: TrialEvent): void {
    this.events.push(event);
    this.recorder.record(event);
    this.notifyWaiters();
  }

  count(predicate: (event: TrialEvent) => boolean): number {
    return this.events.filter(predicate).length;
  }

  waitFor(predicate: (event: TrialEvent) => boolean, timeoutMs: number, description: string): Promise<TrialEvent>;
  waitFor(predicate: () => boolean, timeoutMs: number, description: string): Promise<void>;
  waitFor(predicate: ((event: TrialEvent) => boolean) | (() => boolean), timeoutMs: number, description: string): Promise<TrialEvent | void> {
    const existing = this.events.find((event) => predicate(event));
    if (existing) return Promise.resolve(existing);
    if (predicate.length === 0 && (predicate as () => boolean)()) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(`timed out waiting for ${description}`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  private notifyWaiters(): void {
    for (const waiter of [...this.waiters]) {
      const match = this.events.find((event) => waiter.predicate(event));
      if (!match && !(waiter.predicate.length === 0 && (waiter.predicate as () => boolean)())) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(match);
    }
  }
}

interface Waiter {
  predicate: ((event: TrialEvent) => boolean) | (() => boolean);
  resolve(value: TrialEvent | undefined): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

class ManualEvents {
  private readonly events: EvidenceInputEvent[] = [];
  private readonly waiters = new Set<ManualWaiter>();

  record(event: EvidenceInputEvent): void {
    this.events.push(event);
    for (const waiter of [...this.waiters]) {
      const match = this.events.find((entry) => waiter.predicate(entry));
      if (!match) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(match);
    }
  }

  waitFor(predicate: (event: EvidenceInputEvent) => boolean, timeoutMs: number, description: string): Promise<EvidenceInputEvent> {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter: ManualWaiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(`timed out waiting for ${description}`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }
}

interface ManualWaiter {
  predicate(event: EvidenceInputEvent): boolean;
  resolve(event: EvidenceInputEvent): void;
  timer: NodeJS.Timeout;
}

function normalizeTraceEvent(event: Record<string, unknown>): TrialEvent {
  const component = event.component;
  const name = event.event;
  const normalized: TrialEvent = {
    component: component === "pi-extension" || component === "pi-process" ? component : "pi-process",
    event: typeof name === "string" ? name : "trace",
  };
  if (typeof event.message_id === "string") normalized.message_id = event.message_id;
  if (typeof event.delivery_id === "string") normalized.delivery_id = event.delivery_id;
  if (typeof event.detail === "string") normalized.detail = event.detail;
  return normalized;
}

function safeRecord(events: TrialEvents, event: TrialEvent): void {
  try {
    events.record(event);
  } catch {
    // The original failure is more useful than a secondary evidence-write failure.
  }
}

async function createTrialResources(runDir: string, runId: string, scenario: ScenarioId, trial: number): Promise<TrialResources> {
  const trialId = `${runId}-${scenario}-${trial}-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const sessionDir = join(runDir, "sessions", scenario, String(trial));
  await mkdir(sessionDir, { recursive: true });
  const endpoint = createRunEndpoint(trialId, endpointTempRoot(), process.platform);
  return {
    endpoint,
    endpointDirectory: dirname(endpoint),
    ownerId: `${DEFAULT_OWNER_ID}-${scenario}-${trial}`,
    deliveryId: `D-${scenario}-${trial}-${randomUUID().replaceAll("-", "").slice(0, 8)}`,
    sessionDir,
  };
}

function endpointPatternFor(_runDir: string, runId: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return `\\\\.\\pipe\\a4s-e0-${runId}-{scenario}-{trial}-{suffix}`;
  return join(endpointTempRoot(), `${runId}-{scenario}-{trial}-{suffix}`, "a4sd.sock");
}

function endpointTempRoot(): string {
  return process.platform === "win32" ? tmpdir() : "/tmp/a4s-e0";
}

async function createEnvironmentRecord(options: {
  runId: string;
  startedAt: string;
  endpointPattern: string;
  trials: number;
}): Promise<EnvironmentRecord> {
  return {
    run_id: options.runId,
    started_at: options.startedAt,
    os_version: `${process.platform} ${release()}`,
    architecture: process.arch,
    node_version: process.version,
    pi_version: await readPiVersion(),
    a4s_commit: await readGitCommit(),
    endpoint_pattern: options.endpointPattern,
    transport: process.platform === "win32" ? "named_pipe" : "unix_socket",
    trials_per_scenario: options.trials,
  };
}

async function readGitCommit(): Promise<string> {
  try {
    const { stdout } = await execFilePromise("git", ["rev-parse", "HEAD"]);
    return stdout.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

async function readPiVersion(): Promise<string> {
  try {
    const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { devDependencies?: Record<string, string> };
    return packageJson.devDependencies?.["@earendil-works/pi-coding-agent"] ?? "unknown";
  } catch {
    return "unknown";
  }
}

function execFilePromise(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { cwd: process.cwd() }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

function validateExperimentOptions(options: ExperimentOptions): void {
  if (!Number.isInteger(options.trials) || options.trials <= 0) throw new Error("trials must be a positive integer");
  if (options.scenarios.length === 0) throw new Error("at least one scenario is required");
  for (const scenario of options.scenarios) {
    if (!isScenarioId(scenario)) throw new Error(`invalid scenario: ${scenario}`);
  }
}

function createRunId(): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const suffix = randomUUID().replaceAll("-", "").slice(0, 4);
  return `${timestamp}-${suffix}`;
}

function defaultExtensionPath(): string {
  return fileURLToPath(new URL("../pi-extension/index.ts", import.meta.url));
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isScenarioId(value: string): value is ScenarioId {
  return (ALL_SCENARIOS as readonly string[]).includes(value);
}

function parseCli(argv: readonly string[]): CliResult {
  let trials = DEFAULT_TRIALS;
  const scenarios: ScenarioId[] = [];
  let artifactRoot = DEFAULT_ARTIFACT_ROOT;
  let piBin = process.env.PI_BIN ?? "pi";
  let manual = false;
  let endpoint: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--trials": {
        const value = argv[++index];
        if (!value || !/^\d+$/.test(value)) return { mode: "invalid", message: "--trials requires a positive integer" };
        trials = Number(value);
        if (trials <= 0) return { mode: "invalid", message: "--trials requires a positive integer" };
        break;
      }
      case "--scenario": {
        const value = argv[++index];
        if (!value || !isScenarioId(value)) return { mode: "invalid", message: "--scenario accepts S1, S2, S3, S4, or S5" };
        scenarios.push(value);
        break;
      }
      case "--artifact-root": {
        const value = argv[++index];
        if (!value) return { mode: "invalid", message: "--artifact-root requires a path" };
        artifactRoot = value;
        break;
      }
      case "--pi-bin": {
        const value = argv[++index];
        if (!value) return { mode: "invalid", message: "--pi-bin requires a path" };
        piBin = value;
        break;
      }
      case "--manual":
        manual = true;
        break;
      case "--endpoint": {
        const value = argv[++index];
        if (!value) return { mode: "invalid", message: "--endpoint requires a path" };
        endpoint = value;
        break;
      }
      default:
        return { mode: "invalid", message: `unknown argument: ${arg ?? ""}` };
    }
  }

  if (manual) {
    if (!endpoint) return { mode: "invalid", message: "--endpoint is required with --manual" };
    return { mode: "manual", endpoint, ownerId: DEFAULT_OWNER_ID, timeoutMs: 60_000 };
  }

  return {
    mode: "experiment",
    trials,
    scenarios: scenarios.length > 0 ? scenarios : [...ALL_SCENARIOS],
    artifactRoot,
    piBin,
  };
}

export function formatManualCommand(options: {
  endpoint: string;
  ownerId: string;
  sessionDir: string;
  extensionPath: string;
  piBin: string;
}): string {
  const env = [
    ["A4S_ENDPOINT", options.endpoint],
    ["A4S_OWNER_ID", options.ownerId],
    ["A4S_BINDING_REVISION", "1"],
    ["A4S_E0_TRACE", "stderr"],
  ] as const;
  return [
    ...env.map(([key, value]) => `${key}=${shellQuote(value)}`),
    shellQuote(options.piBin),
    "--approve",
    "--session-dir", shellQuote(options.sessionDir),
    "--no-builtin-tools",
    "-e", shellQuote(options.extensionPath),
  ].join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:.,=@%+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function removeEndpointPath(endpoint: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await unlink(endpoint);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function main(): Promise<number> {
  const parsed = parseCli(process.argv.slice(2));
  if (parsed.mode === "invalid") {
    console.error(parsed.message);
    return 2;
  }

  try {
    if (parsed.mode === "manual") {
      await runManualSmoke({ endpoint: parsed.endpoint, ownerId: parsed.ownerId, timeoutMs: parsed.timeoutMs });
      return 0;
    }

    const result = await runExperiment({
      trials: parsed.trials,
      scenarios: parsed.scenarios,
      launcher: new RealPiLauncher(parsed.piBin),
      artifactRoot: parsed.artifactRoot,
    });
    console.log(`run_dir=${result.runDir}`);
    console.log(`verdict=${result.summary.verdict}`);
    return result.summary.verdict.startsWith("PASS-") ? 0 : 1;
  } catch (error) {
    console.error(errorDetail(error));
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
