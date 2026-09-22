import assert from "node:assert/strict";
import test from "node:test";
import {
  createE2eChildEnvironment,
  parseE2eMode,
} from "../scripts/run-headless-e2e.ts";
import {
  A4S_PI_RULE_COMPILER_COMPACTION_STRATEGY,
  A4S_PI_RULE_COMPILER_EVIDENCE_STRATEGY,
  A4S_PI_RULE_COMPILER_TRIGGER_MODE,
} from "../src/config.ts";

test("E2E mode selection defaults to basic and accepts an explicit Ladder mode", () => {
  assert.equal(parseE2eMode([]), "basic");
  assert.equal(parseE2eMode(["--mode", "basic"]), "basic");
  assert.equal(parseE2eMode(["--mode", "ladder"]), "ladder");
  assert.throws(() => parseE2eMode(["--mode"]), /requires basic or ladder/);
  assert.throws(() => parseE2eMode(["--mode", "unknown"]), /requires basic or ladder/);
  assert.throws(() => parseE2eMode(["--unknown"]), /unknown E2E argument/);
});

test("every E2E child explicitly overrides inherited rule compiler mode settings", () => {
  const inherited = {
    HOME: "/safe-home",
    [A4S_PI_RULE_COMPILER_COMPACTION_STRATEGY]: "ladder",
    [A4S_PI_RULE_COMPILER_TRIGGER_MODE]: "auto",
    [A4S_PI_RULE_COMPILER_EVIDENCE_STRATEGY]: "ladder",
  };

  const basic = createE2eChildEnvironment("basic", inherited);
  assert.equal(basic.HOME, "/safe-home");
  assert.equal(basic[A4S_PI_RULE_COMPILER_COMPACTION_STRATEGY], "basic");
  assert.equal(basic[A4S_PI_RULE_COMPILER_TRIGGER_MODE], "off");
  assert.equal(basic[A4S_PI_RULE_COMPILER_EVIDENCE_STRATEGY], "off");

  const ladder = createE2eChildEnvironment("ladder", inherited);
  assert.equal(ladder[A4S_PI_RULE_COMPILER_COMPACTION_STRATEGY], "ladder");
  assert.equal(ladder[A4S_PI_RULE_COMPILER_TRIGGER_MODE], "off");
  assert.equal(ladder[A4S_PI_RULE_COMPILER_EVIDENCE_STRATEGY], "off");
});
