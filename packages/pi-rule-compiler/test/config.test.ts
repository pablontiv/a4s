import assert from "node:assert/strict";
import test from "node:test";
import {
  A4S_PI_RULE_COMPILER_COMPACTION_STRATEGY,
  A4S_PI_RULE_COMPILER_EVIDENCE_STRATEGY,
  A4S_PI_RULE_COMPILER_TRIGGER_MODE,
  BASIC_COMPACTION_CONFIG,
  configurationFromEnvironment,
  resolveCompactionConfig,
} from "../src/config.ts";

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

test("projects only the three namespaced non-secret environment settings into flat config", () => {
  assert.deepEqual(
    configurationFromEnvironment({
      [A4S_PI_RULE_COMPILER_COMPACTION_STRATEGY]: "ladder",
      [A4S_PI_RULE_COMPILER_TRIGGER_MODE]: "off",
      [A4S_PI_RULE_COMPILER_EVIDENCE_STRATEGY]: "ladder",
      TYPESAFE_API_KEY: "must-not-be-projected",
      UNRELATED: "must-not-be-projected",
    }),
    {
      "compaction.strategy": "ladder",
      "trigger.mode": "off",
      "evidence.strategy": "ladder",
    },
  );
});

test("missing environment settings preserve the basic safe defaults", () => {
  assert.deepEqual(configurationFromEnvironment({}), {});
  assert.deepEqual(
    resolveCompactionConfig(configurationFromEnvironment({})),
    BASIC_COMPACTION_CONFIG,
  );
});

test("an invalid installed environment setting fails closed to the complete basic config", () => {
  const projected = configurationFromEnvironment({
    [A4S_PI_RULE_COMPILER_COMPACTION_STRATEGY]: "ladder",
    [A4S_PI_RULE_COMPILER_TRIGGER_MODE]: "surprise",
    [A4S_PI_RULE_COMPILER_EVIDENCE_STRATEGY]: "off",
  });

  assert.deepEqual(resolveCompactionConfig(projected), BASIC_COMPACTION_CONFIG);
});
