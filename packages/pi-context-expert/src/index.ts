import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadGlobalCompactionConfiguration } from "./config.ts";
import { registerPiContextExpert } from "./extension.ts";
import { registerPiContextExpertSettingsCommand } from "./settings-command.ts";

export {
  BASIC_COMPACTION_CONFIG,
  configurationFromGlobalFile,
  flatConfiguration,
  globalCompactionConfigPath,
  isLadderCompaction,
  isLadderEvidence,
  legacyGlobalCompactionConfigPath,
  loadGlobalCompactionConfiguration,
  PI_CONTEXT_EXPERT_GLOBAL_CONFIG_PATH,
  resolveCompactionConfig,
  serializeGlobalCompactionConfiguration,
  writeGlobalCompactionConfiguration,
} from "./config.ts";
export {
  buildCoreTranscript,
  coreOptionsForPreparation,
  CORE_DETAILS_KEY,
  CORE_DETAILS_VERSION,
  createCoreAsker,
  DEFAULT_MAX_COMPACTION_CHARS,
  DEFAULT_MINIMUM_COMPACTION_EXCERPT_CHARS,
  createPiCompactionBinding,
  findPreviousCoreCompaction,
  piContentToText,
  PiCompactionBuildError,
  renderCoreSummary,
  runPiCoreCompaction,
  toNeutralPiMessages,
  type CompactionPreparationProtection,
  type PiCompactionBindingInput,
  type PreviousCoreCompaction,
} from "./binding.ts";
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
export {
  disabledEvidencePipeline,
  runEvidence,
  type EvidenceEntryAppender,
  type EvidencePipeline,
  type RunEvidenceInput,
  type RunEvidenceResult,
} from "./evidence-pipeline.ts";
export {
  EVIDENCE_LADDER_QUERY,
  extractRuleSignals,
  selectEvidenceContext,
  type EvidenceSource,
  type ExtractedRuleSignals,
  type ExtractRuleSignalsInput,
} from "./evidence.ts";
export { runWithDeadline, DeadlineExceededError, OperationAbortedError } from "./deadline.ts";
export { stableDigest, stableJson, isStableDigest } from "./digest.ts";
export {
  corpusDigest,
  DEFAULT_LADDER_MAX_CANDIDATE_CHUNKS,
  DEFAULT_LADDER_MAX_STATE_TOKENS,
  DEFAULT_LADDER_RECENT_CHUNKS,
  LadderProjectionError,
  LadderShortlistError,
  LONG_SPAN_CHAR_LIMIT,
  renderProjection,
  selectLadderProjection,
  shortlistLadderCorpus,
  SHORT_SPAN_CHAR_LIMIT,
  validateProjection,
  type LadderProfile,
  type LadderShortlist,
  type LadderShortlistOptions,
} from "./ladder.ts";
export { applyContextProjection } from "./projection.ts";
export {
  LADDER_PROJECTION_FAILURE_TYPE,
  LADDER_PROJECTION_RECEIPT_TYPE,
  registerPiContextExpert,
  type PiContextExpertOptions,
} from "./extension.ts";
export {
  JevApiError,
  JevUnavailableError,
  JevValidationError,
  parseScoreAnswer,
  PiJevClient,
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
  buildLadderQuestions,
  COMPACTION_ACTION_CRITERIA,
  COMPACTION_CONTINUITY_LEVELS,
  GENERALITY_LEVELS,
  LADDER_VISIBILITY_CRITERIA,
  canProvideRuleAuthority,
  ObservationPlanError,
  RULE_AUTHORITY_CRITERIA,
  type LadderQuestionRef,
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
  hasConservativeCompactableHistory,
  localTriggerGatesPass,
  type TriggerInput,
  type TriggerProjectionEntry,
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
  collectEvidenceReceipts,
  collectRetroPendingMarkers,
  collectRuleAcceptanceReceipts,
  collectRuleProposalBatches,
  collectRuleProposalReceipts,
  collectRuleSignalBatches,
  parseCorpusChunk,
  parseCorpusReceipt,
  parseEvidenceReceipt,
  parseRetroPendingMarker,
  parseRuleAcceptanceReceipt,
  parseRuleProposalReceipt,
  parseRuleSignalBatch,
  parseStoredRuleProposal,
  reconstructObservedSourceDigests,
  EVIDENCE_RECEIPT_ENTRY_TYPE,
  RETRO_PENDING_ENTRY_TYPE,
  RULE_ACCEPTANCE_ENTRY_TYPE,
  RULE_PROPOSAL_ENTRY_TYPE,
  RULE_SIGNAL_ENTRY_TYPE,
  StoredEntryValidationError,
} from "./storage.ts";
export {
  PI_CONTEXT_EXPERT_SETTINGS_COMMAND,
  registerPiContextExpertSettingsCommand,
  runPiContextExpertSettingsCommand,
  type PiContextExpertSettingsCommandOptions,
} from "./settings-command.ts";
export * from "./types.ts";

export default function piContextExpertExtension(pi: ExtensionAPI): void {
  const config = loadGlobalCompactionConfiguration();
  registerPiContextExpert(pi, { config });
  registerPiContextExpertSettingsCommand(pi, { initialConfiguration: config });
}
