import assert from "node:assert/strict";
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { testRunId } from "../fixtures/run-id.ts";
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { admissionFixture, compiledA4sBin } from "../fixtures/admission.ts";
import { installGithubFixture, writeReleaseDirectory, repository } from "../fixtures/artifact.ts";
import { archiveName } from "../../../launcher/src/release.ts";
import { liveDagu } from "../fixtures/live-dagu.ts";

import { exampleConfig, serializeConfig } from "../../../launcher/src/config.ts";
import { BUNDLE_VERSION } from "../../src/bundle.ts";
const cli = fileURLToPath(new URL("../../bin/dagu-feature-bundle.ts", import.meta.url));

function commitConfig(repo: string, text?: string): void {
  mkdirSync(join(repo, ".workspace", "dagu"), { recursive: true });
  if (text !== undefined) writeFileSync(join(repo, ".workspace", "dagu", "config.json"), text);
  spawnSync("git", ["init", "-b", "main", repo], { encoding: "utf8" });
  spawnSync("git", ["-C", repo, "config", "user.email", "cli@example.test"]);
  spawnSync("git", ["-C", repo, "config", "user.name", "CLI Test"]);
  if (text === undefined) spawnSync("git", ["-C", repo, "commit", "-qm", "empty", "--allow-empty"]);
  else {
    spawnSync("git", ["-C", repo, "add", "."]);
    const committed = spawnSync("git", ["-C", repo, "commit", "-qm", "config"], { encoding: "utf8" });
    assert.equal(committed.status, 0, committed.stderr);
  }
}

test("CLI reports committed config and the reconciler as compatible", () => {
  const root = mkdtempSync(join(tmpdir(), "dagu-bundle-cli-"));
  try {
    const repo = join(root, "repo");
    const daguHome = join(root, "dagu-home");
    const bin = join(root, "bin");
    mkdirSync(join(daguHome, "dags"), { recursive: true });
    mkdirSync(bin);
    commitConfig(repo, serializeConfig(exampleConfig({
      lane: "fixture", gate: "npm test", requiredCheck: "validate",
    })));
    writeFileSync(join(daguHome, "dags", "reconcile.yaml"), "steps:\n  - run: true\n");
    writeFileSync(join(daguHome, "config.yaml"), "queues:\n  enabled: true\n  config:\n    - name: fixture\n      max_concurrency: 6\n");
    const dagu = join(bin, "dagu");
    writeFileSync(dagu, "#!/bin/sh\nprintf '2.24.0\\n'\n");
    chmodSync(dagu, 0o755);
    const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), cli, repo], {
      encoding: "utf8",
      env: { ...process.env, DAGU_PARAMS_JSON: "{}", DAGU_HOME: daguHome, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /config path=\.workspace\/dagu\/config\.json schema=2 .*lane=fixture .*queue=fixture source=config.yaml max_concurrency=6 ready=yes/);
    assert.match(result.stdout, /config policy gate="npm test" requiredCheck="validate"/);
    assert.match(result.stdout, /reconcile\.yaml path=.* installed=yes/);
    assert.match(result.stdout, /dagu version="2\.24\.0"/);
    assert.doesNotMatch(result.stdout, /dagu version=.*(?:required=|compat=)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI exits nonzero when committed config is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "dagu-bundle-cli-"));
  try {
    const repo = join(root, "repo");
    const daguHome = join(root, "dagu-home");
    const bin = join(root, "bin");
    mkdirSync(join(daguHome, "dags"), { recursive: true });
    mkdirSync(bin);
    commitConfig(repo);
    writeFileSync(join(daguHome, "dags", "reconcile.yaml"), "steps:\n  - run: true\n");
    const dagu = join(bin, "dagu");
    writeFileSync(dagu, "#!/bin/sh\nprintf '2.24.0\\n'\n");
    chmodSync(dagu, 0o755);
    const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), cli, repo], {
      encoding: "utf8",
      env: { ...process.env, DAGU_PARAMS_JSON: "{}", DAGU_HOME: daguHome, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /compat=invalid/);
    assert.match(result.stdout, /missing committed config file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("admission rejects adopted policy parameters before reserving a receipt", liveDagu, () => {
  const fixture = admissionFixture();
  try {
    for (const parameter of ["GATE=true", "REBASE_RESOLVER=true", "REQUIRED_CHECK=arbitrary", "PRIMARY=/foreign/clone", "BRANCH=off-pattern"]) {
      const field = parameter.slice(0, parameter.indexOf("="));
      const run = testRunId(`rejected-${field.toLowerCase()}`);
      const result = fixture.command("enqueue", run, {}, [parameter]);
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(`admission rejected run parameter: ${field}`), result.stderr);
      assert.equal(existsSync(join(fixture.packageDir, ".git", "dagu-feature", "runs", run)), false);
    }
    const accepted = fixture.command("admit", "operational-policy", {}, ["PR_NUMBER=327", "OMP_SESSION_ID=owner-session"]);
    assert.equal(accepted.status, 0, accepted.stderr);
    const receipt = JSON.parse(readFileSync(fixture.receipt("operational-policy"), "utf8"));
    assert.equal(receipt.initial.execution.primary, fixture.packageDir);
    assert.deepEqual(receipt.initial.execution.parameters, ["ISSUE=277", "PR_NUMBER=327", "OMP_SESSION_ID=owner-session"]);
  } finally { fixture.dispose(); }
});

test("admission rejects modified cached payload before Dagu creates a run", liveDagu, () => {
  const fixture = admissionFixture();
  try {
    const admitted = fixture.command("admit", "verified-cache");
    assert.equal(admitted.status, 0, admitted.stderr);
    const receipt = JSON.parse(readFileSync(fixture.receipt("verified-cache"), "utf8"));
    const template = join(fixture.home, "cache", "a4s", receipt.artifact.version, "skills", "issue-execution", "feature.yaml");
    writeFileSync(template, `${readFileSync(template, "utf8")}\n# modified payload\n`);
    const run = testRunId("corrupt-cache");
    const result = fixture.command("enqueue", run);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Modified artifact payload/);
    assert.equal(existsSync(fixture.receipt(run)), false);
  } finally { fixture.dispose(); }
});

test("compatible admission enqueues exact bytes and keeps historical receipt across redeployment", liveDagu, () => {
  const fixture = admissionFixture();
  const run = testRunId("compatible");
  const redeployedRun = testRunId("after-redeploy");
  try {
    const result = fixture.command("enqueue", run);
    assert.equal(result.status, 0, result.stderr);
    const path = fixture.receipt(run);
    const initialReceipt = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(initialReceipt.sourceVersion.version, BUNDLE_VERSION);
    assert.match(initialReceipt.deploymentFingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(initialReceipt.initial).sort(), ["admittedAt", "deployment", "eventsAndExternalState", "execution", "runtimeAndModels"]);
    assert.equal(initialReceipt.initial.runtimeAndModels.resolvedModel.state, "pending");
    assert.equal(initialReceipt.runReceipt.observations[0].kind, "enqueued");
    const history = spawnSync("dagu", ["history", "feature", "--format", "json"], { env: { ...process.env, DAGU_HOME: fixture.home }, encoding: "utf8" });
    assert.equal(history.status, 0, history.stderr);
    assert.ok(history.stdout.includes(run));
    assert.equal(readFileSync(join(path, "..", "snapshot", "feature.yaml"), "utf8"), initialReceipt.initial.execution.dagSnapshot);
    const event = { dag: "feature", run, attempt: 1, category: "runtimeAndModels", kind: "model-resolved", data: { resolvedModel: "test/model", resolvedModelIsFallback: false, crossFamilyDecision: { allowed: true, reason: "same family" } } };
    const observed = fixture.observe(run, event);
    assert.equal(observed.status, 0, observed.stderr);
    const afterEvent = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(afterEvent.initial, initialReceipt.initial);
    assert.deepEqual(afterEvent.runReceipt.observations.at(-1).data, event.data);
    const invalid = fixture.observe(run, { ...event, run: "other-run" });
    assert.notEqual(invalid.status, 0);
    const oldBytes = readFileSync(path, "utf8");
    writeFileSync(join(fixture.packageDir, "unrelated-checkout-file"), "This cannot change the cached artifact\n");
    const next = fixture.command("enqueue", redeployedRun);
    assert.equal(next.status, 0, next.stderr);
    const nextReceipt = JSON.parse(readFileSync(fixture.receipt(redeployedRun), "utf8"));
    assert.equal(nextReceipt.deploymentFingerprint, initialReceipt.deploymentFingerprint);
    assert.equal(readFileSync(path, "utf8"), oldBytes);
    const duplicate = fixture.command("enqueue", run);
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /already has an immutable admission receipt; choose a new run ID/);
    assert.equal(readFileSync(path, "utf8"), oldBytes);
    const descriptor = openSync(path, "r");
    try { assert.equal(fstatSync(descriptor).mode & 0o777, 0o600); }
    finally { closeSync(descriptor); }
  } finally { fixture.dispose(); }
});

test("admission ignores station files, forged consumer templates, and notice-only plugin identity", liveDagu, () => {
  const fixture = admissionFixture();
  try {
    assert.equal(existsSync(join(fixture.home, "dags", "reconcile.yaml")), false);
    const absentRun = testRunId("reconciler-absent");
    const absent = fixture.command("enqueue", absentRun);
    assert.equal(absent.status, 0, absent.stderr);
    const consumer = fixture.dag;
    mkdirSync(join(consumer, ".."), { recursive: true });
    writeFileSync(consumer, "# injected code\n");
    const forged = fixture.command("enqueue", testRunId("forged"));
    assert.equal(forged.status, 0, forged.stderr);
    const staleRun = testRunId("stale");
    const stale = fixture.command("enqueue", staleRun, { DAGU_ADMISSION_SESSION: JSON.stringify({ extensionDigest: "old-loaded-digest", transcriptRoot: "/session" }) });
    assert.equal(stale.status, 0, stale.stderr);
    assert.deepEqual(JSON.parse(readFileSync(fixture.receipt(absentRun), "utf8")).artifact, JSON.parse(readFileSync(fixture.receipt(staleRun), "utf8")).artifact);
  } finally { fixture.dispose(); }
});

function snapshot(root: string): Record<string, string> {
  return Object.fromEntries(readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? [[`${entry.name}/`, ""], ...Object.entries(snapshot(path)).map(([name, bytes]) => [`${entry.name}/${name}`, bytes])]
      : [[entry.name, entry.isSymbolicLink() ? `symlink:${readlinkSync(path)}` : readFileSync(path).toString("hex")]];
  }));
}

test("installed admission check preserves history, receipts, refs and checkout in a4s and consumer repos", { ...liveDagu, skip: liveDagu.skip || process.platform !== "linux" }, async () => {
  const binary = compiledA4sBin();
  const exec = promisify(execFile);
  for (const lane of ["a4s", "consumer"]) {
    const fixture = admissionFixture();
    let service: ChildProcess | undefined;
    let active = true, queuePresent = true;
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(request.url?.endsWith("/queues")
        ? { queues: queuePresent ? [{ name: lane, type: "global" }] : [] }
        : { schedulers: active ? [{ status: "active" }] : [] }));
    });
    try {
      fixture.writeConfig({ lane });
      const bin = installGithubFixture(join(fixture.root, "probe-bin"));
      const serviceBin = join(fixture.root, "service-bin");
      mkdirSync(serviceBin);
      for (const tool of ["bash", "git", "gh", "jq", "node", "omp", "dagu"]) {
        writeFileSync(join(serviceBin, tool), "#!/bin/sh\nexit 0\n");
        chmodSync(join(serviceBin, tool), 0o755);
      }
      writeReleaseDirectory(fixture.releases, {
        repository, moving: {}, releases: [{ tag_name: "v0.6.0", commit: "a".repeat(40) }],
      });
      writeFileSync(join(fixture.releases, `${archiveName("0.6.0")}.sha256`), `${"b".repeat(64)}  ${archiveName("0.6.0")}\n`);
      const stationConfig = (present: boolean) => writeFileSync(join(fixture.home, "config.yaml"),
        `auth: {mode: none}\ncoordinator: {enabled: true}\nqueues:\n  config:\n    - name: ${present ? lane : "foreign"}\n      max_concurrency: 2\n`);
      stationConfig(true);
      // Retain pre-existing lifecycle evidence and use real history reads.
      const retained = join(fixture.packageDir, ".git", "dagu-feature", "runs", "retained");
      mkdirSync(retained, { recursive: true });
      writeFileSync(join(retained, "receipt.json"), '{"retained":true}\n');
      for (const dag of ["feature", "poc", "planning"]) {
        writeFileSync(join(fixture.home, "dags", `${dag}.yaml`), `name: ${dag}\nsteps:\n  - run: echo untouched\n`);
      }
      const history = () => ["feature", "poc", "planning"].map(dag => {
        const result = spawnSync("dagu", ["history", dag, "--format", "json"], { env: { ...process.env, DAGU_HOME: fixture.home }, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
      });
      history();
      service = spawn(process.execPath, ["-e", "process.stdin.resume(); console.log('ready')", "start-all"], {
        argv0: "dagu", env: { DAGU_HOME: fixture.home, PATH: serviceBin }, stdio: ["pipe", "pipe", "pipe"],
      });
      await once(service.stdout!, "data");
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const env = { ...process.env, DAGU_HOME: fixture.home, A4S_PRIMARY: fixture.packageDir,
        DAGU_URL: `http://127.0.0.1:${address.port}`, A4S_FIXTURE_RELEASES: fixture.releases,
        PATH: `${dirname(binary)}:${bin}:${process.env.PATH ?? ""}` };
      const check = async (status: number, reason: RegExp) => {
        const histories = history();
        const homeBefore = snapshot(fixture.home), repoBefore = snapshot(fixture.packageDir);
        const result = await exec("a4s", ["admit", "--check", "--run-id", "sprint-admission-check", "feature", "--", "ISSUE=277", "OMP_SESSION_ID=owner-session"], {
          cwd: fixture.packageDir, env, timeout: 15000,
        }).then(output => ({ ...output, status: 0 }), error => ({ stdout: String(error.stdout), stderr: String(error.stderr), status: error.code }));
        assert.equal(result.status, status, result.stdout + result.stderr);
        assert.match(result.stdout, status === 0 ? /admissible=yes/ : /admissible=no/);
        assert.match(result.stdout, reason);
        assert.deepEqual(history(), histories);
        assert.deepEqual(snapshot(fixture.home), homeBefore);
        assert.deepEqual(snapshot(fixture.packageDir), repoBefore);
      };
      await check(0, /artifact=\S+@/);
      // Repeating a check with the same id still creates no receipt or run.
      await check(0, /service-environment ready=yes/);
      stationConfig(false);
      queuePresent = false;
      await check(1, /missing lane queue/);
      stationConfig(true);
      queuePresent = true;
      active = false;
      await check(1, /no active Dagu scheduler/);
      active = true;
      writeFileSync(fixture.configPath, JSON.stringify({ ...exampleConfig({ lane }), schemaVersion: 1, uses: "a4s@v0.7.8" }));
      for (const args of [["add", ".workspace/dagu/config.json"], ["commit", "-qm", "historical policy"]]) {
        const result = spawnSync("git", ["-C", fixture.packageDir, ...args], { encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
      }
      await check(1, /admission requires config schema 2/);
      fixture.writeConfig({ lane });
      writeFileSync(fixture.configPath, `${readFileSync(fixture.configPath, "utf8")}\n`);
      await check(1, /uncommitted config file/);
      fixture.writeConfig({ lane });
      for (const args of [["rm", "-q", ".workspace/dagu/config.json"], ["commit", "-qm", "remove config"]]) {
        const result = spawnSync("git", ["-C", fixture.packageDir, ...args], { encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
      }
      await check(1, /missing committed config file/);
      assert.ok(requests.length > 0);
      assert.ok(requests.every(request => request === "GET /api/v1/queues" || request === "GET /api/v1/services/scheduler"));
      assert.equal(existsSync(join(fixture.releases, "gh-calls.jsonl")), false, "station-current checks do not resolve release aliases or download assets");
    } finally {
      server.close();
      if (service) { service.kill(); await once(service, "exit"); }
      fixture.dispose();
    }
  }
});
