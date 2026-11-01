import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { captureInventoryInputs, assertInventoryInputsCurrent } from "../src/station-inventory.ts";
import { CONFIG_PATH } from "../src/config.ts";
import { fixture } from "./fixture.ts";
import { useStation } from "../../issue-lifecycle/test/fixtures/service-environment.ts";

for (const source of ["config", "HEAD", "ref", "packed refs", "receipt", "WAL", "SHM", "checkpoint"] as const) {
  test(`inventory input proof detects a changed ${source} without running git or inspecting artifacts`, async t => {
    const f = fixture(t), git = join(f.primary, ".git"), run = join(git, "dagu-feature", "runs", "old");
    mkdirSync(join(git, "refs", "heads"), { recursive: true });
    mkdirSync(dirname(join(f.primary, CONFIG_PATH)), { recursive: true });
    mkdirSync(run, { recursive: true });
    writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(git, "refs", "heads", "main"), `${"a".repeat(40)}\n`);
    writeFileSync(join(f.primary, CONFIG_PATH), '{"schemaVersion":1}\n');
    writeFileSync(join(run, "receipt.json"), "{}\n");
    const dependencies = { primaries: () => [f.primary], listRuns: async () => [] };
    const inputs = await captureInventoryInputs(f.home, dependencies);
    if (source === "config") writeFileSync(join(f.primary, CONFIG_PATH), '{"schemaVersion":2}\n');
    else if (source === "HEAD") writeFileSync(join(git, "HEAD"), `${"b".repeat(40)}\n`);
    else if (source === "ref") writeFileSync(join(git, "refs", "heads", "main"), `${"b".repeat(40)}\n`);
    else if (source === "packed refs") writeFileSync(join(git, "packed-refs"), `${"b".repeat(40)} refs/heads/main\n`);
    else if (source === "receipt") writeFileSync(join(run, "receipt.json"), "{}\n\n");
    else if (source === "checkpoint") writeFileSync(join(run, "pr.json"), "{}\n");
    else writeFileSync(join(f.home, `role-jobs.sqlite-${source.toLowerCase()}`), "changed\n");
    await assert.rejects(assertInventoryInputsCurrent(f.home, inputs, "test", dependencies), { code: "ESTALE", message: /inventory inputs changed.*retry/ });
  });
}

test("inventory proof resolves linked-worktree HEAD and shared refs without a subprocess", async t => {
  const f = fixture(t), primary = join(f.root, "worktree"), directory = join(f.root, "git", "worktrees", "test"), common = join(f.root, "git");
  mkdirSync(primary);
  mkdirSync(directory, { recursive: true });
  mkdirSync(join(common, "refs", "heads"), { recursive: true });
  writeFileSync(join(primary, ".git"), `gitdir: ${directory}\n`);
  writeFileSync(join(directory, "commondir"), "../..\n");
  writeFileSync(join(directory, "HEAD"), "ref: refs/heads/main\n");
  const ref = join(common, "refs", "heads", "main");
  writeFileSync(ref, `${"a".repeat(40)}\n`);
  const dependencies = { primaries: () => [primary], listRuns: async () => [] };
  const inputs = await captureInventoryInputs(f.home, dependencies);
  assert.ok(inputs.files.some(([path]) => path === ref));
  assert.ok(inputs.listings.some(([path]) => path === join(directory, "dagu-feature")));
  writeFileSync(ref, `${"b".repeat(40)}\n`);
  await assert.rejects(assertInventoryInputsCurrent(f.home, inputs, "test", dependencies), { code: "ESTALE" });
});

test("inventory proof compares run/status sets using only aggregate list endpoints", async t => {
  const f = fixture(t);
  t.after(useStation(f.home));
  const dependencies = { primaries: () => [] };
  let requests = 0, reverse = false, statusLabel = "failed";
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    assert.equal(new URL(String(input)).pathname, "/api/v1/dag-runs", "no detail or spec HTTP is allowed in an input recheck");
    requests++;
    const rows = [{ name: "feature", dagRunId: "old", statusLabel }, { name: "other", dagRunId: "live", statusLabel: "running" }];
    return Response.json({ dagRuns: reverse ? rows.reverse() : rows });
  });
  const inputs = await captureInventoryInputs(f.home, dependencies);
  reverse = true;
  await assertInventoryInputsCurrent(f.home, inputs, "test", dependencies);
  assert.equal(requests, 2);
  statusLabel = "succeeded";
  await assert.rejects(assertInventoryInputsCurrent(f.home, inputs, "test", dependencies), { code: "ESTALE" });
  assert.equal(requests, 3);
});

test("a timed-out list recheck aborts with a retry instead of holding the station lock", async t => {
  const f = fixture(t);
  t.after(useStation(f.home));
  const inputs = await captureInventoryInputs(f.home, { primaries: () => [], listRuns: async () => [] });
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    assert.equal(milliseconds, 1000, "one deadline covers all final list pages");
    return AbortSignal.abort(new DOMException("simulated scheduler timeout", "TimeoutError"));
  });
  t.mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
    assert.ok(init?.signal?.aborted);
    throw init.signal.reason;
  });
  await assert.rejects(assertInventoryInputsCurrent(f.home, inputs, "test", { primaries: () => [] }), { code: "ESTALE", message: /recheck exceeded 1000ms.*retry/ });
});

test("inventory proof rejects Git path overrides it cannot prove from PRIMARY", async t => {
  const f = fixture(t), previous = process.env.GIT_DIR;
  process.env.GIT_DIR = join(f.root, "other-git");
  t.after(() => { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; });
  await assert.rejects(captureInventoryInputs(f.home, { primaries: () => [f.primary], listRuns: async () => [] }), /GIT_DIR overridden.*retry/);
});

test("the final proof also stops synchronous stat work at its recheck deadline", async t => {
  const f = fixture(t), dependencies = { primaries: () => [], listRuns: async () => [] };
  const inputs = await captureInventoryInputs(f.home, dependencies, false);
  let time = 0;
  t.mock.method(performance, "now", () => time += 600);
  await assert.rejects(assertInventoryInputsCurrent(f.home, inputs, "test", dependencies, false), { code: "ESTALE", message: /recheck exceeded 1000ms.*retry/ });
});

test("an unavailable final list proof fails closed with a retryable diagnostic", async t => {
  const f = fixture(t);
  t.after(useStation(f.home));
  const inputs = await captureInventoryInputs(f.home, { primaries: () => [], listRuns: async () => [] });
  t.mock.method(globalThis, "fetch", async () => Response.json({ message: "unavailable" }, { status: 503 }));
  await assert.rejects(assertInventoryInputsCurrent(f.home, inputs, "test", { primaries: () => [] }), { code: "ESTALE", message: /inventory inputs unavailable.*retry/ });
});
