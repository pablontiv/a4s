import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gc, promote } from "../../launcher/src/station.ts";
import { selectPayload } from "../../launcher/src/select.ts";
import { stationRoot } from "../../launcher/src/station-state.ts";
import { HotLoader } from "../../loader/src/index.ts";
import { leaseSelection, stationSelection } from "../../loader/src/station.ts";
import { FakeHost, selection } from "../../loader/test/fixtures.ts";
import { gcFixture } from "./fixtures/cache-gc.ts";

function gate() {
  const { promise, resolve: open } = Promise.withResolvers<void>();
  return { promise, open };
}

test("launcher verifies outside the station lock and refuses a selection pruned before lease commit", async t => {
  const f = await gcFixture(t), entered = gate(), resume = gate();
  f.setState({ ...f.state(), current: f.builds[0]! });
  const pending = selectPayload(f.home, ["status"], { ...f.dependencies, env: {}, restore: async (home, tuple) => {
    const cached = await f.dependencies.inspect!(home, tuple);
    entered.open(); await resume.promise; return cached;
  } });
  const rejected = assert.rejects(pending, /Station changed during payload preparation/);
  await entered.promise;
  f.setState({ ...f.state(), generation: f.state().generation + 2, current: f.builds[13]!, previous: f.builds[12]! });
  const report = await gc(f.home, f.dependencies);
  assert.ok(report.removed.includes("r1"));
  resume.open(); await rejected;
  const selected = await selectPayload(f.home, ["status"], { ...f.dependencies, env: {}, restore: (home, tuple) => f.dependencies.inspect!(home, tuple) });
  assert.equal(selected.cached.record.version, "r14");
  assert.ok(existsSync(selected.cached.executable));
});

test("GC runs during promotion download/verification; only verified state publication takes the lock", async t => {
  const f = await gcFixture(t), candidate = await f.release("r15"), entered = gate(), resume = gate();
  const promoting = promote(f.home, { ...f.dependencies, releases: async () => [candidate], ensure: async (home, tuple) => {
    const cached = await f.dependencies.ensure!(home, tuple);
    entered.open(); await resume.promise; return cached;
  } });
  await entered.promise;
  const report = await gc(f.home, { ...f.dependencies, inventory: async () => {
    assert.equal(f.state().current.version, "r14");
    return { formats: {}, references: [], expiredBindings: [] };
  } });
  assert.ok(report.retained.find(row => row.version === "r15")!.holders.includes("keep-10 highest IDs"));
  resume.open(); assert.equal((await promoting).promoted, true);
  assert.equal(f.state().current.version, "r15");
  assert.equal(f.state().previous.version, "r14");
});

test("a loader selection losing the promotion/GC race cannot acquire a lease or evaluate a pruned generation", async t => {
  const f = await gcFixture(t);
  f.setState({ ...f.state(), current: f.builds[0]!, generation: 1 });
  const selected = await stationSelection(f.home, f.dependencies);
  f.setState({ ...f.state(), current: f.builds[13]!, previous: f.builds[12]!, generation: 2 });
  assert.ok((await gc(f.home, f.dependencies)).removed.includes("r1"));
  await assert.rejects(leaseSelection(f.home, selected, f.dependencies), /generation changed before lease/);
});

test("loader activation and retirement keep evaluated generations leased until OMP exits", async t => {
  const f = await gcFixture(t), entered = gate(), resume = gate(), host = new FakeHost();
  f.setState({ ...f.state(), current: f.builds[0]!, generation: 1 });
  let candidate = selection(1), imports = 0;
  const selected = (index: number) => {
    const value = selection(index + 1), tuple = f.builds[index]!;
    return { ...value, directory: join(stationRoot(f.home), tuple.version),
      identity: { ...value.identity, ...tuple }, state: { ...f.state(), current: tuple } };
  };
  candidate = selected(0);
  const loader = new HotLoader(host, {
    select: async () => candidate,
    lease: async value => {
      const lease = await leaseSelection(f.home, value, f.dependencies);
      t.after(() => lease.release());
      return lease;
    },
    resolveDirectory: async directory => directory,
    importModule: async () => { if (++imports === 1) { entered.open(); await resume.promise; } return { default: () => {} }; },
    pollInterval: 60000,
  });
  t.after(() => loader.dispose());
  const initializing = loader.initialize(); await entered.promise;
  f.setState({ ...f.state(), current: f.builds[13]!, previous: f.builds[1]!, generation: 2 });
  assert.ok((await gc(f.home, f.dependencies)).retained.find(row => row.version === "r1")!.holders.some(holder => holder.includes("plugin lease")));
  resume.open(); await initializing;
  // Activate another generation, then retire it as well. Neither reload nor
  // disposal proves that an already evaluated module has no remaining reader.
  f.setState({ ...f.state(), current: f.builds[1]!, generation: 2 }); candidate = selected(1);
  const notices: string[] = [];
  await loader.check({ isIdle: () => true, ui: { notify: text => notices.push(text) } });
  assert.deepEqual(notices, []); assert.equal(imports, 6);
  loader.dispose();
  f.setState({ ...f.state(), current: f.builds[13]!, previous: f.builds[12]!, generation: 3 });
  const report = await gc(f.home, f.dependencies);
  for (const version of ["r1", "r2"]) assert.ok(report.retained.find(row => row.version === version)!.holders.some(holder => holder.includes("restart OMP")));
  const exited = await gc(f.home, { ...f.dependencies, probe: () => "dead-or-reused" });
  assert.ok(exited.removed.includes("r1")); assert.ok(exited.removed.includes("r2"));
});

test("pruned terminal tick replay restores only its bound immutable tuple; a missing retry binding never repins", async t => {
  const f = await gcFixture(t), { version, commit, digest } = f.builds[0]!, tuple = { version, commit, digest };
  f.binding("tick", tuple);
  const dependencies = { ...f.dependencies, listRuns: async () => [{ name: "reconcile", dagRunId: "tick", statusLabel: "succeeded" }] };
  assert.ok((await gc(f.home, dependencies)).removed.includes("r1"));
  let restored = 0;
  const selected = await selectPayload(f.home, ["tick"], { ...f.dependencies, env: { DAG_RUN_ID: "tick" }, confirm: async () => "retry",
    restore: async (home, requested) => { restored++; assert.deepEqual(requested, tuple); return f.dependencies.ensure!(home, f.builds[0]!); } });
  assert.equal(restored, 1); assert.deepEqual({ version: selected.cached.record.version, commit: selected.cached.record.commit, digest: selected.cached.record.digest }, tuple);
  assert.equal(f.state().current.version, "r14");
  rmSync(join(stationRoot(f.home), "ticks", "tick.json"));
  await assert.rejects(selectPayload(f.home, ["tick"], { ...f.dependencies, env: { DAG_RUN_ID: "tick" }, confirm: async () => "retry",
    restore: async () => { throw new Error("must not restore or repin"); } }), /binding/);
});

test("GC never waits on an artifact being prepared while holding the station lock", async t => {
  const f = await gcFixture(t);
  const report = await gc(f.home, { ...f.dependencies, withFileLock: async (path, body, options) => {
    if (path.endsWith("/r1.lock")) {
      assert.equal(options?.timeoutMs, 0);
      throw Object.assign(new Error("busy preparer pid=123"), { code: "ETIMEDOUT" });
    }
    return f.dependencies.withFileLock!(path, body);
  } });
  assert.ok(!report.removed.includes("r1"));
  assert.match(report.retained.find(row => row.version === "r1")!.holders.join(), /artifact lock busy.*pid=123/);
  assert.ok((await gc(f.home, f.dependencies)).removed.includes("r1"));
});
