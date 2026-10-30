import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { gc } from "../../launcher/src/station.ts";
import { selectStationBuild } from "../../launcher/src/lease.ts";
import { probeProcess } from "../../launcher/src/process-identity.ts";
import { stationRoot } from "../../launcher/src/station-state.ts";
import { listStationRuns, type StationRun } from "../../launcher/src/station-inventory.ts";
import { gcFixture, GC_NOW } from "./fixtures/cache-gc.ts";

for (const source of ["current", "previous", "keep-10"] as const) {
  test(`GC retains ${source} independently of run references`, async t => {
    const f = await gcFixture(t);
    if (source === "current") f.setState({ ...f.state(), current: f.builds[0]! });
    if (source === "previous") f.setState({ ...f.state(), previous: f.builds[0]! });
    const report = await gc(f.home, f.dependencies);
    const version = source === "keep-10" ? "r5" : "r1";
    assert.ok(report.retained.find(entry => entry.version === version)?.holders.some(holder => holder.startsWith(source)));
    assert.ok(existsSync(join(stationRoot(f.home), version, "a4s")));
    assert.ok(report.removed.includes("r4"));
  });
}

test("GC retains a live process lease and frees only a dead or reused identity", async t => {
  const f = await gcFixture(t);
  f.setState({ ...f.state(), current: f.builds[0]! });
  const lease = await selectStationBuild(f.home, "plugin", "retiring generation", f.dependencies);
  f.setState({ ...f.state(), current: f.builds[13]! });
  const report = await gc(f.home, f.dependencies);
  assert.match(report.retained.find(entry => entry.version === "r1")!.holders.join(), /plugin lease holder.*restart OMP/);
  assert.ok(existsSync(join(stationRoot(f.home), "r1", "a4s")));
  const result = await gc(f.home, { ...f.dependencies, probe: () => "dead-or-reused" });
  assert.ok(result.removed.includes("r1"));
  assert.equal(existsSync(join(stationRoot(f.home), "leases", `${lease.id}.json`)), false);
});

test("a failed ps probe aborts GC without deleting cache or lease files; PID reuse frees the lease", async t => {
  const f = await gcFixture(t);
  f.setState({ ...f.state(), current: f.builds[0]! });
  const lease = await selectStationBuild(f.home, "launcher", "handoff", f.dependencies);
  f.setState({ ...f.state(), current: f.builds[13]! });
  const path = join(stationRoot(f.home), "leases", `${lease.id}.json`);
  writeFileSync(path, JSON.stringify({ ...lease, processStartedAt: "ps-c:old" }));
  let failProbe = true;
  const probe = t.mock.method(childProcess, "execFileSync", () => {
    if (failProbe) throw new Error("ps access denied");
    return "Thu Oct 29 05:49:57 2026\n";
  });
  syncBuiltinESMExports();
  t.after(() => { probe.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(gc(f.home, { ...f.dependencies, probe: probeProcess }), /unknown/);
  assert.ok(existsSync(path)); assert.ok(existsSync(join(stationRoot(f.home), "r4")));
  failProbe = false;
  assert.ok((await gc(f.home, { ...f.dependencies, probe: probeProcess })).removed.includes("r1"));
});

for (const statusLabel of ["queued", "waiting", "running", "recoverable", "retrying", "not_started"]) {
  test(`GC resolves ${statusLabel} runs across registered primaries and arbitrary DAGs`, async t => {
    const f = await gcFixture(t), other = join(f.root, "other");
    f.receipt("old-run", f.builds[0]!, 40, "arbitrary-dag");
    const directory = join(other, ".git", "dagu-feature"); mkdirSync(directory, { recursive: true });
    const report = await gc(f.home, { ...f.dependencies, primaries: () => [other, f.primary],
      gitPath: primary => primary === other ? directory : f.directory,
      listRuns: async () => [{ name: "arbitrary-dag", dagRunId: "old-run", primary: f.primary, statusLabel }] });
    assert.match(report.retained.find(entry => entry.version === "r1")!.holders.join(), new RegExp(`run arbitrary-dag/old-run ${statusLabel}`));
  });
}

for (const statusLabel of ["waiting", "failed"]) {
  test(`an exited tick with ${statusLabel} retryable binding retains its exact build`, async t => {
    const f = await gcFixture(t), path = f.binding("tick", f.builds[0]!);
    const run = { name: "reconcile", dagRunId: "tick", statusLabel, retryable: true };
    const report = await gc(f.home, { ...f.dependencies, listRuns: async () => [run] });
    assert.match(report.retained.find(entry => entry.version === "r1")!.holders.join(), /tick reconcile\/tick/);
    assert.ok(existsSync(path));
  });
}

test("an active binding omitted by the inventory snapshot is resolved through its exact detail endpoint", async t => {
  const f = await gcFixture(t); f.binding("tick", f.builds[0]!);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    assert.equal(new URL(String(input)).pathname, "/api/v1/dag-runs/reconcile/tick");
    return Response.json({ dagRunDetails: { name: "reconcile", dagRunId: "tick", statusLabel: "running" } });
  });
  assert.ok((await gc(f.home, f.dependencies)).retained.find(entry => entry.version === "r1")?.holders.includes("tick reconcile/tick"));
});

for (const incident of [false, true]) {
  test(`pending ${incident ? "incident/ambiguous" : "unlisted"} admission expires at five minutes and leaves its receipt intact`, async t => {
    const f = await gcFixture(t), path = f.receipt("pending", f.builds[0]!, 0, "feature", incident);
    const bytes = readFileSync(path, "utf8");
    const expiry = GC_NOW + 5 * 60 * 1000;
    assert.match((await gc(f.home, { ...f.dependencies, now: () => expiry - 1 })).retained.find(entry => entry.version === "r1")!.holders.join(), /pending admission/);
    assert.ok((await gc(f.home, { ...f.dependencies, now: () => expiry })).removed.includes("r1"));
    assert.equal(readFileSync(path, "utf8"), bytes);
  });
}

test("open SQL role jobs retain the receipt tuple even when the native run is terminal", async t => {
  const f = await gcFixture(t); f.receipt("job", f.builds[0]!);
  const db = new DatabaseSync(join(f.home, "role-jobs.sqlite"));
  db.exec("CREATE TABLE jobs(document TEXT, result TEXT)");
  db.prepare("INSERT INTO jobs VALUES (?,NULL)").run(JSON.stringify({ schemaVersion: 1, binding: { repo: f.primary, run: "job", dag: "feature" } })); db.close();
  const report = await gc(f.home, { ...f.dependencies, listRuns: async () => [{ name: "feature", dagRunId: "job", statusLabel: "succeeded" }] });
  assert.match(report.retained.find(entry => entry.version === "r1")!.holders.join(), /open role job feature\/job/);
});

for (const failure of ["receipt", "config", "database", "unresolved job", "nonterminal receipt", "lease"]) {
  test(`unreadable ${failure} source aborts before any deletion`, async t => {
    const f = await gcFixture(t);
    let dependencies = f.dependencies;
    if (failure === "receipt") writeFileSync(f.receipt("bad", f.builds[0]!), "{");
    if (failure === "config") dependencies = { ...dependencies, configVersion: () => { throw new Error("unreadable config"); } };
    if (failure === "database") writeFileSync(join(f.home, "role-jobs.sqlite"), "not a database");
    if (failure === "unresolved job") {
      const db = new DatabaseSync(join(f.home, "role-jobs.sqlite")); db.exec("CREATE TABLE jobs(document TEXT, result TEXT)");
      db.prepare("INSERT INTO jobs VALUES (?,NULL)").run(JSON.stringify({ schemaVersion: 1, binding: { repo: f.primary, dag: "feature", run: "missing" } })); db.close();
    }
    if (failure === "nonterminal receipt") dependencies = { ...dependencies, listRuns: async () => [{ name: "feature", dagRunId: "missing", primary: f.primary, statusLabel: "running" }] };
    if (failure === "lease") { mkdirSync(join(stationRoot(f.home), "leases")); writeFileSync(join(stationRoot(f.home), "leases", "bad.json"), "{}"); }
    await assert.rejects(gc(f.home, dependencies));
    for (let id = 1; id <= 14; id++) assert.ok(existsSync(join(stationRoot(f.home), `r${id}`)), `r${id} survived`);
  });
}

for (const failure of ["transport", "500", "plain404", "html404", "malformed404", "unrelated404", "wrong200", "malformed200"]) {
  test(`tick binding and cache survive ${failure}; uncertainty is not unknown`, async t => {
    const f = await gcFixture(t), path = f.binding("tick", f.builds[0]!);
    t.mock.method(globalThis, "fetch", async () => {
      if (failure === "transport") throw new TypeError("ECONNREFUSED");
      if (failure === "500") return Response.json({ code: "not_found" }, { status: 500 });
      if (failure === "plain404") return new Response("404 page not found", { status: 404 });
      if (failure === "html404") return new Response("<html>not found</html>", { status: 404, headers: { "content-type": "text/html" } });
      if (failure === "malformed404") return new Response("{", { status: 404, headers: { "content-type": "application/json" } });
      if (failure === "unrelated404") return Response.json({ code: "not_found", message: "route not found" }, { status: 404 });
      if (failure === "wrong200") return Response.json({ dagRunDetails: { name: "other", dagRunId: "tick", statusLabel: "succeeded" } });
      return Response.json({});
    });
    await assert.rejects(gc(f.home, f.dependencies));
    assert.ok(existsSync(path)); assert.ok(existsSync(join(stationRoot(f.home), "r4")));
  });
}

test("terminal binding outlives its pruned build until authoritative native unknown", async t => {
  const f = await gcFixture(t), path = f.binding("tick", f.builds[0]!);
  t.mock.method(globalThis, "fetch", async () => Response.json({ dagRunDetails: { name: "reconcile", dagRunId: "tick", statusLabel: "succeeded" } }));
  assert.ok((await gc(f.home, f.dependencies)).removed.includes("r1"));
  assert.ok(existsSync(path));
  t.mock.method(globalThis, "fetch", async () => Response.json({ code: "not_found", message: "dag-run ID tick not found for DAG reconcile" }, { status: 404 }));
  await gc(f.home, f.dependencies);
  assert.equal(existsSync(path), false);
});

test("aggregate cursor inventory uses fixed date bounds and a full terminal page is complete", async t => {
  const filters: string[] = [], runs: StationRun[] = [];
  let now = 1793357400750;
  t.mock.method(Date, "now", () => now);
  for (let index = 0; index < 3; index++) runs.push({ name: `dag-${index}`, dagRunId: `id-${index}`, statusLabel: "succeeded" });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input)), cursor = url.searchParams.get("cursor"), index = cursor ? Number(cursor) : 0;
    assert.equal(url.searchParams.get("fromDate"), "0");
    assert.equal(url.searchParams.get("toDate"), "1793357401");
    now += 1500; // A later page must not change the original upper bound.
    url.searchParams.delete("cursor"); filters.push(url.search);
    return Response.json({ dagRuns: [runs[index]], ...(index < 2 ? { nextCursor: String(index + 1) } : {}) });
  });
  assert.deepEqual(await listStationRuns(undefined, 1), runs.map(run => ({ ...run, retryable: false })));
  assert.equal(new Set(filters).size, 1);
});

for (const failure of ["repeated cursor", "later HTTP error", "later transport error", "malformed page", "empty cursor", "unknown status"]) {
  test(`GC refuses partial cursor inventory on ${failure}`, async t => {
    const f = await gcFixture(t);
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      if (++calls === 1) return Response.json({ dagRuns: [], nextCursor: "opaque" });
      if (failure === "later HTTP error") return Response.json({ code: "error" }, { status: 503 });
      if (failure === "later transport error") throw new TypeError("fetch failed");
      if (failure === "malformed page") return Response.json({ runs: [] });
      if (failure === "unknown status") return Response.json({ dagRuns: [{ name: "dag", dagRunId: "id", statusLabel: "unrecognized" }] });
      return Response.json({ dagRuns: [], nextCursor: failure === "empty cursor" ? "" : "opaque" });
    });
    const { listRuns: _, ...dependencies } = f.dependencies;
    await assert.rejects(gc(f.home, dependencies));
    assert.ok(existsSync(join(stationRoot(f.home), "r4")));
  });
}
