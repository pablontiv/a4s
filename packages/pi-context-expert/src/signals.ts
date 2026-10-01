import { JevValidationError } from "./jev.ts";
import { truncateExcerpt } from "./state.ts";
import type {
  ChoiceAnswer,
  CompactionForcedReason,
  CompactionRetentionAction,
  CompactionRetentionThresholds,
  CompactionWindowObservation,
  NoulAnswer,
  RuleAuthority,
  RuleObservationPlan,
  RuleSignal,
  RuleSignalThresholds,
  ScoreAnswer,
  ValidatedJevResponse,
} from "./types.ts";

export const DEFAULT_RULE_SIGNAL_THRESHOLDS: RuleSignalThresholds = {
  candidateProbabilityMinimum: 0.72,
  generalityMinimum: 0.5,
  authorityProbabilityMinimum: 0.55,
  authorityConfidenceMinimum: 0.2,
  allowedAuthorities: ["explicit_user", "repository_policy", "team_convention"],
};

export const DEFAULT_COMPACTION_RETENTION_THRESHOLDS: CompactionRetentionThresholds = {
  keepProbabilityMinimum: 0.55,
  truncateProbabilityMinimum: 0.45,
  dropProbabilityMinimum: 0.7,
  continuityKeepMinimum: 2 / 3,
  continuityTruncateMinimum: 1 / 3,
  choiceConfidenceMinimum: 0.2,
  truncatedExcerptChars: 240,
};

const RULE_AUTHORITIES: readonly RuleAuthority[] = [
  "explicit_user",
  "repository_policy",
  "team_convention",
  "agent_inference",
  "incidental",
];
const COMPACTION_ACTIONS: readonly CompactionRetentionAction[] = ["keep", "truncate", "drop"];
const EMPTY_SANITIZED_MESSAGE = "[empty sanitized message]";

export interface CompactionPins {
  boundary: ReadonlySet<number>;
  newest: ReadonlySet<number>;
}

export interface SelectedObservation {
  compaction: CompactionWindowObservation;
  signals: RuleSignal[];
}

export function selectObservation(
  plan: RuleObservationPlan,
  responses: readonly ValidatedJevResponse[],
  ruleThresholds: RuleSignalThresholds = DEFAULT_RULE_SIGNAL_THRESHOLDS,
  compactionThresholds: CompactionRetentionThresholds = DEFAULT_COMPACTION_RETENTION_THRESHOLDS,
  pins: CompactionPins = { boundary: new Set(), newest: new Set() },
): SelectedObservation {
  validateRuleThresholds(ruleThresholds);
  validateCompactionThresholds(compactionThresholds);
  if (responses.length !== plan.requests.length) throw new JevValidationError("$.responses");

  const answers = Object.assign({}, ...responses.map((response) => response.answers));
  const signals = selectRuleSignals(plan, answers, ruleThresholds);
  const ruleMessageIndices = new Set(signals.map((signal) => signal.sourceMessageIndex));
  const decisions = plan.compactionMessages.map((message) => {
    const actionAnswer = requireChoice(answers[message.questionIds.action], message.questionIds.action);
    const continuityAnswer = requireScore(answers[message.questionIds.continuity], message.questionIds.continuity);
    const actionChoice = requireAction(actionAnswer.choice);
    const probabilities = actionProbabilities(actionAnswer);
    const continuity = normalizeScore(continuityAnswer);
    const forcedBy: CompactionForcedReason[] = [];
    if (pins.boundary.has(message.sourceMessageIndex)) forcedBy.push("boundary");
    if (pins.newest.has(message.sourceMessageIndex)) forcedBy.push("newest");
    if (ruleMessageIndices.has(message.sourceMessageIndex)) forcedBy.push("rule_candidate");
    const action = chooseCompactionAction(
      actionChoice,
      probabilities,
      actionAnswer.confidence,
      continuity,
      forcedBy,
      compactionThresholds,
    );
    const retainableExcerpt = message.excerpt.length > 0 ? message.excerpt : EMPTY_SANITIZED_MESSAGE;
    const selectedExcerpt =
      action === "drop"
        ? ""
        : action === "truncate"
          ? truncateExcerpt(retainableExcerpt, compactionThresholds.truncatedExcerptChars)
          : retainableExcerpt;

    return {
      schema: "a4s.message-compaction-decision/v1" as const,
      sourceMessageIndex: message.sourceMessageIndex,
      sourceMessageDigest: message.messageDigest,
      sourceRole: message.role,
      action,
      forcedBy,
      continuity,
      continuityConfidence: continuityAnswer.confidence,
      actionChoice,
      actionConfidence: actionAnswer.confidence,
      actionProbabilities: probabilities,
      selectedExcerpt,
    };
  });

  const compaction: CompactionWindowObservation = {
    schema: "a4s.compaction-window-observation/v1",
    kept: decisions.filter((decision) => decision.action === "keep").length,
    truncated: decisions.filter((decision) => decision.action === "truncate").length,
    dropped: decisions.filter((decision) => decision.action === "drop").length,
    decisions,
  };
  return { compaction, signals };
}

export function normalizeScore(answer: ScoreAnswer): number {
  if (!Number.isFinite(answer.score) || answer.score < 0 || answer.score > 1) {
    throw new JevValidationError("score.score");
  }
  return answer.score;
}

function selectRuleSignals(
  plan: RuleObservationPlan,
  answers: Readonly<Record<string, unknown>>,
  thresholds: RuleSignalThresholds,
): RuleSignal[] {
  const signals: RuleSignal[] = [];
  for (const candidate of plan.candidates) {
    const candidateAnswer = requireNoul(answers[candidate.questionIds.candidate], candidate.questionIds.candidate);
    const generalityAnswer = requireScore(answers[candidate.questionIds.generality], candidate.questionIds.generality);
    const authorityAnswer = requireChoice(answers[candidate.questionIds.authority], candidate.questionIds.authority);
    const authority = requireAuthority(authorityAnswer.choice);
    const authorityProbability = authorityAnswer.probabilities[authority];
    if (authorityProbability === undefined) throw new JevValidationError(candidate.questionIds.authority);
    const generality = normalizeScore(generalityAnswer);

    if (
      candidateAnswer.noul < thresholds.candidateProbabilityMinimum ||
      generality < thresholds.generalityMinimum ||
      authorityProbability < thresholds.authorityProbabilityMinimum ||
      authorityAnswer.confidence < thresholds.authorityConfidenceMinimum ||
      !thresholds.allowedAuthorities.includes(authority)
    ) {
      continue;
    }

    signals.push({
      schema: "a4s.rule-signal/v1",
      id: candidate.candidateId,
      sourceDigest: plan.state.sourceDigest,
      sourceMessageDigest: candidate.messageDigest,
      sourceMessageIndex: candidate.sourceMessageIndex,
      sourceRole: candidate.role,
      sanitizedExcerpt: truncateExcerpt(candidate.excerpt, 600),
      candidateProbability: candidateAnswer.noul,
      generality,
      generalityConfidence: generalityAnswer.confidence,
      authority,
      authorityProbability,
      authorityConfidence: authorityAnswer.confidence,
    });
  }
  return signals;
}

function chooseCompactionAction(
  choice: CompactionRetentionAction,
  probabilities: Record<CompactionRetentionAction, number>,
  confidence: number,
  continuity: number,
  forcedBy: readonly CompactionForcedReason[],
  thresholds: CompactionRetentionThresholds,
): CompactionRetentionAction {
  if (forcedBy.length > 0) return "keep";
  if (continuity >= thresholds.continuityKeepMinimum) return "keep";
  if (
    choice === "keep" &&
    probabilities.keep >= thresholds.keepProbabilityMinimum &&
    confidence >= thresholds.choiceConfidenceMinimum
  ) {
    return "keep";
  }
  if (
    choice === "drop" &&
    probabilities.drop >= thresholds.dropProbabilityMinimum &&
    confidence >= thresholds.choiceConfidenceMinimum &&
    continuity < thresholds.continuityTruncateMinimum
  ) {
    return "drop";
  }
  if (
    continuity >= thresholds.continuityTruncateMinimum ||
    probabilities.truncate >= thresholds.truncateProbabilityMinimum
  ) {
    return "truncate";
  }
  if (probabilities.keep >= thresholds.keepProbabilityMinimum) return "keep";
  return "truncate";
}

function actionProbabilities(answer: ChoiceAnswer): Record<CompactionRetentionAction, number> {
  const keep = answer.probabilities.keep;
  const truncate = answer.probabilities.truncate;
  const drop = answer.probabilities.drop;
  if (keep === undefined || truncate === undefined || drop === undefined) {
    throw new JevValidationError("compaction.action.probabilities");
  }
  return { keep, truncate, drop };
}

function requireNoul(answer: unknown, id: string): NoulAnswer {
  if (!answer || typeof answer !== "object" || (answer as { type?: unknown }).type !== "noul") {
    throw new JevValidationError(`$.answers.${id}`);
  }
  return answer as NoulAnswer;
}

function requireScore(answer: unknown, id: string): ScoreAnswer {
  if (!answer || typeof answer !== "object" || (answer as { type?: unknown }).type !== "score") {
    throw new JevValidationError(`$.answers.${id}`);
  }
  return answer as ScoreAnswer;
}

function requireChoice(answer: unknown, id: string): ChoiceAnswer {
  if (!answer || typeof answer !== "object" || (answer as { type?: unknown }).type !== "choice") {
    throw new JevValidationError(`$.answers.${id}`);
  }
  return answer as ChoiceAnswer;
}

function requireAuthority(value: string): RuleAuthority {
  if (!RULE_AUTHORITIES.includes(value as RuleAuthority)) throw new JevValidationError("authority.choice");
  return value as RuleAuthority;
}

function requireAction(value: string): CompactionRetentionAction {
  if (!COMPACTION_ACTIONS.includes(value as CompactionRetentionAction)) {
    throw new JevValidationError("compaction.action.choice");
  }
  return value as CompactionRetentionAction;
}

function validateRuleThresholds(thresholds: RuleSignalThresholds): void {
  for (const value of [
    thresholds.candidateProbabilityMinimum,
    thresholds.generalityMinimum,
    thresholds.authorityProbabilityMinimum,
    thresholds.authorityConfidenceMinimum,
  ]) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError("rule thresholds must be in [0, 1]");
  }
  if (thresholds.allowedAuthorities.length === 0) throw new RangeError("at least one rule authority must be allowed");
  for (const authority of thresholds.allowedAuthorities) {
    if (!RULE_AUTHORITIES.includes(authority)) throw new RangeError("unknown rule authority threshold");
  }
}

function validateCompactionThresholds(thresholds: CompactionRetentionThresholds): void {
  for (const value of [
    thresholds.keepProbabilityMinimum,
    thresholds.truncateProbabilityMinimum,
    thresholds.dropProbabilityMinimum,
    thresholds.continuityKeepMinimum,
    thresholds.continuityTruncateMinimum,
    thresholds.choiceConfidenceMinimum,
  ]) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError("compaction thresholds must be in [0, 1]");
    }
  }
  if (thresholds.continuityTruncateMinimum > thresholds.continuityKeepMinimum) {
    throw new RangeError("continuity truncate threshold cannot exceed keep threshold");
  }
  if (!Number.isSafeInteger(thresholds.truncatedExcerptChars) || thresholds.truncatedExcerptChars <= 0) {
    throw new RangeError("truncatedExcerptChars must be a positive integer");
  }
}
