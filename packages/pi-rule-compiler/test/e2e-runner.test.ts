import assert from "node:assert/strict";
import test from "node:test";
import {
  assertE2eGlobalConfiguration,
  parseE2eMode,
} from "../scripts/run-headless-e2e.ts";
import { configurationFromGlobalFile } from "../src/config.ts";

test("E2E mode selection defaults to basic and accepts an explicit Ladder expectation", () => {
  assert.equal(parseE2eMode([]), "basic");
  assert.equal(parseE2eMode(["--mode", "basic"]), "basic");
  assert.equal(parseE2eMode(["--mode", "ladder"]), "ladder");
  assert.throws(() => parseE2eMode(["--mode"]), /requires basic or ladder/);
  assert.throws(() => parseE2eMode(["--mode", "unknown"]), /requires basic or ladder/);
  assert.throws(() => parseE2eMode(["--unknown"]), /unknown E2E argument/);
});

test("E2E mode verifies the persisted global file instead of constructing child environment config", () => {
  const basic = configurationFromGlobalFile(undefined);
  assert.doesNotThrow(() => assertE2eGlobalConfiguration("basic", basic));
  assert.throws(
    () => assertE2eGlobalConfiguration("ladder", basic),
    /~\/.pi\/agent\/pi-rule-compiler\.json.*ladder/,
  );

  const ladder = configurationFromGlobalFile(JSON.stringify({
    "compaction.strategy": "ladder",
    "trigger.mode": "off",
    "evidence.strategy": "off",
  }));
  assert.doesNotThrow(() => assertE2eGlobalConfiguration("ladder", ladder));
  assert.throws(
    () => assertE2eGlobalConfiguration("basic", ladder),
    /~\/.pi\/agent\/pi-rule-compiler\.json.*basic/,
  );
});
