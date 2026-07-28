import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deviceIdentity, observeLocks, parseLockInventory } from "../src/health-locks.ts";
import { healthJson, stationHealth } from "../src/station-health.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "a4s-health-")), home = join(root, "home"), proc = join(root, "proc");
  mkdirSync(join(home, "cache", "a4s", "leases"), { recursive: true }); mkdirSync(join(home, "a4s")); mkdirSync(proc);
  const paths = [join(home, "cache", "a4s", ".state.lock"), join(home, "a4s", "heavy-slot.lock")];
  paths.forEach(path => writeFileSync(path, "stale contents are not ownership"));
  const state = join(home, "cache", "a4s", "state.json");
  writeFileSync(state, JSON.stringify({ schema: 1, current: { version: "r2" } })); utimesSync(state, new Date("2026-01-01T00:05:00Z"), new Date("2026-01-01T00:05:00Z"));
  for (const [name, host, pid] of [["dead", hostname(), 2147483647], ["renamed", "hostname-before-rename", 42]] as const) {
    writeFileSync(join(home, "cache", "a4s", "leases", `${name}.json`), JSON.stringify({ host, pid, processStartedAt: "linux:boot:1", holder: "fixture" }));
  }
  const info = statSync(paths[0]!, { bigint: true }), identity = deviceIdentity(info.dev, info.ino);
  const key = `${BigInt(identity.major).toString(16)}:${BigInt(identity.minor).toString(16)}:${identity.inode}`;
  writeFileSync(join(proc, "locks"), `1: FLOCK ADVISORY WRITE 42 ${key} 0 EOF\n`);
  mkdirSync(join(proc, "42", "fd"), { recursive: true });
  writeFileSync(join(proc, "42", "status"), "Name:\tomp\nPid:\t42\n");
  writeFileSync(join(proc, "42", "stat"), `42 (omp) S ${Array(18).fill("0").join(" ")} 500 0\n`);
  writeFileSync(join(proc, "42", "cmdline"), "omp\0--restore\0fixture\0"); symlinkSync(paths[0]!, join(proc, "42", "fd", "7"));
  return { root, home, proc, paths, key };
}
function fingerprint(path: string): unknown {
  const info = statSync(path);
  return info.isDirectory() ? Object.fromEntries(readdirSync(path).sort().map(name => [name, fingerprint(join(path, name))])) : { contents: readFileSync(path, "utf8"), inode: info.ino, mtime: info.mtimeMs, size: info.size };
}
const now = "2026-01-01T01:00:00Z";
const rows = [
  { name: "reconcile", dagRunId: "tick-1", statusLabel: "succeeded", startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:10Z" },
  { name: "reconcile", dagRunId: "tick-2", statusLabel: "succeeded", startedAt: "2026-01-01T00:02:00Z", finishedAt: "2026-01-01T00:02:30Z" },
  { name: "feature", dagRunId: "waiting-1", statusLabel: "waiting" },
  { name: "feature", dagRunId: "waiting-2", statusLabel: "waiting" },
  { name: "feature", dagRunId: "failed", statusLabel: "failed" },
];
function api(reverse = false): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method, "GET");
    const parsed = new URL(String(url)), path = parsed.pathname;
    if (path === "/api/v1/health") return Response.json({ version: "2.24.0" });
    if (path === "/api/v1/dag-runs") {
      assert.equal(parsed.searchParams.get("fromDate"), "0"); assert.equal(parsed.searchParams.get("toDate"), "1767229201");
      return Response.json({ dagRuns: reverse ? [...rows].reverse() : rows });
    }
    if (path.endsWith("/log")) {
      assert.equal(parsed.searchParams.get("head"), "4");
      return Response.json({ content: JSON.stringify({ current: { version: "r1" }, promoted: path.includes("tick-1") }) });
    }
    const id = path.split("/").at(-1);
    const failed = id === "failed";
    return Response.json({ dagRunDetails: { nodes: [{ step: { name: failed ? "gate" : "review" }, statusLabel: failed ? "failed" : "waiting", startedAt: id === "waiting-2" ? "2026-01-01T00:20:00Z" : "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:30:00Z" }] } });
  }) as typeof fetch;
}
function github(path: string): unknown {
  if (path.includes("/releases")) return [3, 2, 1].map(id => ({ tag_name: `a4s-r${id}`, created_at: "2025-12-31T23:00:00Z", draft: false, prerelease: false }));
  return [{ body: "poc-verdict:INCONCLUSIVE CPU-seconds 12", created_at: "2025-12-31T00:00:00Z", html_url: "https://github.com/pablontiv/a4s/issues/786#issuecomment-fixture" }];
}
test("read-only health groups waiting/failed steps, infers skips, preserves uncertainty and canonicalizes JSON", async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const before = fingerprint(f.home);
  const options = { home: f.home, url: "http://127.0.0.1:8080", now };
  const dependencies = { fetch: api(), github, probe: (pid: number) => pid === 42 ? "alive" as const : "dead-or-reused" as const,
    locks: (paths: string[]) => observeLocks(paths, f.proc, () => 0xef53) };
  const one = await stationHealth(options, dependencies);
  const two = await stationHealth(options, { ...dependencies, fetch: api(true) });
  assert.equal(healthJson(one), healthJson(two)); assert.deepEqual(fingerprint(f.home), before, "no file created, rewritten or truncated under station home");
  assert.equal(one.tick.value?.skipped.value, 1); assert.equal(one.tick.value?.durationMs.value?.p50, 20000);
  const waiting = one.runs.value?.find(group => group.status === "waiting");
  assert.equal(waiting?.count, 2); assert.deepEqual(waiting?.ageMs.value, { oldest: 3600000, median: 3000000 });
  assert.equal(one.runs.value?.find(group => group.status === "failed")?.step.value, "gate");
  assert.equal(one.leases.value?.[0]?.liveness.value, "dead-or-reused"); assert.equal(one.leases.value?.[1]?.liveness.value, "alive");
  assert.equal(one.locks[0]?.held.value, true); assert.equal(one.locks[0]?.holders.value?.[0]?.alive.value, true);
  assert.equal(one.locks[0]?.holders.value?.[0]?.cmdline.value, "omp --restore fixture");
  assert.equal(one.locks[0]?.holders.value?.[0]?.matchingFds.value?.[0]?.fd, "7"); assert.equal(one.locks[1]?.held.value, false);
  const releases = one.releases.value as Array<{ version: string; source: { value: unknown }; activeTime: { value: unknown }; lagMs: { value: unknown; reason: unknown } }>;
  assert.equal(releases.find(row => row.version === "r1")?.source.value, "promoting-tick-start");
  assert.equal(releases.find(row => row.version === "r2")?.source.value, "state.json-mtime");
  assert.equal(releases.find(row => row.version === "r3")?.lagMs.value, null); assert.ok(releases.find(row => row.version === "r3")?.lagMs.reason);
  assert.equal(one.cpuMeasurement.measuredHere, false); assert.ok(one.cpuMeasurement.reference.value?.includes("786#"));
});
test("lock inventory matches all device components, excludes waiters and keeps occupancy separate from PID metadata", t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  assert.deepEqual(deviceIdentity(66306n, 99n), { major: "259", minor: "2", inode: "99" });
  const [major, minor, inode] = f.key.split(":");
  for (const pid of [0, -1, 99]) {
    writeFileSync(join(f.proc, "locks"), `1: FLOCK ADVISORY WRITE ${pid} ${f.key} 0 EOF\n2: -> FLOCK ADVISORY WRITE 42 ${f.key} 0 EOF\n`);
    const lock = observeLocks(f.paths, f.proc, () => 0xef53)[0]!;
    assert.equal(lock.held.value, true); assert.equal(lock.holders.value?.length, 1);
    assert.equal(lock.holders.value?.[0]?.alive.value, null); assert.ok(lock.holders.value?.[0]?.alive.reason);
  }
  writeFileSync(join(f.proc, "locks"), `1: FLOCK ADVISORY WRITE 42 ${f.key} 0 EOF\n`);
  const processStat = join(f.proc, "42", "stat");
  writeFileSync(processStat, readFileSync(processStat, "utf8").replace(") S ", ") Z "));
  const zombie = observeLocks(f.paths, f.proc, () => 0xef53)[0]!;
  assert.equal(zombie.held.value, true); assert.equal(zombie.holders.value?.[0]?.alive.value, false);
  rmSync(processStat); mkdirSync(processStat); // Unreadable metadata, distinct from an absent PID.
  const unreadable = observeLocks(f.paths, f.proc, () => 0xef53)[0]!;
  assert.equal(unreadable.held.value, true); assert.equal(unreadable.holders.value?.[0]?.alive.value, null);
  assert.match(unreadable.holders.value?.[0]?.alive.reason ?? "", /EISDIR/);
  writeFileSync(join(f.proc, "locks"), `1: FLOCK ADVISORY WRITE 42 ${major}:ff:${inode} 0 EOF\n2: FLOCK ADVISORY WRITE 42 ff:${minor}:${inode} 0 EOF\n3: -> FLOCK ADVISORY WRITE 42 ${f.key} 0 EOF\n4: POSIX ADVISORY WRITE 42 ${f.key} 0 EOF\n`);
  assert.equal(observeLocks(f.paths, f.proc, () => 0xef53)[0]?.held.value, false);
  writeFileSync(join(f.proc, "locks"), "malformed kernel inventory");
  assert.equal(observeLocks(f.paths, f.proc, () => 0xef53)[0]?.held.value, null);
  rmSync(join(f.proc, "locks"));
  assert.match(observeLocks(f.paths, f.proc, () => 0xef53)[0]?.held.reason ?? "", /ENOENT/);
  assert.match(observeLocks(f.paths, f.proc, () => 0x9123683e)[0]?.held.reason ?? "", /Unsupported filesystem/);
  assert.throws(() => parseLockInventory(`1: FLOCK ADVISORY WRITE 42 not-an-identity 0 EOF`), /Malformed/);
});
test("missing API timestamps/details and unreadable sources stay null with reasons, not healthy zeros", async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method, "GET");
    if (String(url).includes("dag-runs?")) return Response.json({ dagRuns: [{ name: "reconcile", dagRunId: "incomplete", statusLabel: "running" }, { name: "feature", dagRunId: "failed", statusLabel: "failed" }] });
    return new Response("missing", { status: 404 });
  }) as typeof fetch;
  const result = await stationHealth({ home: f.home, url: "http://127.0.0.1", now }, { fetch: fetcher, github: () => { throw new Error("GitHub unavailable"); }, locks: () => [] });
  assert.equal(result.tick.value?.durationMs.value, null); assert.ok(result.tick.value?.durationMs.reason);
  assert.equal(result.tick.value?.skipped.value, null); assert.equal(result.daguVersion.value, null);
  assert.equal(result.runs.value?.[0]?.ageMs.value, null); assert.equal(result.runs.value?.[0]?.step.value, null);
  assert.equal(result.releases.value, null); assert.ok(result.releases.reason);
});
