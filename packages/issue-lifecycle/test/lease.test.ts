import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { collectDeadLeases, createLeaseLocked, prepareLease, selectStationBuild } from "@a4s/launcher/lease";
import { probeProcess } from "@a4s/launcher/process-identity";
import { initializeStation, gc, promote } from "@a4s/launcher/station";
import { stationRoot } from "@a4s/launcher/station-state";
import { configSupport, stationFixture } from "./fixtures/station.ts";

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

test("dead-lease collection tolerates new observers and preserves records changed after probing", async t => {
  const f = stationFixture(t), artifact = await f.release("r1");
  await initializeStation(f.home, artifact, f.dependencies);
  const expired = await selectStationBuild(f.home, "plugin", "expired observer", f.dependencies);
  const changed = await selectStationBuild(f.home, "plugin", "changed observer", f.dependencies);
  const observer = prepareLease(artifact, 0, "plugin", "new observer");
  const path = (id: string) => join(stationRoot(f.home), "leases", `${id}.json`);
  let locked = false;
  const collected = await collectDeadLeases(f.home, { ...f.dependencies,
    probe: () => { assert.equal(locked, false); return "dead-or-reused"; },
    async withFileLock(lock, body) {
      return f.dependencies.withFileLock!(lock, async () => {
        locked = true;
        try {
          createLeaseLocked(f.home, observer);
          writeFileSync(path(changed.id), JSON.stringify({ ...changed, generation: changed.generation + 1 }));
          return await body();
        } finally { locked = false; }
      });
    },
  });
  assert.equal(collected, 1);
  assert.equal(existsSync(path(expired.id)), false);
  assert.ok(existsSync(path(changed.id)));
  assert.ok(existsSync(path(observer.id)));
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

test("hostname changes preserve live readers without blocking compatible promotion or dead-lease collection", async t => {
  const f = stationFixture(t), old = await f.release("r1", configSupport([1], 1));
  const bridge = await f.release("r2", configSupport([1, 2], 1)), writer = await f.release("r3", configSupport([1, 2], 2));
  await initializeStation(f.home, old, f.dependencies);
  const lease = await selectStationBuild(f.home, "plugin", "retiring", f.dependencies);
  const path = join(stationRoot(f.home), "leases", `${lease.id}.json`);
  writeFileSync(path, JSON.stringify({ ...lease, host: "hostname-before-rename" }));
  const dependencies = { ...f.dependencies, probe: probeProcess, releases: async () => [writer, bridge] };
  assert.equal(await collectDeadLeases(f.home, dependencies), 0);
  assert.equal((await promote(f.home, dependencies)).current.version, "r2");
  assert.equal((await promote(f.home, dependencies)).promoted, false, "rename cannot release a live incompatible reader");
  writeFileSync(path, JSON.stringify({ ...lease, host: "hostname-before-rename", processStartedAt: `${lease.processStartedAt}-reused` }));
  assert.equal((await promote(f.home, dependencies)).current.version, "r3");
  assert.equal(await collectDeadLeases(f.home, dependencies), 1);
  assert.equal(existsSync(path), false);
});

test("renamed hosts with unreadable process identities and malformed leases still fail closed", async t => {
  const f = stationFixture(t), artifact = await f.release("r1"), next = await f.release("r2");
  await initializeStation(f.home, artifact, f.dependencies);
  const lease = await selectStationBuild(f.home, "plugin", "retiring", f.dependencies);
  const path = join(stationRoot(f.home), "leases", `${lease.id}.json`);
  writeFileSync(path, JSON.stringify({ ...lease, host: "hostname-before-rename" }));
  const before = f.stateBytes();
  const dependencies = { ...f.dependencies, probe: () => "unknown" as const };
  await assert.rejects(gc(f.home, dependencies), /unknown/i);
  await assert.rejects(promote(f.home, { ...dependencies, releases: async () => [next] }), /unknown/i);
  assert.equal(f.stateBytes(), before);
  assert.ok(existsSync(path));
  assert.equal(await collectDeadLeases(f.home, { ...f.dependencies, probe: () => "dead-or-reused" }), 1);
  writeFileSync(path, "{}");
  await assert.rejects(gc(f.home, f.dependencies), /lease/i);
});
