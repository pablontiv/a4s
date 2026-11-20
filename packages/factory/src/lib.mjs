// Pure helpers shared by the station wrapper, the T3 CLI shim and the selftest.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
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

/**
 * Enforce the verdict contract: a "pass" must carry evidence for every acceptance criterion.
 * @returns {{verdict:object, reason:string|null}} the verdict (downgraded to "fail" when the proof is missing) and why
 */
export function checkVerdict(v) {
  if (!v || v.verdict !== "pass") return { verdict: v, reason: null };
  let reason = null;
  const c = v.criteria;
  if (!Array.isArray(c) || c.length === 0) reason = "verdict contract: pass without criteria";
  else {
    const bad = c.findIndex((x) => !x || typeof x.evidence !== "string" || !x.evidence.trim());
    if (bad >= 0) reason = `verdict contract: criterion ${bad + 1} has empty evidence`;
    else {
      const nope = c.findIndex((x) => x.result !== "pass");
      if (nope >= 0) reason = `verdict contract: criterion ${nope + 1} result is not pass`;
    }
  }
  if (!reason) return { verdict: v, reason: null };
  return { verdict: { ...v, verdict: "fail", findings: [...(Array.isArray(v.findings) ? v.findings : []), reason] }, reason };
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

/** Typed outcome every attempt ends in. */
export const OUTCOMES = Object.freeze(["pass", "fail", "malformed", "stuck", "timeout", "blocked", "cancelled", "infra"]);

/** What happens after an attempt: the single retry policy table. */
export const POLICY = Object.freeze({
  pass: "stop",
  blocked: "resume", // same thread, with the answer
  fail: "escalate", // next attempt on `escalate_to`
  malformed: "escalate",
  stuck: "escalate",
  timeout: "escalate",
  cancelled: "same-model", // next attempt on `model`
  infra: "reattach", // same thread, no new brief
});

/** Exit code the station returns for each outcome (see station.mjs header). */
export const OUTCOME_EXIT = Object.freeze({
  pass: EXIT.PASS, blocked: EXIT.PASS, fail: EXIT.WORKER_FAIL, stuck: EXIT.WORKER_FAIL, timeout: EXIT.WORKER_FAIL,
  malformed: EXIT.MALFORMED, infra: EXIT.INFRA, cancelled: 143,
});

/** Exit codes Dagu should retry on: those of outcomes whose policy is `escalate`. */
export function retryExitCodes() {
  return [...new Set(OUTCOMES.filter((o) => POLICY[o] === "escalate").map((o) => OUTCOME_EXIT[o]))].sort((x, y) => x - y);
}

/** Silence (no new turn items) after which a producing attempt ends as `stuck`; override: `STALL_SEC` env or limits.json `stallSec`. */
export const STALL_SEC = 1200;
/** Safety cap of one producing attempt (outcome `timeout`); override: `MAX_SEC` env or limits.json `maxSec`. */
export const MAX_SEC = 14400;
/** Default cap an attempt is judged by when it did not record its own (breaker). */
export const STATION_TIMEOUT_SEC = MAX_SEC;

/**
 * Liveness limits: first valid positive number of env (`STALL_SEC`, `MAX_SEC`), then the JSON file
 * (`{"stallSec":N,"maxSec":N}`), then the defaults. An unreadable file or an invalid value is skipped.
 */
export function loadLimits(file, env = process.env) {
  let j = {};
  try { j = JSON.parse(readFileSync(file, "utf8")) ?? {}; } catch { /* absent: defaults */ }
  const pick = (...c) => c.map(Number).find((n) => Number.isFinite(n) && n > 0);
  return { stallSec: pick(env.STALL_SEC, j.stallSec) ?? STALL_SEC, maxSec: pick(env.MAX_SEC, j.maxSec) ?? MAX_SEC };
}

/**
 * Fingerprint (sha1) of a thread's turn items: changes only when a message or tool call is added or changes
 * (`thread.itemCount`, `thread.runCount`, the recent messages). Thread metadata (`updatedAt`, status...) is not activity.
 */
export function activitySig(snap) {
  const t = snap?.thread ?? {};
  return createHash("sha1").update(JSON.stringify({ items: t.itemCount ?? null, runs: t.runCount ?? null, messages: snap?.messages ?? [] })).digest("hex");
}

/** Validate a station state file; an attempt without outcome is in flight, an unknown outcome is an error. */
export function validateState(st) {
  if (!st || typeof st !== "object" || !Array.isArray(st.attempts)) throw new Error("invalid state: attempts must be an array");
  st.attempts.forEach((at, i) => {
    if (at.outcome !== undefined && !OUTCOMES.includes(at.outcome)) throw new Error(`invalid state: attempt ${i + 1} has unknown outcome "${at.outcome}"`);
  });
  return st;
}

/**
 * Decide the next attempt from the previous outcome only (never from the attempt count).
 * Returns {kind:"stop"|"await", attempt} | {kind:"new", model} | {kind:"resume", threadId} (send the answer) | {kind:"reattach", threadId}.
 */
export function planNext(line, st, { answer } = {}) {
  const prev = st.attempts.at(-1);
  if (!prev) return { kind: "new", model: line.model };
  if (prev.outcome === undefined) return { kind: "reattach", threadId: prev.threadId };
  switch (POLICY[prev.outcome]) {
    case "stop": return { kind: "stop", attempt: prev };
    case "resume": return prev.threadId ? (answer ? { kind: "resume", threadId: prev.threadId } : { kind: "await", attempt: prev }) : { kind: "new", model: line.model };
    case "reattach": return prev.threadId ? { kind: "reattach", threadId: prev.threadId, model: prev.model } : { kind: "new", model: line.model };
    case "escalate": return { kind: "new", model: line.escalate_to || line.model };
    default: return { kind: "new", model: line.model }; // same-model
  }
}

/** Outcome of an attempt whose thread ended in a terminal status other than `completed`. */
export function outcomeForStatus(status) {
  return status === "cancelled" ? "cancelled" : "fail";
}

/** Runs an issue gets (admissions since the last human decision) before it goes to `factory:needs-human`. */
export const MAX_RUNS = 3;

/** An outcome is retryable by a new run unless the policy table needs a human answer (`resume`) or it is a pass. */
export const isRetryable = (outcome) => OUTCOMES.includes(outcome) && !["stop", "resume"].includes(POLICY[outcome]);

/** What the issue becomes after a failed run: "ready" (new attempt) or "needs-human". */
export function decideAfterFailure(outcome, runs) {
  return isRetryable(outcome) && runs < MAX_RUNS ? "ready" : "needs-human";
}
