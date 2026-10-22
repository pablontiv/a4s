import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { bindQualityImplementer, orderReviewModels } from "@a4s/omp-cross-family-review";
import type { ReviewPolicies } from "@a4s/omp-cross-family-review";
import { shellWords } from "../resources.ts";
import { resolveRunPrimary, runParam } from "../status/progress.ts";
import type { CallDecision, Event } from "./guard.ts";
import { verifyJobResult } from "../role-jobs.ts";
import type { Receipt } from "../admission.ts";

interface Model { provider: string; id: string }
interface Models {
  current(): Model | undefined;
  resolve(spec: string): Model | undefined;
  family(model: Model): string;
}
interface Part {
  type: string; text?: string | undefined; id?: string | undefined; name?: string | undefined;
  arguments?: Record<string, unknown> | undefined;
}
interface Message {
  role?: string | undefined; provider?: string | undefined; model?: string | undefined;
  stopReason?: string | undefined; errorMessage?: string | undefined;
  toolName?: string | undefined; toolCallId?: string | undefined; isError?: boolean; content: string | Part[];
}
export interface TranscriptRow {
  type?: string | undefined; id?: string | undefined; timestamp?: string | undefined;
  parentSession?: string | undefined; agent?: string | undefined; task?: string | undefined;
  role?: string | undefined; model?: string | undefined; resolvedModelIsFallback?: boolean; message?: Message | undefined;
}
export interface QualityContext {
  cwd: string;
  sessionManager: { getSessionDir(): string };
  models?: Models;
}
export interface QualityRequest {
  repo: string; worktree: string; run: string; sha: string; iteration: number; attempt: string;
  implementer: string; session: string; implementStartedAt: string;
}
const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    repo: { type: "string" }, run: { type: "string" }, sha: { type: "string" },
    iteration: { type: "integer" }, attempt: { type: "string" },
    role: { type: "string", enum: ["qa", "reviewer"] },
    verdict: { type: "string", enum: ["PASS", "FAIL"] },
    findings: { type: "array", items: { type: "string" } },
  },
  required: ["repo", "run", "sha", "iteration", "attempt", "role", "verdict", "findings"],
  additionalProperties: false,
};
function requireValue(condition: unknown, diagnostic: string): asserts condition {
  if (!condition) throw new Error(diagnostic);
}
function object(value: unknown): Record<string, unknown> {
  requireValue(value && typeof value === "object" && !Array.isArray(value), "expected JSON object");
  return value as Record<string, unknown>;
}
function optionalString(value: unknown): string | undefined {
  requireValue(value === undefined || typeof value === "string", "expected runtime string field");
  return value;
}
function json(path: string): Record<string, unknown> { return object(JSON.parse(readFileSync(path, "utf8"))); }
function rows(path: string, contents = readFileSync(path)): TranscriptRow[] {
  return contents.toString("utf8").split("\n").filter(Boolean).map(line => {
    const row = object(JSON.parse(line));
    let message: Message | undefined;
    if (row.message !== undefined) {
      const raw = object(row.message);
      let content: string | Part[] = "";
      if (typeof raw.content === "string") content = raw.content;
      else if (Array.isArray(raw.content)) content = raw.content.map(item => {
        const part = object(item);
        return { type: optionalString(part.type) ?? "", text: optionalString(part.text),
          id: optionalString(part.id), name: optionalString(part.name),
          arguments: part.arguments === undefined ? undefined : object(part.arguments) };
      });
      message = { role: optionalString(raw.role), provider: optionalString(raw.provider), model: optionalString(raw.model),
        stopReason: optionalString(raw.stopReason), errorMessage: optionalString(raw.errorMessage),
        toolName: optionalString(raw.toolName), toolCallId: optionalString(raw.toolCallId),
        isError: raw.isError === true, content };
    }
    return { type: optionalString(row.type), id: optionalString(row.id), timestamp: optionalString(row.timestamp),
      parentSession: optionalString(row.parentSession), agent: optionalString(row.agent), task: optionalString(row.task),
      role: optionalString(row.role), model: optionalString(row.model), resolvedModelIsFallback: row.resolvedModelIsFallback === true, message };
  });
}
function text(content: string | Part[]): string {
  return typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
}
export function qualityMarker(request: QualityRequest, role: string): string {
  return `FEATURE_QUALITY RUN=${request.run} SHA=${request.sha} ITERATION=${request.iteration} ATTEMPT=${request.attempt} ROLE=${role}`;
}
function identity(row: TranscriptRow, models: Models) {
  const { provider, model: id } = row.message ?? {};
  requireValue(provider && id, "indeterminate effective provider/model");
  const model = models.resolve(`${provider}/${id}`);
  requireValue(model && model.provider === provider && model.id === id, `indeterminate effective model ${provider}/${id}`);
  const family = models.family(model);
  requireValue(typeof family === "string" && family.length > 0, `indeterminate family ${provider}/${id}`);
  return { provider, id, family };
}
function assigned(task: string | undefined, marker: string): boolean {
  if (task === undefined) return false;
  const offset = task.indexOf(marker);
  return offset >= 0 && (offset === 0 || /\s/.test(task[offset - 1]!)) &&
    (offset + marker.length === task.length || /\s/.test(task[offset + marker.length]!));
}
function transcript(parent: string, id: string, marker: string, agent: string | undefined, cutoff: string) {
  requireValue(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id), "invalid subagent id");
  const path = join(parent.slice(0, -6), `${id}.jsonl`);
  requireValue(realpathSync(path) === path, "transcript must be a canonical regular path");
  const contents = readFileSync(path);
  const child = rows(path, contents);
  const sessions = child.filter(row => row.type === "session");
  const inits = child.filter(row => row.type === "session_init");
  const init = inits[0];
  requireValue(sessions.length === 1 && init?.agent && init.task &&
    inits.every(row => row.agent === init.agent && row.task === init.task), "ambiguous session identity");
  const session = sessions[0]!;
  requireValue(session.parentSession === parent && session.id, "wrong parent session");
  requireValue(!agent || init.agent === agent, `wrong agent for ${agent}`);
  requireValue(assigned(init.task, marker), "wrong run, iteration, SHA or role assignment");
  const cutoffTime = /^\d+(?:\.\d+)?$/.test(cutoff) ? Number(cutoff) * 1000 : Date.parse(cutoff);
  requireValue(init.timestamp && Date.parse(init.timestamp) > cutoffTime, "stale invocation");
  requireValue(child.some(row => row.type === "model_change" && row.role === `subagent:${id}`), "subagent id not attributed by runtime");
  const invocations = rows(parent).flatMap(row => {
    const content = row.message?.content;
    if (row.message?.role !== "assistant" || !Array.isArray(content)) return [];
    return content.filter(part => part.type === "toolCall" && part.name === "task").flatMap(call => {
      const tasks = Array.isArray(call.arguments?.tasks) ? call.arguments.tasks : [call.arguments];
      return tasks.map(object).filter(task => task.name === id && (task.agent === undefined ? "task" : task.agent) === init.agent &&
        assigned(`${call.arguments?.context ?? ""}\n${task.task ?? ""}`, marker)).map(() => ({ id: call.id, timestamp: row.timestamp }));
    });
  });
  requireValue(invocations.length === 1 && invocations[0]!.id && invocations[0]!.timestamp, "missing or ambiguous parent task invocation");
  requireValue(Date.parse(invocations[0]!.timestamp) <= Date.parse(init.timestamp), "invocation occurs after child start");
  return { path, contents, child, session: session.id, invocation: invocations[0]!.id };
}
function effective(child: TranscriptRow[], models: Models) {
  const assistants = child.filter((row): row is TranscriptRow & { message: Message } => row.type === "message" && row.message?.role === "assistant");
  const observed = assistants.map(row => ({ event: row.id, timestamp: row.timestamp,
    provider: row.message.provider, model: row.message.model, stopReason: row.message.stopReason, error: row.message.errorMessage,
  }));
  const fallbacks = child.filter(row => row.type === "model_change" && row.resolvedModelIsFallback)
    .map(row => ({ event: row.id, timestamp: row.timestamp, model: row.model, resolvedModelIsFallback: true }));
  const attempts = observed.map((attempt, index) => {
    const row = assistants[index]!;
    if ((!row.message.provider || !row.message.model) && row.message.stopReason === "error") return { ...attempt, family: undefined };
    try { return { ...attempt, family: identity(row, models).family }; }
    catch (error) { throw new Error(`indeterminate identity: ${String(error)}; ${JSON.stringify({ attempts: observed, fallbacks })}`); }
  });
  const successful = assistants.filter(row => row.message.stopReason === "stop" || row.message.stopReason === "toolUse");
  requireValue(successful.length > 0, `exhausted effective responses: ${JSON.stringify({ attempts, fallbacks })}`);
  return { successful, attempts, fallbacks };
}
export function inspectImplementer(parent: string, request: QualityRequest, models: Models) {
  if (/^[a-f0-9]{64}$/.test(request.implementer)) {
    const state = execFileSync("git", ["-C", request.repo, "rev-parse", "--path-format=absolute", "--git-path",
      `dagu-feature/runs/${request.run}`], { encoding: "utf8" }).trim();
    const candidate = json(join(state, "candidate.json"));
    const captured = object(candidate.implementation);
    requireValue(candidate.sha === request.sha && candidate.iteration === request.iteration &&
      candidate.implementer === request.implementer, "stale native implementer candidate");
    const path = join(state, "role-jobs", request.implementer, "result.json");
    requireValue(createHash("sha256").update(readFileSync(path)).digest("hex") === captured.resultDigest,
      "native implementer receipt digest mismatch");
    const result = verifyJobResult(path, { repo: request.repo, worktree: request.worktree, run: request.run,
      lane: "feature", dag: "feature", stage: "implement", sha: String(captured.inputSha) });
    requireValue(result.binding.role === "implement" || result.binding.role === "conflict-resolution",
      "native implementer role mismatch");
    const admission = JSON.parse(readFileSync(join(state, "receipt.json"), "utf8")) as Receipt;
    requireValue(admission.schemaVersion === 1 && admission.runReceipt.dag === "feature" &&
      admission.runReceipt.run === request.run && admission.initial.execution.primary === request.repo &&
      admission.initial.execution.ompSession === request.session &&
      admission.initial.execution.dagSnapshot.includes("dagu-role-jobs stage implement") &&
      admission.runReceipt.observations.some(observation => {
        if (observation.kind !== "role-job" || observation.run !== request.run || observation.dag !== "feature") return false;
        const data = object(observation.data);
        return data.id === result.id && data.state === "completed" && data.result === path;
      }), "native implementer lacks admitted execution observation");
    const native = result.native!;
    const child = rows(native.transcript, readFileSync(native.transcript).subarray(0, native.bytes));
    const inits = child.filter(row => row.type === "session_init");
    requireValue(inits.length > 0 && inits.every(row => row.agent === "task" &&
      assigned(row.task, `Authorized Dagu role job ${result.id}.`) &&
      assigned(row.task, `FEATURE_IMPLEMENT RUN=${request.run}`)), "native implementer assignment mismatch");
    const evidence = effective(child, models);
    const final = evidence.successful.at(-1)!;
    requireValue(final.id === native.event, "native implementer effective response mismatch");
    return { ...identity(final, models), subagent: request.implementer, session: native.session,
      coordinatorSession: parent, event: native.event, receipt: path, receiptDigest: captured.resultDigest,
      transcript: native.transcript, bytes: native.bytes, digest: native.digest,
      attempts: evidence.attempts, fallbacks: evidence.fallbacks };
  }
  const source = transcript(parent, request.implementer, `FEATURE_IMPLEMENT RUN=${request.run}`, undefined, request.implementStartedAt);
  const evidence = effective(source.child, models);
  const final = evidence.successful.at(-1)!;
  requireValue(final.id, "indeterminate implementer response event");
  requireValue(final.message.stopReason === "stop" || (Array.isArray(final.message.content) && final.message.content.some(part => part.name === "yield")), "implementer has not completed");
  return { ...identity(final, models), subagent: request.implementer, session: source.session,
    parentSession: parent, invocation: source.invocation, event: final.id,
    attempts: evidence.attempts, fallbacks: evidence.fallbacks };
}
export function inspectVerdict(parent: string, request: QualityRequest, role: "qa" | "reviewer", id: string, models: Models) {
  const source = transcript(parent, id, qualityMarker(request, role), role === "qa" ? "qa" : "reviewer", request.attempt);
  const evidence = effective(source.child, models);
  let report: Record<string, unknown> | undefined;
  let response: TranscriptRow | undefined;
  for (const row of evidence.successful) {
    const content = row.message.content;
    const yielded = Array.isArray(content) ? content.find(part => part.type === "toolCall" && part.name === "yield") : undefined;
    if (yielded) {
      const result = source.child.find(item => item.message?.role === "toolResult" && item.message.toolCallId === yielded.id && !item.message.isError);
      if (result) { report = yielded.arguments; response = row; }
    } else if (row.message.stopReason === "stop") {
      try { report = object(JSON.parse(text(content))); response = row; } catch { /* A structured yield may precede final prose. */ }
    }
  }
  requireValue(report && response?.id, `missing runtime-authored structured verdict; attempts=${JSON.stringify(evidence.attempts)}`);
  for (const key of ["repo", "run", "sha", "iteration", "attempt"] as const) requireValue(report[key] === request[key], `verdict ${key} mismatch`);
  const verdict = report.verdict;
  requireValue(report.role === role && (verdict === "PASS" || verdict === "FAIL"), "invalid verdict role/content");
  const findings = report.findings;
  requireValue(Array.isArray(findings) && findings.every((item): item is string => typeof item === "string") &&
    (verdict === "PASS" || findings.some(item => item.trim())), "invalid findings");
  const responseIndex = source.child.indexOf(response);
  const shaRead = source.child.some((row, index) => {
    if (index >= responseIndex || row.message?.role !== "toolResult" || row.message.toolName !== "bash" || row.message.isError || !text(row.message.content).includes(request.sha)) return false;
    return source.child.some(call => Array.isArray(call.message?.content) && call.message.content.some(part => {
      if (part.type !== "toolCall" || part.id !== row.message!.toolCallId || part.name !== "bash") return false;
      const command = part.arguments?.command;
      if (typeof command !== "string") return false;
      const explicit = /^git -C (?:"([^"]+)"|'([^']+)'|(\S+)) rev-parse HEAD$/.exec(command);
      const target = explicit?.[1] ?? explicit?.[2] ?? explicit?.[3] ??
        (command === "git rev-parse HEAD" && typeof part.arguments?.cwd === "string" ? part.arguments.cwd : undefined);
      return target !== undefined && realpathSync(target) === request.worktree;
    }));
  });
  requireValue(shaRead, "missing correlated git rev-parse HEAD evidence for candidate SHA");
  return { repo: request.repo, run: request.run, sha: request.sha, iteration: request.iteration, attempt: request.attempt,
    role, verdict, findings, subagent: id, childSession: source.session, parentSession: parent, invocation: source.invocation,
    event: response.id, model: identity(response, models), attempts: evidence.attempts, fallbacks: evidence.fallbacks,
    transcript: source.path, bytes: source.contents.length, digest: createHash("sha256").update(source.contents).digest("hex") };
}
export function verifyQuality(parent: string, request: QualityRequest, qa: string, reviewer: string, models: Models) {
  requireValue(new Set([request.implementer, qa, reviewer]).size === 3, "implementer, QA and reviewer must be distinct subagents");
  const implementer = inspectImplementer(parent, request, models);
  const verdicts = [inspectVerdict(parent, request, "qa", qa, models), inspectVerdict(parent, request, "reviewer", reviewer, models)];
  requireValue(new Set([implementer.session, ...verdicts.map(verdict => verdict.childSession)]).size === 3, "distinct runtime child sessions required");
  for (const verdict of verdicts) requireValue(verdict.model.family !== implementer.family &&
    verdict.attempts.every(attempt => attempt.stopReason === "error" || attempt.family !== implementer.family),
    `same-family effective ${verdict.role}: ${JSON.stringify({ implementer, model: verdict.model, attempts: verdict.attempts, fallbacks: verdict.fallbacks })}`);
  return { ...request, implementer, verdicts, action: verdicts.every(verdict => verdict.verdict === "PASS") ? "complete" : "rewind" };
}
async function load(run: string, ctx: QualityContext, implementer?: string) {
  const base = (process.env.DAGU_URL || `http://127.0.0.1:${process.env.DAGU_PORT || "8080"}`).replace(/\/+$/, "");
  const response = await fetch(`${base}/api/v1/dag-runs/feature/${encodeURIComponent(run)}`, { signal: AbortSignal.timeout(5000) });
  requireValue(response.ok, `Dagu HTTP ${response.status}`);
  const details = object(object(await response.json()).dagRunDetails);
  const params = optionalString(details.params);
  const runDetails = { name: "feature", dagRunId: run, statusLabel: "waiting",
    ...(params === undefined ? {} : { params }),
    ...(details.resolvedPrimary === undefined ? {} : { resolvedPrimary: optionalString(details.resolvedPrimary)! }) };
  const parameter = (name: string) => runParam(runDetails, name);
  const implementation = Array.isArray(details.nodes) ? details.nodes.map(object).filter(node => object(node.step).id === "implement") : [];
  requireValue(implementation.length === 1, "ambiguous implement checkpoint");
  const resolvedPrimary = await resolveRunPrimary(base, runDetails, AbortSignal.timeout(5000));
  requireValue(resolvedPrimary, "Run PRIMARY is missing");
  const primary = realpathSync(resolvedPrimary);
  const state = execFileSync("git", ["-C", primary, "rev-parse", "--path-format=absolute", "--git-path", `dagu-feature/runs/${run}`], { encoding: "utf8" }).trim();
  const raw: Record<string, unknown> = implementer === undefined ? json(join(state, "quality-request.json")) : {
    repo: primary, worktree: join(primary, ".workspace", "worktrees", `issue-${parameter("ISSUE")}`),
    run, sha: "", iteration: 0, attempt: "", implementer, session: parameter("OMP_SESSION_ID"),
    implementStartedAt: implementation[0]!.startedAt,
  };
  for (const key of ["repo", "worktree", "run", "sha", "attempt", "implementer", "session", "implementStartedAt"]) requireValue(typeof raw[key] === "string", `invalid quality request ${key}`);
  requireValue(typeof raw.iteration === "number" && Number.isInteger(raw.iteration), "invalid candidate iteration");
  // Every field consumed below has been checked at this persisted-state boundary.
  const request = raw as unknown as QualityRequest;
  if (implementer === undefined) {
    const candidate = json(join(state, "candidate.json"));
    requireValue(request.repo === primary && request.worktree === join(primary, ".workspace", "worktrees", `issue-${parameter("ISSUE")}`) &&
      request.run === run && request.sha === candidate.sha && request.iteration === candidate.iteration && request.implementer === candidate.implementer, "stale quality request");
    requireValue(request.implementStartedAt === implementation[0]!.startedAt, "implement invocation cutoff mismatch");
  } else {
    requireValue(details.statusLabel === "waiting" && implementation[0]!.statusLabel === "waiting", "implement checkpoint is not Waiting");
  }
  requireValue(request.session === parameter("OMP_SESSION_ID"), "wrong coordinator session");
  const sessionDir = resolve(ctx.sessionManager.getSessionDir());
  const parents = readdirSync(sessionDir).filter(name => name.endsWith(`_${request.session}.jsonl`));
  requireValue(parents.length === 1, "missing or ambiguous coordinator transcript");
  const parent = join(sessionDir, parents[0]!);
  requireValue(rows(parent).some(row => row.type === "session" && row.id === request.session), "parent session identity mismatch");
  requireValue(ctx.models, "canonical ctx.models API unavailable");
  return { request, parent, state, models: ctx.models };
}
interface ImplementCompletion {
  dag: string | undefined;
  run: string | undefined;
  implementer: string | undefined;
  syntax: string | undefined;
}
function literalImplementCompletion(text: string): ImplementCompletion | undefined {
  let syntax: string | undefined;
  const words = shellWords(text, value => { syntax ??= value; });
  for (let i = 0; i < words.length; i++) {
    if (words[i] !== "human-task" || words[i + 1] !== "complete") continue;
    let dag: string | undefined, run: string | undefined, step: string | undefined, implementer: string | undefined;
    let positional = false;
    for (let j = i + 2; j < words.length && words[j] !== ";"; j++) {
      const word = words[j]!;
      if (word === "--") { positional = true; continue; }
      if (positional || !word.startsWith("-")) { dag ??= word; continue; }
      if (word.startsWith("-r") && word.length > 2) {
        run = word.slice(word[2] === "=" ? 3 : 2);
        continue;
      }
      const equals = word.indexOf("=");
      const flag = equals < 0 ? word : word.slice(0, equals);
      if (flag === "--quiet" || flag === "-q" || flag === "--cpu-profile" || flag === "--help" || flag === "-h") continue;
      if (!["--run-id", "-r", "--step", "--input", "--inputs-json", "--config", "-c", "--dagu-home", "--context"].includes(flag)) continue;
      // Quoted input values stay one word; only a positional argument names the DAG.
      const value = equals < 0 ? (words[j + 1] === ";" ? undefined : words[++j]) : word.slice(equals + 1);
      if (flag === "--run-id" || flag === "-r") run = value;
      if (flag === "--step") step = value;
      if (flag === "--input") implementer = /^IMPLEMENTER=([\w.-]+)$/.exec(value ?? "")?.[1] ?? implementer;
    }
    if (step === "implement") return { dag, run: run && /^[\w.-]+$/.test(run) ? run : undefined, implementer, syntax };
  }
  return undefined;
}

function visibleImplementCompletion(text: string): boolean {
  const literal = text.replace(/\\\r?\n/g, "").replace(/["'`]/g, "");
  return /\bhuman-task\b/.test(literal) && /\bcomplete\b/.test(literal) && /\bimplement\b/.test(literal);
}

function evalImplementCompletion(code: string): ImplementCompletion | undefined {
  // Discover JS literals before shell parsing. In particular, # has no comment
  // meaning in the wrapper, and backticks delimit JS templates, not shell expansion.
  const literals: { value: string; template: boolean; escaped: boolean }[] = [];
  let wrapper = "", syntax: string | undefined;
  for (let i = 0; i < code.length;) {
    const char = code[i++]!;
    if (char === "/" && (code[i] === "/" || code[i] === "*")) {
      const line = code[i++] === "/";
      const end = line ? code.indexOf("\n", i) : code.indexOf("*/", i);
      if (end < 0) { if (!line) syntax ??= "unfinished JS comment"; i = code.length; }
      else i = end + (line ? 1 : 2);
      wrapper += " ";
      continue;
    }
    if (char !== "'" && char !== '"' && char !== "`") { wrapper += char; continue; }
    let value = "", closed = false, escaped = false;
    while (i < code.length) {
      const next = code[i++]!;
      if (next === char) { closed = true; break; }
      if (char === "`" && next === "$" && code[i] === "{") syntax ??= "dynamic JS template";
      if (next !== "\\") {
        if (char !== "`" && /[\r\n]/.test(next)) syntax ??= "multiline JS string";
        value += next;
        continue;
      }
      escaped = true;
      const escape = code[i++];
      if (escape === "\n") continue;
      if (escape === "\r") { if (code[i] === "\n") i++; continue; }
      const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "`": "`", "$": "$" };
      if (escape !== undefined && escapes[escape] !== undefined) value += escapes[escape];
      else { syntax ??= "unsupported JS escape"; value += escape ?? ""; }
    }
    if (!closed) syntax ??= "unfinished JS literal";
    literals.push({ value, template: char === "`", escaped });
    wrapper += "@";
  }
  const candidates = literals.map(literal => literalImplementCompletion(literal.value)).filter(value => value !== undefined);
  const visible = visibleImplementCompletion(code) || literals.some(literal => visibleImplementCompletion(literal.value));
  if (!visible && candidates.length === 0) return undefined;
  // Only one static call/tag is inspectable. Extra literals, branches, operators
  // and statements cannot let an inert fresh decoy authorize a different command.
  wrapper = wrapper.trim().replace(/;$/, "").trim();
  wrapper = wrapper.replace(/^(?:const|let|var)\s+[\w$]+\s*=\s*/, "");
  while (wrapper.startsWith("(") && wrapper.endsWith(")")) {
    let depth = 0, encloses = true;
    for (let i = 0; i < wrapper.length - 1; i++) {
      if (wrapper[i] === "(") depth++;
      if (wrapper[i] === ")" && --depth === 0) { encloses = false; break; }
    }
    if (!encloses) break;
    wrapper = wrapper.slice(1, -1).trim();
  }
  const call = /^(?:await\s+)?[\w$]+(?:\.[\w$]+)*\s*\(\s*@\s*\)$/.test(wrapper);
  const tag = /^(?:await\s+)?[\w$]+(?:\.[\w$]+)*\s*@$/.test(wrapper);
  if (literals.length !== 1 || candidates.length !== 1) syntax ??= "one static JS command literal required";
  if (!call && !(tag && literals[0]?.template && !literals[0].escaped)) syntax ??= "unsupported JS command wrapper";
  const candidate = candidates[0];
  return { dag: candidate?.dag, run: candidate?.run, implementer: candidate?.implementer,
    syntax: syntax ?? candidate?.syntax ?? (candidate ? undefined : "uninspectable implement completion") };
}

export async function qualityDecision(
  event: Event,
  ctx: QualityContext,
  readPolicies?: (cwd: string) => ReviewPolicies | Promise<ReviewPolicies>,
): Promise<CallDecision> {
  const rawCommand: unknown = event.toolName === "bash" ? event.input.command : event.toolName === "eval" ? event.input.code : undefined;
  const command = typeof rawCommand === "string" ? rawCommand.replace(/["'`]/g, "") : undefined;
  let implementCompletion = typeof rawCommand === "string"
    ? event.toolName === "eval" ? evalImplementCompletion(rawCommand) : literalImplementCompletion(rawCommand) : undefined;
  if (implementCompletion?.dag && implementCompletion.dag !== "feature" && !implementCompletion.syntax) implementCompletion = undefined;
  else if (!implementCompletion && typeof rawCommand === "string" && event.toolName === "bash" &&
    visibleImplementCompletion(shellWords(rawCommand).join(" "))) {
    implementCompletion = { dag: undefined, run: undefined, implementer: undefined, syntax: "uninspectable implement completion" };
  }
  const completion = command !== undefined && /\bhuman-task\s+complete\b/.test(command) && /--step(?:\s+|=)quality_review\b/.test(command);
  const tasks = event.toolName === "task" ? (Array.isArray(event.input.tasks) ? event.input.tasks.map(object) : [object(event.input)]) : [];
  const assignments = tasks.map(task => `${event.input.context ?? ""}\n${task.task ?? ""}`);
  if (!completion && !implementCompletion && !assignments.some(assignment => assignment.includes("FEATURE_QUALITY RUN="))) return undefined;
  try {
    requireValue(!implementCompletion || (!implementCompletion.syntax && implementCompletion.dag === "feature"),
      `one literal implement completion command required: ${implementCompletion?.syntax ?? "literal feature DAG required"}`);
    if (!completion && !implementCompletion) {
      const bindings: { name: string; model: Model }[] = [];
      const revised = [...tasks];
      for (const [index, task] of tasks.entries()) {
        if (!assignments[index]?.includes("FEATURE_QUALITY RUN=")) continue;
        const assignment = assignments[index]!;
        requireValue(assignment.split("FEATURE_QUALITY RUN=").length === 2, "one quality marker required per assignment");
        const run = /FEATURE_QUALITY RUN=([\w.-]+)/.exec(assignment)?.[1];
        requireValue(run, "literal run id required");
        const { request, parent, models } = await load(run, ctx);
        const role = task.agent === "qa" ? "qa" : task.agent === "reviewer" ? "reviewer" : "invalid";
        requireValue(role !== "invalid" && assigned(assignment, qualityMarker(request, role)), "stale quality assignment or invalid role");
        requireValue(typeof task.name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(task.name), "explicit quality subagent name required");
        requireValue(task.name !== request.implementer && tasks.filter(other => other.name === task.name).length === 1,
          "quality subagent names must be distinct");
        const implementer = inspectImplementer(parent, request, models);
        const effectiveModel = models.resolve(`${implementer.provider}/${implementer.id}`);
        requireValue(effectiveModel && effectiveModel.provider === implementer.provider && effectiveModel.id === implementer.id, "effective implementer catalog identity unavailable");
        requireValue(readPolicies, "native cross-family settings reader required for quality dispatch");
        const policies = await readPolicies(ctx.cwd);
        const policy = Object.hasOwn(policies, role) ? policies[role] : undefined;
        requireValue(policy, `quality agent ${role} requires a configured crossFamilyReview.policies entry`);
        // Keep the independent strict preflight even without the extension.
        // The spawn hook applies these same fallbacks to actual native candidates.
        const eligible = orderReviewModels(["@slow"], policy.fallbackRoles, models,
          [{ label: "effective implementer", model: effectiveModel }]);
        requireValue(eligible.model?.length, eligible.reason ?? "no eligible quality model");
        bindings.push({ name: task.name, model: effectiveModel });
        const contract = [
          "Quality verdict contract: Before inspecting the candidate and before your verdict, run this standalone bash command, with nothing chained and with cwd omitted:",
          `git -C "${request.worktree}" rev-parse HEAD`,
          "Your final message is ONLY one raw JSON object. Preserve these literal repo/run/sha/iteration/attempt/role values from quality-request.json (repo is the canonical primary path). iteration is a number; attempt is a string. Set verdict to PASS or FAIL and findings to a string[] of observed commands/results or actionable findings:",
          JSON.stringify({ repo: request.repo, run: request.run, sha: request.sha, iteration: request.iteration,
            attempt: request.attempt, role, verdict: "PASS", findings: [] }),
        ].join("\n");
        revised[index] = { ...task, task: `${task.task ?? ""}\n\n${contract}`, outputSchema: VERDICT_SCHEMA };
      }
      for (const binding of bindings) bindQualityImplementer(binding.name, binding.model);
      return { input: Array.isArray(event.input.tasks) ? { ...event.input, tasks: revised } : revised[0]! };
    }
    const run = implementCompletion ? implementCompletion.run : /--run-id(?:\s+|=)([\w.-]+)/.exec(command!)?.[1];
    requireValue(run, "literal run id required");
    const implementerId = implementCompletion?.implementer;
    requireValue(!implementCompletion || implementerId, "complete with literal --input IMPLEMENTER=<id>");
    const { request, parent, state, models } = await load(run, ctx, implementerId);
    if (implementCompletion) {
      inspectImplementer(parent, request, models);
      return undefined;
    }
    const qa = /\bQA=([\w.-]+)/.exec(command!)?.[1];
    const reviewer = /\bREVIEW=([\w.-]+)/.exec(command!)?.[1];
    requireValue(qa && reviewer, "complete with literal --input QA=<id> --input REVIEW=<id>");
    const evidence = verifyQuality(parent, request, qa, reviewer, models);
    const temporary = join(state, "quality.json.tmp");
    writeFileSync(temporary, JSON.stringify(evidence) + "\n");
    renameSync(temporary, join(state, "quality.json"));
    return undefined;
  } catch (error) {
    return { block: true, reason: implementCompletion
      ? `IMPLEMENT_BLOCKED: ${error instanceof Error ? error.message : String(error)}; launch a new Implement<issue>v<N> task with FEATURE_IMPLEMENT RUN=<run> after the current implement startedAt; keep Waiting implement`
      : `QUALITY_BLOCKED: ${error instanceof Error ? error.message : String(error)}; local candidate retained` };
  }
}
