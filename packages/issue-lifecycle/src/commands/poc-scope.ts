import { appendFileSync } from "node:fs";
import { approvedPocScope, assessPocScope, decidePocScope, pocScopeRequest, pocScopeRejection, PocScopeRejection, recordPocScopeRejection, requirePocScope, scopeTargets, type PocScopeDecision, type PocScopeDecisionInput, type PocScopeInput } from "../poc-scope.ts";

const env = process.env;
const primary = env.PRIMARY || ".";
const issue = env.ISSUE || "";
function emit(name: string, value: string): void {
  if (/[\r\n]/.test(value)) throw new Error(`PoC scope output ${name} must be one line`);
  if (env.DAGU_OUTPUT_FILE) appendFileSync(env.DAGU_OUTPUT_FILE, `${name}=${value}\n`);
  console.log(`${name}=${value}`);
}
function input(prefix = ""): PocScopeInput {
  return { issue, question: env[`${prefix}QUESTION`] || "", requiredTargets: scopeTargets(JSON.parse(env[`${prefix}REQUIRED_TARGETS`] || "[]")),
    authorizedTargets: scopeTargets(JSON.parse(env[`${prefix}AUTHORIZED_TARGETS`] || "[]")), basis: env[`${prefix}SCOPE_BASIS`] || "" };
}
function answer(name: string): string | undefined {
  const value = env[name];
  return !value || /^\$\{steps\.[^}]+\}$/.test(value) ? undefined : value;
}
function decisionTargets(name: string): string[] | undefined {
  const value = answer(name);
  if (value === undefined) return undefined;
  try { return scopeTargets(JSON.parse(value)); }
  catch { throw new PocScopeRejection(name, "a JSON string array of nonempty targets", value); }
}
export function main(argv: string[]): void {
try {
  const action = argv[0];
  if (action === "assess") {
    const request = assessPocScope(primary, input(), Number(env.ESCALATION_POC_INCONCLUSIVE || "2"));
    emit("SCOPE_DECISION", request.decisionRequired ? "yes" : "no");
    emit("SCOPE_REQUEST", request.id);
    emit("SCOPE_REASON", request.reason);
    emit("SCOPE_REJECTION", env.RUN ? pocScopeRejection(primary, env.RUN, issue, request.id) : "");
  } else if (action === "decide") {
    const id = env.SCOPE_REQUEST || "";
    const request = pocScopeRequest(primary, issue, id);
    const choice = answer("POC_SCOPE_ACTION");
    if (!choice && request.decisionRequired) throw new PocScopeRejection("POC_SCOPE_DECISION_REQUIRED", ["narrow", "provide-access", "defer"], null);
    if (choice) {
      const value: PocScopeDecisionInput = choice === "defer" ? {} : {
        issue, question: answer("POC_QUESTION"), requiredTargets: decisionTargets("POC_REQUIRED_TARGETS"),
        authorizedTargets: decisionTargets("POC_AUTHORIZED_TARGETS"), basis: answer("POC_SCOPE_BASIS"),
      };
      decidePocScope(primary, issue, id, choice as PocScopeDecision["action"], value, env.USER || "operator", answer("POC_SCOPE_BASIS") || "");
      if (choice === "defer") process.exit(77);
    }
    const approved = approvedPocScope(primary, issue, id);
    emit("POC_QUESTION", approved.question);
    emit("POC_REQUIRED_TARGETS", JSON.stringify(approved.requiredTargets));
    emit("POC_AUTHORIZED_TARGETS", JSON.stringify(approved.authorizedTargets));
    emit("POC_SCOPE_BASIS", approved.basis);
  } else if (action === "require") {
    requirePocScope(primary, input(), env.SCOPE_REQUEST || undefined, Number(env.ESCALATION_POC_INCONCLUSIVE || "2"));
  } else throw new Error("Usage: dagu-poc-scope assess|decide|require");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (argv[0] === "decide" && error instanceof PocScopeRejection) {
    // Persist before Dagu opens the recovery checkpoint and resets step outputs.
    if (env.RUN) recordPocScopeRejection(primary, env.RUN, issue, env.SCOPE_REQUEST || "", error);
    process.exitCode = 23;
  } else process.exitCode = 1;
}
}
