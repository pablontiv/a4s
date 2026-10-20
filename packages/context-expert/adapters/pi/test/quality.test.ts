import assert from "node:assert/strict";
import test from "node:test";
import {
  collectRuleAcceptanceReceipts,
  collectRuleProposalBatches,
  observeCompactionRules,
  prepareRuleObservation,
  RULE_ACCEPTANCE_ENTRY_TYPE,
  RULE_PROPOSAL_ENTRY_TYPE,
  stableDigest,
  type JevClient,
  type JevQuestion,
  type JevRequest,
} from "../src/index.ts";
import { validJevResponse } from "./fixtures.ts";

// A Jev that scores EVERY rule candidate as a maximally strong repository policy.
// This is the adversarial case for extraction quality: if tool output ever
// reached the candidate pool, this gateway would happily promote it to a rule.
class RulePromotingJev implements JevClient {
  async evaluate(request: JevRequest): Promise<unknown> {
    return validJevResponse(request, (id: string, question: JevQuestion) => {
      if (id.startsWith("rule_candidate_") && question.type === "noul") {
        return { type: "noul", noul: 0.99 };
      }
      if (id.startsWith("rule_authority_") && question.type === "choice") {
        const options = Object.keys(question.criteria);
        return {
          type: "choice",
          choice: "repository_policy",
          probabilities: Object.fromEntries(options.map((o) => [o, o === "repository_policy" ? 1 : 0])),
          confidence: 1,
        };
      }
      if (id.startsWith("rule_generality_") && question.type === "score") {
        return { type: "score", score: 1, confidence: 1 };
      }
      return undefined;
    });
  }
}

const toolResult = (text: string) => ({ role: "toolResult", toolName: "read", content: [{ type: "text", text }] });

test("a genuine user directive still produces a rule signal", async () => {
  const batch = await observeCompactionRules(
    {
      messagesToSummarize: [{ role: "user", content: "Always run the repository checks before you mark a task complete." }],
      turnPrefixMessages: [],
    },
    { reason: "manual", willRetry: false, observedAt: "2026-09-19T10:00:00.000Z" },
    new RulePromotingJev(),
    new AbortController().signal,
  );

  assert.equal(batch.signals.length, 1);
  assert.equal(batch.signals[0]?.sourceRole, "user");
  assert.equal(batch.signals[0]?.authority, "repository_policy");
});

test("acceptance receipts are collected and deduplicated per candidate", () => {
  const candidateId = stableDigest({ candidate: "one" });
  const proposal = proposalBatch(candidateId);
  const idempotencyKey = proposal.data.idempotencyKey;
  const entries = [
    proposal,
    acceptanceEntry(idempotencyKey, candidateId, "2026-09-19T11:00:00.000Z"),
    acceptanceEntry(idempotencyKey, candidateId, "2026-09-19T12:00:00.000Z"),
  ];

  const stored = collectRuleProposalBatches(entries);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.candidates[0]?.id, candidateId);
  assert.equal(stored[0]?.candidates[0]?.disposition, "propose");

  const receipts = collectRuleAcceptanceReceipts(entries);
  assert.equal(receipts.length, 1, "duplicate acceptances collapse to one");
  assert.equal(receipts[0]?.candidateId, candidateId);
});

function acceptanceEntry(proposalIdempotencyKey: string, candidateId: string, acceptedAt: string) {
  return {
    type: "custom",
    customType: RULE_ACCEPTANCE_ENTRY_TYPE,
    data: { schema: "a4s.rule-acceptance/v1", proposalIdempotencyKey, candidateId, acceptedAt },
  };
}

function proposalBatch(candidateId: string) {
  const digest = stableDigest({ seed: candidateId });
  return {
    type: "custom",
    customType: RULE_PROPOSAL_ENTRY_TYPE,
    data: {
      schema: "a4s.rule-proposal-batch/v1",
      idempotencyKey: stableDigest({ idempotency: candidateId }),
      createdAt: "2026-09-19T10:30:00.000Z",
      sourceCompactionAttemptIds: [digest],
      sourceBatchDigests: [digest],
      sourceSignalIds: [candidateId],
      synthesisModel: { provider: "anthropic", id: "claude-opus-5" },
      jevModel: "jev-1.13.0",
      candidates: [
        {
          id: candidateId,
          scope: { kind: "project", target: null },
          trigger: "before marking a task complete",
          obligation: "run the repository checks",
          exceptions: [],
          sourceRefs: [candidateId],
          proposedCheck: { kind: "manual", description: "reviewer confirms checks ran", command: null },
          evaluation: {
            evidenceRelation: "direct",
            evidenceRelationConfidence: 1,
            support: 1,
            supportConfidence: 1,
            generality: 1,
            generalityConfidence: 1,
            enforceability: 1,
            enforceabilityConfidence: 1,
            authority: "repository_policy",
            authorityConfidence: 1,
            ruleClass: "workflow",
            ruleClassConfidence: 1,
            disposition: "propose",
          },
        },
      ],
    },
  };
}
