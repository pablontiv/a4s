export type WitnessVerdict = "pass" | "fail" | "unknown";

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
  kind: "started" | "terminated";
  observedAt: number;
  link: WorkerLinkEvidence;
}

export interface InventoryProcess {
  link: WorkerLinkEvidence;
}

export interface InventorySnapshot {
  observedAt: number;
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
  startedAt: number | undefined;
  terminatedAt: number | undefined;
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

function isCandidateDuringLifecycle(actual: WorkerLinkEvidence, expected: WorkerLink): boolean {
  return actual.correlationId === expected.correlationId || actual.pid === expected.pid;
}

function isCandidateAfterTermination(actual: WorkerLinkEvidence, expected: WorkerLink): boolean {
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

function validateExpectedWorkers(expectedWorkers: readonly WorkerLink[]): string[] {
  const reasons: string[] = [];
  const correlationIds = new Set<string>();
  const workerNames = new Set<string>();

  for (const worker of expectedWorkers) {
    const missing = missingFields(worker);
    if (missing.length > 0) {
      reasons.push(`expected worker has missing identity fields: ${missing.join(",")}`);
    }
    if (correlationIds.has(worker.correlationId)) {
      reasons.push(`duplicate correlationId: ${worker.correlationId}`);
    }
    if (workerNames.has(worker.worker)) {
      reasons.push(`duplicate worker: ${worker.worker}`);
    }
    correlationIds.add(worker.correlationId);
    workerNames.add(worker.worker);
  }

  return reasons;
}

function buildLifecycles(
  input: WorkerWitnessInput,
  identityFailures: string[],
  identityUnknowns: string[],
): Lifecycle[] {
  return input.expectedWorkers.map((expected) => {
    const events = input.runtimeEvents.filter(
      (event) => event.link.correlationId === expected.correlationId,
    );

    for (const event of events) {
      const missing = missingFields(event.link);
      if (missing.length > 0) {
        identityUnknowns.push(
          `${expected.worker} ${event.kind} event lacks: ${missing.join(",")}`,
        );
      }
      const mismatched = mismatchedFields(event.link, expected);
      if (mismatched.length > 0) {
        identityFailures.push(
          `${expected.worker} ${event.kind} event contradicts: ${mismatched.join(",")}`,
        );
      }
    }

    const starts = events.filter((event) => event.kind === "started");
    const terminations = events.filter((event) => event.kind === "terminated");
    if (starts.length === 0) identityUnknowns.push(`${expected.worker} has no started event`);
    if (terminations.length === 0) {
      identityUnknowns.push(`${expected.worker} has no terminated event`);
    }
    if (starts.length > 1) identityFailures.push(`${expected.worker} has duplicate started events`);
    if (terminations.length > 1) {
      identityFailures.push(`${expected.worker} has duplicate terminated events`);
    }

    const startedAt = starts.length === 1 ? starts[0]!.observedAt : undefined;
    const terminatedAt = terminations.length === 1 ? terminations[0]!.observedAt : undefined;
    if (startedAt !== undefined && terminatedAt !== undefined && terminatedAt <= startedAt) {
      identityFailures.push(`${expected.worker} terminates before it starts`);
    }

    return { expected, startedAt, terminatedAt };
  });
}

function evaluateIdentity(
  input: WorkerWitnessInput,
  lifecycles: readonly Lifecycle[],
  initialFailures: readonly string[],
  initialUnknowns: readonly string[],
): WitnessCheck {
  const failures = [...initialFailures];
  const unknowns = [...initialUnknowns];

  for (const lifecycle of lifecycles) {
    const { expected, startedAt, terminatedAt } = lifecycle;
    let hasIndependentIdentity = false;

    for (const snapshot of input.inventorySnapshots) {
      const inLifecycle =
        startedAt !== undefined &&
        terminatedAt !== undefined &&
        snapshot.observedAt >= startedAt &&
        snapshot.observedAt < terminatedAt;
      if (!inLifecycle) continue;

      const candidates = snapshot.processes.filter((process) =>
        isCandidateDuringLifecycle(process.link, expected),
      );
      for (const process of candidates) {
        const missing = missingFields(process.link);
        if (missing.length > 0) {
          unknowns.push(
            `${expected.worker} inventory identity lacks: ${missing.join(",")}`,
          );
          continue;
        }
        const mismatched = mismatchedFields(process.link, expected);
        if (mismatched.length > 0) {
          failures.push(
            `${expected.worker} inventory identity contradicts: ${mismatched.join(",")}`,
          );
          continue;
        }
        hasIndependentIdentity = true;
      }
    }

    if (!hasIndependentIdentity) {
      unknowns.push(`${expected.worker} has no matching inventory identity`);
    }
  }

  if (failures.length > 0) return check("fail", uniqueReasons(failures));
  if (unknowns.length > 0) return check("unknown", uniqueReasons(unknowns));
  return check("pass", ["runtime and inventory identities match"]);
}

function evaluateConcurrency(
  input: WorkerWitnessInput,
  lifecycles: readonly Lifecycle[],
  minimumConcurrentWorkers: number,
): WitnessCheck {
  if (!Number.isInteger(minimumConcurrentWorkers) || minimumConcurrentWorkers < 2) {
    return check("fail", ["minimumConcurrentWorkers must be an integer of at least 2"]);
  }
  if (lifecycles.length < minimumConcurrentWorkers) {
    return check("unknown", [
      `only ${lifecycles.length} expected workers are available for concurrency evidence`,
    ]);
  }
  if (lifecycles.some((item) => item.startedAt === undefined || item.terminatedAt === undefined)) {
    return check("unknown", ["runtime lifecycle evidence is incomplete"]);
  }

  const usable = lifecycles.map((item) => ({
    ...item,
    startedAt: item.startedAt!,
    terminatedAt: item.terminatedAt!,
  }));
  let inspectedCompleteOverlap = false;

  for (const snapshot of input.inventorySnapshots) {
    const active = usable.filter(
      (item) => snapshot.observedAt >= item.startedAt && snapshot.observedAt < item.terminatedAt,
    );
    if (active.length < minimumConcurrentWorkers) continue;

    const matching = active.filter((item) =>
      snapshot.processes.some((process) => linksEqual(process.link, item.expected)),
    );
    if (matching.length >= minimumConcurrentWorkers) {
      return check("pass", [
        `${matching.length} workers have independent concurrent inventory evidence`,
      ]);
    }
    const ambiguous = active.filter((item) =>
      snapshot.processes.some(
        (process) =>
          isCandidateDuringLifecycle(process.link, item.expected) &&
          missingFields(process.link).length > 0,
      ),
    );
    if (snapshot.complete && matching.length + ambiguous.length < minimumConcurrentWorkers) {
      inspectedCompleteOverlap = true;
    }
  }

  const overlapExists = usable.some((candidate) => {
    const concurrent = usable.filter(
      (item) =>
        candidate.startedAt >= item.startedAt && candidate.startedAt < item.terminatedAt,
    );
    return concurrent.length >= minimumConcurrentWorkers;
  });
  if (!overlapExists) {
    return check("fail", ["runtime lifecycles do not meet the concurrency requirement"]);
  }
  if (inspectedCompleteOverlap) {
    return check("fail", ["complete inventory contradicts runtime concurrency"]);
  }
  return check("unknown", ["no inventory snapshot proves runtime concurrency"]);
}

function evaluateTermination(
  input: WorkerWitnessInput,
  lifecycles: readonly Lifecycle[],
): WitnessCheck {
  const failures: string[] = [];
  const unknowns: string[] = [];

  for (const lifecycle of lifecycles) {
    const { expected, terminatedAt } = lifecycle;
    if (terminatedAt === undefined) {
      unknowns.push(`${expected.worker} has no termination time`);
      continue;
    }

    const laterSnapshots = input.inventorySnapshots.filter(
      (snapshot) => snapshot.observedAt > terminatedAt,
    );
    let hasCompleteAbsence = false;
    for (const snapshot of laterSnapshots) {
      const candidates = snapshot.processes.filter((process) =>
        isCandidateAfterTermination(process.link, expected),
      );
      for (const process of candidates) {
        const missing = missingFields(process.link);
        if (missing.length > 0) {
          unknowns.push(
            `${expected.worker} post-termination inventory identity lacks: ${missing.join(",")}`,
          );
          continue;
        }
        if (linksEqual(process.link, expected)) {
          failures.push(`${expected.worker} process remains after termination`);
        } else if (process.link.correlationId === expected.correlationId) {
          failures.push(`${expected.worker} correlationId maps to a different process`);
        }
      }

      const hasAmbiguousCandidate = candidates.some(
        (process) => missingFields(process.link).length > 0,
      );
      if (
        snapshot.complete &&
        !hasAmbiguousCandidate &&
        !snapshot.processes.some((process) => linksEqual(process.link, expected))
      ) {
        hasCompleteAbsence = true;
      }
    }
    if (!hasCompleteAbsence) {
      unknowns.push(`${expected.worker} has no complete post-termination inventory snapshot`);
    }
  }

  if (failures.length > 0) return check("fail", uniqueReasons(failures));
  if (unknowns.length > 0) return check("unknown", uniqueReasons(unknowns));
  return check("pass", ["complete inventory proves that all worker processes terminated"]);
}

export function reconcileWorkerWitness(input: WorkerWitnessInput): WorkerWitnessResult {
  const minimumConcurrentWorkers = input.minimumConcurrentWorkers ?? 2;
  const expectedFailures = validateExpectedWorkers(input.expectedWorkers);
  const identityUnknowns: string[] = [];
  if (input.expectedWorkers.length === 0) {
    identityUnknowns.push("expected worker inventory is empty");
  }
  const identityFailures = [...expectedFailures];
  const lifecycles = buildLifecycles(input, identityFailures, identityUnknowns);

  const identity = evaluateIdentity(
    input,
    lifecycles,
    identityFailures,
    identityUnknowns,
  );
  const concurrency = evaluateConcurrency(input, lifecycles, minimumConcurrentWorkers);
  const termination = evaluateTermination(input, lifecycles);
  const checks = { identity, concurrency, termination };
  const verdict = overallVerdict(Object.values(checks));

  return {
    verdict,
    checks,
    reasons: uniqueReasons(
      Object.entries(checks).flatMap(([name, item]) =>
        item.verdict === "pass" ? [] : item.reasons.map((reason) => `${name}: ${reason}`),
      ),
    ),
  };
}
