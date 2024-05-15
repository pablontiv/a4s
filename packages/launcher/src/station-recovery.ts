import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assertStationBinding, executableOnPath, executableDigest } from "./station-binding.ts";
import { readServiceEnvironment } from "./service-environment.ts";
import { readRecoveryEvidence, receiptBindingDigest, recoveryEvidencePath } from "./station-recovery-evidence.ts";
import { receiptTuple, restoreArtifact, runReceiptPath } from "./select.ts";
import { isRecord } from "./type-guard.ts";
import { withFileLockAsync } from "./file-lock.ts";
import { EXIT_CODES, writeAtomicJson } from "./runtime.cjs";
import { setTimeout as delay } from "node:timers/promises";
import { parseAllDocuments } from "yaml";

function cancellationCheckpoint(snapshot: string, directory: string, dag: string, nodes: unknown[]): string {
  if (!["feature", "poc"].includes(dag)) throw new Error("Historical DAG has no verified cancellation checkpoint; restore its original station for operator-reviewed continuation");
  const definition = parseAllDocuments(snapshot)[0]?.toJS();
  const original = parseAllDocuments(readFileSync(join(directory, "skills", "issue-execution", `${dag}.yaml`), "utf8"))[0]?.toJS();
  if (!isRecord(definition) || !Array.isArray(definition.steps) || !isRecord(original) || !Array.isArray(original.steps) || definition.shell !== "bash") throw new Error("Historical snapshot has no supported legacy cancellation shell/steps");
  const steps = definition.steps.filter(isRecord), originals = original.steps.filter(isRecord);
  for (const node of nodes) {
    if (!isRecord(node) || node.statusLabel !== "waiting" || !isRecord(node.step)) continue;
    const name = node.step.name;
    const step = steps.find(step => step.id === name);
    if (!step || step.action !== "human.task" || !isRecord(step.with) || !isRecord(step.with.form) || !isRecord(step.with.form.properties) || !isRecord(step.with.form.properties.CANCEL)) continue;
    const gate = steps.find(candidate => candidate.id === `${String(step.id)}_cancellation`);
    const canonical = originals.find(candidate => candidate.id === gate?.id);
    if (!gate || !canonical || !isDeepStrictEqual(gate, canonical) || !isDeepStrictEqual(step, originals.find(candidate => candidate.id === step.id))) continue;
    const successors = steps.filter(candidate => candidate.depends === step.id || Array.isArray(candidate.depends) && candidate.depends.includes(step.id));
    if (successors.length !== 1 || successors[0] !== gate) continue;
    if (nodes.filter(node => isRecord(node) && node.statusLabel === "waiting").length > 1 &&
        (!Array.isArray(gate.env) || !gate.env.some(value => isRecord(value) && value.NATIVE_TERMINAL === "aborted"))) continue;
    return String(step.id);
  }
  throw new Error("Historical run is not at an artifact-verified CANCEL checkpoint with only its effect-free cancellation successor; restore the original station for operator-reviewed continuation");
}

export interface RecoveryDependencies {
  restore?: typeof restoreArtifact;
  fetch?: typeof fetch;
  spawn?: typeof spawnSync;
  lock?: typeof withFileLockAsync;
}
async function observeRun(endpoint: string, dag: string, run: string, request: typeof fetch): Promise<Record<string, unknown>> {
  const response = await request(`${endpoint}/api/v1/dag-runs/${encodeURIComponent(dag)}/${encodeURIComponent(run)}`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Station recovery native observation HTTP ${response.status}; no mutation authorized`);
  const payload: unknown = await response.json();
  const observed = isRecord(payload) ? payload.dagRunDetails : undefined;
  if (!isRecord(observed) || observed.name !== dag || observed.dagRunId !== run || !Array.isArray(observed.nodes)) throw new Error("Station recovery native observation has an invalid DAG/run binding");
  return observed;
}

export async function recoveryContext(primary: string, run: string, restore = restoreArtifact) {
  primary = realpathSync(primary);
  const station = readServiceEnvironment(), path = runReceiptPath(primary, run);
  const receipt: unknown = JSON.parse(readFileSync(path, "utf8"));
  const tuple = receiptTuple(path), cached = await restore(station.DAGU_HOME, tuple);
  if (!isRecord(receipt) || !isRecord(receipt.initial) || !isRecord(receipt.initial.execution) || !isRecord(receipt.initial.runtimeAndModels) || !isRecord(receipt.runReceipt) || receipt.runReceipt.run !== run || receipt.initial.execution.primary !== primary || !["feature", "poc", "discovery", "planning"].includes(String(receipt.runReceipt.dag)) || typeof receipt.initial.execution.dagSnapshot !== "string" || !isDeepStrictEqual(receipt.artifactSupport, cached.identity.support)) throw new Error("Station recovery receipt/cache/primary/run binding is invalid");
  const admitted = receipt.initial.runtimeAndModels.station;
  if (!isRecord(admitted) || typeof admitted.PATH !== "string") throw new Error("Station recovery requires a literal station-bound receipt; identity-bound runs use a4s run");
  for (const field of ["DAGU_URL", "DAGU_HOME"] as const) if (admitted[field] !== station[field]) throw new Error(`Station recovery target ${field} mismatch; restore the original station target`);
  return { primary, run, path, receipt, station, admitted, cached, dag: String(receipt.runReceipt.dag), state: dirname(path) };
}

/** The launcher owns this narrow boundary so old cached engines remain immutable.
 * Only the artifact-verified cancellation gate may resume, never normal work. */
export async function stationRecovery(args: string[], dependencies: RecoveryDependencies = {}): Promise<void> {
  const [action, ...flags] = args;
  const manifest = action === "pin" && flags.length === 6 && flags[4] === "--evidence" ? flags[5] : undefined;
  if (!["pin", "check", "cancel"].includes(action || "") || !(flags.length === 4 || manifest) || flags[0] !== "--primary" || flags[2] !== "--run" || !flags[1] || !flags[3]) throw new Error("Usage: a4s station-recovery pin|check|cancel --primary <primary> --run <run> [pin: --evidence <verified-manifest.json>]");
  const context = await recoveryContext(flags[1], flags[3], dependencies.restore);
  await (dependencies.lock ?? withFileLockAsync)(join(context.state, "station-recovery.lock"), async () => {
    // Re-read under the per-run lock; no other run's state is touched.
    const current = await recoveryContext(context.primary, context.run, dependencies.restore);
    const evidence = readRecoveryEvidence(current.path, current.receipt);
    if (action === "pin") {
      if (evidence) { assertStationBinding(evidence.station, current.station); console.log(JSON.stringify(evidence)); return; }
      if (!manifest) throw new Error("Station recovery pin has no independently verified identity evidence; supply --evidence with a receipt-bound manifest from retained original tool provenance. Matching PATH or current binaries alone cannot recover historical identities");
      const baseline: unknown = JSON.parse(readFileSync(manifest, "utf8"));
      if (!isRecord(baseline) || baseline.schemaVersion !== 1 || baseline.receiptDigest !== receiptBindingDigest(current.receipt) || typeof baseline.verifiedAt !== "string" || typeof baseline.provenance !== "string" || !baseline.provenance.trim()) throw new Error("Station recovery evidence must bind this original receipt and include verifiedAt, independently verified provenance and station identities; ask the operator to restore matching original evidence");
      assertStationBinding(baseline.station, current.station);
      writeAtomicJson(recoveryEvidencePath(current.path), baseline, { exclusive: true });
      console.log(JSON.stringify(baseline));
      return;
    }
    if (!evidence) throw new Error("Station recovery missing receipt-bound tool digest evidence; use station-recovery pin --evidence with independently verified original identities. Without original tool and target evidence, restore the genuine original station; names or PATH membership cannot approve recovery");
    assertStationBinding(evidence.station, current.station);
    if (action === "check") { console.log(JSON.stringify({ compatible: true, run: current.run, receiptDigest: evidence.receiptDigest, evidence: recoveryEvidencePath(current.path) })); return; }
    const dagu = executableOnPath("dagu", current.station.PATH);
    const ledger = join(current.state, "station-recovery-cancellation.json");
    if (existsSync(ledger)) {
      const prior: unknown = JSON.parse(readFileSync(ledger, "utf8"));
      if (!isRecord(prior) || prior.receiptDigest !== evidence.receiptDigest) throw new Error("Station cancellation evidence binding mismatch");
      if (prior.state === "completed") { console.log(JSON.stringify(prior)); return; }
      throw new Error("Station cancellation has an uncertain prior native attempt; inspect retained evidence and native status, do not automatically retry");
    }
    const observed = await observeRun(current.station.DAGU_URL, current.dag, current.run, dependencies.fetch ?? fetch);
    if (observed.statusLabel !== "waiting" || (observed.nodes as unknown[]).some(node => !isRecord(node) || !["succeeded", "failed", "skipped", "aborted", "cancelled", "waiting", "not_started"].includes(String(node.statusLabel)))) throw new Error("Station recovery cancel requires native Waiting with no running/queued/unknown nodes; inspect the original snapshot/status. Active or uncertain historical runs cannot be safely cancelled through this path");
    const initial = current.receipt.initial as Record<string, unknown>;
    const snapshot = String((initial.execution as Record<string, unknown>).dagSnapshot);
    const specResponse = await (dependencies.fetch ?? fetch)(`${current.station.DAGU_URL}/api/v1/dag-runs/${encodeURIComponent(current.dag)}/${encodeURIComponent(current.run)}/spec`, { signal: AbortSignal.timeout(5000) });
    const nativeSpec: unknown = specResponse.ok ? await specResponse.json() : undefined;
    if (!isRecord(nativeSpec) || nativeSpec.spec !== snapshot) throw new Error("Station recovery native snapshot differs from original admission or is unavailable; restore retained matching run evidence before mutation");
    const checkpoint = cancellationCheckpoint(snapshot, current.cached.directory, current.dag, observed.nodes as unknown[]);
    // Immutable legacy shells keep their old PATH. Verify every cancellation-gate
    // tool there too; relocating OMP is harmless because the gate never invokes it.
    for (const tool of ["bash", "git", "jq", "dagu"]) if (executableDigest(executableOnPath(tool, String(current.admitted.PATH))) !== evidence.station.tools[tool]?.sha256) throw new Error(`Station cancellation legacy tool ${tool} cannot be verified on the snapshot search path; restore the pinned bytes there before cancellation`);
    const record = { schemaVersion: 1, receiptDigest: evidence.receiptDigest, run: current.run, dag: current.dag, checkpoint, outcome: "cancelled", nativeExpected: "failed or aborted", at: new Date().toISOString(), state: "prepared", observation: observed };
    const output = current.dag === "poc" ? execFileSync(executableOnPath("git", current.station.PATH), ["-C", current.primary, "rev-parse", "--path-format=absolute", "--git-path", `poc/runs/${current.run}`], { encoding: "utf8", env: { ...process.env, ...current.station } }).trim() : current.state;
    mkdirSync(output, { recursive: true });
    const cancellation = join(output, "cancellation.json");
    // Reverify immediately before the sole native mutation, not merely at pin/check.
    assertStationBinding(evidence.station, readServiceEnvironment());
    writeAtomicJson(ledger, record);
    if (!existsSync(cancellation)) writeAtomicJson(cancellation, record, { exclusive: true });
    const stopped = (dependencies.spawn ?? spawnSync)(dagu, ["human-task", "complete", current.dag, "--run-id", current.run, "--step", checkpoint, "--input", "CANCEL=yes"], { env: { ...process.env, ...current.station }, encoding: "utf8", timeout: 10000 });
    let terminal: Record<string, unknown> | undefined;
    let observationError: string | undefined;
    if (stopped.status === 0 && !stopped.error) {
      const deadline = Date.now() + 10000;
      do {
        try { terminal = await observeRun(current.station.DAGU_URL, current.dag, current.run, dependencies.fetch ?? fetch); observationError = undefined; }
        catch (error) { observationError = error instanceof Error ? error.message : String(error); await delay(100); continue; }
        if (["failed", "aborted"].includes(String(terminal.statusLabel))) break;
        await delay(100);
      } while (Date.now() < deadline);
    }
    const gate = terminal && Array.isArray(terminal.nodes) ? terminal.nodes.find(node => isRecord(node) && isRecord(node.step) && node.step.name === `${checkpoint}_cancellation`) : undefined;
    const cancelled = isRecord(gate) && (terminal?.statusLabel === "failed" && gate.statusLabel === "failed" && gate.error === `exit status ${EXIT_CODES.cancelled}` || terminal?.statusLabel === "aborted" && gate.statusLabel === "aborted");
    const result = { ...record, state: cancelled ? "completed" : "uncertain", terminal, evidenceLocation: output, observationError,
      native: { status: stopped.status, stdout: stopped.stdout?.toString(), stderr: stopped.stderr?.toString(), error: stopped.error?.message } };
    writeAtomicJson(ledger, result);
    if (result.state !== "completed") throw new Error(`Station cancellation uncertain (native=${stopped.status}, observed=${String(terminal?.statusLabel)}, error=${JSON.stringify(observationError ?? stopped.error?.message ?? stopped.stderr?.toString())}); inspect ${ledger}; no automatic retry`);
    console.log(JSON.stringify(result));
  });
}
