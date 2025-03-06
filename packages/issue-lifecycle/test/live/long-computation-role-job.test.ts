import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { openComputation, readCompleted, recordSample, superviseComputation } from "../../src/long-computation.ts";
import { proveLongComputation } from "../long-computation-scenario.ts";
test("the role-job executor resumes at shard 2 and reports one stall to the owner", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a4s-computation-scenario-")));
  try {
    const evidence = await proveLongComputation(root);
    assert.equal(evidence.resumeIndex, 2);
    assert.match(evidence.shardOutput, /"index": 1/);
    assert.equal(evidence.notice.progress.lastShard?.index, 1);
    assert.ok(evidence.commands.some(command => command.includes("computation sample")));
    assert.ok(evidence.commands.some(command => command.includes("computation open")));
    assert.ok(evidence.commands.some(command => command.includes("computation run") && command.includes("--background")));
    assert.ok(evidence.commands.some(command => command.includes("--decision stop")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const failure of ["nonzero", "killed"] as const) {
  test(`supervision reports a real ${failure} worker promptly without a stall`, { timeout: 15_000 }, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "a4s-computation-failure-")));
    const directory = join(root, "computations", failure);
    recordSample(directory, { units: 1, elapsedMs: 60_000, projectedUnits: 2, shardUnits: 1 });
    const manifest = openComputation(directory, { id: failure, run: "feature-775", session: "owner", totalUnits: 2, shardUnits: 1, stallMultiple: 8 });
    const cli = fileURLToPath(new URL("../../bin/dagu-role-jobs.ts", import.meta.url));
    const args = failure === "nonzero"
      ? ["--command", "if [ \"$A4S_SHARD_INDEX\" = 2 ]; then printf 'shard failure diagnostic' >&2; exit 7; fi"]
      : ["--delay-ms", "60000"];
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), cli, "computation", "run", "--dir", directory, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    try {
      const started = Date.now();
      const deadline = Date.now() + 5_000;
      while (!existsSync(join(directory, "worker.json"))) {
        assert.ok(Date.now() < deadline, `worker did not register: ${stderr}`);
        await delay(10);
      }
      const supervised = superviseComputation(directory, {
        signal: AbortSignal.timeout(8_000), pollMs: 10,
        notify: () => assert.fail("worker failure must not be reported as a stall"),
      });
      if (failure === "killed") child.kill("SIGKILL");
      const result = await supervised;
      assert.equal(await exited, failure === "nonzero" ? 1 : null, stderr);
      if (failure === "nonzero") {
        assert.equal(typeof result, "object");
        if (typeof result !== "object" || result.state !== "failed") assert.fail("expected failed result");
        assert.equal(result.shard, 2);
        assert.equal(result.exitCode, 7);
        assert.equal(result.log, "command-2.log");
        assert.match(readFileSync(join(directory, result.log), "utf8"), /shard failure diagnostic/);
        assert.equal(readCompleted(directory).length, 1);
        assert.deepEqual(JSON.parse(readFileSync(join(directory, "state.json"), "utf8")), result);
      } else {
        assert.deepEqual(result, { state: "dead", log: "worker.log" });
        assert.equal(JSON.parse(readFileSync(join(directory, "state.json"), "utf8")).state, "running");
      }
      assert.ok(Date.now() - started < manifest.measuredShardMs * manifest.stallMultiple / 10);
      assert.equal(existsSync(join(directory, "stall.json")), false);
      assert.equal(existsSync(join(root, "stall-notices.jsonl")), false);
    } finally {
      child.kill("SIGKILL");
      await exited;
      rmSync(root, { recursive: true, force: true });
    }
  });
}
