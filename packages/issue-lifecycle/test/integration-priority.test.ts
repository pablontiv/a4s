import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { pathsFromNameStatus } from "../src/integration-protection.ts";

test("changed-path status keeps both sides of a rename", () => {
  assert.deepEqual(pathsFromNameStatus("M\tkeep.txt\nR100\told.md\tnew.md\n"), ["keep.txt", "new.md", "old.md"]);
});

test("feature hooks name protection, refresh and release", () => {
  const source = readFileSync(new URL("../skills/issue-execution/feature.yaml", import.meta.url), "utf8");
  assert.match(source, /"\$A4S_BIN" protect admit --checkpoint gate \|\|/);
  assert.match(source, /"\$A4S_BIN" protect admit --checkpoint push/);
  assert.match(source, /"\$A4S_BIN" protect admit --checkpoint auto_merge/);
  assert.match(source, /"\$A4S_BIN" protect refresh/);
  assert.match(source, /"\$A4S_BIN" protect release-auto --reason close_gate/);
  assert.match(source, /"\$A4S_BIN" protect release-auto --reason terminal/);
  const documented = readFileSync(new URL("../skills/issue-execution/SKILL.md", import.meta.url), "utf8");
  assert.match(documented, /a4s protect protect --decision/);
  assert.match(documented, /a4s protect release --decision/);
  assert.match(documented, /integration_hold/);
});
