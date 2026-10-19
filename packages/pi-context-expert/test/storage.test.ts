import assert from "node:assert/strict";
import test from "node:test";
import {
  collectEvidenceReceipts,
  EVIDENCE_RECEIPT_ENTRY_TYPE,
  observeCompactionRules,
  parseEvidenceReceipt,
  parseRuleSignalBatch,
  stableDigest,
  StoredEntryValidationError,
  type EvidenceReceipt,
  type JevClient,
} from "../src/index.ts";
import {
  collectOperationalFailureReceipts,
  OPERATIONAL_FAILURE_ENTRY_TYPE,
  parseOperationalFailureReceipt,
} from "../src/storage.ts";
import { validJevResponse } from "./fixtures.ts";

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

test("historical pinned-model RuleSignal batches remain readable", async () => {
  const jev: JevClient = { evaluate: async (request) => validJevResponse(request) };
  const batch = await observeCompactionRules(
    { messagesToSummarize: [{ role: "user", content: "Always run deterministic tests." }], turnPrefixMessages: [] },
    { reason: "manual", willRetry: false, observedAt: "2026-10-01T20:00:00.000Z" },
    jev,
    new AbortController().signal,
  );
  const historical = { ...batch, jevModel: "jev-1.13.0" };
  assert.equal(parseRuleSignalBatch(historical).jevModel, "jev-1.13.0");
});

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

test("el receipt de fallo aplica la lista privada de campos", () => {
  const valid = {
    schema: "a4s.operational-failure/v1" as const,
    timestamp: "2026-10-01T20:01:00.000Z",
    phase: "evidence" as const,
    code: "storage_failure" as const,
    attemptId: stableDigest({ attempt: "failure" }),
    reason: "threshold" as const,
    willRetry: false,
  };
  assert.deepEqual(parseOperationalFailureReceipt(valid), valid);
  assert.deepEqual(collectOperationalFailureReceipts([{
    type: "custom",
    customType: OPERATIONAL_FAILURE_ENTRY_TYPE,
    data: valid,
  }]), [valid]);
  assert.throws(
    () => parseOperationalFailureReceipt({ ...valid, errorMessage: "private text" }),
    (error: unknown) => error instanceof StoredEntryValidationError && error.path === "$operationalFailure",
  );
  assert.throws(
    () => parseOperationalFailureReceipt({ ...valid, reason: "private text" }),
    (error: unknown) => error instanceof StoredEntryValidationError && error.path === "$operationalFailure",
  );
  assert.throws(
    () => parseOperationalFailureReceipt({ ...valid, phase: "session_compact_failed" }),
    (error: unknown) => error instanceof StoredEntryValidationError && error.path === "$operationalFailure",
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
