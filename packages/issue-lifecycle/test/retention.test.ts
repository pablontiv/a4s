import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("versioned global base config retains thirty days of run history", () => {
  const base = readFileSync(new URL("../dagu/base.yaml", import.meta.url), "utf8");
  const values = [...base.matchAll(/^hist_retention_days:\s*(\d+)\s*$/gm)];
  assert.deepEqual(values.map((match) => Number(match[1])), [30]);
});
