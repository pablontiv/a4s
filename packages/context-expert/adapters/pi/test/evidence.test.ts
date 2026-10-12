import assert from "node:assert/strict";
import test from "node:test";
import * as publicApi from "../src/index.ts";
import {
  collectCorpus,
  collectEvidenceReceipts,
  collectRetroPendingMarkers,
  collectRuleSignalBatches,
  CORPUS_ENTRY_TYPE,
  DEFAULT_JEV_MODEL,
  EVIDENCE_RECEIPT_ENTRY_TYPE,
  extractRuleSignals,
  isLadderEvidence,
  RETRO_PENDING_ENTRY_TYPE,
  RULE_SIGNAL_ENTRY_TYPE,
  runEvidence,
  selectEvidenceContext,
  selectLadderProjection,
  stableDigest,
  stageCorpus,
  type CompactionConfig,
  type JevClient,
  type JevQuestion,
  type JevRequest,
  type RunEvidenceResult,
} from "../src/index.ts";
import { runEvidenceWithFailure } from "../src/evidence-pipeline.ts";
import { validJevResponse } from "./fixtures.ts";

type AssertNever<T extends never> = T;
type RunEvidenceResultHasNoFailureCode = AssertNever<Extract<keyof RunEvidenceResult, "failureCode">>;
const runEvidenceResultHasNoFailureCode: RunEvidenceResultHasNoFailureCode[] = [];

class EvidenceJev implements JevClient {
  readonly requests: JevRequest[] = [];

  constructor(private readonly uncertainVisibility = false) {}

  async evaluate(request: JevRequest): Promise<unknown> {
    this.requests.push(request);
    return validJevResponse(request, (id: string, question: JevQuestion) => {
      if (id.startsWith("ladder_visibility_") && question.type === "choice") {
        const levels = Object.keys(question.criteria);
        if (this.uncertainVisibility) {
          return {
            type: "choice",
            choice: "current",
            probabilities: { current: 0.4, superseded: 0.2, historical: 0.2, irrelevant: 0.2 },
            confidence: 0.4,
          };
        }
        return {
          type: "choice",
          choice: "current",
          probabilities: Object.fromEntries(levels.map((level) => [level, level === "current" ? 1 : 0])),
          confidence: 1,
        };
      }
      if (id.startsWith("rule_authority_") && question.type === "choice") {
        const authorities = Object.keys(question.criteria);
        return {
          type: "choice",
          choice: "explicit_user",
          probabilities: Object.fromEntries(authorities.map((authority) => [authority, authority === "explicit_user" ? 1 : 0])),
          confidence: 1,
        };
      }
      return undefined;
    });
  }
}

function corpus(text = "Always run deterministic tests before declaring completion.") {
  return stageCorpus([
    {
      index: 0,
      role: "user",
      text,
      sourceDigest: stableDigest({ text }),
      redactionCount: 0,
    },
  ], {
    branchId: stableDigest({ branch: "evidence" }),
    compactionAttemptId: stableDigest({ attempt: "evidence" }),
  });
}

const ENABLED_CONFIG: CompactionConfig = {
  compaction: { strategy: "ladder" },
  trigger: { mode: "off" },
  evidence: { strategy: "ladder" },
};

test("Evidence elevates an uncertain candidate instead of hiding it", async () => {
  const chunks = corpus("Potential convention: perhaps run the repository checks before completion.");
  const chunk = chunks[0];
  assert.ok(chunk);
  const jev = new EvidenceJev(true);

  const ordinary = await selectLadderProjection(
    chunks,
    "What happened in the current task?",
    jev,
    new AbortController().signal,
  );
  assert.equal(ordinary.selections[0]?.level, "hide");

  const projection = await selectEvidenceContext(chunks, jev);
  assert.equal(projection.selections.find((item) => item.chunkId === chunk.id)?.level, "full");
  const evidenceState = jev.requests.at(-1)?.state as { query?: unknown; profile?: unknown };
  assert.match(String(evidenceState.query), /durable rule/i);
  assert.equal(evidenceState.profile, "conservative-evidence");
});

test("Evidence stores a review-only signal from selected spans", async () => {
  const chunks = corpus();
  const jev = new EvidenceJev();
  const projection = await selectEvidenceContext(chunks, jev);
  const extracted = await extractRuleSignals({
    projection,
    corpus: chunks,
    jev,
    compactionAttemptId: stableDigest({ attempt: "published" }),
    observedAt: "2026-09-22T12:00:00.000Z",
    reason: "manual",
    willRetry: false,
  });

  assert.equal(extracted.signals[0]?.schema, "a4s.rule-signal/v1");
  assert.deepEqual(extracted.sources.map(({ chunkId, start, end }) => ({ chunkId, start, end })), [
    { chunkId: chunks[0]?.id, start: 0, end: chunks[0]?.text.length },
  ]);
  assert.equal(JSON.stringify(jev.requests).includes("What happened in the current task?"), false);

  const entries: Array<{ type: "custom"; customType: string; data: unknown }> = chunks.map((chunk) => ({
    type: "custom",
    customType: CORPUS_ENTRY_TYPE,
    data: chunk,
  }));
  const result = await runEvidence({
    config: ENABLED_CONFIG,
    result: {
      summary: "summary",
      firstKeptEntryId: "kept",
      tokensBefore: 10,
      details: {
        schema: "a4s.jev-compaction-details/v1",
        attemptId: stableDigest({ attempt: "published" }),
        sourceDigest: stableDigest({ source: "published" }),
        jevModel: DEFAULT_JEV_MODEL,
        createdAt: "2026-09-22T12:00:00.000Z",
        firstKeptEntryId: "kept",
        tokensBefore: 10,
        summary: { digest: stableDigest("summary"), chars: 7, budgetChars: 100, retainedMessages: 1, budgetTruncatedMessages: 0 },
        scheduler: { maxConcurrency: 1, maxRetries: 0, logicalRequests: 1, attempts: 1, retries: 0, maxObservedConcurrency: 1 },
        decisions: [],
        ruleSignalBatches: [],
      },
    },
    reason: "manual",
    willRetry: false,
    corpus: chunks,
    getBranch: () => entries,
    appender: { appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }) },
    jev: new EvidenceJev(),
  });

  assert.equal(result.status, "published");
  assert.equal(result.signals[0]?.schema, "a4s.rule-signal/v1");
  assert.equal(result.rootlineWrites, 0);
  assert.equal(collectRuleSignalBatches(entries).length, 1);
  assert.equal(collectRetroPendingMarkers(entries).length, 1);
  assert.equal(collectEvidenceReceipts(entries).length, 1);
  assert.equal(entries.some((entry) => entry.customType === RULE_SIGNAL_ENTRY_TYPE), true);
  assert.equal(entries.some((entry) => entry.customType === RETRO_PENDING_ENTRY_TYPE), true);
  assert.equal(entries.some((entry) => entry.customType === EVIDENCE_RECEIPT_ENTRY_TYPE), true);

  const replay = await runEvidence({
    config: ENABLED_CONFIG,
    result: result.compactionResult,
    reason: "manual",
    willRetry: false,
    corpus: chunks,
    getBranch: () => entries,
    appender: { appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }) },
    jev: new EvidenceJev(),
  });
  assert.equal(replay.status, "already-published");
  assert.equal(collectRuleSignalBatches(entries).length, 1);
  assert.equal(collectRetroPendingMarkers(entries).length, 1);
  assert.equal(collectEvidenceReceipts(entries).length, 1);
});

test("Evidence keeps candidate, generality, and authority as independent final gates", async (t) => {
  for (const rejectedGate of ["candidate", "generality", "authority"] as const) {
    await t.test(rejectedGate, async () => {
      const chunks = corpus();
      const jev: JevClient = {
        async evaluate(request: JevRequest): Promise<unknown> {
          return validJevResponse(request, (id, question) => {
            if (id.startsWith("ladder_visibility_") && question.type === "choice") {
              return {
                type: "choice",
                choice: "current",
                probabilities: { current: 1, superseded: 0, historical: 0, irrelevant: 0 },
                confidence: 1,
              };
            }
            if (rejectedGate === "candidate" && id.startsWith("rule_candidate_") && question.type === "noul") {
              return { type: "noul", noul: 0.1 };
            }
            if (rejectedGate === "generality" && id.startsWith("rule_generality_") && question.type === "score") {
              return { type: "score", score: 0, confidence: 1 };
            }
            if (id.startsWith("rule_authority_") && question.type === "choice") {
              const authority = rejectedGate === "authority" ? "agent_inference" : "explicit_user";
              return {
                type: "choice",
                choice: authority,
                probabilities: Object.fromEntries(Object.keys(question.criteria).map((item) => [item, item === authority ? 1 : 0])),
                confidence: 1,
              };
            }
            return undefined;
          });
        },
      };
      const projection = await selectEvidenceContext(chunks, jev);
      const extracted = await extractRuleSignals({
        projection,
        corpus: chunks,
        jev,
        compactionAttemptId: stableDigest({ rejectedGate }),
        observedAt: "2026-09-22T12:00:00.000Z",
        reason: "manual",
        willRetry: false,
      });
      assert.deepEqual(extracted.signals, []);
    });
  }
});

test("Evidence failure creates no signal and preserves recoverable corpus", async () => {
  const chunks = corpus();
  const entries: Array<{ type: "custom"; customType: string; data: unknown }> = chunks.map((chunk) => ({
    type: "custom",
    customType: CORPUS_ENTRY_TYPE,
    data: chunk,
  }));
  const result = await runEvidence({
    config: ENABLED_CONFIG,
    result: {
      summary: "summary",
      firstKeptEntryId: "kept",
      tokensBefore: 10,
      details: {
        schema: "a4s.jev-compaction-details/v1",
        attemptId: stableDigest({ attempt: "failure" }),
        sourceDigest: stableDigest({ source: "failure" }),
        jevModel: DEFAULT_JEV_MODEL,
        createdAt: "2026-09-22T12:00:00.000Z",
        firstKeptEntryId: "kept",
        tokensBefore: 10,
        summary: { digest: stableDigest("summary"), chars: 7, budgetChars: 100, retainedMessages: 1, budgetTruncatedMessages: 0 },
        scheduler: { maxConcurrency: 1, maxRetries: 0, logicalRequests: 1, attempts: 1, retries: 0, maxObservedConcurrency: 1 },
        decisions: [],
        ruleSignalBatches: [],
      },
    },
    reason: "manual",
    willRetry: false,
    corpus: chunks,
    getBranch: () => entries,
    appender: { appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }) },
    jev: { evaluate: async () => { throw new Error("Jev failed"); } },
  });

  assert.equal(result.status, "failed");
  assert.equal("failureCode" in result, false);
  assert.deepEqual(result.signals, []);
  assert.equal(collectCorpus(entries).length, chunks.length);
  assert.equal(collectRuleSignalBatches(entries).length, 0);
  assert.equal(collectEvidenceReceipts(entries).length, 0);
});

test("Evidence clasifica límites de estado y plan como oversized_state", async (t) => {
  for (const scenario of [
    { name: "estado", observation: { maxStateTokens: 1, minimumExcerptChars: 48 } },
    { name: "plan", observation: { maxQuestionsPerRequest: 4 } },
  ]) {
    await t.test(scenario.name, async () => {
      const chunks = corpus();
      const failureCodes: string[] = [];
      const result = await runEvidenceWithFailure({
        config: ENABLED_CONFIG,
        result: {
          summary: "summary",
          firstKeptEntryId: "kept",
          tokensBefore: 10,
          details: {
            schema: "a4s.jev-compaction-details/v1",
            attemptId: stableDigest({ attempt: scenario.name }),
            sourceDigest: stableDigest({ source: scenario.name }),
            jevModel: DEFAULT_JEV_MODEL,
            createdAt: "2026-09-22T12:00:00.000Z",
            firstKeptEntryId: "kept",
            tokensBefore: 10,
            summary: { digest: stableDigest("summary"), chars: 7, budgetChars: 100, retainedMessages: 1, budgetTruncatedMessages: 0 },
            scheduler: { maxConcurrency: 1, maxRetries: 0, logicalRequests: 1, attempts: 1, retries: 0, maxObservedConcurrency: 1 },
            decisions: [],
            ruleSignalBatches: [],
          },
        },
        reason: "manual",
        willRetry: false,
        corpus: chunks,
        getBranch: () => [],
        appender: { appendEntry: () => undefined },
        jev: new EvidenceJev(),
        observation: scenario.observation,
      }, (code) => failureCodes.push(code));

      assert.equal(result.status, "failed");
      assert.deepEqual(failureCodes, ["oversized_state"]);
    });
  }
});

test("Evidence conserva su API pública", () => {
  assert.deepEqual(runEvidenceResultHasNoFailureCode, []);
  assert.equal("runEvidenceWithFailure" in publicApi, false);
});

test("Evidence requires both Ladder strategies", () => {
  assert.equal(isLadderEvidence(ENABLED_CONFIG), true);
  assert.equal(isLadderEvidence({ ...ENABLED_CONFIG, evidence: { strategy: "off" } }), false);
  assert.equal(isLadderEvidence({ ...ENABLED_CONFIG, compaction: { strategy: "basic" } }), false);
});
