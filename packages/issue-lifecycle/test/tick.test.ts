import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { tick } from "../src/tick.ts";
import { declareService } from "./fixtures/service-environment.ts";

function tickFixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "a4s-tick-launcher-"));
  const declaration = declareService(home, "http://127.0.0.1:18765");
  const launcher = join(home, "bin", "a4s-launch"), payload = join(home, "cached-payload");
  writeFileSync(launcher, "#!/bin/sh\nexit 0\n");
  chmodSync(launcher, 0o755);
  symlinkSync(launcher, join(home, "bin", "a4s"));
  const previous = process.env;
  process.env = { ...previous, ...declaration, PATH: "/unrelated-caller-path", DAG_RUN_ID: "tick-a", A4S_BIN: payload,
    A4S_ARTIFACT: `r498@${"a".repeat(40)}#${"1".repeat(64)}` };
  t.after(() => { process.env = previous; rmSync(home, { recursive: true, force: true }); });
  const output: string[] = [];
  t.mock.method(console, "log", (line: string) => output.push(`${line}\n`));
  t.mock.method(process.stdout, "write", (chunk: string) => { output.push(chunk); return true; });
  return { launcher, payload, output };
}

for (const promoted of [true, false]) {
  test(`tick reaches the declared stable launcher for promotion and GC and continues when promoted=${promoted}`, async t => {
    const f = tickFixture(t), calls: string[][] = [];
    const report = { current: { version: promoted ? "r503" : "r498", commit: "a".repeat(40), digest: "1".repeat(64) }, promoted,
      skipped: promoted ? [] : [{ version: "r503", reason: "incompatible reader" }] };
    const gc = { removed: [], retained: [] };
    const spawn = t.mock.method(childProcess, "spawnSync", (command: string, args: string[], options: childProcess.SpawnSyncOptions) => {
      calls.push([command, ...args]);
      if (command === f.launcher) {
        assert.deepEqual(options.stdio, ["ignore", "pipe", "inherit"]);
        assert.equal(options.encoding, "utf8");
        assert.deepEqual(args, ["station", calls.length === 1 ? "promote" : "gc"]);
        return { status: 0, stdout: `${JSON.stringify(args[1] === "promote" ? report : gc)}\n` };
      }
      if (command === f.payload) {
        assert.deepEqual(args, ["stale-recovery", "recover-scheduled"]);
        return { status: 0 };
      }
      assert.equal(command, "bash");
      return { status: 0, stdout: "[]\n", stderr: "" };
    });
    syncBuiltinESMExports();
    t.after(() => { spawn.mock.restore(); syncBuiltinESMExports(); });

    await tick([]);
    assert.deepEqual(calls.map(call => call.slice(0, 3)), [
      [f.launcher, "station", "promote"],
      [f.payload, "stale-recovery", "recover-scheduled"],
      ["bash", "-euo", "pipefail"],
      [f.launcher, "station", "gc"],
    ]);
    assert.deepEqual(f.output, [
      `tick=tick-a artifact=${process.env.A4S_ARTIFACT}\n`,
      `${JSON.stringify(report)}\n`,
      `${JSON.stringify(gc)}\n`,
    ]);
    assert.equal(process.env.CI_OBSERVATION_ID, "tick-a");
    assert.equal(process.env.A4S_BIN, f.payload);
    assert.ok(process.env.A4S_ARTIFACT!.startsWith("r498@"), "promotion must not change the executing tick tuple");
  });
}

for (const failure of [{ status: 7 }, { status: null }, { status: null, error: new Error("launcher unavailable") }]) {
  test(`tick fails before reconciliation when launcher promotion ${failure.error ? "cannot start" : `exits ${failure.status}`}`, async t => {
    const f = tickFixture(t);
    const spawn = t.mock.method(childProcess, "spawnSync", (command: string, args: string[]) => {
      assert.equal(command, f.launcher);
      assert.deepEqual(args, ["station", "promote"]);
      return failure;
    });
    syncBuiltinESMExports();
    t.after(() => { spawn.mock.restore(); syncBuiltinESMExports(); });
    await assert.rejects(tick([]), { message: failure.error?.message ?? `Station promote failed: ${failure.status}` });
    assert.equal(spawn.mock.callCount(), 1);
  });
}
