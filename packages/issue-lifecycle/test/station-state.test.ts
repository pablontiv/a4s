import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { initializeStation, promote, rollback, gc } from "../../launcher/src/station.ts";
import { selectStationBuild } from "../../launcher/src/lease.ts";
import { readStationState, stationRoot, validateState } from "../../launcher/src/station-state.ts";
import { inventoryStation, listStationRuns } from "../../launcher/src/station-inventory.ts";
import { stationFixture } from "./fixtures/station.ts";

for (const point of ["before-rename", "after-rename"] as const) {
  test(`atomic state ${point} fault exposes only old or new to launcher, loader, rollback and GC`, async t => {
    const f = stationFixture(t), old = await f.release("r1"), candidate = await f.release("r2");
    await initializeStation(f.home, old, f.dependencies);
    await assert.rejects(promote(f.home, { ...f.dependencies, releases: async () => [candidate], fault: stage => { if (stage === point) throw new Error("injected crash"); } }), /injected crash/);
    const expected = point === "before-rename" ? old : candidate;
    const state = await readStationState(f.home, f.dependencies);
    assert.equal(state.current.version, expected.version);
    assert.equal(state.generation, point === "before-rename" ? 0 : 1);
    assert.equal(readlinkSync(join(stationRoot(f.home), "current")), expected.version);
    for (const kind of ["launcher", "plugin"] as const) assert.equal((await selectStationBuild(f.home, kind, "atomic reader", f.dependencies)).artifact.version, expected.version);
    const report = await gc(f.home, f.dependencies);
    assert.ok(report.retained.some(entry => entry.version === expected.version && entry.holders.includes("current")));
    assert.equal((await rollback(f.home, f.dependencies)).current.version, old.version);
    assert.ok(f.calls.every(path => path.endsWith(".state.lock") || path.endsWith(".lock")));
    assert.ok(!readdirSync(stationRoot(f.home)).some(name => name.endsWith(".tmp")));
  });
}

test("native resource discovery is a repairable state-derived cache pointer, not an execution selector", async t => {
  const f = stationFixture(t), current = await f.release("r1"), next = await f.release("r2");
  await initializeStation(f.home, current, f.dependencies);
  const pointer = join(stationRoot(f.home), "current");
  rmSync(pointer);
  symlinkSync("r999", pointer);
  assert.equal((await readStationState(f.home, f.dependencies)).current.version, "r1");
  assert.equal(readlinkSync(pointer), "r1");
  await promote(f.home, { ...f.dependencies, releases: async () => [next] });
  assert.equal(readlinkSync(pointer), "r2");
  const loader = join(stationRoot(f.home), "loader");
  mkdirSync(loader);
  writeFileSync(join(loader, "package.json"), '{"name":"@a4s/loader"}');
  await gc(f.home, f.dependencies);
  assert.ok(existsSync(join(loader, "package.json")));
  await rollback(f.home, f.dependencies);
  assert.equal(readlinkSync(pointer), "r1");
});

test("state schemas, format sets and symlinks fail closed; initialization cannot overwrite", async t => {
  const f = stationFixture(t), old = await f.release("r1");
  await initializeStation(f.home, old, f.dependencies);
  await assert.rejects(initializeStation(f.home, old, f.dependencies), /already initialized/);
  for (const value of [{ ...f.state(), schema: 99 }, { ...f.state(), generation: -1 }, { ...f.state(), formats: { receipt: [2] } }, { ...f.state(), formats: { ...f.state().formats, config: [1, 1] } }]) assert.throws(() => validateState(value));
  writeFileSync(join(stationRoot(f.home), "state.json"), JSON.stringify({ ...f.state(), schema: 99 }));
  await assert.rejects(selectStationBuild(f.home, "launcher", "schema test", f.dependencies), /reinstall a4s-launch/);
  const other = join(f.root, "other"); mkdirSync(other);
  const home = join(f.root, "linked"); symlinkSync(other, home);
  await assert.rejects(readStationState(home, f.dependencies), /symlinks/);
});

test("cutover inventories legacy and current receipts, committed configs, SQL/payloads and run/checkpoint state", async t => {
  const f = stationFixture(t), current = await f.release("r1"), primary = join(f.root, "repo"), directory = join(primary, ".git", "dagu-feature"), run = join(directory, "runs", "old");
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, "receipt.json"), JSON.stringify({ schemaVersion: 1, initial: { admittedAt: "2026-10-01T00:00:00Z" }, runReceipt: { dag: "feature", run: "old" } }));
  writeFileSync(join(run, "pr.json"), "{}");
  const db = new DatabaseSync(join(f.home, "role-jobs.sqlite"));
  db.exec("CREATE TABLE jobs(document TEXT, result TEXT)");
  db.prepare("INSERT INTO jobs VALUES (?,?)").run(JSON.stringify({ schemaVersion: 1, binding: { repo: primary, run: "old", dag: "feature" } }), JSON.stringify({ schemaVersion: 1 })); db.close();
  const { inventory: _, ...dependencies } = f.dependencies;
  const state = await initializeStation(f.home, current, { ...dependencies, primaries: () => [primary], gitPath: () => directory, configVersion: () => 1 });
  assert.deepEqual(state.formats.receipt, [1, 2]);
  assert.deepEqual(state.formats.config, [1, 2]);
  for (const name of ["roleJobStore", "roleJobPayload", "runState", "prCheckpoint"] as const) assert.deepEqual(state.formats[name], [1]);
  assert.equal(JSON.parse(readFileSync(join(run, "receipt.json"), "utf8")).schemaVersion, 1);
});

test("GC keeps 10 highest IDs, current, previous, all referenced builds, and aborts before deletion on unreadable sources", async t => {
  const f = stationFixture(t), entries = [];
  for (let id = 1; id <= 14; id++) entries.push(await f.release(`r${id}`));
  await initializeStation(f.home, entries[0]!, f.dependencies);
  f.setState({ ...f.state(), previous: entries[1]! });
  const referenced = entries[2]!;
  const report = await gc(f.home, { ...f.dependencies, inventory: async () => ({ formats: {}, references: [{ artifact: referenced, holder: "pending admission" }], expiredBindings: [] }) });
  assert.deepEqual(report.removed, ["r4"]);
  assert.ok(report.retained.find(entry => entry.version === "r3")!.holders.includes("pending admission"));
  assert.equal(existsSync(join(stationRoot(f.home), "r4")), false);
  await assert.rejects(gc(f.home, { ...f.dependencies, inventory: async () => { throw new Error("unreadable role jobs"); } }), /unreadable/);
  assert.equal(existsSync(join(stationRoot(f.home), "r3")), true);
});

test("Dagu inventory covers all DAGs and pages, and repeated cursors fail closed", async t => {
  stationFixture(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input)); assert.equal(url.searchParams.get("fromDate"), "0");
    calls++;
    return Response.json({ dagRuns: [{ name: calls === 1 ? "feature" : "other-dag", dagRunId: `run-${calls}`, statusLabel: "succeeded" }], ...(calls === 1 ? { nextCursor: "page2" } : {}) });
  });
  assert.deepEqual((await listStationRuns()).map(run => run.name), ["feature", "other-dag"]);
  t.mock.method(globalThis, "fetch", async () => Response.json({ dagRuns: [], nextCursor: "same" }));
  await assert.rejects(listStationRuns(), /Repeated/);
});

test("pending receipts include incident enqueue, expire at five minutes; open jobs and live runs resolve exact receipts", async t => {
  const f = stationFixture(t), artifact = await f.release("r1"), primary = join(f.root, "repo"), directory = join(primary, ".git", "dagu-feature");
  const now = Date.parse("2026-10-29T00:00:00Z"), fiveMinutes = 5 * 60 * 1000;
  const create = (run: string, ageMs: number, dag = "other-dag") => {
    const path = join(directory, "runs", run); mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "receipt.json"), JSON.stringify({ schemaVersion: 2, artifact, initial: { admittedAt: new Date(now - ageMs).toISOString() }, runReceipt: { dag, run, observations: [{ kind: "incident" }] } }));
  };
  create("pending", fiveMinutes - 1); create("expired", fiveMinutes); create("active", 30 * 86400000); create("job", 30 * 86400000);
  const db = new DatabaseSync(join(f.home, "role-jobs.sqlite"));
  db.exec("CREATE TABLE jobs(document TEXT, result TEXT)");
  db.prepare("INSERT INTO jobs VALUES (?,NULL)").run(JSON.stringify({ schemaVersion: 1, binding: { repo: primary, run: "job", dag: "other-dag" } })); db.close();
  const inventory = await inventoryStation(f.home, { primaries: () => [primary], gitPath: () => directory, configVersion: () => 1, now: () => now,
    listRuns: async () => [{ name: "other-dag", dagRunId: "active", primary, statusLabel: "recoverable" }, { name: "other-dag", dagRunId: "job", statusLabel: "succeeded" }] });
  const holders = inventory.references.map(reference => reference.holder).join("\n");
  assert.match(holders, /pending admission other-dag\/pending/);
  assert.doesNotMatch(holders, /expired/);
  assert.match(holders, /run other-dag\/active/);
  assert.match(holders, /open role job other-dag\/job/);
  await assert.rejects(inventoryStation(f.home, { primaries: () => [], listRuns: async () => [] }), /Unresolved open role job/);
});

test("tick binding files survive every listed status and API errors, only definitive unknown permits cleanup", async t => {
  const f = stationFixture(t), artifact = await f.release("r1");
  await initializeStation(f.home, artifact, f.dependencies);
  const directory = join(stationRoot(f.home), "ticks"); mkdirSync(directory);
  const path = join(directory, "tick.json");
  writeFileSync(path, JSON.stringify({ dagRunId: "tick", tuple: artifact, createdAt: new Date().toISOString() }));
  const { inventory: _, ...dependencies } = f.dependencies;
  const base = { ...dependencies, primaries: () => [], listRuns: async () => [{ name: "reconcile", dagRunId: "tick", statusLabel: "succeeded" }] };
  await gc(f.home, { ...base, bindingRun: async () => { throw new Error("should not query listed binding"); } });
  assert.ok(existsSync(path));
  await assert.rejects(gc(f.home, { ...base, listRuns: async () => [], bindingRun: async () => { throw new Error("API down"); } }), /API down/);
  assert.ok(existsSync(path));
  await gc(f.home, { ...base, listRuns: async () => [], bindingRun: async () => undefined });
  assert.equal(existsSync(path), false);
});

test("failed roots with pending resumes or automatic retries remain live readers across workspaces", async t => {
  const f = stationFixture(t);
  const primary = join(f.root, "repo"); mkdirSync(primary);
  const seen: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input)); seen.push(url.pathname + url.search);
    if (url.pathname.endsWith("/spec")) {
      assert.equal(url.searchParams.get("workspace"), "team");
      return Response.json({ spec: `env:\n  - PRIMARY: ${JSON.stringify(primary)}\n` });
    }
    if (url.pathname.endsWith("/retry")) return Response.json({ dagRunDetails: {} });
    if (url.pathname.endsWith("/resume")) return Response.json({ dagRunDetails: { approvalResumePending: true } });
    return Response.json({ dagRuns: [
      { name: "feature", dagRunId: "retry", statusLabel: "failed", autoRetryCount: 0, autoRetryLimit: 1, workspace: "team" },
      { name: "other", dagRunId: "resume", statusLabel: "aborted", workspace: "team" },
    ] });
  });
  const runs = await listStationRuns(f.home);
  assert.ok(runs.every(run => run.retryable && run.primary === primary));
  assert.equal(seen.filter(path => path.includes("/spec")).length, 2);
});
