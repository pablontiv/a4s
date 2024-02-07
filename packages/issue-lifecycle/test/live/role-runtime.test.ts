import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { liveDagu, liveDaguVersion } from "../fixtures/live-dagu.ts";
import { roleRuntimeFixture } from "../fixtures/role-runtime.ts";
import { packageRoot } from "../../src/executable.ts";

const cli = fileURLToPath(new URL("../../bin/dagu-role-jobs.ts", import.meta.url));
test(`Dagu ${liveDaguVersion} discovers the omp binary from its step PATH`, { ...liveDagu, timeout: 30_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "a4s-role-dagu-"));
  try {
    roleRuntimeFixture(root);
    const output = join(root, "detected.json"), dag = join(root, "role-runtime.yaml");
    writeFileSync(dag, `type: graph
dotenv: []
shell: bash
env:
  PRIMARY: ${JSON.stringify(root)}
  PATH: ${JSON.stringify(`${join(root, "bin")}:${process.env.PATH}`)}
steps:
  - id: detect
    run: ${JSON.stringify(`${JSON.stringify(process.execPath)} --import ${JSON.stringify(import.meta.resolve("tsx"))} ${JSON.stringify(cli)} detect > ${JSON.stringify(output)}`)}
`);
    execFileSync("dagu", ["start", dag], { env: { ...process.env, DAGU_HOME: join(root, "home"), DAGU_COORDINATOR_ENABLED: "false" }, encoding: "utf8", timeout: 25_000, stdio: ["ignore", "pipe", "pipe"] });
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), { root: realpathSync(join(root, "bin/omp")), agents: [
      { name: "triage-reviewer", source: join(packageRoot, "agents/triage-reviewer.md") }, { name: "task", source: `fixture:${root}` },
    ] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
