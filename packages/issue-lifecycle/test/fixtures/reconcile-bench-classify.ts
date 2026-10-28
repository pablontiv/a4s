import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Receipt } from "../../src/admission.ts";
import { USED_CONTRACTS } from "../../src/artifact-receipt.ts";
import type { CachedArtifact } from "../../src/artifact-cache.ts";
import { identity } from "../../src/identity.ts";
import type { ClassifyDependencies } from "../../src/reconcile-classify.ts";
import type { Routed } from "../../src/reconcile-run.ts";
import type { ArtifactTuple } from "../../src/release.ts";
import type { VerifiedRun } from "../../src/run-artifact.ts";

export const tuple: ArtifactTuple = { version: "0.6.1", commit: "a".repeat(40), digest: "b".repeat(64) };
export function cachedArtifact(home: string, artifact = tuple): CachedArtifact {
  const directory = join(home, "cache/a4s", artifact.version);
  return { directory, executable: join(directory, "a4s"), executableDigest: "c".repeat(64),
    identity: { ...identity, version: artifact.version, commit: artifact.commit },
    record: { ...artifact, verifiedAt: "2026-10-25T00:00:00Z" } };
}
export function receipt(primary: string, home: string, run: string, artifact = tuple): Receipt {
  return { schemaVersion: 2, artifact, artifactSupport: identity.support, contracts: USED_CONTRACTS,
    sourceVersion: { version: artifact.version, commit: artifact.commit, origin: "fixture/repo" }, deploymentFingerprint: "fixture",
    initial: { admittedAt: "2026-10-25T00:00:00Z", deployment: { config: { schemaVersion: 1, commit: "d".repeat(40), digest: "e".repeat(64) } },
      runtimeAndModels: { daguHome: home }, execution: { primary, dagSnapshot: "env: []\nsteps: []\n" }, eventsAndExternalState: {} },
    runReceipt: { dag: "feature", run, attempt: 1, observations: [] } };
}
export function context(primary: string, run: string, home = "/fixture/station", artifact = tuple): VerifiedRun {
  const state = join(primary, ".git/dagu-feature/runs", run);
  return { primary, home, state, path: join(state, "receipt.json"), receipt: receipt(primary, home, run, artifact), cached: cachedArtifact(home, artifact) };
}
export function routed(row: Record<string, string>, route = "issue"): Routed {
  return { run: row.RUN!, primary: row.PRIMARY!, issue: row.ISSUE || "", branch: row.BRANCH || "", pr: row.PR_NUMBER || "",
    repo: row.REPO || "example/repo", step: "implement", iteration: 0, class: "PENDING", action: "WAIT", observation: "implement",
    cause: "", route, worktree: join(row.PRIMARY!, ".workspace/worktrees", `issue-${row.ISSUE}`), calls: 1, skipped: 1, started: 0, deadline: 0 };
}
export function classifyFixture(rows: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), "reconcile-bench-unit-"));
  const output = join(root, "outputs");
  const previous = process.env;
  process.env = { ...previous, RUNS: JSON.stringify(rows), RECONCILE_OBSERVE_TIMEOUT_SECONDS: "20", RECONCILE_CALL_TIMEOUT_SECONDS: "8" };
  const verifications: string[] = [];
  const finished: Array<{ item: Routed; issue: { state: string; closed_at?: string | null } | null }> = [];
  const dependencies: ClassifyDependencies = {
    scope: { artifactVerifications: 1, async verify(primary, run) { verifications.push(run); return context(primary, run); },
      async locally(_context, _phase, execute) { return { local: true, value: execute() }; } },
    inspect: row => routed(row),
    finish(item, issue) { finished.push({ item, issue }); return ""; },
    requestIssues() { throw new Error("Unexpected GitHub request"); },
    invoke() { throw new Error("Unexpected artifact process dispatch"); },
  };
  return { root, output, dependencies, verifications, finished,
    outputs() { return Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map(line => { const at = line.indexOf("="); return [line.slice(0, at), JSON.parse(line.slice(at + 1))]; })); },
    dispose() { process.env = previous; rmSync(root, { recursive: true, force: true }); } };
}
