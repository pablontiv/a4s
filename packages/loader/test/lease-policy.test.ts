import assert from "node:assert/strict";
import { test } from "node:test";
import { registrationHash } from "../../launcher/src/contracts.ts";
import { harness, selection } from "./fixtures.ts";
import { createLeaseLocked } from "../../launcher/src/lease.ts";
import { initializeStation, promote } from "../../launcher/src/station.ts";
import { stationTransaction } from "../../launcher/src/station-state.ts";
import { configSupport, stationFixture } from "../../issue-lifecycle/test/fixtures/station.ts";

test("manifest mismatch leases nothing; retired and failed imported candidates retain leases", async t => {
  const h = harness(); t.after(() => h.loader.dispose());
  await h.loader.initialize(); await h.host.emit("session_start", h.context);
  const mismatch = selection(2);
  mismatch.identity.registrationManifest.loaderHelperApi++;
  mismatch.identity.registrationManifestHash = registrationHash(mismatch.identity.registrationManifest);
  h.setCandidate(mismatch); await h.loader.check(h.context);
  assert.equal(h.counts().leases, 1);
  h.setCandidate(selection(3)); await h.loader.check(h.context); // Missing module still counts as import started.
  assert.equal(h.counts().leases, 2);
  assert.equal(h.counts().released, 0);
  h.setCandidate(selection(2)); await h.loader.check(h.context);
  assert.equal(h.counts().leases, 3);
  h.loader.dispose();
  assert.equal(h.counts().released, 0, "behavior shutdown is not process exit");
  assert.equal(h.counts().observers, 0);
});

test("restore failure before the first import releases only that candidate lease", async t => {
  const h = harness(); t.after(() => h.loader.dispose());
  await h.loader.initialize(); await h.host.emit("session_start", h.context);
  h.setCandidate(selection(2)); h.setRestoreFailure(true);
  await h.loader.check(h.context);
  assert.deepEqual(h.counts(), { observers: 1, leases: 2, released: 1, imports: 2 });
});

test("OMP process exit removes the retired-reader barrier for a new-format writer", async t => {
  const f = stationFixture(t);
  const old = await f.release("r1", configSupport([1], 1));
  const bridge = await f.release("r2", configSupport([1, 2], 1));
  const writer = await f.release("r3", configSupport([1, 2], 2));
  await initializeStation(f.home, old, f.dependencies);
  await stationTransaction(f.home, async () => { createLeaseLocked(f.home, old, 0, "plugin", "@a4s/loader retired generation"); }, f.dependencies);
  const dependencies = { ...f.dependencies, releases: async () => [writer, bridge] };
  assert.equal((await promote(f.home, dependencies)).current.version, "r2");
  const held = await promote(f.home, dependencies);
  assert.equal(held.promoted, false);
  assert.match(held.skipped[0]!.reason, /restart OMP/);
  // Model the retired OMP PID having exited. The new process cannot retain its modules.
  assert.equal((await promote(f.home, { ...dependencies, probe: () => "dead-or-reused" })).current.version, "r3");
});
