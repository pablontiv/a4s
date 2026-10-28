import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { roleRuntimeFixture } from "./fixtures/role-runtime.ts";

import { runRoleCommand } from "./fixtures/rolejobs-cli.ts";

test("explicit package runtime wins over a compiled-binary-first PATH", async () => {
  const root = mkdtempSync(join(tmpdir(), "a4s-role-runtime-"));
  try {
    const runtime = roleRuntimeFixture(root);
    mkdirSync(join(root, "bin"));
    symlinkSync(process.execPath, join(root, "bin/omp"));
    const env = { ...process.env, PRIMARY: root, PATH: `${join(root, "bin")}:${process.env.PATH}`, DAGU_OMP_ROLE_RUNTIME: runtime };
    const result = await runRoleCommand(["detect"], env);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { root: runtime, agents: [
      { name: "triage-reviewer", source: `fixture:${root}` }, { name: "task", source: `fixture:${root}` },
    ] });
    const missing = await runRoleCommand(["detect"], { ...env, DAGU_OMP_ROLE_RUNTIME: undefined, OMP_ROLE_RUNTIME: runtime });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /tried DAGU_OMP_ROLE_RUNTIME is unset/);
    assert.match(missing.stderr, /Set DAGU_OMP_ROLE_RUNTIME to the installed @oh-my-pi\/pi-coding-agent package root/);
    assert.match(missing.stderr, /PATH\/compiled omp binaries are not used/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid explicit runtime fails closed and names the attempted root", async () => {
  const root = mkdtempSync(join(tmpdir(), "a4s-role-invalid-"));
  try {
    const runtime = roleRuntimeFixture(root);
    writeFileSync(join(runtime, "package.json"), JSON.stringify({ name: "unrelated-package" }));
    const result = await runRoleCommand(["detect"], { ...process.env, PRIMARY: root, DAGU_OMP_ROLE_RUNTIME: runtime });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(`tried DAGU_OMP_ROLE_RUNTIME=${JSON.stringify(runtime)}`), result.stderr);
    assert.match(result.stderr, /package is not @oh-my-pi\/pi-coding-agent/);
    writeFileSync(join(runtime, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent" }));
    rmSync(join(runtime, "src/task/executor.ts"));
    const incomplete = await runRoleCommand(["detect"], { ...process.env, PRIMARY: root, DAGU_OMP_ROLE_RUNTIME: runtime });
    assert.notEqual(incomplete.status, 0);
    assert.match(incomplete.stderr, /missing src\/task\/executor.ts/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

