import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { roleRuntimeFixture } from "./fixtures/role-runtime.ts";

const cli = fileURLToPath(new URL("../bin/dagu-role-jobs.ts", import.meta.url));
const bootstrap = fileURLToPath(new URL("../skills/issue-execution/dagu-feature-bootstrap.yaml", import.meta.url));
function detect(env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), cli, "detect"], { env, encoding: "utf8" });
}

test("explicit package runtime wins over a compiled-binary-first PATH", () => {
  const root = mkdtempSync(join(tmpdir(), "a4s-role-runtime-"));
  try {
    const runtime = roleRuntimeFixture(root);
    mkdirSync(join(root, "bin"));
    symlinkSync(process.execPath, join(root, "bin/omp"));
    const env = { ...process.env, PRIMARY: root, PATH: `${join(root, "bin")}:${process.env.PATH}`, DAGU_OMP_ROLE_RUNTIME: runtime };
    const result = detect(env);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { root: runtime, agents: [
      { name: "triage-reviewer", source: `fixture:${root}` }, { name: "task", source: `fixture:${root}` },
    ] });
    const missing = detect({ ...env, DAGU_OMP_ROLE_RUNTIME: undefined, OMP_ROLE_RUNTIME: runtime });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /tried DAGU_OMP_ROLE_RUNTIME is unset/);
    assert.match(missing.stderr, /Set DAGU_OMP_ROLE_RUNTIME to the installed @oh-my-pi\/pi-coding-agent package root/);
    assert.match(missing.stderr, /PATH\/compiled omp binaries are not used/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid explicit runtime fails closed and names the attempted root", () => {
  const root = mkdtempSync(join(tmpdir(), "a4s-role-invalid-"));
  try {
    const runtime = roleRuntimeFixture(root);
    writeFileSync(join(runtime, "package.json"), JSON.stringify({ name: "unrelated-package" }));
    const result = detect({ ...process.env, PRIMARY: root, DAGU_OMP_ROLE_RUNTIME: runtime });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(`tried DAGU_OMP_ROLE_RUNTIME=${JSON.stringify(runtime)}`), result.stderr);
    assert.match(result.stderr, /package is not @oh-my-pi\/pi-coding-agent/);
    writeFileSync(join(runtime, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent" }));
    rmSync(join(runtime, "src/task/executor.ts"));
    const incomplete = detect({ ...process.env, PRIMARY: root, DAGU_OMP_ROLE_RUNTIME: runtime });
    assert.notEqual(incomplete.status, 0);
    assert.match(incomplete.stderr, /missing src\/task\/executor.ts/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const absent of ["triage-reviewer", "task"]) {
  test(`bootstrap detect fails early when ${absent} is not discoverable`, () => {
    const root = mkdtempSync(join(tmpdir(), "a4s-role-bootstrap-"));
    try {
      const runtime = roleRuntimeFixture(root, ["triage-reviewer", "task"].filter(name => name !== absent));
      const bin = join(root, "bin");
      mkdirSync(bin);
      for (const tool of ["git", "gh", "jq", "dagu"]) {
        writeFileSync(join(bin, tool), "#!/bin/sh\nexit 0\n");
        chmodSync(join(bin, tool), 0o755);
      }
      writeFileSync(join(bin, "a4s"), `#!/bin/sh\nshift\nexec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(import.meta.resolve("tsx"))} ${JSON.stringify(cli)} "$@"\n`);
      chmodSync(join(bin, "a4s"), 0o755);
      const spec = parse(readFileSync(bootstrap, "utf8")) as { steps: Array<{ id: string; run: string }> };
      const script = spec.steps.find(step => step.id === "detect")!.run;
      const result = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, A4S_BIN: join(bin, "a4s"), PRIMARY: root, DAGU_OMP_ROLE_RUNTIME: runtime } });
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(`bootstrap detect: Registered OMP agent ${absent} is required but was not discoverable from ${root}`), result.stderr);
      assert.match(result.stderr, /omp plugin link <package-directory>/);
      assert.doesNotMatch(result.stderr, /SKILL_DIR: unbound variable/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
