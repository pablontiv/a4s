import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import { archiveName, checksumDigest, nativePlatform, type ArtifactTuple } from "../../../launcher/src/release.ts";
import { initializeStation } from "../../../launcher/src/station.ts";
import { stationRoot } from "../../../launcher/src/station-state.ts";
import { tickBindingPath } from "../../../launcher/src/tick-binding.ts";
import { exampleConfig, serializeConfig } from "../../../launcher/src/config.ts";
import { roleAdmission } from "../role-job-fixtures.ts";
import { isRecord } from "../../../launcher/src/type-guard.ts";

async function port(): Promise<number> {
  const server = createServer(), listening = Promise.withResolvers<void>();
  server.once("error", listening.reject); server.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
  const address = server.address(); assert.ok(address && typeof address === "object");
  const closed = Promise.withResolvers<void>(); server.close(() => closed.resolve()); await closed.promise; return address.port;
}
function logs(directory: string): string {
  if (!existsSync(directory)) return "";
  return readdirSync(directory, { withFileTypes: true }).map(entry => entry.isDirectory() ? logs(join(directory, entry.name)) : entry.isFile() ? readFileSync(join(directory, entry.name), "utf8") : "").join("\n");
}

test("native scheduled tick A promotes B, dispatches B's receipt, and missing retry binding fails closed", { skip: process.env.A4S_LIVE_DAGU !== "1", timeout: 300_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "a4s-native-tick-")), home = join(root, "home"), primary = join(root, "repo"), releases = join(root, "releases"), bin = join(root, "bin");
  const repository = fileURLToPath(new URL("../../../../", import.meta.url));
  const previous = { home: process.env.DAGU_HOME, url: process.env.DAGU_URL };
  let service: ChildProcess | undefined, serviceLog = "";
  try {
    for (const path of [join(home, "dags"), primary, releases, bin]) mkdirSync(path, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-C", primary, ...args], { encoding: "utf8" }).trim();
    git("init", "-qb", "main"); git("config", "user.name", "Tick fixture"); git("config", "user.email", "tick@example.invalid");
    git("remote", "add", "origin", "https://github.com/fixture/repo.git");
    mkdirSync(join(primary, ".workspace/dagu"), { recursive: true });
    writeFileSync(join(primary, ".workspace/dagu/config.json"), serializeConfig(exampleConfig({ lane: "fixture" })));
    git("add", "."); git("commit", "-qm", "policy");
    function build(version: string, commit: string): ArtifactTuple {
      execFileSync(process.execPath, ["scripts/build-a4s.mjs", "--target", `bun-${nativePlatform()}`, "--outdir", releases, "--test-version", version, "--test-commit", commit], { cwd: repository, env: { ...process.env, A4S_LIVE_DAGU: "1" }, stdio: "pipe", timeout: 120_000 });
      const name = archiveName(version), directory = join(stationRoot(home), version); mkdirSync(directory, { recursive: true });
      execFileSync("tar", ["-xzf", join(releases, name), "-C", directory]);
      copyFileSync(join(releases, name), join(directory, "verified-archive.tar.gz"));
      const tuple = { version, commit, digest: checksumDigest(readFileSync(join(releases, `${name}.sha256`), "utf8"), name) };
      writeFileSync(join(directory, "artifact.json"), JSON.stringify({ ...tuple, verifiedAt: new Date().toISOString() }));
      return tuple;
    }
    const a = build("r9001", "a".repeat(40)), b = build("r9002", "b".repeat(40));
    const launcher = join(root, "launcher"); mkdirSync(launcher);
    execFileSync("tar", ["-xzf", join(releases, `a4s-launch-${nativePlatform()}.tar.gz`), "-C", launcher]);
    symlinkSync(join(launcher, "a4s-launch"), join(bin, "a4s"));
    const installed = readFileSync(join(launcher, "reconcile.yaml"), "utf8"), dag = parse(installed);
    assert.deepEqual(dag.steps, [{ id: "tick", run: "a4s tick" }]);
    assert.doesNotMatch(installed, /A4S_BIN|A4S_ARTIFACT|r900/);
    const offline = join(root, "offline");
    writeFileSync(join(bin, "gh"), `#!/usr/bin/env node\nconst fs=require('node:fs'); const args=process.argv.slice(2), command=args.join(' ');\nif(fs.existsSync(${JSON.stringify(offline)})) process.exit(1);\nif(args[0]==='repo') console.log('fixture/repo');\nelse if(command.includes('/releases?')) console.log(JSON.stringify([[{tag_name:'a4s-r9002',draft:false,prerelease:false}]]));\nelse if(command.includes('/releases/tags/')) console.log(JSON.stringify({tag_name:'a4s-r9002',draft:false,prerelease:false}));\nelse if(command.includes('/git/ref/')) console.log(JSON.stringify({object:{sha:${JSON.stringify(b.commit)},type:'commit'}}));\nelse if(args[0]==='release') process.stdout.write(fs.readFileSync(${JSON.stringify(releases)}+'/'+args[args.indexOf('--pattern')+1]));\nelse if(command.includes('/issues?')) console.log(JSON.stringify([{number:189,state:'open'}]));\nelse { console.error(command); process.exit(2); }\n`, { mode: 0o755 });
    const httpPort = await port(), schedulerPort = await port(), url = `http://127.0.0.1:${httpPort}`;
    const env: NodeJS.ProcessEnv = { ...process.env, DAGU_HOME: home, DAGU_URL: url, DAGU_PORT: String(httpPort), DAGU_COORDINATOR_ENABLED: "false", A4S_PRIMARY: primary, DAGU_PARAMS_JSON: "{}", PATH: `${bin}:${process.env.PATH}` };
    // Native scheduler/CLI requests own dispatch context and output independently of the enclosing role job.
    delete env.DAGU_QUEUE_DISPATCH_RETRY; delete env.DAG_PUSHBACK_ITERATION; delete env.DAGU_OUTPUT_FILE;
    writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${httpPort}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\nscheduler:\n  port: ${schedulerPort}\n`);
    writeFileSync(join(home, "a4s-primary"), `${primary}\n`);
    process.env.DAGU_HOME = home; process.env.DAGU_URL = url;
    await initializeStation(home, a, { listRuns: async () => [] });
    const snapshot = `type: graph\nlabels: [workspace=fixture]\nparams:\n  - ISSUE: 189\n  - PRIMARY: ${JSON.stringify(primary)}\nenv:\n  - PRIMARY: ${JSON.stringify(primary)}\nsteps:\n  - id: hold\n    action: human.task\n    with:\n      prompt: Hold this receipt-bound native run\n`;
    writeFileSync(join(home, "dags/feature.yaml"), snapshot);
    const receipt = roleAdmission(primary, home, "run-b", snapshot, b);
    assert.ok(isRecord(receipt.initial.deployment.config)); receipt.initial.deployment.config.schemaVersion = 2;
    const receiptPath = join(primary, ".git/dagu-feature/runs/run-b/receipt.json"); mkdirSync(dirname(receiptPath), { recursive: true }); writeFileSync(receiptPath, JSON.stringify(receipt));
    service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(httpPort)], { env, stdio: ["ignore", "pipe", "pipe"] });
    service.stdout!.on("data", bytes => { serviceLog += bytes; }); service.stderr!.on("data", bytes => { serviceLog += bytes; });
    async function until<T>(name: string, probe: () => Promise<T | undefined>, timeout = 90_000): Promise<T> {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { const value = await probe(); if (value !== undefined) return value; await delay(200); }
      throw new Error(`Timed out ${name}\n${serviceLog}\n${logs(join(home, "logs"))}`);
    }
    const run = (...args: string[]) => execFileSync("dagu", args, { env, encoding: "utf8", timeout: 15_000 });
    async function details(name: string, id: string): Promise<Record<string, unknown> | undefined> {
      try {
        const result = await fetch(`${url}/api/v1/dag-runs/${name}/${id}`);
        const value: unknown = result.ok ? await result.json() : undefined;
        return isRecord(value) && isRecord(value.dagRunDetails) ? value.dagRunDetails : undefined;
      } catch { return undefined; }
    }
    await until("native API", async () => { try { return (await fetch(`${url}/api/v1/dag-runs`)).ok ? true : undefined; } catch { return undefined; } }, 30_000);
    run("enqueue", "--run-id", "run-b", "feature");
    await until("foreign run waiting", async () => (await details("feature", "run-b"))?.statusLabel === "waiting" ? true : undefined);
    // Install only after the foreign receipt-bound run is visible to discovery.
    writeFileSync(join(home, "dags/reconcile.yaml"), installed);
    const tickId = await until("fresh scheduled tick success", async () => {
      const response = await fetch(`${url}/api/v1/dag-runs/reconcile?fromDate=0`); if (!response.ok) return undefined;
      const value: unknown = await response.json();
      assert.ok(isRecord(value) && Array.isArray(value.dagRuns));
      const runs = value.dagRuns.filter(isRecord);
      const failed = runs.find(item => item.statusLabel === "failed");
      if (failed) throw new Error(`Scheduled tick failed\n${logs(join(home, "logs"))}`);
      const selected = runs.find(item => item.statusLabel === "succeeded");
      return typeof selected?.dagRunId === "string" ? selected.dagRunId : undefined;
    });
    assert.equal((await details("reconcile", tickId))?.triggerType, "scheduler");
    assert.deepEqual(JSON.parse(readFileSync(tickBindingPath(home, tickId), "utf8")).tuple, a);
    assert.deepEqual(JSON.parse(readFileSync(join(stationRoot(home), "state.json"), "utf8")).current, b);
    assert.match(logs(join(home, "logs")), /a4s-run run=run-b artifact=r9002@b{40}#[a-f0-9]{64} command=reconcile inspect/);
    console.log("PASS scheduled first attempt binds A; A promotes B; foreign run action executes receipt B");
    writeFileSync(offline, "offline");
    run("enqueue", "--run-id", "retry-tick", "reconcile");
    await until("first failed attempt", async () => (await details("reconcile", "retry-tick"))?.statusLabel === "failed" ? true : undefined);
    assert.equal((await details("reconcile", "retry-tick"))?.triggerType, "manual");
    assert.deepEqual(JSON.parse(readFileSync(tickBindingPath(home, "retry-tick"), "utf8")).tuple, b);
    rmSync(offline); rmSync(tickBindingPath(home, "retry-tick"));
    const retry = spawnSync("dagu", ["retry", "--run-id", "retry-tick", "reconcile"], { env, encoding: "utf8", timeout: 15_000 });
    if (retry.error) throw retry.error;
    await until("native retry refusal", async () => { const value = await details("reconcile", "retry-tick"); return value?.triggerType === "retry" && value.statusLabel === "failed" ? true : undefined; });
    assert.equal(existsSync(tickBindingPath(home, "retry-tick")), false);
    assert.equal(retry.status, 1, retry.stderr);
    assert.match(logs(join(home, "logs")), /Missing tick binding for retry-tick; attempt=retry; refusing to repin/);
    console.log("PASS missing binding on native same-ID retry fails closed without repinning");
    const statePath = join(stationRoot(home), "state.json"), state = readFileSync(statePath, "utf8");
    writeFileSync(statePath, JSON.stringify({ ...JSON.parse(state), schema: 99 }));
    const rejected = spawnSync(join(bin, "a4s"), ["version"], { env, encoding: "utf8" });
    assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /Unknown station state schema; reinstall a4s-launch/);
    writeFileSync(statePath, state);
    console.log("PASS unknown state schema fails closed before executing current");
  } finally {
    service?.kill("SIGTERM");
    if (service && service.exitCode === null) {
      const stopped = Promise.withResolvers<void>(); service.once("exit", () => stopped.resolve()); await stopped.promise;
    }
    if (previous.home === undefined) delete process.env.DAGU_HOME; else process.env.DAGU_HOME = previous.home;
    if (previous.url === undefined) delete process.env.DAGU_URL; else process.env.DAGU_URL = previous.url;
    rmSync(root, { recursive: true, force: true });
  }
});
