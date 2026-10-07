export type WitnessVerdict = "pass" | "fail" | "unknown";
export type WorkerRuntimeState = "dispatch" | "queued" | "running" | "terminal";

export interface WorkerLink {
  correlationId: string;
  worker: string;
  pane: string;
  tab: string;
  sessionHash: string;
  pid: number;
  processStartTime: string;
}

export type WorkerLinkEvidence = Partial<WorkerLink>;

export interface RuntimeWorkerEvent {
  state: WorkerRuntimeState;
  observedAt: string;
  link: WorkerLinkEvidence;
}

export interface InventoryProcess {
  link: WorkerLinkEvidence;
}

export interface InventorySnapshot {
  observedAt: string;
  complete: boolean;
  processes: readonly InventoryProcess[];
}

export interface WorkerWitnessInput {
  expectedWorkers: readonly WorkerLink[];
  runtimeEvents: readonly RuntimeWorkerEvent[];
  inventorySnapshots: readonly InventorySnapshot[];
  minimumConcurrentWorkers?: number;
}

export interface WitnessCheck {
  verdict: WitnessVerdict;
  reasons: string[];
}

export interface WorkerWitnessResult {
  verdict: WitnessVerdict;
  checks: {
    identity: WitnessCheck;
    concurrency: WitnessCheck;
    termination: WitnessCheck;
  };
  reasons: string[];
}

const LINK_FIELDS = [
  "correlationId",
  "worker",
  "pane",
  "tab",
  "sessionHash",
  "pid",
  "processStartTime",
] as const satisfies readonly (keyof WorkerLink)[];

type LinkField = (typeof LINK_FIELDS)[number];

interface Lifecycle {
  expected: WorkerLink;
  runningAt: bigint | undefined;
  terminalAt: bigint | undefined;
}

function check(verdict: WitnessVerdict, reasons: string[]): WitnessCheck {
  return { verdict, reasons };
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function missingFields(link: WorkerLinkEvidence): LinkField[] {
  return LINK_FIELDS.filter((field) => !isPresent(link[field]));
}

function mismatchedFields(actual: WorkerLinkEvidence, expected: WorkerLink): LinkField[] {
  return LINK_FIELDS.filter(
    (field) => isPresent(actual[field]) && actual[field] !== expected[field],
  );
}

function linksEqual(actual: WorkerLinkEvidence, expected: WorkerLink): boolean {
  return missingFields(actual).length === 0 && mismatchedFields(actual, expected).length === 0;
}

function sameProcess(actual: WorkerLinkEvidence, expected: WorkerLink): boolean {
  return actual.pid === expected.pid && actual.processStartTime === expected.processStartTime;
}

function isCandidate(actual: WorkerLinkEvidence, expected: WorkerLink): boolean {
  return actual.correlationId === expected.correlationId || sameProcess(actual, expected);
}

function overallVerdict(checks: readonly WitnessCheck[]): WitnessVerdict {
  if (checks.some((item) => item.verdict === "fail")) return "fail";
  if (checks.some((item) => item.verdict === "unknown")) return "unknown";
  return "pass";
}

function uniqueReasons(reasons: readonly string[]): string[] {
  return [...new Set(reasons)];
}

function observedTime(value: string, label: string, failures: string[]): bigint | undefined {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    failures.push(`${label} has an invalid observed time`);
    return undefined;
  }
  return BigInt(value);
}

function validateObservedOrder(input: WorkerWitnessInput): string[] {
  const failures: string[] = [];
  let previousEvent: bigint | undefined;
  for (const event of input.runtimeEvents) {
    const current = observedTime(event.observedAt, `runtime ${event.state} event`, failures);
    if (current !== undefined && previousEvent !== undefined && current <= previousEvent) {
      failures.push("runtime event time regressed or repeated");
    }
    if (current !== undefined) previousEvent = current;
  }
  let previousSnapshot: bigint | undefined;
  for (const snapshot of input.inventorySnapshots) {
    const current = observedTime(snapshot.observedAt, "inventory snapshot", failures);
    if (current !== undefined && previousSnapshot !== undefined && current <= previousSnapshot) {
      failures.push("inventory snapshot time regressed or repeated");
    }
    if (current !== undefined) previousSnapshot = current;
  }
  return failures;
}

function validateExpectedWorkers(expectedWorkers: readonly WorkerLink[]): string[] {
  const reasons: string[] = [];
  const correlationIds = new Set<string>();
  const workerNames = new Set<string>();

  for (const worker of expectedWorkers) {
    const missing = missingFields(worker);
    if (missing.length > 0) reasons.push(`expected worker has missing identity fields: ${missing.join(",")}`);
    if (!Number.isSafeInteger(worker.pid) || worker.pid < 1) reasons.push(`invalid pid for worker: ${worker.worker}`);
    if (correlationIds.has(worker.correlationId)) reasons.push(`duplicate correlationId: ${worker.correlationId}`);
    if (workerNames.has(worker.worker)) reasons.push(`duplicate worker: ${worker.worker}`);
    correlationIds.add(worker.correlationId);
    workerNames.add(worker.worker);
  }

  return reasons;
}

function buildLifecycles(
  input: WorkerWitnessInput,
  failures: string[],
  unknowns: string[],
): Lifecycle[] {
  return input.expectedWorkers.map((expected) => {
    const events = input.runtimeEvents.filter(
      (event) => event.link.correlationId === expected.correlationId,
    );

    for (const event of events) {
      const mismatched = mismatchedFields(event.link, expected);
      if (mismatched.length > 0) {
        failures.push(`${expected.worker} ${event.state} event contradicts: ${mismatched.join(",")}`);
      }
    }

    const running = events.filter((event) => event.state === "running");
    const terminal = events.filter((event) => event.state === "terminal");
    if (running.length === 0) unknowns.push(`${expected.worker} has no running event`);
    if (terminal.length === 0) unknowns.push(`${expected.worker} has no terminal event`);
    if (running.length > 1) failures.push(`${expected.worker} has duplicate running events`);
    if (terminal.length > 1) failures.push(`${expected.worker} has duplicate terminal events`);

    const runningAt = running.length === 1
      ? observedTime(running[0]!.observedAt, `${expected.worker} running event`, failures)
      : undefined;
    const terminalAt = terminal.length === 1
      ? observedTime(terminal[0]!.observedAt, `${expected.worker} terminal event`, failures)
      : undefined;
    if (runningAt !== undefined && terminalAt !== undefined && terminalAt <= runningAt) {
      failures.push(`${expected.worker} reaches terminal before it runs`);
    }

    return { expected, runningAt, terminalAt };
  });
}

function snapshotTime(snapshot: InventorySnapshot): bigint | undefined {
  return /^(0|[1-9][0-9]*)$/.test(snapshot.observedAt) ? BigInt(snapshot.observedAt) : undefined;
}

function evaluateIdentity(
  input: WorkerWitnessInput,
  lifecycles: readonly Lifecycle[],
  initialFailures: readonly string[],
  initialUnknowns: readonly string[],
): WitnessCheck {
  const failures = [...initialFailures];
  const unknowns = [...initialUnknowns];

  for (const { expected, runningAt, terminalAt } of lifecycles) {
    let hasIndependentIdentity = false;
    for (const snapshot of input.inventorySnapshots) {
      const time = snapshotTime(snapshot);
      if (time === undefined || runningAt === undefined || terminalAt === undefined || time < runningAt || time >= terminalAt) continue;
      const candidates = snapshot.processes.filter((process) => isCandidate(process.link, expected));
      for (const process of candidates) {
        const missing = missingFields(process.link);
        if (missing.length > 0) {
          unknowns.push(`${expected.worker} inventory identity lacks: ${missing.join(",")}`);
        } else if (linksEqual(process.link, expected)) {
          hasIndependentIdentity = true;
        } else {
          failures.push(`${expected.worker} inventory identity contradicts: ${mismatchedFields(process.link, expected).join(",")}`);
        }
      }
    }
    if (!hasIndependentIdentity) unknowns.push(`${expected.worker} has no matching external inventory identity`);
  }

  if (failures.length > 0) return check("fail", uniqueReasons(failures));
  if (unknowns.length > 0) return check("unknown", uniqueReasons(unknowns));
  return check("pass", ["runtime identities match external inventory"]);
}

function evaluateConcurrency(
  input: WorkerWitnessInput,
  lifecycles: readonly Lifecycle[],
  minimumConcurrentWorkers: number,
  timeFailures: readonly string[],
): WitnessCheck {
  if (timeFailures.length > 0) return check("fail", uniqueReasons(timeFailures));
  if (!Number.isInteger(minimumConcurrentWorkers) || minimumConcurrentWorkers < 2) {
    return check("fail", ["minimumConcurrentWorkers must be an integer of at least 2"]);
  }
  if (lifecycles.length < minimumConcurrentWorkers) {
    return check("unknown", [`only ${lifecycles.length} expected workers are available for concurrency evidence`]);
  }
  if (lifecycles.some((item) => item.runningAt === undefined || item.terminalAt === undefined)) {
    return check("unknown", ["runtime running evidence is incomplete"]);
  }

  const usable = lifecycles.map((item) => ({ ...item, runningAt: item.runningAt!, terminalAt: item.terminalAt! }));
  let completeContradiction = false;
  for (const snapshot of input.inventorySnapshots) {
    const time = snapshotTime(snapshot);
    if (time === undefined) continue;
    const running = usable.filter((item) => time >= item.runningAt && time < item.terminalAt);
    if (running.length < minimumConcurrentWorkers) continue;
    const matching = running.filter((item) =>
      snapshot.processes.some((process) => linksEqual(process.link, item.expected))
    );
    if (matching.length >= minimumConcurrentWorkers) {
      return check("pass", [`${matching.length} Workers are simultaneously running in external inventory`]);
    }
    if (snapshot.complete) completeContradiction = true;
  }

  const boundaries = usable.map((item) => item.runningAt);
  const runtimeOverlap = boundaries.some((time) =>
    usable.filter((item) => time >= item.runningAt && time < item.terminalAt).length >= minimumConcurrentWorkers
  );
  if (!runtimeOverlap) return check("fail", ["Workers were executed serially"]);
  if (completeContradiction) return check("fail", ["complete external inventory contradicts running concurrency"]);
  return check("unknown", ["no external inventory snapshot proves running concurrency"]);
}

function evaluateTermination(
  input: WorkerWitnessInput,
  lifecycles: readonly Lifecycle[],
  timeFailures: readonly string[],
): WitnessCheck {
  const failures = [...timeFailures];
  const unknowns: string[] = [];

  for (const { expected, terminalAt } of lifecycles) {
    if (terminalAt === undefined) {
      unknowns.push(`${expected.worker} has no terminal time`);
      continue;
    }
    const later = input.inventorySnapshots.filter((snapshot) => {
      const time = snapshotTime(snapshot);
      return time !== undefined && time > terminalAt;
    });
    let completeAbsence = false;
    for (const snapshot of later) {
      const candidates = snapshot.processes.filter((process) => isCandidate(process.link, expected));
      for (const process of candidates) {
        if (missingFields(process.link).length > 0) {
          unknowns.push(`${expected.worker} post-terminal inventory identity is incomplete`);
        } else if (linksEqual(process.link, expected)) {
          failures.push(`${expected.worker} process remains after terminal state`);
        } else {
          failures.push(`${expected.worker} identity maps to a different post-terminal process`);
        }
      }
      if (snapshot.complete && candidates.length === 0) completeAbsence = true;
    }
    if (!completeAbsence) unknowns.push(`${expected.worker} has no complete post-terminal external inventory snapshot`);
  }

  if (failures.length > 0) return check("fail", uniqueReasons(failures));
  if (unknowns.length > 0) return check("unknown", uniqueReasons(unknowns));
  return check("pass", ["external inventory proves that all Worker processes terminated"]);
}

export function reconcileWorkerWitness(input: WorkerWitnessInput): WorkerWitnessResult {
  const minimumConcurrentWorkers = input.minimumConcurrentWorkers ?? 2;
  const timeFailures = validateObservedOrder(input);
  const identityFailures = [...validateExpectedWorkers(input.expectedWorkers), ...timeFailures];
  const identityUnknowns: string[] = [];
  if (input.expectedWorkers.length === 0) identityUnknowns.push("expected Worker inventory is empty");
  const lifecycles = buildLifecycles(input, identityFailures, identityUnknowns);
  const identity = evaluateIdentity(input, lifecycles, identityFailures, identityUnknowns);
  const concurrency = evaluateConcurrency(input, lifecycles, minimumConcurrentWorkers, timeFailures);
  const termination = evaluateTermination(input, lifecycles, timeFailures);
  const checks = { identity, concurrency, termination };
  const verdict = overallVerdict(Object.values(checks));
  return {
    verdict,
    checks,
    reasons: uniqueReasons(Object.entries(checks).flatMap(([name, item]) =>
      item.verdict === "pass" ? [] : item.reasons.map((reason) => `${name}: ${reason}`)
    )),
  };
}
