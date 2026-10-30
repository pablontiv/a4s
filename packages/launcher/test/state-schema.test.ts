import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { selectPayload } from "../src/select.ts";
import { stationRoot } from "../src/station-state.ts";
import { fixture } from "./fixture.ts";

test("unknown state schema fails closed without loading current", async t => {
  const f = fixture(t);
  writeFileSync(join(stationRoot(f.home), "state.json"), JSON.stringify({ ...f.state, schema: 99 }));
  await assert.rejects(selectPayload(f.home, ["version"], f.dependencies), /reinstall a4s-launch/);
  assert.deepEqual(f.restored, []);
});
test("unsupported payload launcher protocol refuses handoff", async t => {
  const f = fixture(t);
  await assert.rejects(selectPayload(f.home, ["version"], { ...f.dependencies, restore: async (home, tuple) => {
    const cached = await f.dependencies.restore!(home, tuple);
    return { ...cached, identity: { ...cached.identity, requiredLauncherProtocol: 2 } };
  } }), /reinstall a4s-launch/);
});
