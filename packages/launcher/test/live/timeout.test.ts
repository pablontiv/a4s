import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureArtifact, cachePath } from "../../src/artifact-cache.ts";
import { withFileLockAsync } from "../../src/file-lock.ts";
import { archiveName, github, resolveRelease } from "../../src/release.ts";
import { promote } from "../../src/station.ts";
import { readStationState, stationRoot, stationTransaction } from "../../src/station-state.ts";
import { fixture } from "../fixture.ts";

// No service, network or real GitHub credentials: PATH contains only a scratch gh shim.
// The real child-process deadline/kill behavior cannot be exercised with fake timers.
test("hung gh listing/resolution/download time out, release locks and allow the next tick", { timeout: 15000 }, async t => {
  const f = fixture(t), marker = join(f.root, "hang"), shim = join(f.root, "gh");
  writeFileSync(shim, `#!/bin/sh\nif [ -f ${JSON.stringify(marker)} ]; then trap '' TERM; exec sleep 60; fi\nprintf '[]'\n`);
  chmodSync(shim, 0o700);
  const path = process.env.PATH;
  process.env.PATH = `${f.root}:${path}`;
  t.after(() => { process.env.PATH = path; });
  const dependencies = { ...f.dependencies, withFileLock: withFileLockAsync,
    releases: async () => JSON.parse(github(["api", "--paginate", "--slurp", "repos/test/releases"], 200)) };
  writeFileSync(marker, "hang");
  const before = readFileSync(join(stationRoot(f.home), "state.json"), "utf8");
  await assert.rejects(promote(f.home, dependencies), { code: "ETIMEDOUT", message: /gh api .*timed out after 200ms/ });
  assert.throws(() => resolveRelease("r12", { gh: args => github(args, 200) }), { code: "ETIMEDOUT" });
  const release = { ...f.b, archive: archiveName(f.b.version), repository: "test/repo" };
  await assert.rejects(promote(f.home, { ...dependencies, releases: async () => [release],
    ensure: (home, requested) => ensureArtifact(home, requested, {
      github: () => `${release.digest}  ${release.archive}\n`, download: args => { github(args, 200); },
    }),
  }), { code: "ETIMEDOUT", message: /gh release download .*timed out/ });
  assert.equal(existsSync(cachePath(f.home, release)), false);
  assert.ok(!readdirSync(stationRoot(f.home)).some(name => name.startsWith(`.${release.version}-`)));
  assert.equal(readFileSync(join(stationRoot(f.home), "state.json"), "utf8"), before);
  rmSync(marker);
  assert.equal((await promote(f.home, dependencies)).promoted, false);
  assert.deepEqual((await readStationState(f.home)).current, f.a);
});

test("station lock deadline names observed acquirers, does not run the body, and recovers after release", { timeout: 10000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "a4s-lock-deadline-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // Launcher targets ES2022, whose Promise type does not expose withResolvers.
  let enter!: () => void, unlock!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), release = new Promise<void>(resolve => { unlock = resolve; });
  const holder = stationTransaction(directory, async () => { enter(); await release; });
  await entered;
  let ran = false;
  try {
    await assert.rejects(stationTransaction(directory, async () => { ran = true; }, {
      withFileLock: (path, body) => withFileLockAsync(path, body, { timeoutMs: 100 }),
    }), error => {
      assert.equal((error as NodeJS.ErrnoException).code, "ETIMEDOUT");
      assert.match(String(error), /Lock acquisition timed out after 100ms.*\.state\.lock/);
      assert.ok(String(error).includes(`"pid":${process.pid}`));
      assert.match(String(error), /observed acquirers=.*"host":.*"command":.*"acquiredAt":/);
      return true;
    });
    await assert.rejects(stationTransaction(directory, async () => { ran = true; }, {
      withFileLock: (path, body) => withFileLockAsync(path, body, { timeoutMs: 0 }),
    }), { code: "ETIMEDOUT" });
    assert.equal(ran, false);
  } finally { unlock(); await holder; }
  assert.equal(await stationTransaction(directory, async () => "next tick"), "next tick");
});
