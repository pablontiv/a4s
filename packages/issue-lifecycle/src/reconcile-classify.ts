import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { inspectRun, finishRun, type Routed } from "./reconcile-run.ts";
import { invokeRun, RunArtifactScope, type VerifiedRun } from "./run-artifact.ts";
import { isRecord } from "../../launcher/src/type-guard.ts";

type Issue = { number: number; state: string; closed_at?: string | null };

export interface ClassifyDependencies {
  scope?: Pick<RunArtifactScope, "verify" | "locally" | "artifactVerifications">;
  inspect?: typeof inspectRun;
  finish?: typeof finishRun;
  invoke?: typeof invokeRun;
  now?: () => number;
  requestIssues?: (repo: string, page: number, timeout: number) => { status: number | null; stdout: string; stderr?: string };
}

/** Station-wide batching never supplies the implementation of a foreign run. */
export async function classifyRuns(outputsFile: string, dependencies: ClassifyDependencies = {}): Promise<void> {
  const rows: unknown = JSON.parse(process.env.RUNS || "[]");
  if (!Array.isArray(rows)) throw new Error("classify: discovery output is not a JSON array");
  const scope = dependencies.scope ?? new RunArtifactScope();
  const inspect = dependencies.inspect ?? inspectRun, finish = dependencies.finish ?? finishRun;
  const invoke = dependencies.invoke ?? invokeRun, now = dependencies.now ?? Date.now;
  const requestIssues = dependencies.requestIssues ?? ((repo: string, page: number, timeout: number) =>
    spawnSync("gh", ["api", "--method", "GET", "-H", "Accept: application/vnd.github+json", `repos/${repo}/issues?state=all&per_page=100&page=${page}`],
      { encoding: "utf8", timeout, killSignal: "SIGKILL" }));
  const routed: Routed[] = [], children: Record<string, string>[] = [];
  const failures: { run: string; cause: string }[] = [];
  const repositories = new Set<string>();
  let pages = 0, orphans = 0, inProcessActions = 0;
  function fail(run: string, phase: string, error: unknown): void {
    const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ");
    const cause = `artifact unavailable or unsupported; ${phase} rejected: ${detail}`;
    failures.push({ run, cause });
    console.error(`reconcile-failure run=${run} status=1 cause=${cause}`);
  }
  async function action<T>(context: VerifiedRun, phase: "inspect" | "finish", args: () => string[], execute: () => T): Promise<T | string> {
    const local = await scope.locally(context, phase, execute);
    if (local.local) { inProcessActions++; return local.value; }
    const result = await invoke(context.primary, context.receipt.runReceipt.run, ["reconcile", phase, ...args()], { capture: true });
    process.stderr.write(result.stderr);
    if (result.status !== 0) throw new Error(`Run artifact exited with status ${result.status}`);
    return result.stdout.trimEnd();
  }
  for (const value of rows) {
    if (!isRecord(value) || typeof value.RUN !== "string" || !value.RUN || typeof value.PRIMARY !== "string" || !value.PRIMARY) {
      const run = isRecord(value) && typeof value.RUN === "string" && value.RUN || "unknown";
      failures.push({ run, cause: "discovery row missing RUN or PRIMARY" });
      console.error(`reconcile-failure run=${run} status=1 cause=discovery row missing RUN or PRIMARY`);
      continue;
    }
    const row = value as Record<string, string>;
    try {
      const context = await scope.verify(row.PRIMARY!, row.RUN!);
      const inspected = await action(context, "inspect", () => [JSON.stringify(row)], () => inspect(row));
      const item: Routed = typeof inspected === "string" ? JSON.parse(inspected) : inspected;
      routed.push(item);
      if (item.route === "child") children.push({ RUN: row.RUN!, ISSUE: row.ISSUE || "", PRIMARY: row.PRIMARY!,
        BRANCH: row.BRANCH || "", PR_NUMBER: row.PR_NUMBER || "", REPO: item.repo });
      else if (item.route === "issue" && item.repo) repositories.add(item.repo);
    } catch (error) { fail(row.RUN!, "inspect", error); }
  }
  const issues = new Map<string, Issue[]>();
  const budget = Number(process.env.RECONCILE_OBSERVE_TIMEOUT_SECONDS || 20);
  const cap = Number(process.env.RECONCILE_CALL_TIMEOUT_SECONDS || 8);
  for (const repo of [...repositories].sort()) {
    const started = now(), seen = new Set<string>(), collected: Issue[] = [];
    for (let page = 1; page <= 1000; page++) {
      pages++;
      const timeout = Math.min(cap, budget - (now() - started) / 1000) * 1000;
      if (timeout <= 0) { console.error("classify: deadline exhausted before call"); break; }
      if (!Number.isFinite(timeout)) throw new Error("Invalid reconcile call timeout");
      const result = requestIssues(repo, page, Math.max(1, Math.ceil(timeout)));
      process.stderr.write(result.stderr || "");
      if (result.status !== 0) break;
      let batch: unknown;
      try { batch = JSON.parse(result.stdout); } catch { break; }
      if (!Array.isArray(batch)) break;
      if (batch.length) {
        const first = JSON.stringify(isRecord(batch[0]) ? batch[0].number ?? null : null);
        if (seen.has(first)) { console.error(`classify: issue page did not advance for ${repo}`); break; }
        seen.add(first);
        collected.push(...batch as Issue[]);
      }
      if (batch.length < 100) { issues.set(repo, collected); break; }
      if (page === 1000) console.error(`classify: issue pages did not terminate for ${repo}`);
    }
  }
  for (const item of routed) {
    if (item.route === "child") continue;
    const issue = item.route === "issue" ? issues.get(item.repo)?.find(issue => String(issue.number) === item.issue) ?? null : null;
    try {
      // Re-read each receipt before its write action; only cache verification is
      // memoized. A changed/unsupported receipt cannot inherit an earlier check.
      const context = await scope.verify(item.primary, item.run);
      const result = await action(context, "finish", () => [JSON.stringify(item), JSON.stringify(issue)], () => finish(item, issue));
      if (result.startsWith("ORPHAN")) orphans++;
      if (result) console.log(result);
    } catch (error) { fail(item.run, "observation", error); }
  }
  console.error(`reconcile-metric ${JSON.stringify({ phase: "classify", inputRuns: rows.length, prRuns: children.length, actions: 0,
    orphans, failures: failures.length, issueRepos: repositories.size, issuePages: pages,
    artifactVerifications: scope.artifactVerifications, inProcessActions })}`);
  writeFileSync(outputsFile, `children=${JSON.stringify(children)}\nactions=[]\nfailures=${JSON.stringify(failures)}\n`);
}
