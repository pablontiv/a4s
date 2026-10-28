import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { recordNoProgress } from "../src/ci-no-progress.ts";

test("CI no-progress uses the existing fingerprint, idempotent observation count and durable request", () => {
  const root = mkdtempSync(join(tmpdir(), "a4s-no-progress-"));
  const lock = <T>(_path: string, body: () => T): T => body();
  try {
    const observation = { run: "one", sha: "abc", check: "CI", cause: "déferred", class: "BLOCKED", action: "WAIT" };
    const path = join(root, "ci-observation.json");
    writeFileSync(path, JSON.stringify(observation));
    for (const id of ["first", "first", "second", "third"]) recordNoProgress(root, id, "2", lock);
    const expected = createHash("sha256").update('["one","abc","CI","d\\u00e9ferred"]').digest("hex");
    const state = JSON.parse(readFileSync(join(root, "ci-no-progress.json"), "utf8"));
    assert.equal(state.fingerprint, expected);
    assert.equal(state.observations, 3);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).decisionRequest, { id: expected, observations: 2 });
    writeFileSync(path, JSON.stringify({ ...observation, class: "PASS", action: "AUTO_MERGE" }));
    recordNoProgress(root, "fourth", "2", lock);
    assert.equal(JSON.parse(readFileSync(join(root, "ci-no-progress.json"), "utf8")).observations, 0);
    assert.throws(() => recordNoProgress(root, "fifth", "0", lock), /positive/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
