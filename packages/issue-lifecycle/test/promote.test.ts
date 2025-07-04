import assert from "node:assert/strict";
import { test } from "node:test";
import { createLeaseLocked } from "../src/lease.ts";
import { initializeStation, promote, rollback } from "../src/station.ts";
import { stationTransaction } from "../src/station-state.ts";
import { configSupport, stationFixture } from "./fixtures/station.ts";

test("highest eligible ID wins independently of completion order, never late lower IDs", async t => {
  const f = stationFixture(t), initial = await f.release("r1"), second = await f.release("r2"), third = await f.release("r3");
  await initializeStation(f.home, initial, f.dependencies);
  for (const releases of [[second, third], [third, second]]) {
    f.setState({ ...f.state(), current: initial, previous: initial });
    const report = await promote(f.home, { ...f.dependencies, releases: async () => releases });
    assert.equal(report.current.version, "r3");
    assert.equal(f.state().previous.version, "r1");
  }
  const before = f.stateBytes();
  assert.equal((await promote(f.home, { ...f.dependencies, releases: async () => [second] })).promoted, false);
  assert.equal(f.stateBytes(), before);
});

test("newest incompatible writer falls through to bridge, then writer activates without a third bridge", async t => {
  const f = stationFixture(t), old = await f.release("r1"), bridge = await f.release("r2", configSupport([1, 2], 1)), writer = await f.release("r3", configSupport([1, 2], 2));
  await initializeStation(f.home, old, f.dependencies);
  const dependencies = { ...f.dependencies, releases: async () => [writer, bridge] };
  const first = await promote(f.home, dependencies);
  assert.equal(first.current.version, "r2");
  assert.match(first.skipped[0]!.reason, /post-promotion previous.*config\/2/);
  assert.equal(f.state().previous.version, "r1");
  const second = await promote(f.home, dependencies);
  assert.equal(second.current.version, "r3");
  assert.equal(f.state().previous.version, "r2");
  assert.deepEqual(f.state().formats.config, [1, 2]);
});

test("live and retiring pre-bridge plugin readers block a new writer and name restart remedy", async t => {
  const f = stationFixture(t), old = await f.release("r1"), bridge = await f.release("r2", configSupport([1, 2], 1)), writer = await f.release("r3", configSupport([1, 2], 2));
  await initializeStation(f.home, old, f.dependencies);
  await stationTransaction(f.home, async () => { createLeaseLocked(f.home, old, 0, "plugin", "retiring status generation"); }, f.dependencies);
  const dependencies = { ...f.dependencies, releases: async () => [writer, bridge] };
  assert.equal((await promote(f.home, dependencies)).current.version, "r2");
  const before = f.stateBytes(), report = await promote(f.home, dependencies);
  assert.equal(report.promoted, false);
  assert.equal(f.stateBytes(), before);
  assert.match(report.skipped[0]!.reason, /plugin lease holder pid=\d+ generation=0.*retiring.*restart OMP/);
  assert.equal((await promote(f.home, { ...dependencies, probe: () => "dead-or-reused" })).current.version, "r3");
});

test("nonterminal bindings, pending admissions and open jobs remain live readers", async t => {
  const f = stationFixture(t), old = await f.release("r1"), bridge = await f.release("r2", configSupport([1, 2], 1)), writer = await f.release("r3", configSupport([1, 2], 2));
  await initializeStation(f.home, bridge, f.dependencies);
  for (const holder of ["tick feature/tick-1", "pending admission feature/pending-1", "open role job feature/job-1", "run other/running-1 running"]) {
    const report = await promote(f.home, { ...f.dependencies, releases: async () => [writer], inventory: async () => ({ formats: {}, references: [{ artifact: old, holder }], expiredBindings: [] }) });
    assert.equal(report.promoted, false);
    assert.ok(report.skipped[0]!.reason.includes(holder));
  }
});

test("launcher protocol skew skips newest, download and verification failures leave state unchanged", async t => {
  const f = stationFixture(t), old = await f.release("r1"), bridge = await f.release("r2"), skew = await f.release("r3", undefined, 2);
  await initializeStation(f.home, old, f.dependencies);
  const report = await promote(f.home, { ...f.dependencies, releases: async () => [skew, bridge] });
  assert.equal(report.current.version, "r2");
  assert.match(report.skipped[0]!.reason, /launcher reinstall required/);
  const before = f.stateBytes();
  const failing = await promote(f.home, { ...f.dependencies, releases: async () => [skew], ensure: async () => { throw new Error("disk full before verification"); } });
  assert.equal(failing.promoted, false);
  assert.match(failing.skipped[0]!.reason, /disk full/);
  assert.equal(f.stateBytes(), before);
});

test("rollback rejection floor requires an ID above the bad release, including late arrivals", async t => {
  const f = stationFixture(t), old = await f.release("r1"), middle = await f.release("r2"), bad = await f.release("r3"), revert = await f.release("r4");
  await initializeStation(f.home, old, f.dependencies);
  await promote(f.home, { ...f.dependencies, releases: async () => [bad] });
  await rollback(f.home, f.dependencies);
  const before = f.stateBytes();
  assert.equal((await promote(f.home, { ...f.dependencies, releases: async () => [middle, bad] })).promoted, false);
  assert.equal(f.stateBytes(), before);
  assert.equal((await promote(f.home, { ...f.dependencies, releases: async () => [revert] })).current.version, "r4");
});

test("same-ID conflicting tuples fail before any state commit", async t => {
  const f = stationFixture(t), current = await f.release("r1"), next = await f.release("r2");
  await initializeStation(f.home, current, f.dependencies);
  const before = f.stateBytes();
  await assert.rejects(promote(f.home, { ...f.dependencies, releases: async () => [next, { ...next, digest: "f".repeat(64) }] }), /Conflicting release identity/);
  assert.equal(f.stateBytes(), before);
});
