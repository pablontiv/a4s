import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadDaguConfig } from "../src/config.ts";

test("station config defaults, normalizes URLs and rejects invalid files with their path", () => {
  const root = mkdtempSync(join(tmpdir(), "dagu-config-"));
  const file = join(root, ".workspace", "config", "dagu.json");
  try {
    assert.deepEqual(loadDaguConfig(root), { daguUrl: "http://127.0.0.1:8080" });
    mkdirSync(join(root, ".workspace", "config"), { recursive: true });
    writeFileSync(file, "{}");
    assert.deepEqual(loadDaguConfig(root), { daguUrl: "http://127.0.0.1:8080" });
    writeFileSync(file, JSON.stringify({ daguUrl: "http://station:8090/" }));
    assert.deepEqual(loadDaguConfig(root), { daguUrl: "http://station:8090" });
    for (const text of ["{", "null", "[]", '"station"', "42", '{"daguUrl":null}', '{"daguUrl":8090}']) {
      writeFileSync(file, text);
      assert.throws(() => loadDaguConfig(root), error => error instanceof Error && error.message.includes(file), text);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
