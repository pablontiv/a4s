import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { admissionFixture, compiledA4sBin, compiledArtifact } from "../fixtures/admission.ts";
import { makeArchive } from "../fixtures/artifact.ts";
import { roleAdmission } from "../role-job-fixtures.ts";
import { artifactToken, parseArtifact, type ArtifactTuple } from "../../../launcher/src/release.ts";
import { runMutationDecision } from "../../src/triage/run-guard.ts";
import { receiptCompatibility, recordRunObservation } from "../../src/status/receipt.ts";
import { renderWidget, type RunDetails } from "../../src/status/progress.ts";
import { protectionPath, readProtection } from "../../src/integration-protection.ts";
import { roleRuntimeFixture } from "../fixtures/role-runtime.ts";
import { RunArtifactScope } from "../../src/run-artifact.ts";
import { verifyJobResult } from "../../src/role-jobs.ts";
import { verifyTriageResult } from "../../src/role-dispatch.ts";
import { cachePath, inspectArtifact } from "../../../launcher/src/artifact-cache.ts";

function save(f: ReturnType<typeof admissionFixture>, run: string, artifact: ArtifactTuple): void {
  if (!existsSync(join(f.home, "cache/a4s/state.json"))) {
    execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../../../launcher/src/cli.ts", import.meta.url)), "station", "init", "--artifact", artifactToken(artifact)],
      { cwd: f.packageDir, env: { ...process.env, DAGU_HOME: f.home }, stdio: "pipe" });
  }
  const receipt = roleAdmission(f.packageDir, f.home, run, 'env: []\nsteps:\n  - run: \'"$A4S_BIN" role-jobs stage triage\'\n', artifact);
  mkdirSync(dirname(f.receipt(run)), { recursive: true });
  writeFileSync(f.receipt(run), JSON.stringify(receipt));
}
async function shell(command: string, cwd: string, env: NodeJS.ProcessEnv) {
  return await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    // Station shell startup files must not replace the fixture's controlled PATH.
    const child = spawn("bash", ["--noprofile", "--norc", "-c", command], { cwd, env });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", status => resolve({ status, stdout, stderr }));
  });
}

test("cached artifacts remain exact and verified without installing station DAGs", { timeout: 120_000 }, async () => {
  const f = admissionFixture();
  try {
    const tuple = compiledArtifact(f.home);
    const executable = join(cachePath(f.home, tuple), "a4s");
    const inspect = async (value: string) => inspectArtifact(f.home, parseArtifact(value));
    const before = readdirSync(join(f.home, "dags"));
    assert.equal((await inspect(artifactToken(tuple))).executable, executable);
    assert.deepEqual(readdirSync(join(f.home, "dags")), before);
    for (const moving of ["v0", "a4s@v0", `v0@${tuple.commit}#${tuple.digest}`]) await assert.rejects(inspect(moving));
    const metadata = join(dirname(executable), "artifact.json");
    const original = readFileSync(metadata, "utf8");
    writeFileSync(metadata, JSON.stringify({ ...tuple, verifiedAt: "unverified" }));
    await assert.rejects(inspect(artifactToken(tuple)), /Missing or malformed artifact metadata/);
    writeFileSync(metadata, JSON.stringify({ ...JSON.parse(original), commit: "f".repeat(40) }));
    await assert.rejects(inspect(artifactToken(tuple)), /Conflicting artifact cache entry/);
    writeFileSync(metadata, original);
    writeFileSync(join(dirname(executable), "identity.json"), "{}\n");
    await assert.rejects(inspect(artifactToken(tuple)), /Modified artifact payload/);
    assert.deepEqual(readdirSync(join(f.home, "dags")), before);
  } finally { f.dispose(); }
});

test("release-independent HUD and plugin mutations dispatch A while B is installed", { timeout: 180_000 }, async () => {
  const f = admissionFixture();
  const previousUrl = process.env.DAGU_URL;
  const server = createServer((_request, response) => response.end(JSON.stringify({ dagRunDetails: {
    params: "ISSUE=189 OMP_SESSION_ID=parent-id", nodes: [
      { step: { id: "admit" }, statusLabel: "succeeded", startedAt: "2026-10-22T05:00:00Z" },
      { step: { id: "triage" }, statusLabel: "running", startedAt: "2026-10-22T05:00:01Z" },
    ],
  } })));
  try {
    const a = compiledArtifact(f.home, "0.6.1", "a".repeat(40));
    const b = compiledArtifact(f.home, "0.6.2", "b".repeat(40));
    save(f, "version-a", a); save(f, "version-b", b); save(f, "unsupported", a);
    const invalid = JSON.parse(readFileSync(f.receipt("unsupported"), "utf8"));
    invalid.contracts.roleJobStore = 999;
    writeFileSync(f.receipt("unsupported"), JSON.stringify(invalid));
    const runs: RunDetails[] = ["version-a", "version-b", "unsupported"].map((dagRunId, index) => ({
      name: "feature", dagRunId, statusLabel: "waiting", labels: [`dagu-feature-bundle=${index === 1 ? b.version : a.version}`],
      params: `ISSUE=${189 + index} PRIMARY=${f.packageDir}`, resolvedPrimary: f.packageDir,
    }));
    for (const run of runs) {
      const error = receiptCompatibility(f.packageDir, run);
      if (error) run.artifactError = error;
    }
    assert.equal(runs[0]!.artifactError, undefined); assert.equal(runs[1]!.artifactError, undefined);
    const hud = renderWidget(runs.map(run => ({ run })), { fg: (_color, text) => text, bold: text => text, tree: { branch: "", last: "" } })!.join("\n");
    assert.match(hud, /#189/); assert.match(hud, /#190/); assert.match(hud, /#191.*unsupported:/);
    await recordRunObservation(runs[0]!, f.packageDir);
    assert.equal(JSON.parse(readFileSync(f.receipt("version-a"), "utf8")).runReceipt.observations.at(-1).kind, "runtime");

    const bin = join(f.root, "commands"); mkdirSync(bin);
    const effects = join(f.root, "effects"); writeFileSync(effects, "");
    writeFileSync(join(bin, "dagu"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${effects}'\n`, { mode: 0o755 });
    writeFileSync(join(bin, "gh"), "#!/bin/sh\nprintf '%s\\n' '{}'\n", { mode: 0o755 });
    const env: NodeJS.ProcessEnv = { ...process.env, DAGU_HOME: f.home, PRIMARY: f.packageDir, RUN: "version-a", ISSUE: "189", A4S_BIN: join(f.home, "cache/a4s", b.version, "a4s"), PATH: `${bin}:${process.env.PATH}` };
    const execute = async (action: string, run = "version-a") => {
      const decision = await runMutationDecision({ toolName: "bash", toolCallId: "mutation", input: { command: `PRIMARY='${f.packageDir}' RUN=${run} ${action}` } }, f.packageDir);
      assert.ok(decision && "input" in decision, JSON.stringify(decision));
      assert.ok(decision.input.command.includes(join(f.home, "cache/a4s", a.version, "a4s")));
      return await shell(decision.input.command, f.packageDir, env);
    };
    const triage = await execute("dagu human-task complete feature --run-id version-a --step validation --expected-iteration 0 --input APPROVE=yes");
    assert.equal(triage.status, 0, triage.stderr);
    assert.match(triage.stderr, new RegExp(`a4s-run run=version-a artifact=${a.version}@${a.commit}#${a.digest} command=native human-task`));
    assert.match(readFileSync(effects, "utf8"), /human-task complete feature/);

    writeFileSync(protectionPath(f.packageDir), JSON.stringify({ schemaVersion: 1, status: "active", protectedRun: "version-a", issue: "189", paths: ["value"], candidateSha: "a".repeat(40), decision: "operator", provenance: { recordedAt: new Date().toISOString(), command: "fixture" }, pathsRefreshedAt: new Date().toISOString(), held: [] }));
    const protection = await execute("a4s protect release --decision complete");
    assert.equal(protection.status, 0, protection.stderr);
    assert.match(protection.stderr, /artifact=0\.6\.1@.*command=protect release/);
    assert.equal(readProtection(f.packageDir)?.status, "released");

    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    process.env.DAGU_URL = env.DAGU_URL = `http://127.0.0.1:${address.port}`;
    const runtime = roleRuntimeFixture(f.root);
    writeFileSync(join(runtime, "src/config/settings.ts"), "export const Settings={async loadReadOnly(){return {}}};\n");
    writeFileSync(join(runtime, "src/task/settings.ts"), "export const cfgTaskAgentModelOverrides={get(){return {}}};\n");
    writeFileSync(join(runtime, "src/config/model-resolver.ts"), "export function resolveAgentModelSelection(){return {patterns:['fixture-model'],role:'triage'}};\n");
    writeFileSync(join(runtime, "src/task/executor.ts"), `import {mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
export async function runSubprocess(o){
const output={poc:'no',behavior:'demonstrated',question:'Already supported?',reason:'Version A reviewed the issue'};
const rows=[{type:'session',id:'native-a'}, {type:'session_init',agent:'triage-reviewer',task:o.task},
{type:'message',id:'a-result',message:{role:'assistant',provider:'fixture',model:'fixture-model',stopReason:'toolUse',content:[{type:'toolCall',name:'yield',id:'yield-a',arguments:{data:output}}]}},
{type:'message',message:{role:'toolResult',toolName:'yield',toolCallId:'yield-a',details:{status:'success',data:output}}}];
mkdirSync(o.artifactsDir,{recursive:true});writeFileSync(join(o.artifactsDir,o.id+'.jsonl'),rows.map(row=>JSON.stringify(row)).join('\\n')+'\\n');
return {exitCode:0,output:JSON.stringify(output)}};
`);
    // Exercise the extracted release with only its real tool dependencies. In
    // particular, neither an ambient Bun executable nor a source runtime can win.
    for (const tool of ["bash", "git", "ps"]) {
      symlinkSync(execFileSync("bash", ["--noprofile", "--norc", "-c", 'command -v "$1"', "fixture", tool], { encoding: "utf8" }).trim(), join(bin, tool));
    }
    Object.assign(env, { PATH: `${join(f.root, "bin")}:${bin}`, DAGU_OUTPUT_FILE: join(f.root, "role-outputs"), DAG_PUSHBACK_ITERATION: "0" });
    assert.equal(spawnSync("bash", ["--noprofile", "--norc", "-c", "command -v bun"], { env }).status, 1);
    const detected = await shell(`'${join(cachePath(f.home, a), "a4s")}' role-jobs detect`, f.packageDir, env);
    assert.equal(detected.status, 0, detected.stderr);
    assert.deepEqual(JSON.parse(detected.stdout), { root: join(f.root, "bin/omp"), agents: [
      { name: "triage-reviewer", source: join(cachePath(f.home, a), "agents/triage-reviewer.md") },
      { name: "task", source: `fixture:${f.packageDir}` },
    ] });
    const role = await execute("a4s role-jobs stage triage");
    assert.equal(role.status, 0, role.stderr);
    assert.match(role.stderr, /artifact=0\.6\.1@.*command=role-jobs stage/);
    assert.match(readFileSync(env.DAGU_OUTPUT_FILE!, "utf8"), /POC=no/);
    assert.ok(existsSync(join(f.home, "role-jobs.sqlite")));
    assert.equal(JSON.parse(readFileSync(f.receipt("version-a"), "utf8")).runReceipt.observations.at(-1).kind, "role-job");
    const roleOutput = readFileSync(env.DAGU_OUTPUT_FILE!, "utf8");
    const review = /^REVIEW=(.+)$/m.exec(roleOutput)![1]!;
    const verified = verifyTriageResult(f.packageDir, "version-a", review);
    verifyJobResult(join(dirname(verified.native!.transcript), "result.json"));
    const routing = verified.native!.routing as { runtime: { binary: string; version: string; digest: string }; agent: { source: string } };
    assert.equal(routing.runtime.binary, join(f.root, "bin/omp"));
    assert.equal(routing.runtime.version, "omp/fixture");
    assert.equal(routing.runtime.digest, createHash("sha256").update(readFileSync(join(f.root, "bin/omp"))).digest("hex"));
    assert.equal(routing.agent.source, join(cachePath(f.home, a), "agents/triage-reviewer.md"));

    const before = [readFileSync(effects, "utf8"), readFileSync(f.receipt("unsupported"), "utf8"), readFileSync(protectionPath(f.packageDir), "utf8")];
    for (const action of ["dagu human-task complete feature --run-id unsupported --step triage", "a4s protect release --decision denied", "a4s role-jobs stage triage"]) {
      const decision = await runMutationDecision({ toolName: "bash", toolCallId: "reject", input: { command: `PRIMARY='${f.packageDir}' RUN=unsupported ${action}` } }, f.packageDir);
      assert.ok(decision && "block" in decision);
      assert.match(decision.reason, /A4S_RUN_UNSUPPORTED:.*contract/);
    }
    await assert.rejects(recordRunObservation(runs[2]!, f.packageDir), /Unsupported receipt/);
    assert.deepEqual([readFileSync(effects, "utf8"), readFileSync(f.receipt("unsupported"), "utf8"), readFileSync(protectionPath(f.packageDir), "utf8")], before);
    for (const action of [
      "dagu retry feature --run-id version-a --run-id version-b",
      "dagu retry poc --run-id version-a",
      "dagu stop feature --run-id version-a --dagu-home /another-station",
    ]) {
      const rejected = await execute(action);
      assert.equal(rejected.status, 1, rejected.stderr);
      assert.match(rejected.stderr, /receipt's DAG\/run binding|station overrides/);
      assert.equal(readFileSync(effects, "utf8"), before[0]);
    }
    const valid = JSON.parse(readFileSync(f.receipt("version-a"), "utf8"));
    for (const patch of [
      { schemaVersion: 1 },
      { artifactSupport: undefined },
      { contracts: { ...valid.contracts, dispatch: undefined } },
      { contracts: { ...valid.contracts, dispatch: "a4s-run/2" } },
      { contracts: { ...valid.contracts, config: 999 } },
      { contracts: { ...valid.contracts, protocols: { ...valid.contracts.protocols, triage: "future/2" } } },
      { artifact: { ...a, version: "0.6.9" }, sourceVersion: { version: "0.6.9", commit: a.commit } },
    ]) {
      const unchanged = JSON.stringify({ ...valid, ...patch, runReceipt: { ...valid.runReceipt, run: "unsupported" } });
      writeFileSync(f.receipt("unsupported"), unchanged);
      const decision = await runMutationDecision({ toolName: "bash", toolCallId: "unsupported", input: { command: `PRIMARY='${f.packageDir}' RUN=unsupported a4s protect release --decision denied` } }, f.packageDir);
      assert.ok(decision && "block" in decision);
      assert.match(decision.reason, /A4S_RUN_UNSUPPORTED/);
      assert.ok(receiptCompatibility(f.packageDir, runs[2]!));
      assert.equal(readFileSync(f.receipt("unsupported"), "utf8"), unchanged);
      assert.equal(readFileSync(effects, "utf8"), before[0]);
      assert.equal(readFileSync(protectionPath(f.packageDir), "utf8"), before[2]);
    }
  } finally {
    if (previousUrl === undefined) delete process.env.DAGU_URL; else process.env.DAGU_URL = previousUrl;
    if (server.listening) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    f.dispose();
  }
});

test("native mutations reject a caller PATH without jq before invoking Dagu", { timeout: 120_000 }, () => {
  const f = admissionFixture();
  try {
    const tuple = compiledArtifact(f.home);
    save(f, "missing-tool", tuple);
    const executable = join(f.home, "cache/a4s", tuple.version, "a4s");
    const bin = join(f.root, "native-bin"); mkdirSync(bin);
    const effects = join(f.root, "native-effects");
    for (const tool of ["bash", "git"]) {
      symlinkSync(execFileSync("bash", ["-c", 'command -v "$1"', "fixture", tool], { encoding: "utf8" }).trim(), join(bin, tool));
    }
    for (const tool of ["gh", "curl", "node", "omp"]) {
      writeFileSync(join(bin, tool), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    writeFileSync(join(bin, "dagu"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${effects}'\nexit 42\n`, { mode: 0o755 });
    const run = (args: string[]) => spawnSync(executable, ["run", "--primary", f.packageDir, "--run", "missing-tool", "--", "native", ...args], {
      env: { ...process.env, DAGU_HOME: f.home, PATH: bin }, encoding: "utf8",
    });
    const actions = [
      ["retry", "feature", "--run-id", "missing-tool", "--step", "capture", "--downstream"],
      ["human-task", "complete", "feature", "--run-id", "missing-tool", "--step", "validation", "--input", "APPROVE=yes"],
      ["stop", "feature", "--run-id", "missing-tool"],
    ];
    const before = readFileSync(f.receipt("missing-tool"), "utf8");
    for (const args of actions) {
      const result = run(args);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /required command not found: jq.*no Dagu mutation started/);
      assert.doesNotMatch(result.stderr, /malformed ownership history/);
      assert.equal(existsSync(effects), false, "Dagu must not run even once when jq is missing");
      assert.equal(readFileSync(f.receipt("missing-tool"), "utf8"), before);
      assert.deepEqual(readdirSync(dirname(f.receipt("missing-tool"))), ["receipt.json"]);
    }
    writeFileSync(join(bin, "jq"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    assert.equal(existsSync(join(bin, "bun")), false);
    for (const args of actions) {
      const ready = run(args);
      assert.equal(ready.status, 42, ready.stderr);
    }
    assert.equal(readFileSync(effects, "utf8"), actions.map(args => args.join(" ")).join("\n") + "\n");
  } finally { f.dispose(); }
});

test("tick verification shares artifact evidence but rechecks every receipt and expires with the tick", async () => {
  const f = admissionFixture();
  try {
    const tuple = compiledArtifact(f.home);
    save(f, "first", tuple); save(f, "second", tuple);
    const scope = new RunArtifactScope();
    const first = await scope.verify(f.packageDir, "first");
    const second = await scope.verify(f.packageDir, "second");
    assert.equal(first.cached, second.cached);
    assert.equal(scope.artifactVerifications, 1);
    const receipt = JSON.parse(readFileSync(f.receipt("second"), "utf8"));
    receipt.contracts.roleJobStore = 999;
    writeFileSync(f.receipt("second"), JSON.stringify(receipt));
    await assert.rejects(scope.verify(f.packageDir, "second"), /Unsupported receipt roleJobStore contract/);
    assert.equal(scope.artifactVerifications, 1);
    assert.equal((await scope.verify(f.packageDir, "first")).cached, first.cached);
    writeFileSync(join(first.cached.directory, "identity.json"), "{}\n");
    await assert.rejects(new RunArtifactScope().verify(f.packageDir, "first"), /Modified artifact payload/);
    assert.deepEqual(readdirSync(dirname(f.receipt("first"))), ["receipt.json"]);
    assert.deepEqual(readdirSync(dirname(f.receipt("second"))), ["receipt.json"]);
  } finally { f.dispose(); }
});

test("native classification rechecks changed receipts before writing and restores station context", () => {
  const f = admissionFixture();
  try {
    const tuple = compiledArtifact(f.home), executable = join(f.home, "cache/a4s", tuple.version, "a4s");
    save(f, "changed", tuple); save(f, "compatible", tuple);
    const bin = join(f.root, "tick-bin"); mkdirSync(bin);
    writeFileSync(join(bin, "dagu"), "#!/bin/sh\nprintf 'Waiting\\n├─triage [waiting]\\n'\n", { mode: 0o755 });
    writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
if (process.env.RUN !== "station-sentinel") process.exit(92);
const receipt = JSON.parse(fs.readFileSync(process.env.CHANGED_RECEIPT, "utf8"));
receipt.contracts.roleJobStore = 999;
fs.writeFileSync(process.env.CHANGED_RECEIPT, JSON.stringify(receipt));
console.log(JSON.stringify([{ number: 189, state: "open" }, { number: 190, state: "open" }]));
`, { mode: 0o755 });
    const output = join(f.root, "classify.output");
    const result = spawnSync(executable, ["reconcile", "classify", output], { encoding: "utf8", env: { ...process.env,
      PATH: `${bin}:${process.env.PATH}`, DAGU_HOME: f.home, A4S_ARTIFACT: artifactToken(tuple), RUN: "station-sentinel",
      CHANGED_RECEIPT: f.receipt("changed"), CI_OBSERVATION_ID: "receipt-recheck",
      RUNS: JSON.stringify(["changed", "compatible"].map((run, index) => ({ RUN: run, PRIMARY: f.packageDir, ISSUE: String(189 + index), REPO: "example/repo" }))),
    } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /reconcile-failure run=changed status=1 cause=.*Unsupported receipt roleJobStore contract/);
    assert.match(readFileSync(output, "utf8"), /failures=\[\{"run":"changed"/);
    assert.deepEqual(readdirSync(dirname(f.receipt("changed"))), ["receipt.json"]);
    assert.ok(existsSync(join(dirname(f.receipt("compatible")), "ci-observation.json")));
    assert.match(result.stderr, /"artifactVerifications":1,"inProcessActions":3/);
  } finally { f.dispose(); }
});

test("matching version and commit cannot authorize different executable bytes in process", () => {
  const f = admissionFixture();
  try {
    const executable = compiledA4sBin();
    const declared = JSON.parse(execFileSync(executable, ["version"], { encoding: "utf8" }));
    const release = makeArchive(f.releases, declared.version, declared.commit);
    const tuple = { version: release.version, commit: release.commit, digest: release.digest };
    const directory = join(f.home, "cache/a4s", tuple.version); mkdirSync(directory, { recursive: true });
    execFileSync("tar", ["-xzf", join(f.releases, release.archive), "-C", directory]);
    copyFileSync(join(f.releases, release.archive), join(directory, "verified-archive.tar.gz"));
    writeFileSync(join(directory, "artifact.json"), JSON.stringify({ ...tuple, verifiedAt: new Date().toISOString() }));
    save(f, "different-bytes", tuple);
    const result = spawnSync(executable, ["reconcile", "classify", join(f.root, "classify.output")], { encoding: "utf8", env: { ...process.env,
      DAGU_HOME: f.home, A4S_ARTIFACT: artifactToken(tuple), CI_OBSERVATION_ID: "byte-identity",
      RUNS: JSON.stringify([{ RUN: "different-bytes", PRIMARY: f.packageDir, ISSUE: "189", REPO: "example/repo" }]),
    } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /reconcile-failure run=different-bytes status=1 cause=.*status 91/);
    assert.match(result.stderr, /"artifactVerifications":1,"inProcessActions":0/);
    assert.deepEqual(readdirSync(dirname(f.receipt("different-bytes"))), ["receipt.json"]);
  } finally { f.dispose(); }
});
