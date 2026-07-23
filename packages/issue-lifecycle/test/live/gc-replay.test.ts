import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ensureArtifact } from "../../../launcher/src/artifact-cache.ts";
import { exampleConfig, serializeConfig } from "../../../launcher/src/config.ts";
import { archiveName, artifactToken, checksumDigest, nativePlatform, type ArtifactTuple } from "../../../launcher/src/release.ts";
import { selectPayload, restoreArtifact } from "../../../launcher/src/select.ts";
import { gc, initializeStation } from "../../../launcher/src/station.ts";
import { listStationRuns } from "../../../launcher/src/station-inventory.ts";
import { commitStateLocked, readStateLocked, stationRoot, stationTransaction } from "../../../launcher/src/station-state.ts";
import { tickBindingPath } from "../../../launcher/src/tick-binding.ts";
import { installGithubFixture, makeArchive, writeReleaseDirectory } from "../fixtures/artifact.ts";
import { roleAdmission } from "../role-job-fixtures.ts";

async function port(): Promise<number> {
  const server = createServer(), ready = Promise.withResolvers<void>();
  server.once("error", ready.reject); server.listen(0, "127.0.0.1", ready.resolve); await ready.promise;
  const address = server.address(); assert.ok(address && typeof address === "object");
  const closed = Promise.withResolvers<void>(); server.close(() => closed.resolve()); await closed.promise; return address.port;
}
async function exit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  const result = Promise.withResolvers<number | null>(); child.once("error", result.reject); child.once("exit", result.resolve); return result.promise;
}
function directories(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? [join(path, entry.name), ...directories(join(path, entry.name))] : []);
}
function containsRun(path: string, run: string): boolean {
  return readdirSync(path, { withFileTypes: true }).some(entry => entry.isDirectory() ? containsRun(join(path, entry.name), run) : entry.isFile() && readFileSync(join(path, entry.name), "utf8").includes(run));
}

test("native GC preserves admissions, exact replay, cursor history and bindings until native retention", { skip: process.env.A4S_LIVE_DAGU !== "1", timeout: 300000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a4s-gc-live-"))), home = join(root, "home"), primary = join(root, "repo");
  const releases = process.env.A4S_GC_RELEASES || join(root, "releases"), bin = installGithubFixture(join(root, "bin"));
  const repository = fileURLToPath(new URL("../../../../", import.meta.url));
  const saved = { ...process.env }, children: ChildProcess[] = [];
  let service: ChildProcess | undefined, serviceLog = "";
  try {
    for (const path of [join(home, "dags"), primary, releases]) mkdirSync(path, { recursive: true });
    const dagu = realpathSync(execFileSync("which", ["dagu"], { encoding: "utf8" }).trim());
    const version = execFileSync(dagu, ["version"], { encoding: "utf8" }).trim();
    assert.match(version, /2\.24\.0/);
    t.diagnostic(`Dagu ${version}; sha256=${createHash("sha256").update(readFileSync(dagu)).digest("hex")}`);
    function build(version: string, commit: string): ArtifactTuple {
      const archive = archiveName(version);
      if (!existsSync(join(releases, archive))) execFileSync(process.execPath, ["scripts/build-a4s.mjs", "--target", `bun-${nativePlatform()}`, "--outdir", releases, "--test-version", version, "--test-commit", commit], { cwd: repository, env: { ...process.env, A4S_LIVE_DAGU: "1" }, stdio: "pipe", timeout: 120000 });
      const directory = join(stationRoot(home), version); mkdirSync(directory, { recursive: true });
      execFileSync("tar", ["-xzf", join(releases, archive), "-C", directory]);
      copyFileSync(join(releases, archive), join(directory, "verified-archive.tar.gz"));
      const tuple = { version, commit, digest: checksumDigest(readFileSync(join(releases, `${archive}.sha256`), "utf8"), archive) };
      writeFileSync(join(directory, "artifact.json"), JSON.stringify({ ...tuple, verifiedAt: new Date().toISOString() })); return tuple;
    }
    const a = build("r7961", "a".repeat(40)), b = build("r7962", "b".repeat(40));
    writeReleaseDirectory(releases, { repository: "pablontiv/a4s", moving: {}, releases: [...[a, b].map(tuple => ({ tag_name: `a4s-${tuple.version}`, commit: tuple.commit })),
      ...Array.from({ length: 10 }, (_, index) => ({ tag_name: `a4s-r${8001 + index}`, commit: (8001 + index).toString(16).padStart(40, "0") }))] });
    const git = (...args: string[]) => execFileSync("git", ["-C", primary, ...args], { encoding: "utf8" }).trim();
    git("init", "-qb", "main"); git("config", "user.name", "GC fixture"); git("config", "user.email", "gc@example.invalid"); git("remote", "add", "origin", "https://github.com/fixture/repo.git");
    mkdirSync(join(primary, ".workspace/dagu"), { recursive: true });
    writeFileSync(join(primary, ".workspace/dagu/config.json"), serializeConfig(exampleConfig({ lane: "fixture" })));
    git("add", "."); git("commit", "-qm", "fixture policy");
    const httpPort = await port(), url = `http://127.0.0.1:${httpPort}`;
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, DAGU_HOME: home, DAGU_URL: url, DAGU_PORT: String(httpPort), DAGU_COORDINATOR_ENABLED: "false", A4S_PRIMARY: primary, A4S_FIXTURE_RELEASES: releases, PATH: `${bin}:${process.env.PATH}` };
    for (const key of ["DAGU_QUEUE_DISPATCH_RETRY", "DAG_PUSHBACK_ITERATION", "DAGU_OUTPUT_FILE", "DAG_RUN_ID", "DAG_NAME", "RUN", "PRIMARY", "A4S_ARTIFACT", "A4S_BIN"]) delete env[key];
    Object.assign(process.env, { DAGU_HOME: home, DAGU_URL: url, A4S_PRIMARY: primary, A4S_FIXTURE_RELEASES: releases, PATH: env.PATH });
    writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${httpPort}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\nscheduler:\n  port: 0\n`);
    writeFileSync(join(home, "a4s-primary"), `${primary}\n`);
    // The native admission's tick payload is a real compiled version invocation:
    // no fixture can accidentally execute the feature lifecycle or publish work.
    writeFileSync(join(bin, "a4s"), `#!/bin/sh\nexec ${JSON.stringify(join(stationRoot(home), a.version, "a4s"))} version\n`, { mode: 0o755 });
    writeFileSync(join(bin, "dagu"), `#!/bin/sh\nif [ "$1" = enqueue ] && [ -n "$GC_PAUSE" ]; then\n  : > "$GC_PAUSE"\n  while [ ! -f "$GC_CONTINUE" ]; do sleep 0.02; done\n  [ "$GC_INCIDENT" != 1 ] || exit 77\nfi\nexec ${JSON.stringify(dagu)} "$@"\n`, { mode: 0o755 });
    await initializeStation(home, a, { listRuns: async () => [] });
    async function until<T>(description: string, probe: () => Promise<T | undefined>): Promise<T> {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) { const result = await probe(); if (result !== undefined) return result; await delay(50); }
      throw new Error(`Timed out ${description}\n${serviceLog}`);
    }
    async function startService() {
      service = spawn(dagu, ["start-all", "--host", "127.0.0.1", "--port", String(httpPort)], { env, stdio: ["ignore", "pipe", "pipe"] }); children.push(service);
      service.stdout!.on("data", bytes => { serviceLog += bytes; }); service.stderr!.on("data", bytes => { serviceLog += bytes; });
      await until("isolated API", async () => { try { return (await fetch(`${url}/api/v1/dag-runs`)).ok ? true : undefined; } catch { return undefined; } });
    }
    async function stopService() { service!.kill("SIGTERM"); assert.equal(await exit(service!), 0); service = undefined; }
    const detailUrl = (dag: string, run: string) => `${url}/api/v1/dag-runs/${dag}/${run}`;
    const details = async (dag: string, run: string) => { const response = await fetch(detailUrl(dag, run)); return response.ok ? (await response.json()).dagRunDetails : undefined; };
    const native = (dag: string, run: string) => {
      const child = spawn(dagu, ["start", "--run-id", run, join(home, "dags", `${dag}.yaml`)], { env, stdio: ["ignore", "pipe", "pipe"] }); children.push(child);
      child.stdout!.on("data", bytes => { serviceLog += bytes; }); child.stderr!.on("data", bytes => { serviceLog += bytes; }); return child;
    };
    const switchState = (tuple: ArtifactTuple) => stationTransaction(home, async () => { const state = readStateLocked(home); commitStateLocked(home, { ...state, generation: state.generation + 1, current: tuple, previous: tuple }); });
    function unlease(id: string) { rmSync(join(stationRoot(home), "leases", `${id}.json`)); }
    writeFileSync(join(home, "dags/reconcile.yaml"), "hist_retention_runs: 1\nsteps:\n  - id: noop\n    run: sleep 1\n");
    await startService();
    const first = native("reconcile", "retained-r1");
    await until("R1 native identity", async () => (await details("reconcile", "retained-r1"))?.statusLabel === "running" ? true : undefined);
    const selection = await selectPayload(home, ["tick"], { env: { DAG_RUN_ID: "retained-r1", DAG_NAME: "reconcile" } });
    assert.deepEqual(JSON.parse(readFileSync(tickBindingPath(home, "retained-r1"), "utf8")).tuple, a);
    assert.equal(await exit(first), 0); unlease(selection.lease.id);
    assert.equal((await fetch(detailUrl("reconcile", "retained-r1"))).status, 200);
    await gc(home); assert.ok(existsSync(tickBindingPath(home, "retained-r1")));
    await stopService();
    await assert.rejects(gc(home), /fetch failed|ECONNREFUSED/);
    assert.ok(existsSync(tickBindingPath(home, "retained-r1")));
    await startService(); assert.equal((await fetch(detailUrl("reconcile", "retained-r1"))).status, 200);
    // Small, genuine shell-identity fixture archives age the compiled selected
    // build out of highest-ten without compiling ten irrelevant 116 MB payloads.
    for (let id = 8001; id <= 8010; id++) await ensureArtifact(home, makeArchive(releases, `r${id}`, id.toString(16).padStart(40, "0")));
    await switchState(b);
    assert.ok((await gc(home)).removed.includes(a.version)); assert.ok(existsSync(tickBindingPath(home, "retained-r1")));
    const replay = await selectPayload(home, ["tick"], { env: { DAG_RUN_ID: "retained-r1" } });
    assert.deepEqual({ version: replay.cached.record.version, commit: replay.cached.record.commit, digest: replay.cached.record.digest }, a);
    assert.deepEqual(readStateLocked(home).current, b); unlease(replay.lease.id);
    assert.equal(JSON.parse(execFileSync(replay.cached.executable, ["version"], { encoding: "utf8" })).version, a.version);
    assert.equal(await exit(native("reconcile", "retention-r2")), 0);
    await until("native count retention", async () => { const response = await fetch(detailUrl("reconcile", "retained-r1")); if (response.status !== 404) return undefined; const body = await response.json(); assert.equal(body.code, "not_found"); return true; });
    assert.equal((await fetch(detailUrl("reconcile", "retention-r2"))).status, 200);
    await gc(home); assert.equal(existsSync(tickBindingPath(home, "retained-r1")), false);
    t.diagnostic("terminal binding retained through success, ECONNREFUSED and exact-tuple pruning/replay; deleted only after native hist_retention_runs: 1 purged R1");

    async function admission(run: string, incident: boolean) {
      await restoreArtifact(home, a); await switchState(a);
      const pause = join(root, `${run}-paused`), resume = join(root, `${run}-continue`);
      const child = spawn(join(stationRoot(home), a.version, "a4s"), ["admit", "--artifact", artifactToken(a), "--run-id", run, "reconcile.yaml", "--", "OMP_SESSION_ID=gc-owner"], { cwd: primary, env: { ...env, GC_PAUSE: pause, GC_CONTINUE: resume, ...(incident ? { GC_INCIDENT: "1" } : {}) }, stdio: ["ignore", "pipe", "pipe"] }); children.push(child);
      let output = ""; child.stdout!.on("data", bytes => { output += bytes; }); child.stderr!.on("data", bytes => { output += bytes; });
      await until("receipt-to-enqueue pause", async () => { if (child.exitCode !== null) throw new Error(output); return existsSync(pause) ? true : undefined; });
      const path = join(primary, ".git/dagu-feature/runs", run, "receipt.json"), receipt = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(typeof receipt.receiptCreatedAt, "string");
      const leases = join(stationRoot(home), "leases");
      const lease = readdirSync(leases).find(name => { const record = JSON.parse(readFileSync(join(leases, name), "utf8")); return record.kind === "engine" && record.pid === child.pid; });
      assert.ok(lease);
      await switchState(b);
      const report = await gc(home);
      assert.ok(report.retained.find(row => row.version === a.version)!.holders.some(holder => holder.includes("pending admission")));
      assert.ok(report.retained.find(row => row.version === a.version)!.holders.some(holder => holder.includes("engine lease")));
      assert.ok(existsSync(join(stationRoot(home), a.version, "a4s")));
      writeFileSync(resume, "continue"); assert.equal(await exit(child), incident ? 77 : 0, output);
      assert.ok(existsSync(join(leases, lease)), "only GC's dead-or-reused probe frees the exited admission lease");
      return path;
    }
    await admission("paused-admission", false);
    await until("admitted native run", async () => (await details("reconcile", "paused-admission"))?.statusLabel === "succeeded" ? true : undefined);
    const ambiguous = await admission("ambiguous-admission", true), original = readFileSync(ambiguous, "utf8");
    assert.equal(JSON.parse(original).runReceipt.observations.at(-1).kind, "incident");
    assert.ok((await gc(home)).retained.find(row => row.version === a.version)!.holders.some(holder => holder.includes("pending admission")));
    assert.ok((await gc(home, { now: () => Date.now() + 8 * 86400000 })).removed.includes(a.version));
    const restored = await selectPayload(home, ["run", "--primary", primary, "--run", "ambiguous-admission", "--", "version"], { env: {} });
    assert.deepEqual({ version: restored.cached.record.version, commit: restored.cached.record.commit, digest: restored.cached.record.digest }, a); unlease(restored.lease.id);
    assert.equal(readFileSync(ambiguous, "utf8"), original);
    t.diagnostic("receipt-to-enqueue pause preserves canonical executable; ambiguous receipt retains seven days, then exact immutable restore without receipt mutation");

    writeFileSync(join(home, "dags/aged.yaml"), "hist_retention_days: 90\nsteps:\n  - id: noop\n    run: 'true'\n");
    assert.equal(await exit(native("aged", "aged-run")), 0);
    await stopService();
    const candidates = directories(join(home, "data")).filter(path => /dag-run_\d{8}_/.test(path.split("/").at(-1)!) && containsRun(path, "aged-run"));
    assert.equal(candidates.length, 1);
    const aged = new Date(Date.now() - 40 * 86400000), year = String(aged.getFullYear()), month = String(aged.getMonth() + 1).padStart(2, "0"), day = String(aged.getDate()).padStart(2, "0");
    const target = candidates[0]!.replace(/\/\d{4}\/\d{2}\/\d{2}\/dag-run_\d{8}_/, `/${year}/${month}/${day}/dag-run_${year}${month}${day}_`);
    assert.notEqual(target, candidates[0]); mkdirSync(dirname(target), { recursive: true }); renameSync(candidates[0]!, target);
    t.diagnostic("date regression uses an explicitly aged native storage creation directory while offline; never used to simulate retention purge");
    await startService();
    const defaultList = await (await fetch(`${url}/api/v1/dag-runs`)).json();
    assert.equal(defaultList.dagRuns.some((run: { dagRunId: string }) => run.dagRunId === "aged-run"), false);
    const release = join(root, "release-running");
    for (const dag of ["alpha", "beta"]) {
      const snapshot = `hist_retention_days: 90\nenv:\n  - PRIMARY: ${JSON.stringify(primary)}\nsteps:\n  - id: hold\n    run: while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.05; done\n`;
      writeFileSync(join(home, "dags", `${dag}.yaml`), snapshot);
      const receipt = roleAdmission(primary, home, `${dag}-running`, snapshot, a); receipt.initial.admittedAt = new Date(Date.now() - 40 * 86400000).toISOString();
      receipt.runReceipt!.dag = dag;
      const path = join(primary, ".git/dagu-feature/runs", `${dag}-running`, "receipt.json"); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(receipt));
    }
    // Start both within one creation second to exercise cursor tie-breaking.
    await delay(1000 - Date.now() % 1000 + 20);
    const alpha = native("alpha", "alpha-running"), beta = native("beta", "beta-running");
    await until("two cross-DAG running references", async () => (await details("alpha", "alpha-running"))?.statusLabel === "running" && (await details("beta", "beta-running"))?.statusLabel === "running" ? true : undefined);
    const creationSecond = (run: string) => directories(join(home, "data")).find(path => /dag-run_\d{8}_/.test(path.split("/").at(-1)!) && containsRun(path, run))?.match(/dag-run_(\d{8}_\d{6})/)?.[1];
    assert.ok(creationSecond("alpha-running")); assert.equal(creationSecond("alpha-running"), creationSecond("beta-running"));
    let pages = 0, fullTerminal = false;
    const actualFetch = globalThis.fetch;
    const observe = t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const response = await actualFetch(input, init), url = new URL(String(input));
      if (url.pathname === "/api/v1/dag-runs") { const body = await response.clone().json(); pages++; if (!Object.hasOwn(body, "nextCursor")) fullTerminal = body.dagRuns.length === 1; }
      return response;
    });
    const inventory = await listStationRuns(home, 1);
    assert.ok(inventory.some(run => run.dagRunId === "aged-run")); assert.ok(pages > 2); assert.ok(fullTerminal);
    assert.ok(inventory.some(run => run.name === "alpha" && run.dagRunId === "alpha-running" && run.statusLabel === "running"));
    assert.ok(inventory.some(run => run.name === "beta" && run.dagRunId === "beta-running" && run.statusLabel === "running"));
    const report = await gc(home, { listRuns: () => listStationRuns(home, 1), now: () => Date.now() + 8 * 86400000 });
    assert.ok(report.retained.find(row => row.version === a.version)!.holders.some(holder => holder.includes("alpha/alpha-running")));
    assert.ok(report.retained.find(row => row.version === a.version)!.holders.some(holder => holder.includes("beta/beta-running")));
    observe.mock.restore(); writeFileSync(release, "release"); assert.equal(await exit(alpha), 0); assert.equal(await exit(beta), 0);
    t.diagnostic(`cross-DAG opaque cursors: ${pages} observed pages, aged native history and both running references retained, terminal full page without cursor`);
  } finally {
    // Release only this throwaway home's processes; no station/service mutation.
    writeFileSync(join(root, "release-running"), "release");
    for (const run of ["paused-admission", "ambiguous-admission"]) writeFileSync(join(root, `${run}-continue`), "continue");
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.all(children.map(child => exit(child)));
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved); rmSync(root, { recursive: true, force: true });
  }
});
