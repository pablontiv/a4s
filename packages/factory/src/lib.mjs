// Pure helpers shared by the station wrapper, the T3 CLI shim and the selftest.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Exit codes the station returns to Dagu. */
export const EXIT = Object.freeze({ PASS: 0, WORKER_FAIL: 10, INFRA: 30, MALFORMED: 40 });

/** Thread statuses that mean "no run is active". */
export const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "error", "idle"]);

/** Outputs every station step declares in the DAG (Dagu rejects undeclared and missing ones). */
export const OUTPUT_KEYS = Object.freeze(["result", "thread_id", "model", "question", "commit", "findings", "worktree"]);

/**
 * Resolve the `t3` CLI that matches the version of the server running for `t3Home`.
 * T3 updates delete old version directories, so the path is derived on every call.
 */
export function resolveT3(t3Home, versionsDir = join(homedir(), ".t3", "runtime", "versions")) {
  const runtimeFile = join(t3Home, "userdata", "server-runtime.json");
  if (!existsSync(runtimeFile)) return { error: `no server-runtime.json in ${t3Home}` };
  const info = JSON.parse(readFileSync(runtimeFile, "utf8"));
  const bin = join(versionsDir, info.serverVersion, "t3");
  if (!existsSync(bin)) return { error: `no t3 CLI for server version ${info.serverVersion} at ${bin}` };
  return { bin, origin: info.origin, version: info.serverVersion };
}

/** True when a CLI failure means the T3 server is not reachable (infra), not a worker failure. */
export function isUnreachable(text) {
  return /Could not reach|No running T3 Code server|HTTP 50[23]|ECONNREFUSED|fetch failed/i.test(text);
}

/**
 * Classify one `t3 thread show --json` snapshot.
 * @returns {"waiting"|"idle"|"busy"}
 */
export function threadPhase(thread) {
  if (thread.pendingRequestCount > 0 && !thread.activeRunId) return "waiting";
  const background = thread.pendingBackgroundTasks ?? [];
  if (TERMINAL.has(thread.status) && !thread.activeRunId && background.length === 0) return "idle";
  return "busy";
}

/**
 * Extract the structured verdict: the last line starting with "{" in the last assistant message.
 * @returns {{verdict:string, findings?:unknown[], commit?:string|null, question?:string|null} | null}
 */
export function parseVerdict(text) {
  const line = String(text ?? "").trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
  if (!line) return null;
  try {
    const v = JSON.parse(line.trim());
    return v && ["pass", "fail", "blocked"].includes(v.verdict) ? v : null;
  } catch {
    return null;
  }
}

/** Map a verdict to the station exit code. */
export function exitFor(verdict) {
  if (!verdict) return EXIT.MALFORMED;
  return verdict.verdict === "fail" ? EXIT.WORKER_FAIL : EXIT.PASS;
}

/** Find the pi processes that belong to a T3 thread (T3 sets T3CODE_THREAD_ID in their env). */
export function threadPids(threadId, procDir = "/proc") {
  const pids = [];
  for (const pid of readdirSync(procDir).filter((p) => /^\d+$/.test(p))) {
    try {
      const env = readFileSync(join(procDir, pid, "environ"), "utf8");
      if (env.split("\0").includes(`T3CODE_THREAD_ID=${threadId}`)) pids.push(Number(pid));
    } catch {
      // process exited or not readable
    }
  }
  return pids;
}

/** Cancel a thread by terminating its pi processes. Returns how many were signalled. */
export function killThread(threadId) {
  let n = 0;
  for (const pid of threadPids(threadId)) {
    try { process.kill(pid, "SIGTERM"); n++; } catch { /* already gone */ }
  }
  return n;
}
