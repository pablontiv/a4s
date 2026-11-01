import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import test from "node:test";
import { main } from "../../launcher/src/cli.ts";
import { initializeStation } from "../../launcher/src/station.ts";
import { stationRoot } from "../../launcher/src/station-state.ts";
import { declareService } from "./fixtures/service-environment.ts";
import { stationFixture } from "./fixtures/station.ts";

test("launcher-owned promotion accepts guarded extensions rejected by the stale current validator without executing current", async t => {
  const f = stationFixture(t), current = await f.release("r498"), successor = await f.release("r503");
  await initializeStation(f.home, current, f.dependencies);
  const successorRoot = join(stationRoot(f.home), successor.version);
  const manifest = JSON.parse(readFileSync(join(successorRoot, "package.json"), "utf8"));
  // r498 required exactly these two entries, rejecting the primary guard in r503.
  const staleValidator = (extensions: unknown) => {
    if (!isDeepStrictEqual(extensions, ["./src/status/reloadable.ts", "./src/triage/reloadable.ts"])) {
      throw new Error("Artifact OMP extension metadata does not name the shipped extension entries");
    }
  };
  assert.throws(() => staleValidator(manifest.omp.extensions), /Artifact OMP extension metadata/);
  f.breakPayload(current);

  const previous = process.env;
  process.env = { ...previous, ...f.dependencies.env, ...declareService(f.home, "http://127.0.0.1:18765") };
  delete process.env.A4S_PRIMARY;
  t.after(() => { process.env = previous; });
  const output: string[] = [], executed: string[] = [];
  t.mock.method(console, "log", (line: string) => output.push(line));
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ dagRuns: [] })));
  const spawn = t.mock.method(childProcess, "spawnSync", (command: string) => {
    assert.equal(command, "python3"); // In-process lock boundary; no child is started.
    return { status: 0 };
  });
  const exec = t.mock.method(childProcess, "execFileSync", (command: string, args: string[]) => {
    executed.push(command);
    if (command === join(successorRoot, "a4s")) {
      assert.deepEqual(args, ["version"]);
      return readFileSync(join(successorRoot, "identity.json"), "utf8");
    }
    assert.equal(command, "gh", "current payload must never be invoked for promotion or GC");
    if (args.includes("--paginate")) return JSON.stringify([[{ tag_name: "a4s-r503", draft: false, prerelease: false }]]);
    if (args[1]?.includes("/releases/tags/")) return JSON.stringify({ tag_name: "a4s-r503", draft: false, prerelease: false });
    if (args[1]?.includes("/git/ref/")) return JSON.stringify({ object: { sha: successor.commit, type: "commit" } });
    assert.equal(args[0], "release");
    assert.equal(args[args.indexOf("--pattern") + 1], `${successor.archive}.sha256`);
    return `${successor.digest}  ${successor.archive}\n`;
  });
  syncBuiltinESMExports();
  t.after(() => { spawn.mock.restore(); exec.mock.restore(); syncBuiltinESMExports(); });

  await main(["station", "promote"]);
  const tuple = { version: successor.version, commit: successor.commit, digest: successor.digest };
  assert.deepEqual(JSON.parse(output[0]!), { current: tuple, promoted: true, skipped: [] });
  assert.deepEqual(f.state().current, tuple);
  assert.equal(f.state().generation, 1);
  assert.ok(!executed.includes(join(stationRoot(f.home), current.version, "a4s")));

  // GC must remain launcher-owned even when the newly selected payload is broken.
  f.breakPayload(successor);
  const beforeGc = executed.length;
  await main(["station", "gc"]);
  assert.equal(executed.length, beforeGc);
  const collected = JSON.parse(output[1]!);
  assert.deepEqual(collected.removed, []);
  assert.deepEqual(new Set(collected.retained.map((row: { version: string }) => row.version)), new Set([current.version, successor.version]));
});

test("launcher-owned station commands reject extra arguments before payload handoff", async t => {
  const f = stationFixture(t);
  await f.release("r498");
  const previous = process.env;
  process.env = { ...previous, ...f.dependencies.env, ...declareService(f.home, "http://127.0.0.1:18765") };
  t.after(() => { process.env = previous; });
  for (const command of ["promote", "gc"]) {
    await assert.rejects(main(["station", command, "unexpected"]), { message: `Usage: a4s station ${command}` });
  }
});
