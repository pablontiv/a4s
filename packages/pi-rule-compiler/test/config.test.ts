import assert from "node:assert/strict";
import test from "node:test";
import {
  BASIC_COMPACTION_CONFIG,
  configurationFromGlobalFile,
  resolveCompactionConfig,
} from "../src/config.ts";

const BASIC_FLAT_CONFIG = {
  "compaction.strategy": "basic",
  "trigger.mode": "hint",
  "evidence.strategy": "off",
};

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

test("global file accepts only the three flat non-secret mode keys", () => {
  assert.deepEqual(
    configurationFromGlobalFile(JSON.stringify({
      "compaction.strategy": "ladder",
      "trigger.mode": "off",
      "evidence.strategy": "ladder",
    })),
    {
      "compaction.strategy": "ladder",
      "trigger.mode": "off",
      "evidence.strategy": "ladder",
    },
  );
});

test("missing, malformed, and non-object global files fail closed to basic", () => {
  assert.deepEqual(configurationFromGlobalFile(undefined), BASIC_FLAT_CONFIG);
  assert.deepEqual(configurationFromGlobalFile("{"), BASIC_FLAT_CONFIG);
  assert.deepEqual(configurationFromGlobalFile("null"), BASIC_FLAT_CONFIG);
  assert.deepEqual(configurationFromGlobalFile("[]"), BASIC_FLAT_CONFIG);
  assert.deepEqual(configurationFromGlobalFile('"ladder"'), BASIC_FLAT_CONFIG);
});

test("unknown global fields fail closed instead of projecting selected keys", () => {
  assert.deepEqual(
    configurationFromGlobalFile(JSON.stringify({
      "compaction.strategy": "ladder",
      "trigger.mode": "off",
      "evidence.strategy": "off",
      TYPESAFE_API_KEY: "must-not-be-read-as-configuration",
    })),
    BASIC_FLAT_CONFIG,
  );
});

test("invalid global values and combinations fail closed to the complete basic config", () => {
  assert.deepEqual(
    configurationFromGlobalFile(JSON.stringify({
      "compaction.strategy": "ladder",
      "trigger.mode": "surprise",
      "evidence.strategy": "off",
    })),
    BASIC_FLAT_CONFIG,
  );
  assert.deepEqual(
    configurationFromGlobalFile(JSON.stringify({
      "compaction.strategy": "basic",
      "trigger.mode": "off",
      "evidence.strategy": "ladder",
    })),
    BASIC_FLAT_CONFIG,
  );
});
