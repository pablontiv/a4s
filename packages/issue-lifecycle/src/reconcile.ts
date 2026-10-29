import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, readFileSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { inspectArtifact, ensureArtifact } from "./artifact-cache.ts";
import { artifactToken, parseArtifact, resolveRelease } from "./release.ts";
import { exampleConfig } from "./config.ts";
import { materializeDag } from "./materialize.ts";
import { inspectRun, finishRun, executeStep } from "./reconcile-run.ts";
import { acquireLock, openLock } from "./file-lock.ts";
import { recordNoProgress } from "./ci-no-progress.ts";
import { classifyRuns } from "./reconcile-classify.ts";
import { observeRequiredCheckPolicy } from "./required-check-policy.ts";

export async function main(argv: string[]): Promise<void> {
  const [mode, ...args] = argv;
  if (mode === "cache" && args.length === 2 && args[0] === "--release") {
    if (!/^a4s@v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(args[1]!)) throw new Error("Pinned reconciliation requires an exact release a4s@vX.Y.Z, never a moving ref");
    const release = resolveRelease(args[1]!);
    const cached = await ensureArtifact(process.env.DAGU_HOME || join(homedir(), ".dagu"), release);
    console.log(artifactToken(cached.record));
    return;
  }
  if (mode === "render" && args.length === 2 && args[0] === "--artifact") {
    const tuple = parseArtifact(args[1]);
    const cached = await inspectArtifact(process.env.DAGU_HOME || join(homedir(), ".dagu"), tuple);
    const dag = materializeDag(cached.directory, "reconcile.yaml", exampleConfig(), {
      version: tuple.version, source: artifactToken(tuple), executable: cached.executable,
    }).replace(/^env:\n/gm, `env:\n  - A4S_ARTIFACT: ${JSON.stringify(artifactToken(tuple))}\n`);
    process.stdout.write(dag);
    return;
  }
  if (mode === "classify" && args.length === 1) { await classifyRuns(args[0]!); return; }
  if (mode === "inspect" && args.length === 1) { console.log(JSON.stringify(inspectRun(JSON.parse(args[0]!)))); return; }
  if (mode === "finish" && args.length === 2) { const result = finishRun(JSON.parse(args[0]!), JSON.parse(args[1]!)); if (result) console.log(result); return; }
  if (mode === "step" && args.length === 1) { executeStep(args[0]!); return; }
  if (mode === "required-policy" && args.length === 3) { console.log(JSON.stringify(observeRequiredCheckPolicy(args[0]!, args[1]!, args[2]!))); return; }
  if (mode === "now" && !args.length) { console.log(Date.now()); return; }
  if (mode === "sha256" && !args.length) { console.log(createHash("sha256").update(readFileSync(0)).digest("hex")); return; }
  if (mode === "bounded" && args.length >= 5) {
    const [phase, budget, started, cap, command, ...rest] = args;
    const label = phase === "observe" ? "reconcile" : phase;
    const timeout = Math.min(Number(cap), Number(budget) - (Date.now() - Number(started)) / 1000) * 1000;
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
    recordNoProgress(args[0]!, args[1]!, args[2]!);
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
  throw new Error("Usage: a4s reconcile cache --release a4s@vX.Y.Z | render --artifact <version>@<commit>#<digest> | classify <outputs-file> | inspect <row> | finish <row> <issue> | step observe|transition | required-policy <repo> <pr> <sha> | now | bounded <phase> <budget-seconds> <started-ms> <cap-seconds> <command> [args...] | sha256 | ci-no-progress <state> <observation-id> <threshold> | lock <command> [args...]");
}
