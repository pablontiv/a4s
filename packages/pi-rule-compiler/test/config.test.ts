import assert from "node:assert/strict";
import test from "node:test";
import { BASIC_COMPACTION_CONFIG, resolveCompactionConfig } from "../src/config.ts";

test("default configuration offers a compaction hint", () => {
  assert.deepEqual(resolveCompactionConfig(undefined), {
    compaction: { strategy: "basic" },
    trigger: { mode: "hint" },
    evidence: { strategy: "off" },
  });
});

test("invalid configuration preserves the previous safe value", () => {
  assert.deepEqual(
    resolveCompactionConfig({ "evidence.strategy": "ladder" }, BASIC_COMPACTION_CONFIG),
    BASIC_COMPACTION_CONFIG,
  );
});

test("valid opt-in trigger config preserves basic compaction and disabled Evidence", () => {
  assert.deepEqual(
    resolveCompactionConfig({ "trigger.mode": "auto" }, BASIC_COMPACTION_CONFIG),
    {
      compaction: { strategy: "basic" },
      trigger: { mode: "auto" },
      evidence: { strategy: "off" },
    },
  );
});
