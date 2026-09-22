import { isStableDigest, stableDigest } from "./digest.ts";
import { MAX_CORPUS_TEXT_CHARS, redactAndLimitCorpusText } from "./redaction.ts";
import type {
  CompactionForcedReason,
  CompactionRetentionAction,
  CorpusChunk,
  CorpusReceipt,
  CompactionRetentionThresholds,
  CompactionWindowObservation,
  MessageCompactionDecision,
  RetroPendingMarker,
  RuleAcceptanceReceipt,
  RuleAuthority,
  RuleClass,
  RuleProposalReceipt,
  RuleScopeKind,
  RuleSignal,
  RuleSignalBatch,
  RuleSignalThresholds,
  StoredRuleProposal,
  StoredRuleProposalCandidate,
} from "./types.ts";
import { DEFAULT_JEV_MODEL } from "./types.ts";

export const RULE_SIGNAL_ENTRY_TYPE = "a4s.pi-rule-compiler.rule-signals.v2" as const;
export const RETRO_PENDING_ENTRY_TYPE = "a4s.pi-rule-compiler.retro-pending.v1" as const;
export const RULE_PROPOSAL_ENTRY_TYPE = "a4s.pi-rule-compiler.rule-proposals.v1" as const;
export const RULE_ACCEPTANCE_ENTRY_TYPE = "a4s.pi-rule-compiler.rule-acceptance.v1" as const;
export const CORPUS_ENTRY_TYPE = "a4s.pi-rule-compiler.corpus.v1" as const;

const RULE_SCOPE_KINDS: readonly RuleScopeKind[] = ["global", "project", "path", "task"];
const RULE_CLASSES: readonly RuleClass[] = [
  "safety",
  "privacy",
  "security",
  "workflow",
  "testing",
  "code_quality",
  "documentation",
  "architecture",
  "other",
];

const AUTHORITIES: readonly RuleAuthority[] = [
  "explicit_user",
  "repository_policy",
  "team_convention",
  "agent_inference",
  "incidental",
];
const ACTIONS: readonly CompactionRetentionAction[] = ["keep", "truncate", "drop"];
const FORCED_REASONS: readonly CompactionForcedReason[] = ["boundary", "newest", "rule_candidate"];

export class StoredEntryValidationError extends Error {
  constructor(readonly path: string) {
    super(`invalid stored rule compiler entry at ${path}`);
    this.name = "StoredEntryValidationError";
  }
}

export function collectCorpus(entries: readonly unknown[]): CorpusChunk[] {
  const chunks: CorpusChunk[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const record = optionalRecord(entry);
    if (record?.type !== "custom" || record.customType !== CORPUS_ENTRY_TYPE) continue;
    try {
      const chunk = parseCorpusChunk(record.data);
      if (!seen.has(chunk.id)) {
        chunks.push(chunk);
        seen.add(chunk.id);
      }
    } catch (error) {
      if (!(error instanceof StoredEntryValidationError)) throw error;
    }
  }
  return chunks;
}

export function collectCorpusReceipts(entries: readonly unknown[]): CorpusReceipt[] {
  const receipts: CorpusReceipt[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const record = optionalRecord(entry);
    if (record?.type !== "custom" || record.customType !== CORPUS_ENTRY_TYPE) continue;
    try {
      const receipt = parseCorpusReceipt(record.data);
      if (!seen.has(receipt.idempotencyKey)) {
        receipts.push(receipt);
        seen.add(receipt.idempotencyKey);
      }
    } catch (error) {
      if (!(error instanceof StoredEntryValidationError)) throw error;
    }
  }
  return receipts;
}

export function parseCorpusChunk(value: unknown): CorpusChunk {
  const path = "$corpusChunk";
  const record = requireRecord(value, path);
  requireExactKeys(record, ["schema", "id", "digest", "role", "position", "text", "provenance"], path);
  if (record.schema !== "a4s.corpus-chunk/v1") fail(`${path}.schema`);
  const role = requireBoundedString(record.role, 1, 80, `${path}.role`);
  if (redactAndLimitCorpusText(role, 80).text.replaceAll(/[\r\n\t]/g, " ").trim() !== role) fail(`${path}.role`);
  const position = requireNonNegativeInteger(record.position, `${path}.position`);
  const text = requireBoundedString(record.text, 1, MAX_CORPUS_TEXT_CHARS, `${path}.text`);
  if (redactAndLimitCorpusText(text).text !== text) fail(`${path}.text`);
  const provenance = requireRecord(record.provenance, `${path}.provenance`);
  requireExactKeys(provenance, ["branchId", "compactionAttemptId", "sourceDigest"], `${path}.provenance`);
  const branchId = requireBoundedString(provenance.branchId, 1, 200, `${path}.provenance.branchId`);
  if (redactAndLimitCorpusText(branchId, 200).text !== branchId) fail(`${path}.provenance.branchId`);
  const compactionAttemptId = requireDigest(provenance.compactionAttemptId, `${path}.provenance.compactionAttemptId`);
  const sourceDigest = requireDigest(provenance.sourceDigest, `${path}.provenance.sourceDigest`);
  const digest = requireDigest(record.digest, `${path}.digest`);
  const expectedDigest = stableDigest({
    schema: "a4s.corpus-chunk/v1",
    role,
    position,
    text,
    provenance: { branchId, compactionAttemptId, sourceDigest },
  });
  if (digest !== expectedDigest) fail(`${path}.digest`);
  const id = requireDigest(record.id, `${path}.id`);
  if (id !== stableDigest({ schema: "a4s.corpus-chunk-id/v1", digest })) fail(`${path}.id`);
  return {
    schema: "a4s.corpus-chunk/v1",
    id,
    digest,
    role,
    position,
    text,
    provenance: { branchId, compactionAttemptId, sourceDigest },
  };
}

export function parseCorpusReceipt(value: unknown): CorpusReceipt {
  const path = "$corpusReceipt";
  const record = requireRecord(value, path);
  requireExactKeys(record, ["schema", "idempotencyKey", "branchId", "compactionAttemptId", "chunkIds"], path);
  if (record.schema !== "a4s.corpus-receipt/v1" || !Array.isArray(record.chunkIds)) fail(path);
  const branchId = requireBoundedString(record.branchId, 1, 200, `${path}.branchId`);
  if (redactAndLimitCorpusText(branchId, 200).text !== branchId) fail(`${path}.branchId`);
  const compactionAttemptId = requireDigest(record.compactionAttemptId, `${path}.compactionAttemptId`);
  const chunkIds = requireUniqueDigests(record.chunkIds, `${path}.chunkIds`);
  const idempotencyKey = requireDigest(record.idempotencyKey, `${path}.idempotencyKey`);
  if (idempotencyKey !== stableDigest({ schema: "a4s.corpus-receipt/v1", branchId, compactionAttemptId, chunkIds })) {
    fail(`${path}.idempotencyKey`);
  }
  return { schema: "a4s.corpus-receipt/v1", idempotencyKey, branchId, compactionAttemptId, chunkIds };
}

export function collectRuleSignalBatches(entries: readonly unknown[]): RuleSignalBatch[] {
  const batches: RuleSignalBatch[] = [];
  for (const entry of entries) {
    const record = optionalRecord(entry);
    if (record?.type !== "custom" || record.customType !== RULE_SIGNAL_ENTRY_TYPE) continue;
    try {
      batches.push(parseRuleSignalBatch(record.data));
    } catch (error) {
      if (!(error instanceof StoredEntryValidationError)) throw error;
    }
  }
  return batches;
}

export function reconstructObservedSourceDigests(entries: readonly unknown[]): Set<string> {
  return new Set(collectRuleSignalBatches(entries).map((batch) => batch.sourceDigest));
}

export function collectRetroPendingMarkers(entries: readonly unknown[]): RetroPendingMarker[] {
  const markers: RetroPendingMarker[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const record = optionalRecord(entry);
    if (record?.type !== "custom" || record.customType !== RETRO_PENDING_ENTRY_TYPE) continue;
    try {
      const marker = parseRetroPendingMarker(record.data);
      if (!seen.has(marker.attemptId)) {
        markers.push(marker);
        seen.add(marker.attemptId);
      }
    } catch (error) {
      if (!(error instanceof StoredEntryValidationError)) throw error;
    }
  }
  return markers;
}

export function parseRetroPendingMarker(value: unknown): RetroPendingMarker {
  const path = "$retroPending";
  const record = requireRecord(value, path);
  requireExactKeys(
    record,
    ["schema", "attemptId", "createdAt", "sourceDigests", "compactionReason", "deferredUntilAgentSettled"],
    path,
  );
  if (
    record.schema !== "a4s.retro-pending/v1" ||
    !Array.isArray(record.sourceDigests) ||
    record.sourceDigests.length === 0 ||
    typeof record.deferredUntilAgentSettled !== "boolean" ||
    (record.compactionReason !== "manual" &&
      record.compactionReason !== "threshold" &&
      record.compactionReason !== "overflow")
  ) {
    fail(path);
  }
  const sourceDigests = record.sourceDigests.map((digest, index) =>
    requireDigest(digest, `${path}.sourceDigests[${index}]`),
  );
  if (new Set(sourceDigests).size !== sourceDigests.length) fail(`${path}.sourceDigests`);
  return {
    schema: "a4s.retro-pending/v1",
    attemptId: requireDigest(record.attemptId, `${path}.attemptId`),
    createdAt: requireTimestamp(record.createdAt, `${path}.createdAt`),
    sourceDigests,
    compactionReason: record.compactionReason,
    deferredUntilAgentSettled: record.deferredUntilAgentSettled,
  };
}

export function collectRuleProposalReceipts(entries: readonly unknown[]): RuleProposalReceipt[] {
  const receipts: RuleProposalReceipt[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const record = optionalRecord(entry);
    if (record?.type !== "custom" || record.customType !== RULE_PROPOSAL_ENTRY_TYPE) continue;
    try {
      const receipt = parseRuleProposalReceipt(record.data);
      if (!seen.has(receipt.idempotencyKey)) {
        receipts.push(receipt);
        seen.add(receipt.idempotencyKey);
      }
    } catch (error) {
      if (!(error instanceof StoredEntryValidationError)) throw error;
    }
  }
  return receipts;
}

export function parseRuleProposalReceipt(value: unknown): RuleProposalReceipt {
  const path = "$ruleProposal";
  const record = requireRecord(value, path);
  requireExactKeys(
    record,
    [
      "schema",
      "idempotencyKey",
      "createdAt",
      "sourceCompactionAttemptIds",
      "sourceBatchDigests",
      "sourceSignalIds",
      "synthesisModel",
      "jevModel",
      "candidates",
    ],
    path,
  );
  if (
    record.schema !== "a4s.rule-proposal-batch/v1" ||
    record.jevModel !== DEFAULT_JEV_MODEL ||
    !Array.isArray(record.sourceCompactionAttemptIds) ||
    !Array.isArray(record.sourceBatchDigests) ||
    !Array.isArray(record.sourceSignalIds) ||
    !Array.isArray(record.candidates)
  ) {
    fail(path);
  }
  requireTimestamp(record.createdAt, `${path}.createdAt`);
  const model = requireRecord(record.synthesisModel, `${path}.synthesisModel`);
  requireExactKeys(model, ["provider", "id"], `${path}.synthesisModel`);
  requireBoundedString(model.provider, 1, 120, `${path}.synthesisModel.provider`);
  requireBoundedString(model.id, 1, 200, `${path}.synthesisModel.id`);
  const sourceCompactionAttemptIds = requireUniqueDigests(
    record.sourceCompactionAttemptIds,
    `${path}.sourceCompactionAttemptIds`,
  );
  const sourceBatchDigests = requireUniqueDigests(record.sourceBatchDigests, `${path}.sourceBatchDigests`);
  requireUniqueDigests(record.sourceSignalIds, `${path}.sourceSignalIds`);
  return {
    idempotencyKey: requireDigest(record.idempotencyKey, `${path}.idempotencyKey`),
    sourceCompactionAttemptIds,
    sourceBatchDigests,
  };
}

export function collectRuleProposalBatches(entries: readonly unknown[]): StoredRuleProposal[] {
  const proposals: StoredRuleProposal[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const record = optionalRecord(entry);
    if (record?.type !== "custom" || record.customType !== RULE_PROPOSAL_ENTRY_TYPE) continue;
    try {
      const proposal = parseStoredRuleProposal(record.data);
      if (!seen.has(proposal.idempotencyKey)) {
        proposals.push(proposal);
        seen.add(proposal.idempotencyKey);
      }
    } catch (error) {
      if (!(error instanceof StoredEntryValidationError)) throw error;
    }
  }
  return proposals;
}

export function parseStoredRuleProposal(value: unknown): StoredRuleProposal {
  const receipt = parseRuleProposalReceipt(value);
  const record = value as Record<string, unknown>;
  const candidates = (record.candidates as unknown[]).map((candidate, index) =>
    parseStoredProposalCandidate(candidate, index),
  );
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) {
    fail("$ruleProposal.candidates");
  }
  return { idempotencyKey: receipt.idempotencyKey, createdAt: requireTimestamp(record.createdAt, "$ruleProposal.createdAt"), candidates };
}

function parseStoredProposalCandidate(value: unknown, index: number): StoredRuleProposalCandidate {
  const path = `$ruleProposal.candidates[${index}]`;
  const record = requireRecord(value, path);
  const scope = requireRecord(record.scope, `${path}.scope`);
  const scopeKind = scope.kind;
  if (typeof scopeKind !== "string" || !RULE_SCOPE_KINDS.includes(scopeKind as RuleScopeKind)) fail(`${path}.scope.kind`);
  const scopeTarget = scope.target === null ? null : requireBoundedString(scope.target, 1, 240, `${path}.scope.target`);
  const evaluation = requireRecord(record.evaluation, `${path}.evaluation`);
  if (evaluation.disposition !== "propose" && evaluation.disposition !== "hold") fail(`${path}.evaluation.disposition`);
  const ruleClass = evaluation.ruleClass;
  if (typeof ruleClass !== "string" || !RULE_CLASSES.includes(ruleClass as RuleClass)) fail(`${path}.evaluation.ruleClass`);
  if (!Array.isArray(record.exceptions) || !Array.isArray(record.sourceRefs)) fail(path);
  return {
    id: requireDigest(record.id, `${path}.id`),
    scope: { kind: scopeKind as RuleScopeKind, target: scopeTarget },
    trigger: requireBoundedString(record.trigger, 1, 500, `${path}.trigger`),
    obligation: requireBoundedString(record.obligation, 1, 1_000, `${path}.obligation`),
    exceptions: record.exceptions.map((item, itemIndex) => requireBoundedString(item, 1, 500, `${path}.exceptions[${itemIndex}]`)),
    sourceRefs: record.sourceRefs.map((item, itemIndex) => requireDigest(item, `${path}.sourceRefs[${itemIndex}]`)),
    ruleClass: ruleClass as RuleClass,
    disposition: evaluation.disposition,
  };
}

export function collectRuleAcceptanceReceipts(entries: readonly unknown[]): RuleAcceptanceReceipt[] {
  const receipts: RuleAcceptanceReceipt[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const record = optionalRecord(entry);
    if (record?.type !== "custom" || record.customType !== RULE_ACCEPTANCE_ENTRY_TYPE) continue;
    try {
      const receipt = parseRuleAcceptanceReceipt(record.data);
      const key = `${receipt.proposalIdempotencyKey}:${receipt.candidateId}`;
      if (!seen.has(key)) {
        receipts.push(receipt);
        seen.add(key);
      }
    } catch (error) {
      if (!(error instanceof StoredEntryValidationError)) throw error;
    }
  }
  return receipts;
}

export function parseRuleAcceptanceReceipt(value: unknown): RuleAcceptanceReceipt {
  const path = "$ruleAcceptance";
  const record = requireRecord(value, path);
  requireExactKeys(record, ["schema", "proposalIdempotencyKey", "candidateId", "acceptedAt"], path);
  if (record.schema !== "a4s.rule-acceptance/v1") fail(`${path}.schema`);
  return {
    schema: "a4s.rule-acceptance/v1",
    proposalIdempotencyKey: requireDigest(record.proposalIdempotencyKey, `${path}.proposalIdempotencyKey`),
    candidateId: requireDigest(record.candidateId, `${path}.candidateId`),
    acceptedAt: requireTimestamp(record.acceptedAt, `${path}.acceptedAt`),
  };
}

export function parseRuleSignalBatch(value: unknown): RuleSignalBatch {
  const batch = requireRecord(value, "$batch");
  requireExactKeys(
    batch,
    [
      "schema",
      "sourceDigest",
      "stateDigest",
      "observedAt",
      "jevModel",
      "compaction",
      "signals",
      "provenance",
      "ruleThresholds",
      "compactionThresholds",
    ],
    "$batch",
  );
  if (batch.schema !== "a4s.rule-signal-batch/v2") fail("$batch.schema");
  const sourceDigest = requireDigest(batch.sourceDigest, "$batch.sourceDigest");
  const stateDigest = requireDigest(batch.stateDigest, "$batch.stateDigest");
  const observedAt = requireTimestamp(batch.observedAt, "$batch.observedAt");
  if (batch.jevModel !== DEFAULT_JEV_MODEL) fail("$batch.jevModel");
  const compaction = parseCompaction(batch.compaction);
  if (!Array.isArray(batch.signals)) fail("$batch.signals");
  const signals = batch.signals.map((signal, index) => parseSignal(signal, index, sourceDigest));
  const provenance = parseProvenance(batch.provenance);
  const ruleThresholds = parseRuleThresholds(batch.ruleThresholds);
  const compactionThresholds = parseCompactionThresholds(batch.compactionThresholds);
  validateRelationships(compaction, signals, provenance);

  return {
    schema: "a4s.rule-signal-batch/v2",
    sourceDigest,
    stateDigest,
    observedAt,
    jevModel: DEFAULT_JEV_MODEL,
    compaction,
    signals,
    provenance,
    ruleThresholds,
    compactionThresholds,
  };
}

function parseCompaction(value: unknown): CompactionWindowObservation {
  const path = "$batch.compaction";
  const record = requireRecord(value, path);
  requireExactKeys(record, ["schema", "kept", "truncated", "dropped", "decisions"], path);
  if (record.schema !== "a4s.compaction-window-observation/v1" || !Array.isArray(record.decisions)) {
    fail(`${path}.schema`);
  }
  const decisions = record.decisions.map((decision, index) => parseDecision(decision, index));
  const kept = requireNonNegativeInteger(record.kept, `${path}.kept`);
  const truncated = requireNonNegativeInteger(record.truncated, `${path}.truncated`);
  const dropped = requireNonNegativeInteger(record.dropped, `${path}.dropped`);
  if (
    kept !== decisions.filter((decision) => decision.action === "keep").length ||
    truncated !== decisions.filter((decision) => decision.action === "truncate").length ||
    dropped !== decisions.filter((decision) => decision.action === "drop").length
  ) {
    fail(path);
  }
  return { schema: "a4s.compaction-window-observation/v1", kept, truncated, dropped, decisions };
}

function parseDecision(value: unknown, index: number): MessageCompactionDecision {
  const path = `$batch.compaction.decisions[${index}]`;
  const record = requireRecord(value, path);
  requireExactKeys(
    record,
    [
      "schema",
      "sourceMessageIndex",
      "sourceMessageDigest",
      "sourceRole",
      "action",
      "forcedBy",
      "continuity",
      "continuityConfidence",
      "actionChoice",
      "actionConfidence",
      "actionProbabilities",
      "selectedExcerpt",
    ],
    path,
  );
  if (record.schema !== "a4s.message-compaction-decision/v1" || !Array.isArray(record.forcedBy)) {
    fail(`${path}.schema`);
  }
  const action = requireAction(record.action, `${path}.action`);
  const actionChoice = requireAction(record.actionChoice, `${path}.actionChoice`);
  const probabilityRecord = requireRecord(record.actionProbabilities, `${path}.actionProbabilities`);
  requireExactKeys(probabilityRecord, ACTIONS, `${path}.actionProbabilities`);
  const actionProbabilities = {
    keep: requireUnit(probabilityRecord.keep, `${path}.actionProbabilities.keep`),
    truncate: requireUnit(probabilityRecord.truncate, `${path}.actionProbabilities.truncate`),
    drop: requireUnit(probabilityRecord.drop, `${path}.actionProbabilities.drop`),
  };
  if (Math.abs(actionProbabilities.keep + actionProbabilities.truncate + actionProbabilities.drop - 1) > 0.02) {
    fail(`${path}.actionProbabilities`);
  }
  const forcedBy = record.forcedBy.map((reason, reasonIndex) =>
    requireForcedReason(reason, `${path}.forcedBy[${reasonIndex}]`),
  );
  if (new Set(forcedBy).size !== forcedBy.length) fail(`${path}.forcedBy`);
  const selectedExcerpt = requireBoundedString(record.selectedExcerpt, 0, 2_400, `${path}.selectedExcerpt`);
  if ((action === "drop") !== (selectedExcerpt.length === 0)) fail(`${path}.selectedExcerpt`);

  return {
    schema: "a4s.message-compaction-decision/v1",
    sourceMessageIndex: requireNonNegativeInteger(record.sourceMessageIndex, `${path}.sourceMessageIndex`),
    sourceMessageDigest: requireDigest(record.sourceMessageDigest, `${path}.sourceMessageDigest`),
    sourceRole: requireBoundedString(record.sourceRole, 1, 80, `${path}.sourceRole`),
    action,
    forcedBy,
    continuity: requireUnit(record.continuity, `${path}.continuity`),
    continuityConfidence: requireUnit(record.continuityConfidence, `${path}.continuityConfidence`),
    actionChoice,
    actionConfidence: requireUnit(record.actionConfidence, `${path}.actionConfidence`),
    actionProbabilities,
    selectedExcerpt,
  };
}

function parseSignal(value: unknown, index: number, batchSourceDigest: string): RuleSignal {
  const path = `$batch.signals[${index}]`;
  const record = requireRecord(value, path);
  requireExactKeys(
    record,
    [
      "schema",
      "id",
      "sourceDigest",
      "sourceMessageDigest",
      "sourceMessageIndex",
      "sourceRole",
      "sanitizedExcerpt",
      "candidateProbability",
      "generality",
      "generalityConfidence",
      "authority",
      "authorityProbability",
      "authorityConfidence",
    ],
    path,
  );
  if (record.schema !== "a4s.rule-signal/v1") fail(`${path}.schema`);
  const sourceDigest = requireDigest(record.sourceDigest, `${path}.sourceDigest`);
  if (sourceDigest !== batchSourceDigest) fail(`${path}.sourceDigest`);
  return {
    schema: "a4s.rule-signal/v1",
    id: requireDigest(record.id, `${path}.id`),
    sourceDigest,
    sourceMessageDigest: requireDigest(record.sourceMessageDigest, `${path}.sourceMessageDigest`),
    sourceMessageIndex: requireNonNegativeInteger(record.sourceMessageIndex, `${path}.sourceMessageIndex`),
    sourceRole: requireBoundedString(record.sourceRole, 1, 80, `${path}.sourceRole`),
    sanitizedExcerpt: requireBoundedString(record.sanitizedExcerpt, 1, 600, `${path}.sanitizedExcerpt`),
    candidateProbability: requireUnit(record.candidateProbability, `${path}.candidateProbability`),
    generality: requireUnit(record.generality, `${path}.generality`),
    generalityConfidence: requireUnit(record.generalityConfidence, `${path}.generalityConfidence`),
    authority: requireAuthority(record.authority, `${path}.authority`),
    authorityProbability: requireUnit(record.authorityProbability, `${path}.authorityProbability`),
    authorityConfidence: requireUnit(record.authorityConfidence, `${path}.authorityConfidence`),
  };
}

function parseProvenance(value: unknown): RuleSignalBatch["provenance"] {
  const path = "$batch.provenance";
  const record = requireRecord(value, path);
  requireExactKeys(
    record,
    [
      "compactionAttemptId",
      "compactionReason",
      "willRetry",
      "windowIndex",
      "windowCount",
      "messageCount",
      "redactionCount",
      "requestCount",
      "inputTokens",
      "outputTokens",
      "sourceMessageIndices",
      "sourceMessageDigests",
      "sanitizedExcerpts",
    ],
    path,
  );
  if (record.compactionReason !== "manual" && record.compactionReason !== "threshold" && record.compactionReason !== "overflow") {
    fail(`${path}.compactionReason`);
  }
  if (typeof record.willRetry !== "boolean" || !Array.isArray(record.sourceMessageIndices) ||
      !Array.isArray(record.sourceMessageDigests) || !Array.isArray(record.sanitizedExcerpts)) {
    fail(path);
  }
  const sourceMessageIndices = record.sourceMessageIndices.map((item, index) =>
    requireNonNegativeInteger(item, `${path}.sourceMessageIndices[${index}]`),
  );
  const sourceMessageDigests = record.sourceMessageDigests.map((item, index) =>
    requireDigest(item, `${path}.sourceMessageDigests[${index}]`),
  );
  const sanitizedExcerpts = record.sanitizedExcerpts.map((item, index) => {
    const itemPath = `${path}.sanitizedExcerpts[${index}]`;
    const excerpt = requireRecord(item, itemPath);
    requireExactKeys(excerpt, ["sourceMessageIndex", "sourceMessageDigest", "role", "excerpt"], itemPath);
    return {
      sourceMessageIndex: requireNonNegativeInteger(excerpt.sourceMessageIndex, `${itemPath}.sourceMessageIndex`),
      sourceMessageDigest: requireDigest(excerpt.sourceMessageDigest, `${itemPath}.sourceMessageDigest`),
      role: requireBoundedString(excerpt.role, 1, 80, `${itemPath}.role`),
      excerpt: requireBoundedString(excerpt.excerpt, 0, 600, `${itemPath}.excerpt`),
    };
  });
  return {
    compactionAttemptId: requireDigest(record.compactionAttemptId, `${path}.compactionAttemptId`),
    compactionReason: record.compactionReason,
    willRetry: record.willRetry,
    windowIndex: requireNonNegativeInteger(record.windowIndex, `${path}.windowIndex`),
    windowCount: requirePositiveInteger(record.windowCount, `${path}.windowCount`),
    messageCount: requirePositiveInteger(record.messageCount, `${path}.messageCount`),
    redactionCount: requireNonNegativeInteger(record.redactionCount, `${path}.redactionCount`),
    requestCount: requirePositiveInteger(record.requestCount, `${path}.requestCount`),
    inputTokens: requireNonNegativeInteger(record.inputTokens, `${path}.inputTokens`),
    outputTokens: requireNonNegativeInteger(record.outputTokens, `${path}.outputTokens`),
    sourceMessageIndices,
    sourceMessageDigests,
    sanitizedExcerpts,
  };
}

function validateRelationships(
  compaction: CompactionWindowObservation,
  signals: readonly RuleSignal[],
  provenance: RuleSignalBatch["provenance"],
): void {
  if (
    provenance.windowIndex >= provenance.windowCount ||
    provenance.messageCount !== provenance.sourceMessageIndices.length ||
    provenance.messageCount !== provenance.sourceMessageDigests.length ||
    provenance.messageCount !== provenance.sanitizedExcerpts.length ||
    provenance.messageCount !== compaction.decisions.length
  ) {
    fail("$batch.provenance");
  }
  const indexToDigest = new Map<number, string>();
  for (const [position, sourceIndex] of provenance.sourceMessageIndices.entries()) {
    if (indexToDigest.has(sourceIndex)) fail("$batch.provenance.sourceMessageIndices");
    const digest = provenance.sourceMessageDigests[position]!;
    const excerpt = provenance.sanitizedExcerpts[position]!;
    if (excerpt.sourceMessageIndex !== sourceIndex || excerpt.sourceMessageDigest !== digest) {
      fail(`$batch.provenance.sanitizedExcerpts[${position}]`);
    }
    indexToDigest.set(sourceIndex, digest);
  }
  for (const [position, decision] of compaction.decisions.entries()) {
    if (indexToDigest.get(decision.sourceMessageIndex) !== decision.sourceMessageDigest) {
      fail(`$batch.compaction.decisions[${position}]`);
    }
  }
  const signalIds = new Set<string>();
  for (const [position, signal] of signals.entries()) {
    if (indexToDigest.get(signal.sourceMessageIndex) !== signal.sourceMessageDigest || signalIds.has(signal.id)) {
      fail(`$batch.signals[${position}]`);
    }
    signalIds.add(signal.id);
  }
}

function parseRuleThresholds(value: unknown): RuleSignalThresholds {
  const path = "$batch.ruleThresholds";
  const record = requireRecord(value, path);
  requireExactKeys(record, ["candidateProbabilityMinimum", "generalityMinimum", "authorityProbabilityMinimum", "authorityConfidenceMinimum", "allowedAuthorities"], path);
  if (!Array.isArray(record.allowedAuthorities) || record.allowedAuthorities.length === 0) fail(`${path}.allowedAuthorities`);
  return {
    candidateProbabilityMinimum: requireUnit(record.candidateProbabilityMinimum, `${path}.candidateProbabilityMinimum`),
    generalityMinimum: requireUnit(record.generalityMinimum, `${path}.generalityMinimum`),
    authorityProbabilityMinimum: requireUnit(record.authorityProbabilityMinimum, `${path}.authorityProbabilityMinimum`),
    authorityConfidenceMinimum: requireUnit(record.authorityConfidenceMinimum, `${path}.authorityConfidenceMinimum`),
    allowedAuthorities: record.allowedAuthorities.map((item, index) => requireAuthority(item, `${path}.allowedAuthorities[${index}]`)),
  };
}

function parseCompactionThresholds(value: unknown): CompactionRetentionThresholds {
  const path = "$batch.compactionThresholds";
  const record = requireRecord(value, path);
  requireExactKeys(record, ["keepProbabilityMinimum", "truncateProbabilityMinimum", "dropProbabilityMinimum", "continuityKeepMinimum", "continuityTruncateMinimum", "choiceConfidenceMinimum", "truncatedExcerptChars"], path);
  return {
    keepProbabilityMinimum: requireUnit(record.keepProbabilityMinimum, `${path}.keepProbabilityMinimum`),
    truncateProbabilityMinimum: requireUnit(record.truncateProbabilityMinimum, `${path}.truncateProbabilityMinimum`),
    dropProbabilityMinimum: requireUnit(record.dropProbabilityMinimum, `${path}.dropProbabilityMinimum`),
    continuityKeepMinimum: requireUnit(record.continuityKeepMinimum, `${path}.continuityKeepMinimum`),
    continuityTruncateMinimum: requireUnit(record.continuityTruncateMinimum, `${path}.continuityTruncateMinimum`),
    choiceConfidenceMinimum: requireUnit(record.choiceConfidenceMinimum, `${path}.choiceConfidenceMinimum`),
    truncatedExcerptChars: requirePositiveInteger(record.truncatedExcerptChars, `${path}.truncatedExcerptChars`),
  };
}

function requireAuthority(value: unknown, path: string): RuleAuthority {
  if (typeof value !== "string" || !AUTHORITIES.includes(value as RuleAuthority)) fail(path);
  return value as RuleAuthority;
}

function requireAction(value: unknown, path: string): CompactionRetentionAction {
  if (typeof value !== "string" || !ACTIONS.includes(value as CompactionRetentionAction)) fail(path);
  return value as CompactionRetentionAction;
}

function requireForcedReason(value: unknown, path: string): CompactionForcedReason {
  if (typeof value !== "string" || !FORCED_REASONS.includes(value as CompactionForcedReason)) fail(path);
  return value as CompactionForcedReason;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  const record = optionalRecord(value);
  if (!record) fail(path);
  return record;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[], path: string): void {
  const actual = Object.keys(record).sort((left, right) => left.localeCompare(right));
  const expected = [...keys].sort((left, right) => left.localeCompare(right));
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(path);
}

function requireDigest(value: unknown, path: string): string {
  if (!isStableDigest(value)) fail(path);
  return value;
}

function requireTimestamp(value: unknown, path: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail(path);
  return new Date(value).toISOString();
}

function requireUniqueDigests(value: readonly unknown[], path: string): string[] {
  if (value.length === 0) fail(path);
  const digests = value.map((item, index) => requireDigest(item, `${path}[${index}]`));
  if (new Set(digests).size !== digests.length) fail(path);
  return digests;
}

function requireUnit(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) fail(path);
  return value;
}

function requirePositiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) fail(path);
  return value;
}

function requireNonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail(path);
  return value;
}

function requireBoundedString(value: unknown, minimum: number, maximum: number, path: string): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) fail(path);
  return value;
}

function fail(path: string): never {
  throw new StoredEntryValidationError(path);
}
