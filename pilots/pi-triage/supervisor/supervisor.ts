import { createHash } from "node:crypto";
import { dirname } from "node:path";
import {
  type DaguExec, type DaguRequest, type JsonObject, type Sandbox,
  DAG, ISSUE, RUN_ID, STEP, TOKEN, checkSandbox, execDagu, inside, loadSandbox, object, readArtifact, requestDagu,
} from "./sandbox.ts";

export const DECISIONS = ["APPROVE", "REJECT"] as const;
type Decision = typeof DECISIONS[number];
type Confirm = (message: string, signal: AbortSignal) => Promise<boolean>;
type Choose = (title: string, options: string[], signal: AbortSignal) => Promise<string | undefined>;
/** Button labels for the one-click decision dialog. Only an exact match decides. */
export const CHOICES = { APPROVE: "Aprobar", REJECT: "Rechazar", LATER: "Después" } as const;
const DECISION_BY_CHOICE = new Map<string | undefined, Decision>([[CHOICES.APPROVE, "APPROVE"], [CHOICES.REJECT, "REJECT"]]);
const RUN_STATUSES = ["not_started", "running", "failed", "aborted", "succeeded", "queued", "partially_succeeded", "waiting", "rejected"] as const;
const STEP_STATUSES = [...RUN_STATUSES, "skipped", "retrying"] as const;
const RFC3339 = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;
const readTimeout = 5_000;
const confirmTimeout = 60_000;
const chooseTimeout = 15 * 60_000;

interface Triage {
  schemaVersion: 1;
  issue: typeof ISSUE;
  runId: string;
  poc: "yes";
  question: string;
  reason: string;
}

interface Verdict { schemaVersion: 1; runId: string; decision: Decision }
interface Snapshot {
  dag: typeof DAG;
  issue: typeof ISSUE;
  runId: string;
  runStatus: typeof RUN_STATUSES[number];
  decideStatus: typeof STEP_STATUSES[number] | null;
  decideStartedAt: string | null;
  phase: "waiting_for_evidence" | "awaiting_decision" | "resolved" | "inactive";
  triage: Triage | null;
  verdict: Verdict | null;
  token: string | null;
}

type Outcome = { outcome: string; runId: string; message?: string; snapshot?: Snapshot; queued?: boolean; decidedBy?: "operator-click" };

function member<T extends string>(list: readonly T[], value: JsonObject[string]): value is T {
  return list.some(item => item === value);
}

function matches(pattern: string, value: string): boolean {
  return new RegExp(pattern).exec(value)?.[0] === value;
}

function checkRunId(runId: string): void {
  if (!matches(RUN_ID, runId)) throw new Error("runId inválido: solo IDs concretos con prefijo pi-slice-.");
}

function parameters(sandbox: Sandbox): string[] {
  return [`ISSUE=${ISSUE}`, `WORKER_ENTRY=${sandbox.workerEntry}`, `STATE_ROOT=${sandbox.stateRoot}`];
}

// Dagu 2.26.0 joins the named runtime parameters with spaces. Match exactly
// the configured values without splitting inside paths that contain spaces.
function matchesParams(params: string, expected: string[]): boolean {
  if (expected.length === 1) return params === expected[0];
  return expected.some((item, i) => params.startsWith(`${item} `) &&
    matchesParams(params.slice(item.length + 1), expected.filter((_, j) => i !== j)));
}

function parsePayload(body: string, label: string): JsonObject {
  let payload: unknown;
  try { payload = JSON.parse(body); }
  catch { throw new Error(`${label}: Dagu no devolvió JSON válido.`); }
  if (!object(payload)) throw new Error(`${label}: Dagu no devolvió un objeto JSON.`);
  return payload;
}

function nonemptyText(value: JsonObject[string]): value is string {
  return typeof value === "string" && value.length <= 2000 && value.trim().length > 0 &&
    !/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value);
}

function evidence(sandbox: Sandbox, runId: string): { triage: Triage | null; verdict: Verdict | null } {
  const triage = readArtifact(sandbox, runId, "triage.json");
  const verdict = readArtifact(sandbox, runId, "decision.json");
  let validTriage: Triage | null = null;
  let validVerdict: Verdict | null = null;
  if (triage) {
    const { question, reason } = triage;
    if (triage.schemaVersion !== 1 || triage.issue !== ISSUE || triage.runId !== runId || triage.poc !== "yes" ||
      !nonemptyText(question) || !nonemptyText(reason)) {
      throw new Error("triage.json no cumple el contrato del fixture y run consultados.");
    }
    validTriage = { schemaVersion: 1, issue: ISSUE, runId, poc: "yes", question, reason };
  }
  if (verdict) {
    if (verdict.schemaVersion !== 1 || verdict.runId !== runId || !member(DECISIONS, verdict.decision)) {
      throw new Error("decision.json no cumple el contrato del run consultado.");
    }
    validVerdict = { schemaVersion: 1, runId, decision: verdict.decision };
  }
  return { triage: validTriage, verdict: validVerdict };
}

function snapshot(sandbox: Sandbox, runId: string, body: string): Snapshot {
  const { dagRunDetails: run } = parsePayload(body, "Estado");
  if (!object(run) || run.name !== DAG || run.dagRunId !== runId || typeof run.params !== "string" ||
    !matchesParams(run.params, parameters(sandbox)) || typeof run.log !== "string" || !inside(sandbox.daguHome, run.log) ||
    !member(RUN_STATUSES, run.statusLabel) || !Array.isArray(run.nodes)) {
    throw new Error("El estado REST no corresponde al DAG/run/fixture del sandbox configurado.");
  }
  const nodes = run.nodes.filter((node): node is JsonObject => object(node) && object(node.step) && node.step.name === STEP);
  if (nodes.length > 1) throw new Error("Dagu devolvió más de un paso decide.");
  const node = nodes[0];
  const step = node?.step;
  const status = node?.statusLabel;
  if (node && (!member(STEP_STATUSES, status) || !object(step) || (step.id !== undefined && step.id !== STEP))) {
    throw new Error("El paso decide no coincide con el contrato del piloto.");
  }
  const startedAt = typeof node?.startedAt === "string" && RFC3339.test(node.startedAt) && Number.isFinite(Date.parse(node.startedAt))
    ? node.startedAt : null;
  const { triage, verdict } = evidence(sandbox, runId);
  const task = object(step) && step.humanTask;
  const open = run.statusLabel === "waiting" && status === "waiting" && startedAt !== null && node?.retryCount === 0 && object(task) && task.pushBack === undefined;
  const phase = verdict || status === "succeeded" ? "resolved" : open ? (triage ? "awaiting_decision" : "waiting_for_evidence") : "inactive";
  const token = phase === "awaiting_decision" && triage
    ? createHash("sha256").update(JSON.stringify([DAG, runId, STEP, startedAt, triage.question, triage.reason])).digest("hex") : null;
  return { dag: DAG, issue: ISSUE, runId, runStatus: run.statusLabel, decideStatus: member(STEP_STATUSES, status) ? status : null,
    decideStartedAt: startedAt, phase, triage, verdict, token };
}

function compare(runId: string, token: string, current: Snapshot | undefined): Outcome | undefined {
  if (current?.phase === "resolved") return { outcome: "already_resolved", runId, snapshot: current };
  if (!current || current.phase !== "awaiting_decision" || current.token !== token) {
    return { outcome: "stale", runId, message: "La espera revisada ya no es válida. Consulta factory_status; no se completó decide." };
  }
}

function deadline(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function createSupervisor(configPath: string | undefined, { execute = execDagu, request = requestDagu }: {
  execute?: DaguExec; request?: DaguRequest;
} = {}) {
  const busy = new Set<string>();
  const runUrl = (sandbox: Sandbox, runId: string) => new URL(`/api/v1/dag-runs/${DAG}/${runId}`, sandbox.origin);

  async function observe(sandbox: Sandbox, runId: string, signal?: AbortSignal): Promise<Snapshot | undefined> {
    checkSandbox(sandbox);
    signal?.throwIfAborted();
    let reply: Awaited<ReturnType<DaguRequest>>;
    try { reply = await request(runUrl(sandbox, runId), { method: "GET", signal: deadline(readTimeout, signal) }); }
    catch { throw new Error("No se pudo consultar el Dagu del sandbox; la lectura no autoriza ninguna acción."); }
    if (reply.status === 404) return undefined;
    if (reply.status !== 200) throw new Error(`La consulta a Dagu falló (HTTP ${reply.status}).`);
    return snapshot(sandbox, runId, reply.body);
  }

  const missing = (runId: string): Outcome => ({ outcome: "not_found", runId });
  const readOnly = (runId: string): Outcome => ({ outcome: "read_only", runId, message: "Este perfil solo permite factory_status." });

  async function exclusive(runId: string, action: () => Promise<Outcome>): Promise<Outcome> {
    if (busy.has(runId)) return { outcome: "busy", runId };
    busy.add(runId);
    try { return await action(); }
    finally { busy.delete(runId); }
  }

  const api = {
    async start(runId: string, signal?: AbortSignal): Promise<Outcome> {
      checkRunId(runId);
      const sandbox = loadSandbox(configPath);
      if (sandbox.access === "observe") return readOnly(runId);
      return exclusive(runId, async () => {
        const current = await observe(sandbox, runId, signal);
        if (current) return { outcome: "already_exists", runId, snapshot: current };
        const opts = { cwd: sandbox.daguHome, env: sandbox.env, signal };
        const version = await execute(sandbox.daguBin, ["version"], { ...opts, timeout: 5_000 });
        if (version.stdout.trim() !== "2.26.0") throw new Error("El piloto solo admite Dagu 2.26.0.");
        signal?.throwIfAborted();
        checkSandbox(sandbox);
        try {
          await execute(sandbox.daguBin, ["start", "--context", "local", "--dagu-home", sandbox.daguHome,
            "--config", sandbox.daguConfig, "--run-id", runId, "--name", DAG, sandbox.dagFile, "--", ...parameters(sandbox)],
          { ...opts, cwd: dirname(sandbox.dagFile), timeout: 165_000 });
        } catch {
          return { outcome: "unconfirmed", runId, message: "Dagu start falló o se interrumpió. Consulta factory_status antes de actuar; no se reintentó." };
        }
        return { outcome: "started", runId, message: "Dagu start terminó sin error. Consulta factory_status para conocer la fase." };
      });
    },

    async status(runId: string, signal?: AbortSignal): Promise<Outcome> {
      checkRunId(runId);
      const current = await observe(loadSandbox(configPath), runId, signal);
      return current ? { outcome: "observed", runId, snapshot: current } : missing(runId);
    },

    async decide(runId: string, decision: Decision, token: string, confirm?: Confirm, signal?: AbortSignal): Promise<Outcome> {
      checkRunId(runId);
      if (!member(DECISIONS, decision) || !matches(TOKEN, token)) throw new Error("Se requiere APPROVE o REJECT y el token exacto de factory_status.");
      const sandbox = loadSandbox(configPath);
      if (sandbox.access === "observe") return readOnly(runId);
      if (!confirm) return { outcome: "denied", runId, message: "Se requiere un diálogo interactivo del operador." };
      return exclusive(runId, async () => {
        const current = await observe(sandbox, runId, signal);
        const blocked = compare(runId, token, current);
        if (blocked) return blocked;
        const uiSignal = deadline(confirmTimeout, signal);
        uiSignal.throwIfAborted();
        let confirmed = false;
        try {
          confirmed = await confirm(`¿Completar ${DAG}/${runId} (${ISSUE}), paso ${STEP}, con DECISION=${decision}?\n` +
            `Espera desde ${current?.decideStartedAt}. Esto registra un veredicto del fixture; no ejecuta la PoC.\n` +
            `Pregunta del fixture: ${JSON.stringify(current?.triage?.question)}\nMotivo del fixture: ${JSON.stringify(current?.triage?.reason)}`, uiSignal);
        } catch { /* A failed UI is not approval. */ }
        if (confirmed !== true || uiSignal.aborted) return { outcome: "denied", runId, message: "Sin confirmación del operador; no se envió POST." };

        // This recheck is not a server-side compare-and-swap. The pilot never
        // rewinds/retries decide, and Dagu arbitrates conflicting completions.
        const fresh = compare(runId, token, await observe(sandbox, runId, signal));
        if (fresh) return fresh;
        signal?.throwIfAborted();
        const url = runUrl(sandbox, runId);
        url.pathname += `/human-tasks/${STEP}/complete`;
        const uncertain = { outcome: "unconfirmed", runId, message: "No se pudo confirmar el resultado del POST. Consulta factory_status; no reenvíes la decisión." };
        try {
          const reply = await request(url, { method: "POST", body: JSON.stringify({ DECISION: decision }), signal: deadline(readTimeout, signal) });
          if (reply.status === 409 || reply.status === 404) {
            const changed = compare(runId, token, await observe(sandbox, runId, signal));
            return changed ?? { outcome: "conflict", runId, message: `Dagu no aceptó completar (HTTP ${reply.status}); no se reintentó.` };
          }
          if (reply.status !== 200) return uncertain;
          const result = parsePayload(reply.body, "Completar");
          if (result.dagName !== DAG || result.dagRunId !== runId || result.stepId !== STEP ||
            typeof result.alreadyCompleted !== "boolean" || typeof result.queued !== "boolean") return uncertain;
          return { outcome: result.alreadyCompleted ? "already_resolved" : "completed", runId, queued: result.queued };
        } catch { return uncertain; }
      });
    },

    // One-click flow: the operator's button press is the authorization, so the
    // model never chooses the decision. decide() still rechecks the token
    // against Dagu before and after, exactly as with the confirmation dialog.
    async request(runId: string, choose?: Choose, signal?: AbortSignal): Promise<Outcome> {
      checkRunId(runId);
      const sandbox = loadSandbox(configPath);
      if (sandbox.access === "observe") return readOnly(runId);
      if (!choose) return { outcome: "denied", runId, message: "Se requiere un diálogo interactivo del operador." };
      const current = await observe(sandbox, runId, signal);
      if (!current) return missing(runId);
      if (current.phase !== "awaiting_decision" || !current.token || !current.triage) return { outcome: "observed", runId, snapshot: current };
      const uiSignal = deadline(chooseTimeout, signal);
      let choice: string | undefined;
      try {
        choice = await choose(`🔴 Decisión pendiente · ${runId} (${ISSUE})\n` +
          `Pregunta: ${current.triage.question}\nMotivo del triage: ${current.triage.reason}\n` +
          `Espera desde ${current.decideStartedAt}. Registra un veredicto del fixture; no ejecuta la PoC.`,
        [CHOICES.APPROVE, CHOICES.REJECT, CHOICES.LATER], uiSignal);
      } catch { /* A failed UI is not a decision. */ }
      const decision = uiSignal.aborted ? undefined : DECISION_BY_CHOICE.get(choice);
      if (!decision) return { outcome: "deferred", runId, message: "El operador dejó la decisión pendiente o no respondió; no se envió POST." };
      return { ...(await api.decide(runId, decision, current.token, async () => true, signal)), decidedBy: "operator-click" };
    },
  };
  return api;
}
