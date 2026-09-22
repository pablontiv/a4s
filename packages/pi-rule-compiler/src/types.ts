export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const DEFAULT_JEV_MODEL = "jev-1.13.0" as const;
export const TYPESAFE_API_KEY_ENV = "TYPESAFE_API_KEY" as const;
export const TYPESAFE_PROVIDER_ID = "typesafe" as const;

/** Evidence lifecycle strategy; ladder remains inert until its later implementation. */
export interface EvidenceOptions {
  strategy: "off" | "ladder";
}

export type TriggerMode = "off" | "hint" | "auto";

export interface CompactionConfig {
  compaction: { strategy: "basic" | "ladder" };
  trigger: { mode: TriggerMode };
  evidence: EvidenceOptions;
}

export type TriggerDecision =
  | { action: "none" }
  | { action: "hint"; reason: string }
  | { action: "compact" };

export interface NormalizedSessionMessage {
  index: number;
  role: string;
  text: string;
  sourceDigest: string;
  redactionCount: number;
}

/** A redacted, bounded source fragment retained only after Pi confirms compaction. */
export interface CorpusChunk {
  schema: "a4s.corpus-chunk/v1";
  id: string;
  digest: string;
  role: string;
  position: number;
  text: string;
  provenance: {
    branchId: string;
    compactionAttemptId: string;
    sourceDigest: string;
  };
}

/** Idempotency marker for one successful compaction corpus publication. */
export interface CorpusReceipt {
  schema: "a4s.corpus-receipt/v1";
  idempotencyKey: string;
  branchId: string;
  compactionAttemptId: string;
  chunkIds: string[];
}

/** Request-time visibility selected for one sanitized corpus chunk. */
export type VisibilityLevel = "hide" | "short" | "long" | "full";

/** Half-open source offsets into the immutable CorpusChunk.text value. */
export interface SourceSpan {
  chunkId: string;
  start: number;
  end: number;
}

/** A recalculable query/corpus-bound view; it never mutates durable corpus entries. */
export interface VisibilityProjection {
  queryDigest: string;
  corpusDigest: string;
  selections: readonly {
    chunkId: string;
    level: VisibilityLevel;
    spans: readonly SourceSpan[];
  }[];
}

export interface FittedStateMessage {
  index: number;
  role: string;
  sourceDigest: string;
  excerpt: string;
}

export interface RuleObservationState {
  schema: "a4s.rule-observation-state/v1";
  sourceDigest: string;
  messages: FittedStateMessage[];
}

export interface FittedSessionState {
  state: RuleObservationState;
  stateDigest: string;
  sourceDigest: string;
  messages: FittedStateMessage[];
  redactionCount: number;
}

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: {
    true: string;
    false: string;
  };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface JevRequest {
  state: string | readonly unknown[] | object;
  model: typeof DEFAULT_JEV_MODEL;
  questions: Record<string, JevQuestion>;
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface ValidatedJevResponse {
  model: typeof DEFAULT_JEV_MODEL;
  answers: Record<string, JevAnswer>;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface JevClient {
  evaluate(request: JevRequest, options: { signal: AbortSignal }): Promise<unknown>;
}

export interface JevRequestSchedulerStats {
  maxConcurrency: number;
  maxRetries: number;
  logicalRequests: number;
  attempts: number;
  retries: number;
  maxObservedConcurrency: number;
}

export interface RuleCandidateQuestionRef {
  candidateId: string;
  stateMessageIndex: number;
  sourceMessageIndex: number;
  messageDigest: string;
  excerpt: string;
  role: string;
  questionIds: {
    candidate: string;
    generality: string;
    authority: string;
  };
}

export interface CompactionMessageQuestionRef {
  stateMessageIndex: number;
  sourceMessageIndex: number;
  messageDigest: string;
  excerpt: string;
  role: string;
  questionIds: {
    action: string;
    continuity: string;
  };
}

export interface RuleObservationPlan {
  state: FittedSessionState;
  candidates: RuleCandidateQuestionRef[];
  compactionMessages: CompactionMessageQuestionRef[];
  requests: JevRequest[];
}

export type RuleAuthority =
  | "explicit_user"
  | "repository_policy"
  | "team_convention"
  | "agent_inference"
  | "incidental";

export interface RuleSignalThresholds {
  candidateProbabilityMinimum: number;
  generalityMinimum: number;
  authorityProbabilityMinimum: number;
  authorityConfidenceMinimum: number;
  allowedAuthorities: readonly RuleAuthority[];
}

export type CompactionRetentionAction = "keep" | "truncate" | "drop";
export type CompactionForcedReason = "boundary" | "newest" | "rule_candidate";

export interface CompactionRetentionThresholds {
  keepProbabilityMinimum: number;
  truncateProbabilityMinimum: number;
  dropProbabilityMinimum: number;
  continuityKeepMinimum: number;
  continuityTruncateMinimum: number;
  choiceConfidenceMinimum: number;
  truncatedExcerptChars: number;
}

export interface MessageCompactionDecision {
  schema: "a4s.message-compaction-decision/v1";
  sourceMessageIndex: number;
  sourceMessageDigest: string;
  sourceRole: string;
  action: CompactionRetentionAction;
  forcedBy: CompactionForcedReason[];
  continuity: number;
  continuityConfidence: number;
  actionChoice: CompactionRetentionAction;
  actionConfidence: number;
  actionProbabilities: Record<CompactionRetentionAction, number>;
  selectedExcerpt: string;
}

export interface CompactionWindowObservation {
  schema: "a4s.compaction-window-observation/v1";
  kept: number;
  truncated: number;
  dropped: number;
  decisions: MessageCompactionDecision[];
}

export interface RuleSignal {
  schema: "a4s.rule-signal/v1";
  id: string;
  sourceDigest: string;
  sourceMessageDigest: string;
  sourceMessageIndex: number;
  sourceRole: string;
  sanitizedExcerpt: string;
  candidateProbability: number;
  generality: number;
  generalityConfidence: number;
  authority: RuleAuthority;
  authorityProbability: number;
  authorityConfidence: number;
}

export interface RuleSignalBatch {
  schema: "a4s.rule-signal-batch/v2";
  sourceDigest: string;
  stateDigest: string;
  observedAt: string;
  jevModel: typeof DEFAULT_JEV_MODEL;
  compaction: CompactionWindowObservation;
  signals: RuleSignal[];
  provenance: {
    compactionAttemptId: string;
    compactionReason: "manual" | "threshold" | "overflow";
    willRetry: boolean;
    windowIndex: number;
    windowCount: number;
    messageCount: number;
    redactionCount: number;
    requestCount: number;
    inputTokens: number;
    outputTokens: number;
    sourceMessageIndices: number[];
    sourceMessageDigests: string[];
    sanitizedExcerpts: Array<{
      sourceMessageIndex: number;
      sourceMessageDigest: string;
      role: string;
      excerpt: string;
    }>;
  };
  ruleThresholds: RuleSignalThresholds;
  compactionThresholds: CompactionRetentionThresholds;
}

export interface PersistedCompactionDecision extends MessageCompactionDecision {
  summaryExcerpt: string;
  budgetTruncated: boolean;
}

export interface JevCompactionDetails {
  schema: "a4s.jev-compaction-details/v1";
  attemptId: string;
  sourceDigest: string;
  jevModel: typeof DEFAULT_JEV_MODEL;
  createdAt: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  summary: {
    digest: string;
    chars: number;
    budgetChars: number;
    retainedMessages: number;
    budgetTruncatedMessages: number;
  };
  scheduler: JevRequestSchedulerStats;
  decisions: PersistedCompactionDecision[];
  ruleSignalBatches: RuleSignalBatch[];
}

export interface JevCompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details: JevCompactionDetails;
}

export type RuleScopeKind = "global" | "project" | "path" | "task";
export type ProposedCheckKind = "manual" | "command" | "static_analysis";

export interface RuleCandidate {
  id: string;
  scope: {
    kind: RuleScopeKind;
    target: string | null;
  };
  trigger: string;
  obligation: string;
  exceptions: string[];
  sourceRefs: string[];
  proposedCheck: {
    kind: ProposedCheckKind;
    description: string;
    command: string | null;
  };
}

export type EvidenceRelation = "direct" | "consistent" | "inferred" | "contradicted" | "unsupported";
export type RuleClass =
  | "safety"
  | "privacy"
  | "security"
  | "workflow"
  | "testing"
  | "code_quality"
  | "documentation"
  | "architecture"
  | "other";

export interface EvaluatedRuleCandidate extends RuleCandidate {
  evaluation: {
    evidenceRelation: EvidenceRelation;
    evidenceRelationConfidence: number;
    support: number;
    supportConfidence: number;
    generality: number;
    generalityConfidence: number;
    enforceability: number;
    enforceabilityConfidence: number;
    authority: RuleAuthority | "unknown";
    authorityConfidence: number;
    ruleClass: RuleClass;
    ruleClassConfidence: number;
    disposition: "propose" | "hold";
  };
}

export interface RetroPendingMarker {
  schema: "a4s.retro-pending/v1";
  attemptId: string;
  createdAt: string;
  sourceDigests: string[];
  compactionReason: "manual" | "threshold" | "overflow";
  deferredUntilAgentSettled: boolean;
}

export interface RuleProposalReceipt {
  idempotencyKey: string;
  sourceCompactionAttemptIds: string[];
  sourceBatchDigests: string[];
}

export interface RuleProposalBatch {
  schema: "a4s.rule-proposal-batch/v1";
  idempotencyKey: string;
  createdAt: string;
  sourceCompactionAttemptIds: string[];
  sourceBatchDigests: string[];
  sourceSignalIds: string[];
  synthesisModel: {
    provider: string;
    id: string;
  };
  jevModel: typeof DEFAULT_JEV_MODEL;
  candidates: EvaluatedRuleCandidate[];
}

/**
 * Bounded projection of a stored proposal candidate for the review surface.
 * Reconstructed defensively from persisted entries — enough to list, inspect,
 * and accept a candidate without rehydrating the full evaluation payload.
 */
export interface StoredRuleProposalCandidate {
  id: string;
  scope: {
    kind: RuleScopeKind;
    target: string | null;
  };
  trigger: string;
  obligation: string;
  exceptions: string[];
  sourceRefs: string[];
  ruleClass: RuleClass;
  disposition: "propose" | "hold";
}

export interface StoredRuleProposal {
  idempotencyKey: string;
  createdAt: string;
  candidates: StoredRuleProposalCandidate[];
}

/**
 * A manual, human-gated acceptance of a single proposed candidate. Storing an
 * acceptance is the terminal step of the review->accept path today: it is
 * store-only and never writes Rootline/AGENTS.md. The durable write of an
 * accepted rule is deferred to the decision recorded in ADR 0020.
 */
export interface RuleAcceptanceReceipt {
  schema: "a4s.rule-acceptance/v1";
  proposalIdempotencyKey: string;
  candidateId: string;
  acceptedAt: string;
}
