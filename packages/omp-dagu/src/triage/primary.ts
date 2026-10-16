import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { runParam } from "../status/progress.ts";
import type { RunDetails } from "../status/progress.ts";
import { target } from "./guard.ts";
import type { CallDecision, Event } from "./guard.ts";

export interface SessionContext {
  cwd: string;
  sessionManager: { getSessionDir(): string };
}
const exec = promisify(execFile);
async function mainWorktree(cwd: string): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, "worktree", "list", "--porcelain"]);
  const top = /^worktree (.+)$/m.exec(stdout)?.[1];
  if (!top) throw new Error(`Cannot resolve main worktree for ${cwd}`);
  return realpath(top);
}

// Keep identical to triage_decision's encode_relative and canonical PRIMARY lookup.
export function encodePrimary(primary: string, home: string, tmp: string): string {
  for (const [root, prefix] of [[tmp, "-tmp"], [home, "-"]] as const) {
    if (primary === root) return prefix;
    if (primary.startsWith(`${root}/`)) return `${prefix}${prefix.endsWith("-") ? "" : "-"}${primary.slice(root.length + 1).replace(/[/\\:]/g, "-")}`;
  }
  return `--${primary.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`;
}

export async function primarySessionDecision(event: Event, ctx: SessionContext): Promise<CallDecision> {
  const text = event.toolName === "bash" ? event.input.command : event.toolName === "eval" ? event.input.code : undefined;
  const completion = typeof text === "string" ? target(text) : undefined;
  if (!completion || completion.poc !== "no") return undefined;
  let expected = "the run's PRIMARY";
  try {
    const base = (process.env.DAGU_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
    const response = await fetch(`${base}/api/v1/dag-runs/${encodeURIComponent(completion.dag)}/${encodeURIComponent(completion.run)}`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Dagu HTTP ${response.status}`);
    const body = await response.json() as { dagRunDetails: RunDetails };
    const primary = runParam(body.dagRunDetails, "PRIMARY");
    if (!primary) throw new Error("Run PRIMARY is missing");
    expected = await realpath(primary);
    const [primaryRepo, sessionRepo, home, tmp] = await Promise.all([
      mainWorktree(expected), mainWorktree(ctx.cwd), realpath(homedir()), realpath(process.env.TMPDIR || "/tmp"),
    ]);
    const sessionDir = resolve(ctx.sessionManager.getSessionDir());
    const expectedDir = join(home, ".omp", "agent", "sessions", encodePrimary(expected, home, tmp));
    if (primaryRepo === sessionRepo && (sessionDir === expectedDir || sessionDir.startsWith(`${expectedDir}${sep}`))) return undefined;
    return { block: true, reason: `TRIAGE_PRIMARY_MISMATCH: Expected primary ${expected}. Open the coordinator in that repository with omp -p --cwd '${expected.replace(/'/g, "'\\''")}' or an Orca tab there, then coordinate the run from that session. Session transcript directory ${sessionDir} is not ${expectedDir}, the default-profile transcript namespace that triage_decision verifies.` };
  } catch (error) {
    return { block: true, reason: `TRIAGE_PRIMARY_CHECK_FAILED: Cannot verify session for ${expected}: ${error instanceof Error ? error.message : String(error)}. Open the coordinator in that primary repository (omp -p --cwd <primary> or an Orca tab there) and retry.` };
  }
}
