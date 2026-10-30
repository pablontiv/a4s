import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import test from "node:test";
import { selectPayload } from "../src/select.ts";
import { confirmFirstAttempt, tickBindingPath } from "../src/tick-binding.ts";
import { fixture } from "./fixture.ts";

test("fresh tick writes binding before handoff; A stays A after promotion to B", async t => {
  const f = fixture(t);
  const selected = await selectPayload(f.home, ["tick"], f.dependencies);
  assert.deepEqual(selected.lease.artifact, f.a);
  assert.deepEqual(JSON.parse(readFileSync(tickBindingPath(f.home, "tick-a"), "utf8")).tuple, f.a);
  f.setState({ ...f.state, current: f.b, previous: f.a, generation: 1 });
  const replay = await selectPayload(f.home, ["tick"], { ...f.dependencies, confirm: async () => { throw new Error("binding bypasses history"); } });
  assert.deepEqual(replay.lease.artifact, f.a);
  const next = await selectPayload(f.home, ["tick"], { ...f.dependencies, env: { DAG_RUN_ID: "tick-b" } });
  assert.deepEqual(next.lease.artifact, f.b);
});
test("missing retry or unreadable-history binding fails closed, never repins", async t => {
  const f = fixture(t);
  for (const attempt of ["retry", "unknown"] as const) {
    await assert.rejects(selectPayload(f.home, ["tick"], { ...f.dependencies, confirm: async () => attempt }), /refusing to repin/);
    assert.equal(existsSync(tickBindingPath(f.home, "tick-a")), false);
  }
  assert.deepEqual(f.restored, []);
});
test("binding replay restores recorded A even if current B cannot start", async t => {
  const f = fixture(t);
  await selectPayload(f.home, ["tick"], f.dependencies);
  f.setState({ ...f.state, current: f.b });
  const selected = await selectPayload(f.home, ["tick"], { ...f.dependencies, restore: async (home, tuple) => {
    assert.deepEqual(tuple, f.a); return f.dependencies.restore!(home, tuple);
  } });
  assert.deepEqual(selected.lease.artifact, f.a);
  rmSync(tickBindingPath(f.home, "tick-a"));
  await assert.rejects(selectPayload(f.home, ["tick"], { ...f.dependencies, confirm: async () => "retry" }), /attempt=retry/);
});
test("PoC-4 native trigger evidence: manual/scheduler first, retry/404/malformed/offline fail closed", async t => {
  for (const trigger of ["manual", "scheduler", "retry", "unknown"]) {
    t.mock.method(globalThis, "fetch", async () => Response.json({ dagRunDetails: { name: "reconcile", dagRunId: "tick", triggerType: trigger } }));
    assert.equal(await confirmFirstAttempt("tick", {}), trigger === "manual" || trigger === "scheduler" ? "first" : trigger);
    t.mock.restoreAll();
  }
  for (const response of [Response.json({ code: "not_found" }, { status: 404 }), Response.json({ dagRunDetails: {} })]) {
    t.mock.method(globalThis, "fetch", async () => response);
    assert.equal(await confirmFirstAttempt("tick", {}), "unknown"); t.mock.restoreAll();
  }
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  assert.equal(await confirmFirstAttempt("tick", {}), "unknown");
});
