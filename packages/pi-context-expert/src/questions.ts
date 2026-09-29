import { stableDigest } from "./digest.ts";
import { estimateJevTokens } from "./state.ts";
import type {
  ChoiceQuestion,
  CompactionMessageQuestionRef,
  CorpusChunk,
  FittedSessionState,
  JevQuestion,
  JevRequest,
  RuleCandidateQuestionRef,
  RuleObservationPlan,
} from "./types.ts";
import { DEFAULT_JEV_MODEL } from "./types.ts";

export const GENERALITY_LEVELS = [
  "Only describes one transient action or fact in this session.",
  "Could guide another step in this task, but not unrelated work.",
  "Is reusable for multiple tasks in this project or repository.",
  "Is a broadly durable rule across projects or working contexts.",
] as const;

export const COMPACTION_CONTINUITY_LEVELS = [
  "The message has no information needed after compaction.",
  "The message has minor context that may be useful but is not required.",
  "The message contains useful state, evidence, or rationale for correct continuation.",
  "The message contains an essential goal, constraint, decision, unresolved issue, or boundary state.",
] as const;

export const COMPACTION_ACTION_CRITERIA = {
  keep: "Retain the sanitized message excerpt substantially intact because its detail matters later.",
  truncate: "Retain a shorter excerpt because the gist matters but full detail does not.",
  drop: "Omit it because it is redundant, transient, or has no future value.",
} as const;

export const RULE_AUTHORITY_CRITERIA = {
  explicit_user: "A direct instruction, constraint, correction, or preference stated by the user.",
  repository_policy: "A rule from an authoritative repository policy, accepted decision, or governed document.",
  team_convention: "A repeated team convention supported by the conversation but not a direct policy quotation.",
  agent_inference: "A rule inferred or proposed by an assistant rather than authorized by a source.",
  incidental: "A one-off fact, implementation detail, example, or observation without rule authority.",
} as const;

export const LADDER_VISIBILITY_CRITERIA = {
  hide: "The chunk is not useful for answering the concrete query.",
  short: "Only a bounded source excerpt is useful for answering the concrete query.",
  long: "A longer bounded source excerpt is useful for answering the concrete query.",
  full: "The full sanitized chunk is necessary for answering the concrete query.",
} as const;

export interface LadderQuestionRef {
  questionId: string;
  corpusIndex: number;
  chunkId: string;
  query: string;
}

export interface ObservationPlanOptions {
  maxQuestionsPerRequest?: number;
  maxCandidates?: number;
  maxRequestTokens?: number;
  maxStatePlusQuestionTokens?: number;
}

export class ObservationPlanError extends Error {
  readonly code: "too_many_candidates" | "question_batch_too_small" | "request_budget";

  constructor(code: "too_many_candidates" | "question_batch_too_small" | "request_budget") {
    const messages = {
      too_many_candidates: "too many rule candidates",
      question_batch_too_small: "question batch cannot hold one message",
      request_budget: "a Jev request cannot fit configured token budgets",
    } as const;
    super(messages[code]);
    this.name = "ObservationPlanError";
    this.code = code;
  }
}

export function buildRuleObservationPlan(
  fitted: FittedSessionState,
  options: ObservationPlanOptions = {},
): RuleObservationPlan {
  const maxQuestions = positiveInteger(options.maxQuestionsPerRequest ?? 120, "maxQuestionsPerRequest");
  const maxCandidates = positiveInteger(options.maxCandidates ?? 1_024, "maxCandidates");
  const maxRequestTokens = positiveInteger(options.maxRequestTokens ?? 60_000, "maxRequestTokens");
  const maxStatePlusQuestionTokens = positiveInteger(
    options.maxStatePlusQuestionTokens ?? 30_000,
    "maxStatePlusQuestionTokens",
  );
  if (maxQuestions < 5) throw new ObservationPlanError("question_batch_too_small");

  const candidates: RuleCandidateQuestionRef[] = [];
  const compactionMessages: CompactionMessageQuestionRef[] = [];
  const questionGroups: Array<Record<string, JevQuestion>> = [];

  for (const [stateMessageIndex, message] of fitted.messages.entries()) {
    const suffix = String(message.index).padStart(6, "0");
    const compactionRef: CompactionMessageQuestionRef = {
      stateMessageIndex,
      sourceMessageIndex: message.index,
      messageDigest: message.sourceDigest,
      excerpt: message.excerpt,
      role: message.role,
      questionIds: {
        action: `compaction_action_${suffix}`,
        continuity: `compaction_continuity_${suffix}`,
      },
    };
    compactionMessages.push(compactionRef);

    const group: Record<string, JevQuestion> = compactionQuestions(compactionRef);
    if (message.excerpt.trim().length > 0 && canProvideRuleAuthority(message.role)) {
      const candidate: RuleCandidateQuestionRef = {
        candidateId: stableDigest({
          sourceDigest: fitted.sourceDigest,
          sourceMessageDigest: message.sourceDigest,
          sourceMessageIndex: message.index,
        }),
        stateMessageIndex,
        sourceMessageIndex: message.index,
        messageDigest: message.sourceDigest,
        excerpt: message.excerpt,
        role: message.role,
        questionIds: {
          candidate: `rule_candidate_${suffix}`,
          generality: `rule_generality_${suffix}`,
          authority: `rule_authority_${suffix}`,
        },
      };
      candidates.push(candidate);
      Object.assign(group, candidateQuestions(candidate));
    }
    questionGroups.push(group);
  }

  if (candidates.length > maxCandidates) throw new ObservationPlanError("too_many_candidates");

  const sharedState = fitted.state;
  const stateTokens = estimateJevTokens(JSON.stringify(sharedState));
  const batches: Array<Record<string, JevQuestion>> = [];
  let current: Record<string, JevQuestion> = {};
  for (const group of questionGroups) {
    assertStatePlusQuestionBudget(group, stateTokens, maxStatePlusQuestionTokens);
    const candidate = { ...current, ...group };
    if (
      Object.keys(current).length > 0 &&
      (Object.keys(candidate).length > maxQuestions ||
        requestTokens(sharedState, candidate) > maxRequestTokens)
    ) {
      batches.push(current);
      current = {};
    }
    const next = { ...current, ...group };
    if (Object.keys(next).length > maxQuestions || requestTokens(sharedState, next) > maxRequestTokens) {
      throw new ObservationPlanError("request_budget");
    }
    current = next;
  }
  if (Object.keys(current).length > 0) batches.push(current);

  const requests: JevRequest[] = batches.map((questions) => ({
    state: sharedState,
    model: DEFAULT_JEV_MODEL,
    questions,
  }));

  return { state: fitted, candidates, compactionMessages, requests };
}

/** Creates one query-bound visibility decision for every chronological corpus chunk. */
export function buildLadderQuestions(
  corpus: readonly CorpusChunk[],
  query: string,
): { questions: Record<string, ChoiceQuestion>; refs: readonly LadderQuestionRef[] } {
  const refs = corpus.map((chunk, corpusIndex) => ({
    questionId: `ladder_visibility_${String(corpusIndex).padStart(6, "0")}`,
    corpusIndex,
    chunkId: chunk.id,
    query,
  }));
  const questions = Object.fromEntries(refs.map((ref) => [ref.questionId, {
    type: "choice" as const,
    instructions: `How much of corpus chunk ${ref.corpusIndex} should be visible to answer the concrete query in the shared state?`,
    criteria: { ...LADDER_VISIBILITY_CRITERIA },
  } satisfies ChoiceQuestion]));
  return { questions, refs };
}

export function canProvideRuleAuthority(role: string): boolean {
  // A rule originates from user intent or an explicit decision, not from a tool
  // output. `toolResult`/`bashExecution` still receive compaction-retention
  // questions, but they never enter the rule-candidate pool: their content
  // (skill dumps, PR reports, mem_save JSON, bash output) is evidence, not
  // authority, and over-captured the pool as noise.
  return role === "user" || role === "custom";
}

function requestTokens(state: FittedSessionState["state"], questions: Record<string, JevQuestion>): number {
  return estimateJevTokens(JSON.stringify({ state, model: DEFAULT_JEV_MODEL, questions }));
}

function assertStatePlusQuestionBudget(
  questions: Record<string, JevQuestion>,
  stateTokens: number,
  maximum: number,
): void {
  for (const question of Object.values(questions)) {
    if (stateTokens + estimateJevTokens(JSON.stringify(question)) > maximum) {
      throw new ObservationPlanError("request_budget");
    }
  }
}

function compactionQuestions(message: CompactionMessageQuestionRef): Record<string, JevQuestion> {
  const path = `messages[${message.stateMessageIndex}].excerpt`;
  return {
    [message.questionIds.action]: {
      type: "choice",
      instructions: `Should \`${path}\` be kept, truncated, or dropped from a deterministic compaction summary?`,
      criteria: { ...COMPACTION_ACTION_CRITERIA },
    },
    [message.questionIds.continuity]: {
      type: "score",
      instructions: `How necessary is \`${path}\` for a future agent to continue the session correctly?`,
      criteria: [...COMPACTION_CONTINUITY_LEVELS],
    },
  };
}

function candidateQuestions(candidate: RuleCandidateQuestionRef): Record<string, JevQuestion> {
  const path = `messages[${candidate.stateMessageIndex}].excerpt`;
  return {
    [candidate.questionIds.candidate]: {
      type: "noul",
      instructions: `Does \`${path}\` state or provide direct evidence for a reusable behavioral rule, constraint, or working convention?`,
      criteria: {
        true: "There is a concrete obligation, prohibition, preference, or repeatable procedure worth reviewing as a rule.",
        false: "It is only a fact, result, question, example, transient action, or unsupported suggestion.",
      },
    },
    [candidate.questionIds.generality]: {
      type: "score",
      instructions: `How broadly reusable is the possible rule evidenced by \`${path}\`?`,
      criteria: [...GENERALITY_LEVELS],
    },
    [candidate.questionIds.authority]: {
      type: "choice",
      instructions: `What is the strongest source of authority for the possible rule evidenced by \`${path}\`?`,
      criteria: { ...RULE_AUTHORITY_CRITERIA },
    } satisfies ChoiceQuestion,
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}
