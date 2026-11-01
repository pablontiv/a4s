import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse, stringify } from "yaml";
import { fixtureArtifact } from "../fixtures/artifact.ts";
import { declareService } from "../fixtures/service-environment.ts";
import { liveDagu } from "../fixtures/live-dagu.ts";
import { roleAdmission } from "../role-job-fixtures.ts";
import { readServiceEnvironment } from "../../../launcher/src/service-environment.ts";
import { stationRecovery } from "../../../launcher/src/station-recovery.ts";
import { stationBinding } from "../../../launcher/src/station-binding.ts";
import { artifactToken } from "../../../launcher/src/release.ts";
import { receiptBindingDigest } from "../../../launcher/src/station-recovery-evidence.ts";
import { stationScript } from "../../src/materialize.ts";

test("receipt-bound recovery cancels a native Waiting run after OMP relocation without touching another run or admitting successors", { ...liveDagu, timeout: 60000 }, async () => {
  const root = mkdtempSync(join(process.env.A4S_STATION_RECOVERY_EVIDENCE ?? tmpdir(), "a4s-native-station-recovery-"));
  const home = join(root, "station"), primary = join(root, "primary"), old = join(root, "old-tools"), upgraded = join(root, "new-tools"), stable = join(root, "launcher");
  mkdirSync(join(home, "dags"), { recursive: true }); mkdirSync(old); mkdirSync(upgraded);
  execFileSync("git", ["init", "-q", primary]);
  execFileSync("git", ["-C", primary, "-c", "user.name=Recovery", "-c", "user.email=recovery@example.test", "commit", "--allow-empty", "-qm", "initial"]);
  writeFileSync(join(old, "omp"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  mkdirSync(stable);
  const cli = fileURLToPath(new URL("../../../launcher/src/cli.ts", import.meta.url));
  writeFileSync(join(stable, "a4s"), `#!/bin/sh\nexec node --import ${JSON.stringify(import.meta.resolve("tsx"))} ${JSON.stringify(cli)} "$@"\n`, { mode: 0o755 });
  const socket = createServer(), listening = Promise.withResolvers<void>();
  socket.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
  const address = socket.address(); assert.ok(address && typeof address !== "string");
  const port = address.port, closed = Promise.withResolvers<void>(); socket.close(() => closed.resolve()); await closed.promise;
  const previous = { ...process.env };
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DAGU_") && !["RUN", "PRIMARY", "A4S_ARTIFACT", "A4S_BIN"].includes(key)));
  Object.assign(env, declareService(home, `http://127.0.0.1:${port}`, `${stable}:${old}:${process.env.PATH}`), { DAGU_COORDINATOR_ENABLED: "false" });
  env.PATH = `${stable}:${old}:${process.env.PATH}`;
  writeFileSync(join(home, "base.yaml"), stringify({ env: [{ A4S_SERVICE_ENV: env.A4S_SERVICE_ENV }] }));
  writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\nqueues:\n  enabled: true\n  config:\n    - name: recovery-fixture\n      max_concurrency: 4\n`);
  const service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = ""; service.stdout.on("data", chunk => { logs += chunk; }); service.stderr.on("data", chunk => { logs += chunk; });
  const until = async (probe: () => Promise<boolean>) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) { if (await probe()) return; await delay(100); }
    throw new Error(`Native recovery timeout\n${logs}`);
  };
  try {
    Object.assign(process.env, env); delete process.env.DAGU_PORT;
    await until(async () => { try { return (await fetch(`${env.DAGU_URL}/api/v1/health`)).ok; } catch { return false; } });
    const artifact = fixtureArtifact(home);
    const template = parse(readFileSync(new URL("../../skills/issue-execution/feature.yaml", import.meta.url), "utf8"));
    const checkpoint = template.steps.find((step: { id: string }) => step.id === "start_primary_unavailable");
    const cancellation = template.steps.find((step: { id: string }) => step.id === "start_primary_unavailable_cancellation");
    const paths = new Map<string, string>();
    for (const run of ["recover", "unrelated"]) {
      const state = join(primary, ".git", "dagu-feature", "runs", run), path = join(state, "receipt.json");
      mkdirSync(state, { recursive: true }); paths.set(run, path);
      const snapshot = stringify({ name: "feature", type: "graph", queue: "recovery-fixture", shell: "bash", params: [{ name: "ISSUE", type: "string", default: "845" }],
        env: [{ PRIMARY: primary }, { WORKTREE: primary }, { RUN: run }], steps: [
        { id: "detect_start_primary", run: 'printf "reason=primary dirty\\n" >> "$DAGU_OUTPUT_FILE"', outputs: [{ name: "reason" }] },
        checkpoint, cancellation,
        { id: "effect", depends: [cancellation.id], run: `touch ${JSON.stringify(join(root, `effect-${run}`))}` },
      ], handler_on: { exit: { run: `test ! -f ${JSON.stringify(join(state, "cancellation.json"))} || printf cancelled` } } });
      const receipt = roleAdmission(primary, home, run, snapshot, artifact);
      receipt.initial.runtimeAndModels.station = readServiceEnvironment();
      writeFileSync(path, JSON.stringify(receipt));
      const dag = join(home, "dags", "feature.yaml"); writeFileSync(dag, snapshot);
      execFileSync("dagu", ["enqueue", "--run-id", run, dag], { env, stdio: "pipe" });
      await until(async () => {
        const response = await fetch(`${env.DAGU_URL}/api/v1/dag-runs/feature/${run}`);
        if (!response.ok) return false;
        return (await response.json() as { dagRunDetails: { statusLabel: string } }).dagRunDetails.statusLabel === "waiting";
      });
    }
    const dynamicRun = "dynamic", dynamicOutput = join(root, "dynamic-output.json");
    const dynamicSnapshot = stringify({ name: "feature", type: "graph", queue: "recovery-fixture", shell: "bash", env: [
      { PRIMARY: primary }, { RUN: dynamicRun }, { A4S_ARTIFACT: artifactToken(artifact) },
    ], steps: [
      { id: "approve", action: "human.task", with: { prompt: "Operator" } },
      { id: "effect", depends: ["approve"], run: stationScript(`\"$A4S_BIN\" version > ${JSON.stringify(dynamicOutput)}`) },
    ] });
    const dynamicReceipt = roleAdmission(primary, home, dynamicRun, dynamicSnapshot, artifact);
    dynamicReceipt.initial.runtimeAndModels.station = stationBinding();
    const dynamicState = join(primary, ".git", "dagu-feature", "runs", dynamicRun); mkdirSync(dynamicState, { recursive: true });
    writeFileSync(join(dynamicState, "receipt.json"), JSON.stringify(dynamicReceipt));
    const dynamicDag = join(home, "dags", "feature.yaml"); writeFileSync(dynamicDag, dynamicSnapshot);
    execFileSync("dagu", ["enqueue", "--run-id", dynamicRun, dynamicDag], { env, stdio: "pipe" });
    await until(async () => {
      const response = await fetch(`${env.DAGU_URL}/api/v1/dag-runs/feature/${dynamicRun}`);
      return response.ok && (await response.json() as { dagRunDetails: { statusLabel: string } }).dagRunDetails.statusLabel === "waiting";
    });
    const args = (action: string) => [action, "--primary", primary, "--run", "recover"];
    const before = readFileSync(paths.get("recover")!);
    const unrelated = readFileSync(paths.get("unrelated")!);
    const manifest = join(root, "independent-manifest.json");
    writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, receiptDigest: receiptBindingDigest(JSON.parse(before.toString())), verifiedAt: new Date().toISOString(), provenance: "Fixture independently retained original tool digests and native station identity", station: stationBinding() }));
    await stationRecovery([...args("pin"), "--evidence", manifest]);
    copyFileSync(join(old, "omp"), join(upgraded, "omp")); rmSync(old, { recursive: true });
    const declaration = JSON.parse(readFileSync(env.A4S_SERVICE_ENV!, "utf8"));
    writeFileSync(env.A4S_SERVICE_ENV!, JSON.stringify({ ...declaration, PATH: `${join(root, "harmless")}:${stable}:${upgraded}:${previous.PATH}` }));
    await stationRecovery(args("check"));
    writeFileSync(env.A4S_SERVICE_ENV!, JSON.stringify({ ...declaration, PATH: `${stable}:${upgraded}:${previous.PATH}` }));
    await stationRecovery(args("cancel"));
    await stationRecovery(args("cancel"));
    const evidence = JSON.parse(readFileSync(join(dirname(paths.get("recover")!), "station-recovery-cancellation.json"), "utf8"));
    assert.equal(evidence.terminal.statusLabel, "failed");
    assert.ok(evidence.observation.nodes.some((node: { step: { name: string } }) => node.step.name === checkpoint.id));
    assert.match(evidence.observation.params, /ISSUE.*845/);
    assert.deepEqual(readFileSync(paths.get("recover")!), before);
    assert.deepEqual(readFileSync(paths.get("unrelated")!), unrelated);
    const other = await (await fetch(`${env.DAGU_URL}/api/v1/dag-runs/feature/unrelated`)).json() as { dagRunDetails: { statusLabel: string } };
    assert.equal(other.dagRunDetails.statusLabel, "waiting");
    for (const run of ["recover", "unrelated"]) assert.equal(existsSync(join(root, `effect-${run}`)), false);
    execFileSync("dagu", ["human-task", "complete", "feature", "--run-id", dynamicRun, "--step", "approve"], { env, stdio: "pipe" });
    await until(async () => { try { return JSON.parse(readFileSync(dynamicOutput, "utf8")).commit === artifact.commit; } catch { return false; } });
    assert.equal(JSON.parse(readFileSync(dynamicOutput, "utf8")).commit, artifact.commit);
  } finally {
    service.kill("SIGTERM");
    if (service.exitCode === null) { const done = Promise.withResolvers<void>(); service.once("exit", () => done.resolve()); await done.promise; }
    process.env = previous;
    if (!process.env.A4S_STATION_RECOVERY_EVIDENCE) rmSync(root, { recursive: true, force: true });
  }
});
