import assert from "node:assert/strict";
import test from "node:test";
import {
  assertE2eGlobalConfiguration,
  assertReloadedEvidenceArtifacts,
  parseE2eMode,
} from "../scripts/run-headless-e2e.ts";
import { configurationFromGlobalFile } from "../src/config.ts";

test("E2E mode selection defaults to basic and accepts explicit Ladder and Evidence expectations", () => {
  assert.equal(parseE2eMode([]), "basic");
  assert.equal(parseE2eMode(["--mode", "basic"]), "basic");
  assert.equal(parseE2eMode(["--mode", "ladder"]), "ladder");
  assert.equal(parseE2eMode(["--mode", "evidence"]), "evidence");
  assert.throws(() => parseE2eMode(["--mode"]), /requires basic, ladder, or evidence/);
  assert.throws(() => parseE2eMode(["--mode", "unknown"]), /requires basic, ladder, or evidence/);
  assert.throws(() => parseE2eMode(["--unknown"]), /unknown E2E argument/);
});

test("E2E mode verifies the persisted global file instead of constructing child environment config", () => {
  const basic = configurationFromGlobalFile(undefined);
  assert.doesNotThrow(() => assertE2eGlobalConfiguration("basic", basic));
  assert.throws(
    () => assertE2eGlobalConfiguration("ladder", basic),
    /~\/.pi\/agent\/pi-context-expert\.json.*ladder/,
  );

  const ladder = configurationFromGlobalFile(JSON.stringify({
    "compaction.strategy": "ladder",
    "trigger.mode": "off",
    "evidence.strategy": "off",
  }));
  assert.doesNotThrow(() => assertE2eGlobalConfiguration("ladder", ladder));
  assert.throws(
    () => assertE2eGlobalConfiguration("basic", ladder),
    /~\/.pi\/agent\/pi-context-expert\.json.*basic/,
  );
});

test("Evidence E2E requires persisted Ladder compaction and Evidence without automatic Trigger", () => {
  const enabledWithHint = configurationFromGlobalFile(JSON.stringify({
    "compaction.strategy": "ladder",
    "trigger.mode": "hint",
    "evidence.strategy": "ladder",
  }));
  const enabledWithTriggerOff = configurationFromGlobalFile(JSON.stringify({
    "compaction.strategy": "ladder",
    "trigger.mode": "off",
    "evidence.strategy": "ladder",
  }));
  const evidenceOff = configurationFromGlobalFile(JSON.stringify({
    "compaction.strategy": "ladder",
    "trigger.mode": "off",
    "evidence.strategy": "off",
  }));
  const automaticTrigger = configurationFromGlobalFile(JSON.stringify({
    "compaction.strategy": "ladder",
    "trigger.mode": "auto",
    "evidence.strategy": "ladder",
  }));

  assert.doesNotThrow(() => assertE2eGlobalConfiguration("evidence", enabledWithHint));
  assert.doesNotThrow(() => assertE2eGlobalConfiguration("evidence", enabledWithTriggerOff));
  assert.throws(
    () => assertE2eGlobalConfiguration("evidence", evidenceOff),
    /evidence\.strategy=ladder/,
  );
  assert.throws(
    () => assertE2eGlobalConfiguration("evidence", automaticTrigger),
    /trigger\.mode=off or hint/,
  );
});

test("Evidence E2E requires every review-only artifact id to survive reload", () => {
  const first = {
    signalBatchIds: new Set(["batch"]),
    proposalIds: new Set(["proposal"]),
    markerIds: new Set(["marker"]),
    receiptIds: new Set(["receipt"]),
  };
  assert.doesNotThrow(() => assertReloadedEvidenceArtifacts(first, {
    signalBatchIds: new Set(["batch"]),
    proposalIds: new Set(["proposal"]),
    markerIds: new Set(["marker"]),
    receiptIds: new Set(["receipt"]),
  }));
  assert.throws(() => assertReloadedEvidenceArtifacts(first, {
    signalBatchIds: new Set(["batch"]),
    proposalIds: new Set<string>(),
    markerIds: new Set(["marker"]),
    receiptIds: new Set(["receipt"]),
  }), /proposal artifacts/);
});
