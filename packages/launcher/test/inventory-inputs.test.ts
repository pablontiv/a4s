import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { captureInventoryInputs, inventoryStation, listStationRunSummaries, recheckInventory, type StationInventory } from "../src/station-inventory.ts";
import { TICK_DAG } from "../src/tick-binding.ts";
import { CONFIG_PATH } from "../src/config.ts";
import { fixture } from "./fixture.ts";
import { useStation } from "../../issue-lifecycle/test/fixtures/service-environment.ts";

const empty: StationInventory = { formats: {}, references: [], expiredBindings: [] };
function receipt(f: ReturnType<typeof fixture>, artifact = f.a, fields: Record<string, unknown> = {}): string {
  const path = join(f.primary, ".git", "dagu-feature", "runs", "old", "receipt.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ schemaVersion: 2, artifact, initial: { admittedAt: "2026-10-01T00:00:00Z" },
    runReceipt: { dag: "feature", run: "old" }, ...fields }));
  return path;
}

for (const source of ["config", "HEAD", "ref", "packed refs"] as const) {
  test(`inventory config proof detects a changed ${source} without running git or inspecting artifacts`, async t => {
    const f = fixture(t), git = join(f.primary, ".git");
    mkdirSync(join(git, "refs", "heads"), { recursive: true });
    mkdirSync(dirname(join(f.primary, CONFIG_PATH)), { recursive: true });
    writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(git, "refs", "heads", "main"), `${"a".repeat(40)}\n`);
    writeFileSync(join(f.primary, CONFIG_PATH), '{"schemaVersion":2}\n');
    const dependencies = { primaries: () => [f.primary], listRuns: async () => [] };
    const inputs = await captureInventoryInputs(f.home, dependencies);
    if (source === "config") writeFileSync(join(f.primary, CONFIG_PATH), '{"schemaVersion":3}\n');
    else if (source === "HEAD") writeFileSync(join(git, "HEAD"), `${"b".repeat(40)}\n`);
    else if (source === "ref") writeFileSync(join(git, "refs", "heads", "main"), `${"b".repeat(40)}\n`);
    else writeFileSync(join(git, "packed-refs"), `${"b".repeat(40)} refs/heads/main\n`);
    await assert.rejects(recheckInventory(f.home, inputs, empty, "test", dependencies), { code: "ESTALE", message: /inventory inputs changed.*retry/ });
  });
}

test("inventory config proof resolves linked-worktree HEAD and shared refs without a subprocess", async t => {
  const f = fixture(t), primary = join(f.root, "worktree"), directory = join(f.root, "git", "worktrees", "test"), common = join(f.root, "git");
  mkdirSync(primary);
  mkdirSync(directory, { recursive: true });
  mkdirSync(join(common, "refs", "heads"), { recursive: true });
  writeFileSync(join(primary, ".git"), `gitdir: ${directory}\n`);
  writeFileSync(join(directory, "commondir"), "../..\n");
  writeFileSync(join(directory, "HEAD"), "ref: refs/heads/main\n");
  const ref = join(common, "refs", "heads", "main");
  writeFileSync(ref, `${"a".repeat(40)}\n`);
  const dependencies = { primaries: () => [primary], listRuns: async () => [] };
  const inputs = await captureInventoryInputs(f.home, dependencies);
  assert.ok(inputs.files.some(([path]) => path === ref));
  assert.equal(inputs.files.some(([path]) => path.includes("dagu-feature")), false);
  writeFileSync(ref, `${"b".repeat(40)}\n`);
  await assert.rejects(recheckInventory(f.home, inputs, empty, "test", dependencies), { code: "ESTALE" });
});

test("GC decisions reuse unlocked aggregate summaries and never poll under the lock", async t => {
  const f = fixture(t);
  receipt(f);
  t.after(useStation(f.home));
  let locked = false, requests = 0, statusLabel = "failed";
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    assert.equal(locked, false, "no scheduler HTTP is allowed under the lock");
    assert.equal(new URL(String(input)).pathname, "/api/v1/dag-runs");
    requests++;
    return Response.json({ dagRuns: [{ name: "feature", dagRunId: "old", statusLabel }] });
  });
  const dependencies = { primaries: () => [f.primary], configVersion: () => 2, listRuns: () => listStationRunSummaries(f.home) };
  const inputs = await captureInventoryInputs(f.home, dependencies);
  const prepared = await inventoryStation(f.home, dependencies, true, true, { receiptCache: inputs.receiptCache });
  locked = true;
  assert.ok((await recheckInventory(f.home, inputs, prepared, "test", dependencies, { conservativeGc: true })).references.length);
  statusLabel = "succeeded";
  assert.ok((await recheckInventory(f.home, inputs, prepared, "test", dependencies, { conservativeGc: true })).references.length, "a terminal transition does not drop a prepared possible reader");
  assert.equal(requests, 1);
  locked = false;
  const terminalInputs = await captureInventoryInputs(f.home, dependencies);
  const terminal = await inventoryStation(f.home, dependencies, true, true, { receiptCache: terminalInputs.receiptCache });
  locked = true;
  assert.deepEqual((await recheckInventory(f.home, terminalInputs, terminal, "test", dependencies, { conservativeGc: true })).references, []);
  assert.equal(requests, 2);
});

test("observation files and receipt observation/whitespace rewrites are not decision conflicts", async t => {
  const f = fixture(t), path = receipt(f), dependencies = { primaries: () => [f.primary], configVersion: () => 2, listRuns: async () => [] };
  const inputs = await captureInventoryInputs(f.home, dependencies);
  await inventoryStation(f.home, dependencies, false, false, { receiptCache: inputs.receiptCache });
  writeFileSync(join(dirname(path), "ci-observation.json"), '{"changed":true}\n');
  writeFileSync(join(dirname(path), "ci-no-progress.json"), '{"count":2}\n');
  receipt(f, f.a, { runReceipt: { dag: "feature", run: "old", observations: [{ progress: "new" }] } });
  writeFileSync(path, `${readFileSync(path, "utf8")}\n\n`);
  const current = await recheckInventory(f.home, inputs, empty, "test", dependencies, { conservativeGc: true });
  assert.ok(current.references.some(entry => entry.artifact.version === f.a.version));
  assert.deepEqual(current.formats.receipt, [2]);
});

test("new receipt decision fields and newly published receipts are re-parsed before commit", async t => {
  const f = fixture(t), dependencies = { primaries: () => [f.primary], configVersion: () => 2, listRuns: async () => [] };
  const inputs = await captureInventoryInputs(f.home, dependencies);
  receipt(f, f.b, { contracts: { receipt: 3, roleJobPayload: 4 } });
  const current = await recheckInventory(f.home, inputs, empty, "test", dependencies, { conservativeGc: true });
  assert.deepEqual(current.formats.receipt, [2, 3]);
  assert.deepEqual(current.formats.roleJobPayload, [4]);
  assert.ok(current.references.some(entry => entry.artifact.version === f.b.version));
});

test("changed receipt decision fields refresh cached readers and removed receipts drop them", async t => {
  const f = fixture(t), path = receipt(f), dependencies = { primaries: () => [f.primary], configVersion: () => 2, listRuns: async () => [] };
  const inputs = await captureInventoryInputs(f.home, dependencies);
  await inventoryStation(f.home, dependencies, false, false, { receiptCache: inputs.receiptCache });
  receipt(f, f.b, { contracts: { receipt: 3 } });
  const current = await recheckInventory(f.home, inputs, empty, "test", dependencies, { conservativeGc: true });
  assert.deepEqual(current.formats.receipt, [2, 3]);
  assert.deepEqual(current.references.map(entry => entry.artifact.version), [f.b.version]);
  rmSync(path);
  const removed = await recheckInventory(f.home, inputs, empty, "test", dependencies, { conservativeGc: true });
  assert.deepEqual(removed.references, []);
});

test("SQLite recheck sees WAL schema and payload versions but tolerates ordinary role-job writes", async t => {
  const f = fixture(t), dependencies = { primaries: () => [f.primary], configVersion: () => 2, listRuns: async () => [] };
  receipt(f);
  const writer = new DatabaseSync(join(f.home, "role-jobs.sqlite"));
  t.after(() => writer.close());
  writer.exec("PRAGMA journal_mode=WAL; PRAGMA user_version=1; CREATE TABLE jobs(document TEXT,result TEXT)");
  const job = JSON.stringify({ schemaVersion: 1, binding: { repo: f.primary, dag: "feature", run: "old" } });
  writer.prepare("INSERT INTO jobs VALUES (?,NULL)").run(job);
  const inputs = await captureInventoryInputs(f.home, dependencies);
  writer.prepare("UPDATE jobs SET result=?").run('{"schemaVersion":1}');
  writer.prepare("INSERT INTO jobs VALUES (?,?)").run(job, '{"schemaVersion":1}');
  const unchanged = await recheckInventory(f.home, inputs, empty, "test", dependencies);
  assert.deepEqual(unchanged.formats.roleJobStore, [1]);
  assert.deepEqual(unchanged.formats.roleJobPayload, [1]);
  writer.exec("PRAGMA user_version=2");
  writer.prepare("INSERT INTO jobs VALUES (?,NULL)").run(JSON.stringify({ schemaVersion: 3, binding: { repo: f.primary, dag: "feature", run: "old" } }));
  const changed = await recheckInventory(f.home, inputs, empty, "test", dependencies);
  assert.deepEqual(changed.formats.roleJobStore, [2]);
  assert.deepEqual(changed.formats.roleJobPayload, [1, 3]);
  assert.ok(changed.references.some(entry => entry.holder === "open role job feature/old"));
});

test("a new tick record cannot reuse an earlier native-unknown cleanup decision", async t => {
  const f = fixture(t), dependencies = { primaries: () => [], listRuns: async () => [] };
  const path = join(f.home, "cache", "a4s", "ticks", "tick.json");
  mkdirSync(dirname(path));
  const binding = { dagRunId: "tick", tuple: f.a, createdAt: "2026-10-01T00:00:00Z" };
  writeFileSync(path, JSON.stringify(binding));
  const inputs = await captureInventoryInputs(f.home, dependencies), prepared = { ...empty, expiredBindings: [path] };
  assert.deepEqual((await recheckInventory(f.home, inputs, prepared, "test", dependencies)).expiredBindings, [path]);
  writeFileSync(path, JSON.stringify({ ...binding, tuple: f.b }));
  const current = await recheckInventory(f.home, inputs, prepared, "test", dependencies);
  assert.deepEqual(current.expiredBindings, []);
  assert.ok(current.references.some(entry => entry.artifact.version === f.b.version));
});

test("a new tick binding is a reader even when its prepared run summary is terminal", async t => {
  const f = fixture(t), dependencies = { primaries: () => [] };
  const inputs = await captureInventoryInputs(f.home, dependencies);
  const path = join(f.home, "cache", "a4s", "ticks", "tick.json");
  mkdirSync(dirname(path));
  writeFileSync(path, JSON.stringify({ dagRunId: "tick", tuple: f.a, createdAt: "2026-10-01T00:00:00Z" }));
  const prepared = { ...empty, runs: [{ name: TICK_DAG, dagRunId: "tick", statusLabel: "succeeded" }] };
  const current = await recheckInventory(f.home, inputs, prepared, "test", dependencies, { conservativeGc: true });
  assert.ok(current.references.some(entry => entry.artifact.version === f.a.version));
  assert.deepEqual(current.expiredBindings, []);
});

test("a final recheck uses prepared terminal proof even when the scheduler becomes unavailable", async t => {
  const f = fixture(t), dependencies = { primaries: () => [f.primary], configVersion: () => 2 };
  receipt(f);
  const inputs = await captureInventoryInputs(f.home, dependencies);
  await inventoryStation(f.home, dependencies, false, false, { receiptCache: inputs.receiptCache });
  const prepared = { ...empty, runs: [{ name: "feature", dagRunId: "old", statusLabel: "succeeded" }] };
  t.mock.method(globalThis, "fetch", async () => { throw new Error("No scheduler HTTP may occur during the final recheck"); });
  const current = await recheckInventory(f.home, inputs, prepared, "test", dependencies);
  assert.deepEqual(current.references, []);
});

test("inventory config proof rejects Git path overrides it cannot prove from PRIMARY", async t => {
  const f = fixture(t), previous = process.env.GIT_DIR;
  process.env.GIT_DIR = join(f.root, "other-git");
  t.after(() => { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; });
  await assert.rejects(captureInventoryInputs(f.home, { primaries: () => [f.primary] }), /GIT_DIR overridden.*retry/);
});

test("the final decision also stops synchronous local reads at its recheck deadline", async t => {
  const f = fixture(t), dependencies = { primaries: () => [], listRuns: async () => [] };
  const inputs = await captureInventoryInputs(f.home, dependencies);
  let time = 0;
  t.mock.method(performance, "now", () => time += 600);
  await assert.rejects(recheckInventory(f.home, inputs, empty, "test", dependencies), { code: "ESTALE", message: /recheck exceeded 1000ms.*retry/ });
});

test("an unavailable unlocked list aborts inventory before committing a decision", async t => {
  const f = fixture(t), dependencies = { primaries: () => [] };
  t.after(useStation(f.home));
  t.mock.method(globalThis, "fetch", async () => Response.json({ message: "unavailable" }, { status: 503 }));
  await assert.rejects(inventoryStation(f.home, dependencies, true, true), /Dagu inventory HTTP 503/);
});
