import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
