import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { liveDagu, liveDaguVersion } from "../fixtures/live-dagu.ts";
import { roleRuntimeFixture } from "../fixtures/role-runtime.ts";

const cli = fileURLToPath(new URL("../../bin/dagu-role-jobs.ts", import.meta.url));

test(`Dagu ${liveDaguVersion} delivers the explicit runtime to native role discovery`, { ...liveDagu, timeout: 30_000 }, t => {
  const root = mkdtempSync(join(tmpdir(), "a4s-role-dagu-"));
  try {
    const runtime = roleRuntimeFixture(root);
    const output = join(root, "detected.json");
    const legacy = join(root, "legacy.txt");
    const dag = join(root, "role-runtime.yaml");
    writeFileSync(dag, `type: graph
dotenv: []
shell: bash
env:
  PRIMARY: ${JSON.stringify(root)}
steps:
  - id: detect
    run: |
      set -euo pipefail
      printf '%s' "\${OMP_ROLE_RUNTIME-unset}" > ${JSON.stringify(legacy)}
      ${JSON.stringify(process.execPath)} --import ${JSON.stringify(import.meta.resolve("tsx"))} ${JSON.stringify(cli)} detect > ${JSON.stringify(output)}
`);
    const env = { ...process.env, DAGU_HOME: join(root, "home"), DAGU_COORDINATOR_ENABLED: "false", DAGU_OMP_ROLE_RUNTIME: runtime, OMP_ROLE_RUNTIME: "must-not-reach-the-step" };
    execFileSync("dagu", ["start", dag], { env, encoding: "utf8", timeout: 25_000, stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(readFileSync(legacy, "utf8"), "unset");
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), { root: runtime, agents: [
      { name: "triage-reviewer", source: `fixture:${root}` }, { name: "task", source: `fixture:${root}` },
    ] });
    t.diagnostic(`Dagu ${liveDaguVersion}: OMP_ROLE_RUNTIME filtered; DAGU_OMP_ROLE_RUNTIME reached native discovery unchanged`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
