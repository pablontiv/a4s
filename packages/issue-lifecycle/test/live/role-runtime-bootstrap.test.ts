import { stationEnvironment } from "../fixtures/service-environment.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { roleRuntimeFixture } from "../fixtures/role-runtime.ts";
const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const bootstrap = fileURLToPath(new URL("../../skills/issue-execution/dagu-feature-bootstrap.yaml", import.meta.url));
for (const absent of ["task", "task/executor"]) {
  test(`bootstrap detect fails early when ${absent} is unavailable`, () => {
    const root = mkdtempSync(join(tmpdir(), "a4s-role-bootstrap-"));
    try {
      const runtime = roleRuntimeFixture(root, absent === "task" ? [] : ["task"]);
      if (absent === "task/executor") rmSync(join(runtime, "src/task/executor.ts"));
      const bin = join(root, "bin");
      for (const tool of ["git", "gh", "dagu"]) {
        writeFileSync(join(bin, tool), "#!/bin/sh\nexit 0\n");
        chmodSync(join(bin, tool), 0o755);
      }
      writeFileSync(join(bin, "a4s"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(import.meta.resolve("tsx"))} ${JSON.stringify(cli)} "$@"\n`);
      chmodSync(join(bin, "a4s"), 0o755);
      const spec = parse(readFileSync(bootstrap, "utf8")) as { steps: Array<{ id: string; run: string }> };
      const script = spec.steps.find(step => step.id === "detect")!.run;
      const env = stationEnvironment({ ...process.env, DAGU_HOME: root, PATH: `${bin}:${process.env.PATH}`, A4S_BIN: join(bin, "a4s"), PRIMARY: root });
      // Preserve the fake station PATH even on shells with system startup hooks.
      const selected = spawnSync("bash", ["--noprofile", "--norc", "-c", "command -v omp"], { encoding: "utf8", env });
      assert.equal(selected.stdout.trim(), join(bin, "omp"), selected.stderr);
      const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], { encoding: "utf8", env });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, absent === "task" ? /Registered OMP agent task is required/ : /Required OMP host module @oh-my-pi\/pi-coding-agent\/task\/executor is unavailable/);
      assert.doesNotMatch(result.stderr, /SKILL_DIR: unbound variable/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
