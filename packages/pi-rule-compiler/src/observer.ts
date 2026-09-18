import { validateJevResponse } from "./jev.ts";
import {
  digestNormalizedMessages,
  normalizeCompactionMessages,
  type CompactionPreparationMessages,
} from "./messages.ts";
import { buildRuleObservationPlan, type ObservationPlanOptions } from "./questions.ts";
import {
  DEFAULT_COMPACTION_RETENTION_THRESHOLDS,
  DEFAULT_RULE_SIGNAL_THRESHOLDS,
  selectObservation,
  type CompactionPins,
} from "./signals.ts";
import { fitWholeSessionState, StateFitError, truncateExcerpt, type StateFitOptions } from "./state.ts";
import type {
  CompactionRetentionThresholds,
  JevClient,
  NormalizedSessionMessage,
  RuleObservationPlan,
  RuleSignalBatch,
  RuleSignalThresholds,
  ValidatedJevResponse,
} from "./types.ts";
import { DEFAULT_JEV_MODEL } from "./types.ts";

export interface RuleObservationOptions extends StateFitOptions, ObservationPlanOptions {
  ruleThresholds?: RuleSignalThresholds;
  compactionThresholds?: CompactionRetentionThresholds;
  maxMessagesPerWindow?: number;
  pinNewestMessages?: number;
}

export interface PreparedObservationWindows {
  messages: NormalizedSessionMessage[];
  plans: RuleObservationPlan[];
  sourceDigest: string;
  pins: CompactionPins;
}

export interface RuleObservationContext {
  attemptId: string;
  reason: "manual" | "threshold" | "overflow";
  willRetry: boolean;
  observedAt: string;
  windowIndex: number;
  windowCount: number;
  pins: CompactionPins;
}

export function prepareRuleObservation(
  preparation: CompactionPreparationMessages,
  options: RuleObservationOptions = {},
): RuleObservationPlan {
  const prepared = prepareRuleObservationsWithMessages(preparation, {
    ...options,
    maxMessagesPerWindow: Number.MAX_SAFE_INTEGER,
  });
  if (prepared.plans.length !== 1) throw new StateFitError("oversized_state");
  return prepared.plans[0]!;
}

export function prepareRuleObservations(
  preparation: CompactionPreparationMessages,
  options: RuleObservationOptions = {},
): RuleObservationPlan[] {
  return prepareRuleObservationsWithMessages(preparation, options).plans;
}

export function prepareRuleObservationsWithMessages(
  preparation: CompactionPreparationMessages,
  options: RuleObservationOptions = {},
): PreparedObservationWindows {
  const messages = normalizeCompactionMessages(preparation);
  if (messages.length === 0) throw new StateFitError("empty_state");
  const maxMessagesPerWindow = positiveInteger(options.maxMessagesPerWindow ?? 96, "maxMessagesPerWindow");
  const plans: RuleObservationPlan[] = [];
  for (let start = 0; start < messages.length; start += maxMessagesPerWindow) {
    appendFittablePlans(messages.slice(start, start + maxMessagesPerWindow), plans, options);
  }

  return {
    messages,
    plans,
    sourceDigest: digestNormalizedMessages(messages),
    pins: computeCompactionPins(preparation, messages.length, options.pinNewestMessages ?? 4),
  };
}

export async function observeCompactionRules(
  preparation: CompactionPreparationMessages,
  context: Omit<RuleObservationContext, "windowIndex" | "windowCount" | "pins" | "attemptId"> & {
    attemptId?: string;
  },
  jev: JevClient,
  signal: AbortSignal,
  options: RuleObservationOptions = {},
): Promise<RuleSignalBatch> {
  const prepared = prepareRuleObservationsWithMessages(preparation, {
    ...options,
    maxMessagesPerWindow: Number.MAX_SAFE_INTEGER,
  });
  if (prepared.plans.length !== 1) throw new StateFitError("oversized_state");
  return observePreparedCompactionRules(
    prepared.plans[0]!,
    {
      ...context,
      attemptId: context.attemptId ?? prepared.sourceDigest,
      windowIndex: 0,
      windowCount: 1,
      pins: prepared.pins,
    },
    jev,
    signal,
    options,
  );
}

export async function observePreparedCompactionRules(
  plan: RuleObservationPlan,
  context: RuleObservationContext,
  jev: JevClient,
  signal: AbortSignal,
  options: RuleObservationOptions = {},
): Promise<RuleSignalBatch> {
  const responses: ValidatedJevResponse[] = await Promise.all(
    plan.requests.map(async (request) => {
      const rawResponse = await jev.evaluate(request, { signal });
      return validateJevResponse(rawResponse, request.questions, request.model);
    }),
  );

  const ruleThresholds = options.ruleThresholds ?? DEFAULT_RULE_SIGNAL_THRESHOLDS;
  const compactionThresholds = options.compactionThresholds ?? DEFAULT_COMPACTION_RETENTION_THRESHOLDS;
  const selected = selectObservation(plan, responses, ruleThresholds, compactionThresholds, context.pins);

  return {
    schema: "a4s.rule-signal-batch/v2",
    sourceDigest: plan.state.sourceDigest,
    stateDigest: plan.state.stateDigest,
    observedAt: requireIsoTimestamp(context.observedAt),
    jevModel: DEFAULT_JEV_MODEL,
    compaction: selected.compaction,
    signals: selected.signals,
    provenance: {
      compactionAttemptId: context.attemptId,
      compactionReason: context.reason,
      willRetry: context.willRetry,
      windowIndex: context.windowIndex,
      windowCount: context.windowCount,
      messageCount: plan.state.messages.length,
      redactionCount: plan.state.redactionCount,
      requestCount: responses.length,
      inputTokens: responses.reduce((total, response) => total + response.usage.input_tokens, 0),
      outputTokens: responses.reduce((total, response) => total + response.usage.output_tokens, 0),
      sourceMessageIndices: plan.state.messages.map((message) => message.index),
      sourceMessageDigests: plan.state.messages.map((message) => message.sourceDigest),
      sanitizedExcerpts: plan.state.messages.map((message) => ({
        sourceMessageIndex: message.index,
        sourceMessageDigest: message.sourceDigest,
        role: message.role,
        excerpt: truncateExcerpt(message.excerpt, 600),
      })),
    },
    ruleThresholds: {
      candidateProbabilityMinimum: ruleThresholds.candidateProbabilityMinimum,
      generalityMinimum: ruleThresholds.generalityMinimum,
      authorityProbabilityMinimum: ruleThresholds.authorityProbabilityMinimum,
      authorityConfidenceMinimum: ruleThresholds.authorityConfidenceMinimum,
      allowedAuthorities: [...ruleThresholds.allowedAuthorities],
    },
    compactionThresholds: { ...compactionThresholds },
  };
}

function appendFittablePlans(
  messages: readonly NormalizedSessionMessage[],
  plans: RuleObservationPlan[],
  options: RuleObservationOptions,
): void {
  try {
    plans.push(buildRuleObservationPlan(fitWholeSessionState(messages, options), options));
  } catch (error) {
    if (!(error instanceof StateFitError) || error.code !== "oversized_state" || messages.length <= 1) {
      throw error;
    }
    const midpoint = Math.ceil(messages.length / 2);
    appendFittablePlans(messages.slice(0, midpoint), plans, options);
    appendFittablePlans(messages.slice(midpoint), plans, options);
  }
}

function computeCompactionPins(
  preparation: CompactionPreparationMessages,
  messageCount: number,
  pinNewestMessages: number,
): CompactionPins {
  if (!Number.isSafeInteger(pinNewestMessages) || pinNewestMessages < 0) {
    throw new RangeError("pinNewestMessages must be a non-negative integer");
  }
  const boundary = new Set<number>();
  let cursor = 0;
  if (preparation.previousSummary?.trim()) {
    boundary.add(cursor);
    cursor += 1;
  }
  if (preparation.messagesToSummarize.length > 0) {
    boundary.add(cursor);
    boundary.add(cursor + preparation.messagesToSummarize.length - 1);
    cursor += preparation.messagesToSummarize.length;
  }
  if (preparation.turnPrefixMessages.length > 0) {
    boundary.add(cursor);
    boundary.add(cursor + preparation.turnPrefixMessages.length - 1);
  }
  const newest = new Set<number>();
  for (let index = Math.max(0, messageCount - pinNewestMessages); index < messageCount; index += 1) {
    newest.add(index);
  }
  return { boundary, newest };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function requireIsoTimestamp(value: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("observedAt must be an ISO timestamp");
  }
  return new Date(value).toISOString();
}
