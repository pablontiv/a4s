import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseStallNotice, type StallNotice } from "../long-computation.ts";
import { promisify } from "node:util";
import type { CiDiagnostic } from "./progress.ts";

const exec = promisify(execFile);

async function git(cwd: string, args: string[], signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  // Node 22/24 can turn aborting a failed spawn with no pid into kill(0).
  // Own cancellation so a missing cwd never signals the caller's process group.
  const pending = exec("git", args, { cwd, timeout: 5000 });
  const abort = (): void => {
    if (pending.child.pid !== undefined && pending.child.pid > 0) pending.child.kill();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    return (await pending).stdout.trim();
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export function repositoryName(remote: string, commonDir: string): string {
  const path = remote.trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
  const last = path.split(/[/:]/).at(-1)?.replace(/\.git$/, "");
  return last || basename(dirname(commonDir));
}

export async function resolveRepository(cwd: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    const commonDir = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal);
    let remote = "";
    try { remote = await git(cwd, ["remote", "get-url", "origin"], signal); } catch { /* Local repository. */ }
    return repositoryName(remote, commonDir);
  } catch {
    return undefined;
  }
}

/** Read the reconciler's durable evidence, including a return missed by SSE. */
export async function readCiDiagnostic(primary: string | undefined, run: string, returned: boolean, signal: AbortSignal): Promise<CiDiagnostic | undefined> {
  if (!primary || !/^[A-Za-z0-9_-]+$/.test(run)) return undefined;
  try {
    const file = await git(primary, ["rev-parse", "--path-format=absolute", "--git-path",
      `dagu-feature/runs/${run}/${returned ? "ci-return" : "ci-observation"}.json`], signal);
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!value || typeof value !== "object") return undefined;
    const data = value as Record<string, unknown>;
    if (data.run !== run || !Number.isSafeInteger(data.iteration)
      || !["sha", "class", "check", "log", "cause"].every(key => typeof data[key] === "string")) return undefined;
    if (data.decisionRequest !== undefined) {
      const request = data.decisionRequest as Record<string, unknown> | null;
      if (!request || typeof request.id !== "string" || !Number.isSafeInteger(request.observations)
        || Number(request.observations) < 1) return undefined;
    }
    return data as unknown as CiDiagnostic;
  } catch {
    return undefined;
  }
}

/** Stall notices are appended by the role-job watchdog for the owning session. */
export async function readStallNotices(primary: string | undefined, run: string, signal: AbortSignal): Promise<StallNotice[]> {
  if (!primary || !run || run.length > 200 || /[\s\0/\\]/.test(run)) return [];
  try {
    const root = await git(primary, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal);
    const notices: StallNotice[] = [];
    for (const relative of [`dagu-feature/runs/${run}/stall-notices.jsonl`, `poc/runs/${run}/stall-notices.jsonl`]) {
      try {
        const text = await readFile(join(root, relative), "utf8");
        for (const line of text.split("\n")) {
          if (!line) continue;
          try {
            const notice = parseStallNotice(JSON.parse(line));
            if (notice) notices.push(notice);
          } catch { /* Ignore a torn final line. */ }
        }
      } catch { /* This run has no stall evidence in that lane. */ }
    }
    return notices;
  } catch {
    return [];
  }
}

/** Active budget evidence is prepared before the native escalation checkpoint opens. */
export async function readEscalationDiagnostic(primary: string | undefined, run: string, signal: AbortSignal): Promise<string | undefined> {
  if (!primary || !/^[A-Za-z0-9_-]+$/.test(run)) return undefined;
  try {
    const root = await git(primary, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal);
    const value = JSON.parse(await readFile(`${root}/dagu-feature/runs/${run}/escalation.json`, "utf8"));
    if (value?.schemaVersion !== 1 || value.run !== run || !value.trigger
      || typeof value.trigger.id !== "string" || !Array.isArray(value.trigger.reasons)
      || !value.trigger.reasons.every((reason: unknown) => typeof reason === "string")
      || !Number.isSafeInteger(value.trigger.iteration) || typeof value.trigger.sha !== "string"
      || !Number.isFinite(value.trigger.elapsedSeconds)) return undefined;
    const latest = value.trigger.latestFindings ?? value.findings;
    const findings = Array.isArray(latest) ? latest.flatMap((finding: unknown) => {
      if (typeof finding === "string") return [finding];
      if (finding && typeof finding === "object" && "text" in finding && typeof finding.text === "string") return [finding.text];
      return [];
    }).slice(-5).join("; ") : "";
    const spend = value.trigger.spend;
    return `escalation=${value.trigger.id} iteration=${value.trigger.iteration} sha=${value.trigger.sha}`
      + ` reasons=${value.trigger.reasons.join("; ")} findings=${findings} elapsedSeconds=${value.trigger.elapsedSeconds}`
      + ` spend=${spend?.state === "unknown" ? `unknown (${typeof spend.cause === "string" ? spend.cause : "attribution unavailable"})` : JSON.stringify(spend ?? { state: "unknown" })}`
      + " options=continue with a renewed budget; change scope or delivery route; stop. Record the decision and its provenance at this checkpoint.";
  } catch {
    return undefined;
  }
}
