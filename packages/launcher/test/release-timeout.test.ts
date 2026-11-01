import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { ensureArtifact, cachePath } from "../src/artifact-cache.ts";
import { archiveName, github, resolveRelease } from "../src/release.ts";
import { stationRoot } from "../src/station-state.ts";
import { fixture } from "./fixture.ts";

test("all release metadata/checksum calls have a 15s hard timeout", t => {
  const calls: Array<{ args: string[]; options: childProcess.ExecFileSyncOptions }> = [];
  const archive = archiveName("r12");
  const mocked = t.mock.method(childProcess, "execFileSync", (command: string, args: string[], options: childProcess.ExecFileSyncOptions) => {
    assert.equal(command, "gh");
    calls.push({ args, options });
    if (args[0] === "release") return `${"3".repeat(64)}  ${archive}\n`;
    if (args[1]!.includes("releases/tags")) return JSON.stringify({ tag_name: "a4s-r12", draft: false, prerelease: false });
    return JSON.stringify({ object: { type: "commit", sha: "c".repeat(40) } });
  });
  syncBuiltinESMExports();
  try {
    github(["api", "--paginate", "--slurp", "repos/test/releases"]);
    resolveRelease("r12");
    assert.equal(calls.length, 4);
    for (const { options } of calls) {
      assert.equal(options.timeout, 15000);
      assert.equal(options.killSignal, "SIGKILL");
    }
    for (const timeout of [0, -1, NaN, Infinity]) assert.throws(() => github([], timeout), /timeout must be positive/);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("archive downloads have a 5-minute hard timeout and failed staging is discarded", async t => {
  const f = fixture(t), release = { ...f.b, archive: archiveName(f.b.version), repository: "test/repo" };
  const timeout = Object.assign(new Error("simulated timeout"), { code: "ETIMEDOUT" });
  const mocked = t.mock.method(childProcess, "execFileSync", (command: string, args: string[], options: childProcess.ExecFileSyncOptions) => {
    assert.equal(command, "gh");
    assert.equal(args[args.indexOf("--pattern") + 1], release.archive);
    assert.equal(options.timeout, 300000);
    assert.equal(options.killSignal, "SIGKILL");
    throw timeout;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(ensureArtifact(f.home, release, {
      withFileLock: f.dependencies.withFileLock!,
      github: () => `${release.digest}  ${release.archive}\n`,
    }), { code: "ETIMEDOUT", message: /timed out after 300000ms/ });
    assert.equal(mocked.mock.callCount(), 1);
    assert.equal(existsSync(cachePath(f.home, release)), false);
    assert.ok(!readdirSync(stationRoot(f.home)).some(name => name.startsWith(`.${release.version}-`)));
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});
