import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { packageRoot } from "./executable.ts";
import { executingRunArtifact, runArtifactState } from "./run-artifact.ts";
import { writeAtomicJson } from "./atomic-json.ts";
import { recordNoProgress } from "./ci-no-progress.ts";

export interface Routed {
  run: string; issue: string; primary: string; branch: string; pr: string; repo: string; step: string; iteration: number;
  class: string; action: string; observation: string; cause: string; route: string; worktree: string;
  calls: number; skipped: number; started: number; deadline: number;
}
export interface ReconcileRunDependencies {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  executingRunArtifact?: typeof executingRunArtifact;
  spawnSync?: (command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) =>
    Pick<SpawnSyncReturns<string>, "status" | "stdout" | "error">;
  runArtifactState?: typeof runArtifactState;
  recordNoProgress?: typeof recordNoProgress;
  error?: (message: string) => void;
}
function requireRun(verified = executingRunArtifact): void {
  if (!verified()) throw new Error("Reconcile run action requires a verified receipt-bound dispatch");
}
export function inspectRun(row: Record<string, string>, dependencies: ReconcileRunDependencies = {}): Routed {
  requireRun(dependencies.executingRunArtifact);
  const env = dependencies.env ?? process.env;
  if (row.RUN !== env.RUN || row.PRIMARY !== env.PRIMARY) throw new Error("Reconcile discovery/receipt identity mismatch");
  const now = dependencies.now ?? Date.now;
  const execute = dependencies.spawnSync ?? spawnSync;
  const started = now();
  const budget = Number(env.RECONCILE_OBSERVE_TIMEOUT_SECONDS || 20);
  const cap = Number(env.RECONCILE_CALL_TIMEOUT_SECONDS || 8);
  let calls = 0, deadline = 0;
  function call(command: string, args: string[]): string {
    calls++;
    const timeout = Math.max(0, Math.min(cap, budget - (now() - started) / 1000)) * 1000;
    if (timeout <= 0) { deadline = 1; return ""; }
    const result = execute(command, args, { encoding: "utf8", timeout: Math.ceil(timeout), killSignal: "SIGKILL" });
    if (result.error && "code" in result.error && result.error.code === "ETIMEDOUT") deadline = 1;
    return result.status === 0 ? result.stdout.trimEnd() : "";
  }
  const primary = env.PRIMARY!, run = env.RUN!;
  let repo = row.REPO || "";
  const skipped = Number(Boolean(repo));
  if (!repo) {
    const origin = execute("git", ["-C", primary, "remote", "get-url", "origin"], { encoding: "utf8" });
    if (origin.status === 0) repo = call("gh", ["repo", "view", origin.stdout.trim(), "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  }
  const status = call("dagu", ["status", "feature", "--run-id", run]);
  const step = /^(?:├─|└─)([A-Za-z0-9_-]+) .*\[waiting\]$/m.exec(status)?.[1] || "";
  const item: Routed = { run, issue: row.ISSUE || "", primary, branch: row.BRANCH || "", pr: row.PR_NUMBER || "", repo,
    step, iteration: Number(/push-back iteration: ([0-9]+)/.exec(status)?.[1] || 0), class: "PENDING", action: "WAIT", observation: step,
    cause: "", route: "issue", worktree: join(primary, ".workspace", "worktrees", `issue-${row.ISSUE}`), calls, skipped, started, deadline };
  if (!repo || !status) Object.assign(item, { class: "BLOCKED", cause: "GitHub observation unavailable; check repository permissions and authentication", observation: "UNAVAILABLE", route: "root" });
  else if (!status.startsWith("Waiting")) Object.assign(item, { action: "NONE", observation: "NOT_WAITING", route: "root" });
  else if (["await_ci", "await_merge"].includes(step)) item.route = "child";
  else if (!step) item.route = "root";
  return item;
}
export function finishRun(item: Routed, issue: { state: string; closed_at?: string | null } | null, dependencies: ReconcileRunDependencies = {}): string {
  requireRun(dependencies.executingRunArtifact);
  const env = dependencies.env ?? process.env;
  if (item.run !== env.RUN || item.primary !== env.PRIMARY) throw new Error("Reconcile routed run/receipt identity mismatch");
  if (item.route === "issue") {
    if (issue) item.observation = `${item.step} issue=${issue.state.toUpperCase()} closed_at=${issue.closed_at || ""}`;
    else Object.assign(item, { class: "BLOCKED", action: "WAIT", cause: "GitHub issue observation unavailable; check repository permissions and authentication", observation: `${item.step} issue=unavailable` });
  }
  // The freshly verified boundary derives this path, never the routed payload.
  const state = (dependencies.runArtifactState ?? runArtifactState)();
  mkdirSync(state, { recursive: true });
  writeAtomicJson(join(state, "ci-observation.json"), { repo: item.repo, run: item.run, pr: "", worktree: item.worktree,
    step: item.step, iteration: item.iteration, sha: "", class: item.class, action: item.action, check: "", log: "", cause: item.cause, retry_run: "", findings: [] });
  (dependencies.recordNoProgress ?? recordNoProgress)(state, env.CI_OBSERVATION_ID!, env.ESCALATION_CI_BLOCKED || "2");
  const error = dependencies.error ?? console.error;
  error(`reconcile-metric ${JSON.stringify({ phase: "observe", run: item.run, class: item.class, action: item.action, calls: item.calls,
    skippedRepoLookup: item.skipped === 1, latencyMs: (dependencies.now ?? Date.now)() - item.started, deadline: item.deadline === 1,
    callTimeoutSeconds: Number(env.RECONCILE_CALL_TIMEOUT_SECONDS || 8), observeTimeoutSeconds: Number(env.RECONCILE_OBSERVE_TIMEOUT_SECONDS || 20) })}`);
  error(`reconcile-metric ${JSON.stringify({ phase: "transition", run: item.run, action: item.action, applied: false, cause: "no-side-effect", calls: 0, latencyMs: 0 })}`);
  return /^(triage|implement) issue=CLOSED /.test(item.observation) ? `ORPHAN ${item.repo}#${item.issue} ${item.run} ${item.observation}` : "";
}
export function executeStep(name: string): void {
  requireRun();
  if (!["observe", "transition"].includes(name)) throw new Error(`Unsupported reconcile step ${name}`);
  const documents = parseAllDocuments(readFileSync(join(packageRoot, "skills", "issue-execution", "reconcile.yaml"), "utf8"));
  const child = documents[1]!.toJS() as { steps: { id: string; run: string }[] };
  const script = child.steps.find(step => step.id === name)!.run;
  const marker = "# Receipt-bound implementation.\n";
  const offset = script.indexOf(marker);
  if (offset < 0) throw new Error("Run artifact lacks its reconcile step implementation");
  const result = spawnSync("bash", ["-euo", "pipefail", "-c", script.slice(offset + marker.length)], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
