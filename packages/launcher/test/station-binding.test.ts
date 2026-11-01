import assert from "node:assert/strict";
import { execFileSync, type spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { declareService } from "../../issue-lifecycle/test/fixtures/service-environment.ts";
import { roleAdmission } from "../../issue-lifecycle/test/role-job-fixtures.ts";
import { fixtureArtifact } from "../../issue-lifecycle/test/fixtures/artifact.ts";
import { identity } from "../../issue-lifecycle/src/identity.ts";
import { assertArtifactReceipt } from "../../issue-lifecycle/src/artifact-receipt.ts";
import { readServiceEnvironment } from "../src/service-environment.ts";
import { assertStationBinding, stationBinding } from "../src/station-binding.ts";
import { inspectArtifact } from "../src/artifact-cache.ts";
import { stationRecovery, type RecoveryDependencies } from "../src/station-recovery.ts";
import { readRecoveryEvidence, receiptBindingDigest } from "../src/station-recovery-evidence.ts";
import { parse, stringify } from "yaml";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "a4s-station-binding-"));
  const home = join(root, "station"), primary = join(root, "consumer");
  mkdirSync(home); mkdirSync(primary);
  const previous = { ...process.env };
  const selected = declareService(home, "http://127.0.0.1:18765");
  Object.assign(process.env, selected); delete process.env.DAGU_PORT;
  const git = (...args: string[]) => execFileSync("git", ["-C", primary, ...args], { encoding: "utf8" }).trim();
  git("init", "-q"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "initial", "--allow-empty");
  const tuple = fixtureArtifact(home);
  const run = "legacy-path", path = join(primary, ".git", "dagu-feature", "runs", run, "receipt.json");
  const template = parse(readFileSync(new URL("../../issue-lifecycle/skills/issue-execution/feature.yaml", import.meta.url), "utf8"));
  const snapshot = stringify({ shell: "bash", steps: template.steps.filter((step: { id: string }) => ["start_primary_unavailable", "start_primary_unavailable_cancellation"].includes(step.id)) });
  const receipt = roleAdmission(primary, home, run, snapshot, tuple);
  receipt.initial.runtimeAndModels.station = readServiceEnvironment();
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(receipt));
  const manifest = join(root, "independent-manifest.json");
  writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, receiptDigest: receiptBindingDigest(receipt), verifiedAt: new Date().toISOString(), provenance: "Fixture retained original verified tool bytes and original station identity", station: stationBinding() }));
  const declaration = JSON.parse(readFileSync(selected.A4S_SERVICE_ENV!, "utf8"));
  const configure = (changes: Record<string, unknown>) => writeFileSync(selected.A4S_SERVICE_ENV!, JSON.stringify({ ...declaration, ...changes }));
  const args = (action: string) => [action, "--primary", primary, "--run", run];
  const restore: NonNullable<RecoveryDependencies["restore"]> = (station, artifact) => inspectArtifact(station, artifact, { executableIdentity: () => ({ ...identity, commit: artifact.commit }) });
  const recover = (action: string, dependencies: RecoveryDependencies = {}) => stationRecovery([...args(action), ...(action === "pin" ? ["--evidence", manifest] : [])], { restore, lock: async (_path, body) => body(), ...dependencies });
  return { root, home, primary, run, path, receipt, declaration, configure, args, restore, recover,
    dispose() { process.env = previous; rmSync(root, { recursive: true, force: true }); } };
}

test("identity binding survives OMP relocation and harmless PATH additions/removals, but rejects bytes and station retargeting", () => {
  const f = fixture();
  try {
    const admitted = stationBinding();
    assert.equal(JSON.stringify(admitted).includes(f.home), false, "identities contain no literal tool or station paths");
    const relocated = join(f.root, "upgraded-tools"); mkdirSync(relocated);
    copyFileSync(join(f.home, "bin", "omp"), join(relocated, "omp"));
    rmSync(join(f.home, "bin", "omp"));
    const extra = join(f.root, "harmless"); mkdirSync(extra);
    f.configure({ PATH: `${extra}:${relocated}:${f.declaration.PATH}` });
    assertStationBinding(admitted);
    f.configure({ PATH: `${relocated}:${f.declaration.PATH}` });
    assertStationBinding(admitted);
    const moved = join(f.root, "renamed-station"); renameSync(f.home, moved);
    process.env.DAGU_HOME = moved; process.env.A4S_SERVICE_ENV = join(moved, "service-environment.json");
    writeFileSync(process.env.A4S_SERVICE_ENV, JSON.stringify({ ...f.declaration, DAGU_HOME: moved, PATH: `${relocated}:${join(moved, "bin")}` }));
    assertStationBinding(admitted, readServiceEnvironment());
    writeFileSync(join(relocated, "omp"), "#!/bin/sh\nexit 23\n");
    assert.throws(() => assertStationBinding(admitted), /tool omp identity mismatch/);
    const missing = structuredClone(admitted); delete missing.tools.omp;
    assert.throws(() => assertStationBinding(missing), /tool omp has no verified digest/);
    const wrong = structuredClone(admitted); wrong.target.inode = "0";
    assert.throws(() => assertStationBinding(wrong), /target inode/);
  } finally { f.dispose(); }
});

test("legacy recovery retains immutable admission and transition inputs, cancels only its run and is idempotent", async () => {
  const f = fixture();
  try {
    const original = readFileSync(f.path);
    const unrelated = join(dirname(dirname(f.path)), "unrelated"); mkdirSync(unrelated);
    writeFileSync(join(unrelated, "evidence.json"), "unrelated evidence");
    await f.recover("pin");
    const evidence = readRecoveryEvidence(f.path, f.receipt)!;
    assert.equal(evidence.schemaVersion, 1);
    const bin = join(f.root, "host-upgrade"); mkdirSync(bin);
    copyFileSync(join(f.home, "bin", "omp"), join(bin, "omp")); rmSync(join(f.home, "bin", "omp"));
    f.configure({ PATH: `${join(f.root, "harmless")}:${bin}:${f.declaration.PATH}` });
    assertArtifactReceipt(f.receipt, f.path);
    await f.recover("check");
    f.configure({ PATH: `${bin}:${f.declaration.PATH}` });
    let mutations = 0;
    const observation = { name: "feature", dagRunId: f.run, statusLabel: "waiting", params: "ISSUE=845", nodes: [{ statusLabel: "waiting", step: { name: "start_primary_unavailable", params: { input: "retained" } } }] };
    const request: typeof fetch = async input => new Response(JSON.stringify(String(input).endsWith("/spec") ? { spec: f.receipt.initial.execution.dagSnapshot } : { dagRunDetails: { ...observation, statusLabel: mutations ? "aborted" : "waiting", nodes: mutations ? [{ statusLabel: "aborted", step: { name: "start_primary_unavailable_cancellation" } }] : observation.nodes } }));
    const stop = ((file: string, args: string[]) => {
      assert.equal(file, join(f.home, "bin", "dagu"));
      assert.deepEqual(args, ["human-task", "complete", "feature", "--run-id", f.run, "--step", "start_primary_unavailable", "--input", "CANCEL=yes"]);
      mutations++; return { status: 0, signal: null, pid: 1, output: [], stdout: "", stderr: "" };
    }) as unknown as typeof spawnSync;
    await f.recover("cancel", { fetch: request, spawn: stop });
    await f.recover("cancel", { fetch: request, spawn: stop });
    assert.equal(mutations, 1, "repeated recovery does not enqueue normal work, publish, materialize, or complete twice");
    const outcome = JSON.parse(readFileSync(join(dirname(f.path), "station-recovery-cancellation.json"), "utf8"));
    assert.equal(outcome.state, "completed"); assert.equal(outcome.terminal.statusLabel, "aborted");
    assert.deepEqual(outcome.observation, observation);
    assert.equal(outcome.evidenceLocation, dirname(f.path));
    assert.deepEqual(readFileSync(f.path), original);
    assert.deepEqual(readdirSync(unrelated), ["evidence.json"]);
    assert.equal(readFileSync(join(unrelated, "evidence.json"), "utf8"), "unrelated evidence");
    f.receipt.runReceipt.observations.push({ kind: "retained" } as never);
    assert.doesNotThrow(() => readRecoveryEvidence(f.path, f.receipt));
    f.receipt.initial.execution.dagSnapshot += "# changed";
    assert.throws(() => readRecoveryEvidence(f.path, f.receipt), /differs from the original receipt/);
  } finally { f.dispose(); }
});

test("legacy recovery rejects missing identities, changed tools and target or active nodes before mutation", async () => {
  const f = fixture();
  try {
    let writes = 0;
    const spawn = (() => { writes++; throw new Error("unexpected mutation"); }) as typeof spawnSync;
    f.configure({ PATH: `${join(f.root, "harmless")}:${f.declaration.PATH}` });
    await assert.rejects(f.recover("cancel", { spawn }), /missing receipt-bound tool digest/);
    await assert.rejects(stationRecovery(f.args("pin"), { restore: f.restore, lock: async (_path, body) => body(), spawn }), /no independently verified identity evidence/);
    await f.recover("pin"); // Independently retained evidence also supports already-drifted PATH.
    f.configure({ DAGU_URL: "http://127.0.0.1:18766" }); delete process.env.DAGU_URL;
    await assert.rejects(f.recover("cancel", { spawn }), /target DAGU_URL mismatch/);
    f.configure({});
    writeFileSync(join(f.home, "bin", "omp"), "#!/bin/sh\nexit 2\n");
    await assert.rejects(f.recover("cancel", { spawn }), /tool omp identity mismatch/);
    writeFileSync(join(f.home, "bin", "omp"), "#!/bin/sh\nexit 0\n");
    const request: typeof fetch = async () => new Response(JSON.stringify({ dagRunDetails: { name: "feature", dagRunId: f.run, statusLabel: "waiting", nodes: [{ statusLabel: "running" }] } }));
    await assert.rejects(f.recover("cancel", { fetch: request, spawn }), /no running\/queued/);
    for (const statusLabel of ["queued", "unknown"]) {
      const unsafe: typeof fetch = async () => Response.json({ dagRunDetails: { name: "feature", dagRunId: f.run, statusLabel: "waiting", nodes: [{ statusLabel }] } });
      await assert.rejects(f.recover("cancel", { fetch: unsafe, spawn }), /no running\/queued/);
    }
    const changedSpec: typeof fetch = async input => Response.json(String(input).endsWith("/spec") ? { spec: "other snapshot" } : { dagRunDetails: { name: "feature", dagRunId: f.run, statusLabel: "waiting", nodes: [{ statusLabel: "waiting" }] } });
    await assert.rejects(f.recover("cancel", { fetch: changedSpec, spawn }), /native snapshot differs/);
    assert.equal(writes, 0);
    assert.equal(existsSync(join(dirname(f.path), "cancellation.json")), false);
  } finally { f.dispose(); }
});
