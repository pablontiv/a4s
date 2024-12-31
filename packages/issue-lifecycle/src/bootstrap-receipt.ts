import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../launcher/src/type-guard.ts";
import { inspectArtifact } from "../../launcher/src/artifact-cache.ts";
import { parseArtifact } from "../../launcher/src/release.ts";
import { readServiceEnvironment } from "../../launcher/src/service-environment.ts";
import { assertArtifactReceipt, assertExecutingArtifact, receiptArtifact, USED_CONTRACTS } from "./artifact-receipt.ts";
import { cancellationState, assertNotCancelled } from "./cancellation.ts";

/** Bootstrap precedes consumer configuration; its authority is its immutable native snapshot. */
export async function bindBootstrapReceipt(): Promise<void> {
  const primary = realpathSync(process.env.PRIMARY || ""), run = process.env.DAG_RUN_ID;
  if (!run || !process.env.A4S_ARTIFACT) throw new Error("Bootstrap receipt requires run and launcher artifact binding");
  const station = readServiceEnvironment(), tuple = parseArtifact(process.env.A4S_ARTIFACT);
  const cached = await inspectArtifact(station.DAGU_HOME, tuple);
  assertExecutingArtifact(tuple);
  const state = cancellationState(primary, run);
  assertNotCancelled(state);
  const response = await fetch(`${station.DAGU_URL}/api/v1/dag-runs/dagu-feature-bootstrap/${encodeURIComponent(run)}/spec`, { signal: AbortSignal.timeout(15_000) });
  const payload: unknown = await response.json();
  if (!response.ok || !isRecord(payload) || typeof payload.spec !== "string") throw new Error("Bootstrap immutable snapshot is unavailable");
  const digest = createHash("sha256").update(payload.spec).digest("hex"), now = new Date().toISOString();
  if (existsSync(join(state, "receipt.json"))) {
    const existing = await receiptArtifact(station.DAGU_HOME, join(state, "receipt.json"));
    const initial = existing.receipt.initial, execution = isRecord(initial) ? initial.execution : undefined, binding = isRecord(initial) ? initial.runtimeAndModels : undefined;
    const runReceipt = existing.receipt.runReceipt;
    if (!isRecord(runReceipt) || runReceipt.dag !== "dagu-feature-bootstrap" || runReceipt.run !== run ||
      !isRecord(execution) || execution.primary !== primary || execution.dagSnapshot !== payload.spec ||
      !isRecord(binding) || !isRecord(binding.station) || binding.station.DAGU_URL !== station.DAGU_URL || binding.station.DAGU_HOME !== station.DAGU_HOME || binding.station.PATH !== station.PATH) throw new Error("Bootstrap existing receipt run/snapshot/station mismatch");
    if (existing.receipt.artifact.digest !== tuple.digest || existing.receipt.artifact.version !== tuple.version || existing.receipt.artifact.commit !== tuple.commit) throw new Error("Bootstrap existing receipt artifact mismatch");
    return;
  }
  const receipt = { schemaVersion: 2, receiptCreatedAt: now, artifact: tuple, artifactSupport: cached.identity.support, contracts: USED_CONTRACTS,
    sourceVersion: { version: tuple.version, commit: tuple.commit, origin: "verified-cache" }, deploymentFingerprint: digest,
    initial: { admittedAt: now, deployment: { bootstrap: { snapshotDigest: digest } }, runtimeAndModels: { daguHome: realpathSync(station.DAGU_HOME), station },
      execution: { primary, dagSnapshot: payload.spec, parameters: [`PRIMARY=${primary}`, `OMP_SESSION_ID=${process.env.OMP_SESSION_ID || ""}`], ompSession: process.env.OMP_SESSION_ID || "" }, eventsAndExternalState: {} },
    runReceipt: { dag: "dagu-feature-bootstrap", run, attempt: 1, observations: [] } };
  assertArtifactReceipt(receipt, join(state, "receipt.json"));
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
