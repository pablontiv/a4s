import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("station launcher dispatches OMP forms in PRIMARY and commands in the caller's cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "a4s-launcher-"));
  try {
    const primary = join(dir, "primary");
    const caller = join(dir, "caller");
    const bin = join(dir, "bin");
    for (const path of [primary, caller, bin]) mkdirSync(path);
    const omp = join(bin, "omp");
    writeFileSync(omp, '#!/usr/bin/env bash\nprintf "%s\\n" "$PWD" "$@"\n');
    chmodSync(omp, 0o755);
    const launcher = readFileSync(new URL("../station/a4s-14steps", import.meta.url), "utf8")
      .replaceAll("/home/shared/harness/a4s", primary);
    const plugin = join(primary, "packages/omp-dagu");
    const cases = [
      { args: [], cwd: primary, ompArgs: ["-e", plugin] },
      ...["supervisor", "coordinator", "researcher"].map(role => ({
        args: [role, "-p", "prompt with spaces"],
        cwd: primary,
        ompArgs: ["-e", plugin, "--a4s-role", role, "-p", "prompt with spaces"],
      })),
      { args: ["-p", "prompt with spaces"], cwd: primary, ompArgs: ["-e", plugin, "-p", "prompt with spaces"] },
      { args: ["--help"], cwd: primary, ompArgs: ["-e", plugin, "--help"] },
      {
        args: ["omp", "-e", plugin, "--a4s-role", "coordinator", "-p", "legacy prompt"],
        cwd: caller,
        ompArgs: ["-e", plugin, "--a4s-role", "coordinator", "-p", "legacy prompt"],
      },
    ];
    for (const { args, cwd, ompArgs } of cases) {
      const result = spawnSync("bash", ["--noprofile", "--norc", "-c", launcher, "a4s-14steps", ...args], {
        cwd: caller,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, [cwd, ...ompArgs, ""].join("\n"), JSON.stringify(args));
    }
    const command = spawnSync("bash", ["--noprofile", "--norc", "-c", launcher, "a4s-14steps", "pwd"], {
      cwd: caller,
      encoding: "utf8",
    });
    assert.equal(command.status, 0, command.stderr);
    assert.equal(command.stdout, `${caller}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
