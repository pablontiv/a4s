import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, readFileSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { writeAtomicJson } from "./atomic-json.ts";
import { acquireLock, openLock, withFileLock } from "./file-lock.ts";

interface Observation {
  run: string; sha: string; check: string; cause: string; class: string; action: string;
  decisionRequest?: { id: string; observations: number };
}
interface NoProgress {
  schemaVersion: 1; run: string; fingerprint: string | null; observations: number; observationId: string | null;
  requests: Record<string, { id: string; observations: number }>;
}
export function main(argv: string[]): void {
  const [mode, ...args] = argv;
  if (mode === "now" && !args.length) { console.log(Date.now()); return; }
  if (mode === "remaining" && args.length === 3) {
    const [budget, started, cap] = args.map(Number);
    console.log(Math.max(0, Math.min(cap!, budget! - (Date.now() - started!) / 1000)).toFixed(3));
    return;
  }
  if (mode === "positive" && args.length === 1) { process.exitCode = Number(args[0]) > 0 ? 0 : 1; return; }
  if (mode === "sha256" && !args.length) { console.log(createHash("sha256").update(readFileSync(0)).digest("hex")); return; }
  if (mode === "bounded" && args.length >= 3) {
    const [phase, seconds, command, ...rest] = args;
    const label = phase === "observe" ? "reconcile" : phase;
    const timeout = Number(seconds) * 1000;
    if (!Number.isFinite(timeout)) throw new Error("Invalid reconcile call timeout");
    if (timeout <= 0) { console.error(`${label} deadline exceeded`); process.exitCode = 124; return; }
    const child = spawnSync(command!, rest, { stdio: "inherit", timeout: Math.max(1, Math.ceil(timeout)), killSignal: "SIGKILL" });
    if (child.error && "code" in child.error && child.error.code === "ETIMEDOUT") {
      console.error(`${label} deadline exceeded`); process.exitCode = 124;
    } else if (child.error) throw child.error;
    else process.exitCode = child.status ?? (256 - (constants.signals[child.signal!] ?? 0));
    return;
  }
  if (mode === "ci-no-progress" && args.length === 3) {
    const [root, observationId, rawThreshold] = args;
    const threshold = Number(rawThreshold);
    if (!Number.isInteger(threshold) || threshold < 1) throw new Error("ESCALATION_CI_BLOCKED must be a positive integer");
    withFileLock(join(root!, "ci-no-progress.lock"), () => {
      const file = join(root!, "ci-observation.json");
      const observation: Observation = JSON.parse(readFileSync(file, "utf8"));
      const stateFile = join(root!, "ci-no-progress.json");
      const state: NoProgress = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {
        schemaVersion: 1, run: observation.run, fingerprint: null, observations: 0, observationId: null, requests: {},
      };
      const blocked = observation.class === "BLOCKED" && observation.action === "WAIT";
      // Python json.dumps(..., separators=(",", ":")) escapes non-ASCII; preserve
      // those bytes so an existing run retains its fingerprint across cutover.
      const compact = JSON.stringify([observation.run, observation.sha, observation.check, observation.cause])
        .replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
      const fingerprint = blocked ? createHash("sha256").update(compact).digest("hex") : null;
      if (state.observationId !== observationId || state.fingerprint !== fingerprint) {
        state.observations = fingerprint && state.fingerprint === fingerprint ? state.observations + 1 : Number(blocked);
        state.fingerprint = fingerprint;
        state.observationId = observationId!;
      }
      if (blocked && state.observations >= threshold) {
        observation.decisionRequest = state.requests[fingerprint!] ??= { id: fingerprint!, observations: state.observations };
      }
      writeAtomicJson(stateFile, state);
      writeAtomicJson(file, observation);
    });
    return;
  }
  if (mode === "lock" && args.length) {
    // Match Python's Unicode code-point order, including non-BMP paths: mixed
    // source/compiled lock holders must never acquire the same locks in reverse.
    const paths = [...new Set((process.env.RECONCILE_LOCKS ?? "").split("\n").filter(Boolean))].sort((left, right) => {
      let index = 0;
      while (index < left.length && index < right.length) {
        const a = left.codePointAt(index)!;
        const b = right.codePointAt(index)!;
        if (a !== b) return a - b;
        index += a > 0xffff ? 2 : 1;
      }
      return left.length - right.length;
    });
    const descriptors: number[] = [];
    try {
      for (const path of paths) { const fd = openLock(path); descriptors.push(fd); acquireLock(fd); }
      const child = spawnSync(args[0]!, args.slice(1), { stdio: ["inherit", "inherit", "inherit", ...descriptors] });
      if (child.error) throw child.error;
      process.exitCode = child.status ?? (128 + (constants.signals[child.signal!] ?? 0));
    } finally { for (const fd of descriptors) closeSync(fd); }
    return;
  }
  throw new Error("Usage: a4s reconcile now | remaining <budget-seconds> <started-ms> <cap-seconds> | positive <seconds> | bounded <phase> <seconds> <command> [args...] | sha256 | ci-no-progress <state> <observation-id> <threshold> | lock <command> [args...]");
}
