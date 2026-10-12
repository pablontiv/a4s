import assert from "node:assert/strict";
import test from "node:test";
import * as publicApi from "../src/index.ts";
import {
  recoverRuleSignalBatchesFromDetails,
  stableDigest,
} from "../src/index.ts";

test("historical pinned-model compaction details remain readable after native Jev migration", () => {
  const attemptId = stableDigest({ test: "historical-native-migration" });
  const sourceDigest = stableDigest({ source: "historical-native-migration" });
  assert.deepEqual(recoverRuleSignalBatchesFromDetails({
    schema: "a4s.jev-compaction-details/v1",
    attemptId,
    sourceDigest,
    jevModel: "jev-1.13.0",
    ruleSignalBatches: [],
  }), { attemptId, sourceDigest, batches: [] });
});

test("the public API does not expose legacy compaction assemblers", () => {
  assert.equal("buildBasicCompactionResult" in publicApi, false);
  assert.equal("buildJevCompactionResult" in publicApi, false);
  assert.equal("assertCompleteCoverage" in publicApi, false);
  assert.equal("CompactionBuildError" in publicApi, false);
});
