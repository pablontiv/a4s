import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PocScopeInput {
  issue: string; question: string; requiredTargets: string[]; authorizedTargets: string[]; basis: string;
}
interface ScopeHistory { run: string; cause: "scope" | "access" }
export interface PocScopeRequest {
  id: string; input: PocScopeInput; history: ScopeHistory[]; threshold: number;
  decisionRequired: boolean; reason: string; requestedAt: string;
}
export interface PocScopeDecision {
  request: string; action: "narrow" | "provide-access" | "defer";
  input: PocScopeInput; actor: string; basis: string; decidedAt: string;
}
const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function save(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try { linkSync(temporary, path); } finally { unlinkSync(temporary); }
}
export function scopeTargets(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(target => typeof target !== "string" || !target.trim())) throw new Error("PoC targets require a JSON string array");
  return [...new Set((value as string[]).map(normalize))].sort();
}
function canonicalInput(input: PocScopeInput): PocScopeInput {
  if (!/^[1-9][0-9]*$/.test(input.issue) || !input.question.trim() || !input.basis.trim()) throw new Error("PoC scope requires ISSUE, QUESTION and evidence-backed SCOPE_BASIS");
  return { issue: input.issue, question: input.question.trim().replace(/\s+/g, " "), requiredTargets: scopeTargets(input.requiredTargets),
    authorizedTargets: scopeTargets(input.authorizedTargets), basis: input.basis.trim().replace(/\s+/g, " ") };
}
function commonDirectory(primary: string): string {
  return execFileSync("git", ["-C", primary, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
}
export function inconclusiveCause(result: string): "scope" | "access" | "other" {
  const value = /^## Inconclusive cause\s*\n\s*(scope|access|other)\s*(?:\n|$)/m.exec(result)?.[1];
  if (!value) throw new Error("INCONCLUSIVE requires ## Inconclusive cause with scope, access or other");
  return value as "scope" | "access" | "other";
}
function historyFor(common: string, issue: string): ScopeHistory[] {
  const root = join(common, "poc", "runs");
  if (!existsSync(root)) return [];
  return readdirSync(root).sort().flatMap(run => {
    const state = join(root, run);
    if (!existsSync(join(state, "issue.number")) || readFileSync(join(state, "issue.number"), "utf8").trim() !== issue ||
        !existsSync(join(state, "verdict")) || readFileSync(join(state, "verdict"), "utf8").trim() !== "INCONCLUSIVE") return [];
    const result = readFileSync(join(state, "result.md"), "utf8");
    const cause = inconclusiveCause(result);
    return cause === "other" ? [] : [{ run, cause }];
  });
}
function requestDirectory(common: string, issue: string, id: string): string {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid PoC scope request identity");
  return join(common, "poc", "scope", issue, id);
}
export function assessPocScope(primary: string, value: PocScopeInput, threshold = 2): PocScopeRequest {
  const input = canonicalInput(value);
  if (!Number.isSafeInteger(threshold) || threshold < 1) throw new Error("ESCALATION_POC_INCONCLUSIVE requires a positive integer");
  const common = commonDirectory(primary);
  const history = historyFor(common, input.issue);
  const missing = input.requiredTargets.filter(target => !input.authorizedTargets.includes(target));
  const reasons = [...(!input.requiredTargets.length ? ["Required targets are not established"] : []),
    ...(missing.length ? [`Required targets lack authorized access: ${missing.join(", ")}`] : []),
    ...(history.length >= threshold ? [`${history.length} scope/access INCONCLUSIVE PoCs require an owner decision`] : [])];
  const binding = { input, history, threshold };
  const id = digest(binding);
  const directory = requestDirectory(common, input.issue, id);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "request.json");
  const request: PocScopeRequest = { id, ...binding, decisionRequired: reasons.length > 0, reason: reasons.join("; "), requestedAt: new Date().toISOString() };
  try { save(path, request); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return JSON.parse(readFileSync(path, "utf8")) as PocScopeRequest;
}
function readRequest(primary: string, issue: string, id: string): { directory: string; request: PocScopeRequest } {
  if (!/^[1-9][0-9]*$/.test(issue)) throw new Error("Invalid PoC issue");
  const common = commonDirectory(primary);
  const directory = requestDirectory(common, issue, id);
  const request = JSON.parse(readFileSync(join(directory, "request.json"), "utf8")) as PocScopeRequest;
  if (request.id !== id || request.input.issue !== issue || digest({ input: request.input, history: request.history, threshold: request.threshold }) !== id ||
      JSON.stringify(historyFor(common, issue)) !== JSON.stringify(request.history)) throw new Error("PoC scope request/history changed; assess again before admission");
  return { directory, request };
}
export function decidePocScope(primary: string, issue: string, id: string, action: PocScopeDecision["action"], value: PocScopeInput, actor: string, basis: string): PocScopeDecision {
  const { directory, request } = readRequest(primary, issue, id);
  if (!["narrow", "provide-access", "defer"].includes(action) || !actor.trim() || !basis.trim()) throw new Error("PoC scope decision requires an action, operator attribution and evidence basis");
  const input = action === "defer" ? request.input : canonicalInput(value);
  if (input.issue !== issue) throw new Error("PoC scope decision issue mismatch");
  if (action !== "defer" && (!input.requiredTargets.length || input.requiredTargets.some(target => !input.authorizedTargets.includes(target)))) throw new Error("PoC scope decision requires reachable authorized targets");
  if (action === "narrow" && (input.question === request.input.question || input.requiredTargets.some(target => !request.input.requiredTargets.includes(target)) ||
      input.authorizedTargets.some(target => !request.input.authorizedTargets.includes(target)))) throw new Error("Narrow must revise the question within the existing authorized route");
  if (action === "provide-access" && (input.question !== request.input.question || JSON.stringify(input.requiredTargets) !== JSON.stringify(request.input.requiredTargets))) throw new Error("Provide-access preserves the reviewed question and required targets");
  const decision: PocScopeDecision = { request: id, action, input, actor, basis, decidedAt: new Date().toISOString() };
  const path = join(directory, "decision.json");
  try { save(path, decision); return decision; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const previous = JSON.parse(readFileSync(path, "utf8")) as PocScopeDecision;
  if (previous.action !== action || JSON.stringify(previous.input) !== JSON.stringify(input) || previous.actor !== actor || previous.basis !== basis) throw new Error("PoC scope request already has a different operator decision");
  return previous;
}
export function approvedPocScope(primary: string, issue: string, id: string): PocScopeInput {
  const { directory, request } = readRequest(primary, issue, id);
  const path = join(directory, "decision.json");
  if (!existsSync(path)) {
    if (request.decisionRequired) throw new Error(`POC_SCOPE_DECISION_REQUIRED request=${id}: ${request.reason}; choose narrow, provide-access or defer`);
    return request.input;
  }
  const decision = JSON.parse(readFileSync(path, "utf8")) as PocScopeDecision;
  if (decision.request !== id || decision.action === "defer") throw new Error(`POC_SCOPE_DEFERRED request=${id}`);
  return canonicalInput(decision.input);
}
export function requirePocScope(primary: string, input: PocScopeInput, requestId?: string, threshold = 2): void {
  const canonical = canonicalInput(input);
  const id = requestId || assessPocScope(primary, canonical, threshold).id;
  const { request } = readRequest(primary, canonical.issue, id);
  if (request.threshold !== threshold) throw new Error("PoC scope policy changed; assess again");
  if (JSON.stringify(approvedPocScope(primary, canonical.issue, id)) !== JSON.stringify(canonical)) throw new Error("PoC admission differs from its reviewed scope/authorization decision");
}
