import assert from "node:assert/strict";
import test from "node:test";
import {
  collectEvidenceReceipts,
  EVIDENCE_RECEIPT_ENTRY_TYPE,
  parseEvidenceReceipt,
  stableDigest,
  StoredEntryValidationError,
  type EvidenceReceipt,
} from "../src/index.ts";

function receipt(): EvidenceReceipt {
  const body = {
    schema: "a4s.evidence-receipt/v1" as const,
    compactionAttemptId: stableDigest({ attempt: "storage" }),
    queryDigest: stableDigest("Evidence query"),
    corpusDigest: stableDigest({ corpus: "storage" }),
    sourceSpans: [{
      chunkId: stableDigest({ chunk: 1 }),
      start: 4,
      end: 20,
      sourceMessageIndex: 0,
      sourceDigest: stableDigest({ source: 1 }),
    }],
    batchDigests: [stableDigest({ batch: 1 })],
    signalIds: [stableDigest({ signal: 1 })],
  };
  return { ...body, idempotencyKey: stableDigest(body) };
}

test("Evidence receipts validate their idempotency binding and deduplicate storage replay", () => {
  const valid = receipt();
  assert.deepEqual(parseEvidenceReceipt(valid), valid);
  const entries = [
    { type: "custom", customType: EVIDENCE_RECEIPT_ENTRY_TYPE, data: valid },
    { type: "custom", customType: EVIDENCE_RECEIPT_ENTRY_TYPE, data: structuredClone(valid) },
  ];
  assert.deepEqual(collectEvidenceReceipts(entries), [valid]);

  assert.throws(
    () => parseEvidenceReceipt({ ...valid, corpusDigest: stableDigest({ corpus: "other" }) }),
    (error: unknown) => error instanceof StoredEntryValidationError && error.path === "$evidenceReceipt.idempotencyKey",
  );
});

test("legacy pi-rule-compiler custom entries are not read under the new namespace", () => {
  const valid = receipt();
  assert.deepEqual(collectEvidenceReceipts([{
    type: "custom",
    customType: "a4s.pi-rule-compiler.evidence-receipt.v1",
    data: valid,
  }]), []);
});

test("Evidence receipt collection ignores malformed source boundaries", () => {
  const valid = receipt();
  const malformed = {
    ...valid,
    sourceSpans: [{ ...valid.sourceSpans[0], start: 20, end: 4 }],
  };
  assert.deepEqual(collectEvidenceReceipts([
    { type: "custom", customType: EVIDENCE_RECEIPT_ENTRY_TYPE, data: malformed },
  ]), []);
});
