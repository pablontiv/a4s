import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { registrationHash } from "../src/contracts.ts";
import { inventoryStation, type StationRun } from "../src/station-inventory.ts";
import { promote, type StationDependencies } from "../src/station.ts";
import { stationRoot } from "../src/station-state.ts";
import type { ArtifactTuple } from "../src/release.ts";
import { fixture } from "./fixture.ts";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const FIVE_MINUTES = 5 * 60 * 1000;

async function admissionFixture(t: TestContext) {
  const f = fixture(t);
  const legacy: ArtifactTuple = { version: "0.7.4", commit: "c".repeat(40), digest: "3".repeat(64) };
  async function cache(tuple: ArtifactTuple) {
    const cached = await f.dependencies.restore!(f.home, tuple);
    const identity = { ...cached.identity, registrationManifestHash: registrationHash(cached.identity.registrationManifest) };
    mkdirSync(cached.directory, { recursive: true });
    writeFileSync(join(cached.directory, "artifact.json"), JSON.stringify(cached.record));
    writeFileSync(join(cached.directory, "identity.json"), JSON.stringify(identity));
    return { ...cached, identity };
  }
  await cache(f.a);
  const candidate = await cache(f.b);
  const old = await cache(legacy);
  // Historical semver reader accepts receipts but cannot read config schema 2.
  writeFileSync(join(old.directory, "identity.json"), JSON.stringify({ ...old.identity, support: {
    receiptSchemas: { read: [1, 2], write: 2 }, configSchemas: [1], roleJobStores: [1],
    dispatch: old.identity.dispatch, protocols: old.identity.protocols,
  } }));
  const runs: StationRun[] = [];
  const dependencies: StationDependencies = {
    ...f.dependencies,
    primaries: () => [f.primary],
    gitPath: () => join(f.primary, ".git", "dagu-feature"),
    configVersion: () => 2,
    listRuns: async () => runs,
    now: () => NOW,
    releases: async () => [f.b],
    ensure: async () => candidate,
  };
  function receipt({ age = 0, schemaVersion = 1, artifact, receiptCreatedAt }: {
    age?: number; schemaVersion?: number; artifact?: ArtifactTuple; receiptCreatedAt?: string;
  } = {}) {
    const directory = join(f.primary, ".git", "dagu-feature", "runs", "abandoned");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "receipt.json");
    writeFileSync(path, JSON.stringify({ schemaVersion, artifact, receiptCreatedAt,
      initial: { admittedAt: new Date(NOW - age).toISOString() },
      runReceipt: { dag: "planning", run: "abandoned", attempt: 1, observations: [] },
    }));
    return path;
  }
  return { ...f, legacy, runs, dependencies, receipt };
}

test("artifact-less schema-1 receipt absent from Dagu neither throws nor blocks promotion", async t => {
  const f = await admissionFixture(t);
  const path = f.receipt(), before = readFileSync(path, "utf8");
  const inventory = await inventoryStation(f.home, f.dependencies);
  assert.deepEqual(inventory.references, []);
  assert.deepEqual(inventory.formats.receipt, [1]);
  assert.equal((await promote(f.home, f.dependencies)).promoted, true);
  assert.equal(readFileSync(path, "utf8"), before);
});

for (const age of [FIVE_MINUTES - 1, FIVE_MINUTES, FIVE_MINUTES + 1, 6 * 86400000]) {
  test(`unsupported-format receipt absent from Dagu at age ${age}ms only blocks inside five minutes`, async t => {
    const f = await admissionFixture(t);
    const path = f.receipt({ age, artifact: f.legacy }), before = readFileSync(path, "utf8");
    const report = await promote(f.home, f.dependencies);
    if (age < FIVE_MINUTES) {
      assert.equal(report.promoted, false);
      assert.match(report.skipped[0]!.reason, /Blocking reader pending admission planning\/abandoned build=0\.7\.4: Unsupported artifact format config\/2/);
    } else {
      assert.equal(report.promoted, true);
      assert.deepEqual(report.skipped, []);
      assert.deepEqual((await inventoryStation(f.home, f.dependencies)).references, []);
    }
    assert.equal(readFileSync(path, "utf8"), before);
  });
}

test("receiptCreatedAt takes precedence over historical admittedAt", async t => {
  const f = await admissionFixture(t);
  f.receipt({ artifact: f.legacy, receiptCreatedAt: new Date(NOW - FIVE_MINUTES).toISOString() });
  assert.deepEqual((await inventoryStation(f.home, f.dependencies)).references, []);
  f.receipt({ age: FIVE_MINUTES, artifact: f.legacy, receiptCreatedAt: new Date(NOW).toISOString() });
  assert.equal((await inventoryStation(f.home, f.dependencies)).references[0]?.holder, "pending admission planning/abandoned");
});

test("artifact-less modern receipts fail closed while fresh, but not after the pending window", async t => {
  const f = await admissionFixture(t);
  f.receipt({ schemaVersion: 2 });
  await assert.rejects(promote(f.home, f.dependencies), /Unresolved pending admission abandoned/);
  f.receipt({ schemaVersion: 2, age: FIVE_MINUTES });
  assert.equal((await promote(f.home, f.dependencies)).promoted, true);
});

test("nonterminal and recoverable Dagu readers remain blocking regardless of receipt age", async t => {
  const f = await admissionFixture(t);
  f.receipt({ artifact: f.legacy, age: FIVE_MINUTES });
  for (const run of [
    { name: "planning", dagRunId: "abandoned", statusLabel: "running" },
    { name: "planning", dagRunId: "abandoned", statusLabel: "failed", retryable: true },
  ]) {
    f.runs.splice(0, f.runs.length, run);
    const report = await promote(f.home, f.dependencies);
    assert.equal(report.promoted, false);
    assert.match(report.skipped[0]!.reason, /Blocking reader run planning\/abandoned/);
  }
  f.receipt({ age: FIVE_MINUTES });
  await assert.rejects(promote(f.home, f.dependencies), /Unresolved nonterminal artifact abandoned/);
});

test("a listed terminal run is not an in-flight admission even with a fresh receipt", async t => {
  const f = await admissionFixture(t);
  f.receipt({ artifact: f.legacy });
  f.runs.push({ name: "planning", dagRunId: "abandoned", statusLabel: "succeeded" });
  assert.equal((await promote(f.home, f.dependencies)).promoted, true);
});

test("open role jobs retain expired unlisted receipt readers and reject unresolved legacy artifacts", async t => {
  const f = await admissionFixture(t);
  f.receipt({ artifact: f.legacy, age: FIVE_MINUTES });
  const db = new DatabaseSync(join(f.home, "role-jobs.sqlite"));
  try {
    db.exec("CREATE TABLE jobs (document TEXT, result TEXT)");
    db.prepare("INSERT INTO jobs (document, result) VALUES (?, NULL)").run(JSON.stringify({
      schemaVersion: 1, binding: { repo: f.primary, dag: "planning", run: "abandoned" },
    }));
  } finally { db.close(); }
  const report = await promote(f.home, f.dependencies);
  assert.equal(report.promoted, false);
  assert.match(report.skipped[0]!.reason, /Blocking reader open role job planning\/abandoned/);
  f.receipt({ age: FIVE_MINUTES });
  await assert.rejects(promote(f.home, f.dependencies), /Unresolved open role job planning\/abandoned/);
});

test("a live admission lease remains blocking after its pending receipt expires", async t => {
  const f = await admissionFixture(t);
  f.receipt({ artifact: f.legacy, age: FIVE_MINUTES });
  const directory = join(stationRoot(f.home), "leases");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "abc.json"), JSON.stringify({ schema: 1, id: "abc", artifact: f.legacy,
    host: hostname(), pid: 123, processStartedAt: "fixture", generation: 0, kind: "engine", holder: "admission abandoned",
  }));
  const report = await promote(f.home, { ...f.dependencies, probe: () => "alive" });
  assert.equal(report.promoted, false);
  assert.match(report.skipped[0]!.reason, /Blocking reader engine lease holder pid=123.*admission abandoned/);
});
