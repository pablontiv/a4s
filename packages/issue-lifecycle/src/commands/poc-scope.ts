import { appendFileSync } from "node:fs";
import { approvedPocScope, assessPocScope, decidePocScope, requirePocScope, scopeTargets, type PocScopeDecision, type PocScopeInput } from "../poc-scope.ts";

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
export function main(argv: string[]): void {
try {
  const action = argv[0];
  if (action === "assess") {
    const request = assessPocScope(primary, input(), Number(env.ESCALATION_POC_INCONCLUSIVE || "2"));
    emit("SCOPE_DECISION", request.decisionRequired ? "yes" : "no");
    emit("SCOPE_REQUEST", request.id);
    emit("SCOPE_REASON", request.reason);
  } else if (action === "decide") {
    const id = env.SCOPE_REQUEST || "";
    // Native skipped human tasks leave their optional output bindings unresolved.
    const choice = /^\$\{steps\.[^}]+\}$/.test(env.POC_SCOPE_ACTION || "") ? "" : env.POC_SCOPE_ACTION || "";
    if (choice) {
      decidePocScope(primary, issue, id, choice as PocScopeDecision["action"], input("POC_"), env.USER || "operator", env.POC_SCOPE_BASIS || "");
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
  process.exitCode = 1;
}
}
