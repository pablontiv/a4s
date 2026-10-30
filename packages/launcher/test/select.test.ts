import assert from "node:assert/strict";
import test from "node:test";
import { selectPayload } from "../src/select.ts";
import { artifactToken } from "../src/release.ts";
import { fixture } from "./fixture.ts";

test("new admissions select state.current and hand off its tuple", async t => {
  const f = fixture(t);
  const selected = await selectPayload(f.home, ["admit", "--run-id", "new", "feature"], f.dependencies);
  assert.deepEqual(selected.lease.artifact, f.a);
  assert.deepEqual(selected.args.slice(0, 3), ["admit", "--artifact", artifactToken(f.a)]);
  assert.ok(selected.lease.processStartedAt.startsWith(process.platform === "linux" ? "linux:" : "ps-c:"));
});
test("successor admission selects the parent's receipt, not current or caller tick", async t => {
  const f = fixture(t), parent = f.receipt("parent");
  const selected = await selectPayload(f.home, ["admit", "--parent", parent, "--run-id", "child", "feature"], f.dependencies);
  assert.deepEqual(selected.lease.artifact, f.b);
  assert.deepEqual(f.restored, ["r11"]);
});
test("tick A invoking run B routes B's receipt tuple before inspecting caller binding", async t => {
  const f = fixture(t); f.receipt("run-b");
  await selectPayload(f.home, ["tick"], f.dependencies);
  const selected = await selectPayload(f.home, ["run", "--primary", f.primary, "--run", "run-b", "--", "reconcile", "step", "observe"], {
    ...f.dependencies, confirm: async () => { throw new Error("caller tick history must not be read"); },
  });
  assert.deepEqual(selected.lease.artifact, f.b);
  assert.equal(selected.cached.executable.endsWith("/r11/a4s"), true);
  assert.deepEqual(f.restored, ["r10", "r11"]);
});
test("argv-named action/observation/priority targets override caller run and tick identity", async t => {
  const f = fixture(t); f.receipt("run-b"); f.receipt("caller-a", f.a);
  const row = JSON.stringify({ PRIMARY: f.primary, RUN: "run-b" });
  for (const args of [
    ["reconcile", "inspect", row], ["reconcile", "finish", JSON.stringify({ primary: f.primary, run: "run-b" }), "{}"],
    ["observe", "run-b", "{}"], ["observe", "runtime", JSON.stringify({ run: { dagRunId: "run-b" } })],
    ["prioritize", "feature", "run-b"],
  ]) {
    const selected = await selectPayload(f.home, args, { ...f.dependencies, env: { DAG_RUN_ID: "tick-a", PRIMARY: f.primary, RUN: "caller-a" } });
    assert.deepEqual(selected.lease.artifact, f.b);
  }
});
test("explicit artifact cannot override receipt/current selection", async t => {
  const f = fixture(t);
  await assert.rejects(selectPayload(f.home, ["admit", "--artifact", artifactToken(f.b)], f.dependencies), /differs from selected/);
  assert.deepEqual(f.restored, []);
});
