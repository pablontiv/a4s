import assert from "node:assert/strict";
import { test } from "node:test";
import { initializeStation, promote, rollback } from "../src/station.ts";
import { configSupport, stationFixture } from "./fixtures/station.ts";

test("stable rollback works with a broken current, rejects bad ID, and does not bounce back", async t => {
  const f = stationFixture(t), old = await f.release("r1"), bad = await f.release("r2");
  await initializeStation(f.home, old, f.dependencies);
  assert.deepEqual(f.state().current, f.state().previous);
  await promote(f.home, { ...f.dependencies, releases: async () => [bad] });
  f.breakPayload(bad);
  const result = await rollback(f.home, f.dependencies);
  assert.equal(result.current.version, "r1");
  assert.equal(result.previous.version, "r1");
  assert.deepEqual(result.rejected, ["r2"]);
  assert.equal(result.generation, 2);
  const before = f.stateBytes();
  await rollback(f.home, f.dependencies);
  assert.equal(f.stateBytes(), before);
});

test("rollback rejects a target reading the highest version but missing a retained lower one", async t => {
  const f = stationFixture(t), old = await f.release("r1", configSupport([2, 3], 2)), current = await f.release("r2", configSupport([1, 2, 3], 3));
  await initializeStation(f.home, current, f.dependencies);
  f.setState({ ...f.state(), previous: old, formats: { ...f.state().formats, config: [1, 2, 3] } });
  const before = f.stateBytes();
  await assert.rejects(rollback(f.home, f.dependencies), /config\/1/);
  assert.equal(f.stateBytes(), before);
});

test("rollback remains refused after formats advance, even with zero newer-writer runs", async t => {
  const f = stationFixture(t), old = await f.release("r1"), bridge = await f.release("r2", configSupport([1, 2], 1)), writer = await f.release("r3", configSupport([1, 2], 2));
  await initializeStation(f.home, old, f.dependencies);
  await promote(f.home, { ...f.dependencies, releases: async () => [bridge, writer] });
  await promote(f.home, { ...f.dependencies, releases: async () => [writer] });
  assert.deepEqual(f.state().formats.config, [1, 2]);
  // A crash/recovery or later selection must never forget the older writer set.
  f.setState({ ...f.state(), previous: old });
  const before = f.stateBytes();
  await assert.rejects(rollback(f.home, f.dependencies), /config\/2/);
  assert.equal(f.stateBytes(), before);
});

test("rollback to bridge preserves every written version and increments generation", async t => {
  const f = stationFixture(t), bridge = await f.release("r1", configSupport([1, 2], 1)), writer = await f.release("r2", configSupport([1, 2], 2));
  await initializeStation(f.home, bridge, f.dependencies);
  await promote(f.home, { ...f.dependencies, releases: async () => [writer] });
  const result = await rollback(f.home, f.dependencies);
  assert.equal(result.current.version, "r1");
  assert.equal(result.generation, 2);
  assert.deepEqual(result.formats.config, [1, 2]);
});
