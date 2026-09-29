import assert from "node:assert/strict";
import test from "node:test";
import {
  collectCorpus,
  CORPUS_ENTRY_TYPE,
  stableDigest,
  stageCorpus,
  type NormalizedSessionMessage,
} from "../src/index.ts";

const secretMessage: NormalizedSessionMessage = {
  index: 0,
  role: "user",
  text: "password=canary-secret",
  sourceDigest: stableDigest("password=canary-secret"),
  redactionCount: 0,
};

test("corpus redacts before deriving its digest or CustomEntry", () => {
  const chunk = stageCorpus([secretMessage])[0];
  assert.ok(chunk);
  assert.equal(JSON.stringify(chunk).includes("canary-secret"), false);
  assert.notEqual(chunk.digest, stableDigest(secretMessage.text));
  assert.notEqual(chunk.provenance.sourceDigest, secretMessage.sourceDigest);
});

test("corpus entries stay scoped to the current branch", () => {
  const branchA = [{
    type: "custom",
    customType: CORPUS_ENTRY_TYPE,
    data: stageCorpus([{ ...secretMessage, text: "branch A" }], {
      branchId: "branch-a",
      compactionAttemptId: stableDigest("attempt-a"),
    })[0],
  }];
  const branchB = [{
    type: "custom",
    customType: CORPUS_ENTRY_TYPE,
    data: stageCorpus([{ ...secretMessage, text: "branch B" }], {
      branchId: "branch-b",
      compactionAttemptId: stableDigest("attempt-b"),
    })[0],
  }];

  assert.notDeepEqual(collectCorpus(branchA), collectCorpus(branchB));
});
