import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { collectDeadLeases, selectStationBuild } from "../../launcher/src/lease.ts";
import { initializeStation, gc, promote } from "../../launcher/src/station.ts";
import { stationRoot } from "../../launcher/src/station-state.ts";
import { stationFixture } from "./fixtures/station.ts";

test("selection leases the exact generation and artifact while holding the state lock", async t => {
  const f = stationFixture(t), artifact = await f.release("r1");
  await initializeStation(f.home, artifact, f.dependencies);
  const lease = await selectStationBuild(f.home, "plugin", "status generation", f.dependencies);
  assert.equal(lease.generation, 0); assert.equal(lease.artifact.version, "r1");
  assert.equal(lease.pid, process.pid); assert.match(lease.processStartedAt, process.platform === "linux" ? /^linux:[a-f0-9-]{36}:\d+$/ : /^ps-c:/);
  const path = join(stationRoot(f.home), "leases", `${lease.id}.json`);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), lease);
  assert.equal(await collectDeadLeases(f.home, { ...f.dependencies, probe: () => "alive" }), 0);
  assert.ok(existsSync(path));
  assert.equal(await collectDeadLeases(f.home, { ...f.dependencies, probe: () => "dead-or-reused" }), 1);
  assert.equal(existsSync(path), false);
});

test("unknown probe aborts all cleanup, including a previously observed dead lease", async t => {
  const f = stationFixture(t), artifact = await f.release("r1");
  await initializeStation(f.home, artifact, f.dependencies);
  const leases = [await selectStationBuild(f.home, "plugin", "retiring", f.dependencies), await selectStationBuild(f.home, "launcher", "running", f.dependencies)];
  let probes = 0;
  await assert.rejects(collectDeadLeases(f.home, { ...f.dependencies, probe: () => ++probes === 1 ? "dead-or-reused" : "unknown" }), /unknown/i);
  for (const lease of leases) assert.ok(existsSync(join(stationRoot(f.home), "leases", `${lease.id}.json`)));
  await assert.rejects(gc(f.home, { ...f.dependencies, probe: () => "unknown" }), /unknown/i);
  const next = await f.release("r2");
  const before = f.stateBytes();
  await assert.rejects(promote(f.home, { ...f.dependencies, releases: async () => [next], probe: () => "unknown" }), /unknown/i);
  assert.equal(f.stateBytes(), before);
});

test("foreign process hosts and malformed lease stores fail closed", async t => {
  const f = stationFixture(t), artifact = await f.release("r1");
  await initializeStation(f.home, artifact, f.dependencies);
  const lease = await selectStationBuild(f.home, "plugin", "retiring", f.dependencies);
  const path = join(stationRoot(f.home), "leases", `${lease.id}.json`);
  writeFileSync(path, JSON.stringify({ ...lease, host: "different-station" }));
  await assert.rejects(gc(f.home, { ...f.dependencies, probe: () => "dead-or-reused" }), /unknown/i);
  assert.ok(existsSync(path));
  writeFileSync(path, "{}");
  await assert.rejects(gc(f.home, f.dependencies), /lease/i);
});
