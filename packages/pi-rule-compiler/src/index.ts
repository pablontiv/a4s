import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPiRuleCompiler } from "./extension.ts";

export { BASIC_COMPACTION_CONFIG, resolveCompactionConfig } from "./config.ts";
export {
  collectCorpus,
  CORPUS_ENTRY_TYPE,
  publishCorpusAfterCompaction,
  stageCorpus,
  type CorpusEntryAppender,
  type CorpusStageOptions,
} from "./corpus.ts";
export {
  assertCompleteCoverage,
  buildBasicCompactionResult,
  type BasicCompactionInput,
} from "./compaction-core.ts";
export {
  buildJevCompactionResult,
  CompactionBuildError,
  recoverRuleSignalBatchesFromDetails,
  type BuildJevCompactionInput,
  type BuildJevCompactionOptions,
} from "./compaction.ts";
export { disabledEvidencePipeline, type EvidencePipeline } from "./evidence-pipeline.ts";
export { runWithDeadline, DeadlineExceededError, OperationAbortedError } from "./deadline.ts";
export { stableDigest, stableJson, isStableDigest } from "./digest.ts";
export {
  createTypesafeAuthResolver,
  registerPiRuleCompiler,
  type PiRuleCompilerOptions,
} from "./extension.ts";
export {
  HttpJevClient,
  JevApiError,
  JevUnavailableError,
  JevValidationError,
  parseScoreAnswer,
  validateJevResponse,
} from "./jev.ts";
export {
  digestNormalizedMessages,
  normalizeCompactionMessages,
  normalizeSessionMessages,
  type CompactionPreparationMessages,
} from "./messages.ts";
export {
  observeCompactionRules,
  observePreparedCompactionRules,
  prepareRuleObservation,
  prepareRuleObservations,
  prepareRuleObservationsWithMessages,
  type PreparedObservationWindows,
  type RuleObservationContext,
  type RuleObservationOptions,
} from "./observer.ts";
export {
  buildRuleObservationPlan,
  COMPACTION_ACTION_CRITERIA,
  COMPACTION_CONTINUITY_LEVELS,
  GENERALITY_LEVELS,
  canProvideRuleAuthority,
  ObservationPlanError,
  RULE_AUTHORITY_CRITERIA,
  type ObservationPlanOptions,
} from "./questions.ts";
export {
  MAX_CORPUS_TEXT_CHARS,
  redactAndLimitCorpusText,
  redactPrivateData,
  redactStrings,
  type RedactionResult,
} from "./redaction.ts";
export {
  createJsonlLineReader,
  RpcResponseTimeoutError,
  sendCommandAndAwaitResponse,
  type JsonlTransport,
  type RpcCommand,
  type RpcResponse,
} from "./rpc-stdin-guard.ts";
export {
  createRetroProposal,
  ENFORCEABILITY_LEVELS,
  EVIDENCE_RELATION_CRITERIA,
  extractCurrentModelJson,
  parseRuleCandidatesJson,
  RetroValidationError,
  RULE_CLASS_CRITERIA,
  SUPPORT_LEVELS,
  type CurrentModelGateway,
  type RetroContext,
  type RetroOptions,
} from "./retro.ts";
export {
  ScheduledJevClient,
  type JevRequestSchedulerOptions,
} from "./scheduler.ts";
export {
  applyTriggerDecision,
  evaluateTrigger,
  localTriggerGatesPass,
  type TriggerInput,
} from "./trigger.ts";
export {
  DEFAULT_COMPACTION_RETENTION_THRESHOLDS,
  DEFAULT_RULE_SIGNAL_THRESHOLDS,
  normalizeScore,
  selectObservation,
  type CompactionPins,
  type SelectedObservation,
} from "./signals.ts";
export {
  estimateJevTokens,
  fitWholeSessionState,
  fittedMessageByDigest,
  StateFitError,
  truncateExcerpt,
  type StateFitOptions,
} from "./state.ts";
export {
  collectCorpusReceipts,
  collectRetroPendingMarkers,
  collectRuleAcceptanceReceipts,
  collectRuleProposalBatches,
  collectRuleProposalReceipts,
  collectRuleSignalBatches,
  parseCorpusChunk,
  parseCorpusReceipt,
  parseRetroPendingMarker,
  parseRuleAcceptanceReceipt,
  parseRuleProposalReceipt,
  parseRuleSignalBatch,
  parseStoredRuleProposal,
  reconstructObservedSourceDigests,
  RETRO_PENDING_ENTRY_TYPE,
  RULE_ACCEPTANCE_ENTRY_TYPE,
  RULE_PROPOSAL_ENTRY_TYPE,
  RULE_SIGNAL_ENTRY_TYPE,
  StoredEntryValidationError,
} from "./storage.ts";
export * from "./types.ts";

export default function piRuleCompilerExtension(pi: ExtensionAPI): void {
  registerPiRuleCompiler(pi);
}
