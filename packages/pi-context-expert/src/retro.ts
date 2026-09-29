import { isStableDigest, stableDigest, stableJson } from "./digest.ts";
import { validateJevResponse, JevValidationError } from "./jev.ts";
import { redactPrivateData } from "./redaction.ts";
import { normalizeScore } from "./signals.ts";
import type {
  ChoiceAnswer,
  EvaluatedRuleCandidate,
  EvidenceRelation,
  JevClient,
  JevQuestion,
  JevRequest,
  ProposedCheckKind,
  RuleCandidate,
  RuleClass,
  RuleProposalBatch,
  RuleScopeKind,
  RuleSignal,
  RuleSignalBatch,
  ScoreAnswer,
} from "./types.ts";
import { DEFAULT_JEV_MODEL } from "./types.ts";

export interface CurrentModelGateway {
  complete(prompt: { systemPrompt: string; userPrompt: string; maxTokens: number }, signal: AbortSignal): Promise<unknown>;
}

export interface RetroOptions {
  maxSignals?: number;
  maxCandidates?: number;
  maxPromptChars?: number;
  synthesisMaxTokens?: number;
  maxStageTwoStateChars?: number;
  maxStageTwoRequestChars?: number;
  supportMinimum?: number;
  generalityMinimum?: number;
  enforceabilityMinimum?: number;
}

export interface RetroContext {
  model: { provider: string; id: string };
  createdAt: string;
  sourceCompactionAttemptIds?: readonly string[];
}

interface ResolvedRetroOptions {
  maxSignals: number;
  maxCandidates: number;
  maxPromptChars: number;
  synthesisMaxTokens: number;
  maxStageTwoStateChars: number;
  maxStageTwoRequestChars: number;
  supportMinimum: number;
  generalityMinimum: number;
  enforceabilityMinimum: number;
}

export class RetroValidationError extends Error {
  readonly code: "no_signals" | "oversized_state" | "model_failure" | "malformed_model_json";

  constructor(code: RetroValidationError["code"], readonly path = "$") {
    super(`${code} at ${path}`);
    this.name = "RetroValidationError";
    this.code = code;
  }
}

export const EVIDENCE_RELATION_CRITERIA = {
  direct: "The candidate restates direct source evidence without adding a new obligation.",
  consistent: "The candidate combines mutually consistent source signals with only normalization changes.",
  inferred: "The candidate adds a plausible but not directly authorized obligation.",
  contradicted: "At least one cited source conflicts with the candidate.",
  unsupported: "The cited sources do not support the candidate.",
} as const;

export const SUPPORT_LEVELS = [
  "The cited evidence does not support this candidate.",
  "The evidence weakly suggests it but leaves material ambiguity.",
  "The evidence supports the main obligation with minor ambiguity.",
  "The evidence directly and consistently supports the full candidate.",
] as const;

export const ENFORCEABILITY_LEVELS = [
  "No observable check can determine compliance.",
  "Only subjective manual review could assess compliance.",
  "A repeatable manual or partial automated check can assess compliance.",
  "A deterministic automated check can assess compliance.",
] as const;

export const RULE_CLASS_CRITERIA = {
  safety: "Prevents destructive, irreversible, or unauthorized effects.",
  privacy: "Limits exposure or persistence of sensitive data.",
  security: "Protects credentials, trust boundaries, or system integrity.",
  workflow: "Defines sequencing, ownership, coordination, or delivery behavior.",
  testing: "Requires verification, tests, or acceptance evidence.",
  code_quality: "Constrains implementation structure or maintainability.",
  documentation: "Constrains durable documentation or knowledge handling.",
  architecture: "Constrains component boundaries or system design.",
  other: "A durable rule outside the listed classes.",
} as const;

const RULE_SCOPE_KINDS: readonly RuleScopeKind[] = ["global", "project", "path", "task"];
const CHECK_KINDS: readonly ProposedCheckKind[] = ["manual", "command", "static_analysis"];
const EVIDENCE_RELATIONS: readonly EvidenceRelation[] = [
  "direct",
  "consistent",
  "inferred",
  "contradicted",
  "unsupported",
];
const AUTHORITIES = [
  "explicit_user",
  "repository_policy",
  "team_convention",
  "agent_inference",
  "incidental",
  "unknown",
] as const;
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
const SYNTHESIS_SYSTEM_PROMPT = `You normalize possible working rules from already-redacted evidence.
Return JSON only. Do not activate, publish, or write rules. Do not invent authority or source references.
Each candidate must be atomic and reviewable. Preserve exceptions. A proposed check is only a proposal.`;

export async function createRetroProposal(
  batches: readonly RuleSignalBatch[],
  context: RetroContext,
  currentModel: CurrentModelGateway,
  jev: JevClient,
  signal: AbortSignal,
  options: RetroOptions = {},
): Promise<RuleProposalBatch> {
  const resolved = resolveRetroOptions(options);
  const signals = uniqueSignals(batches);
  if (signals.length === 0) throw new RetroValidationError("no_signals");
  if (signals.length > resolved.maxSignals) throw new RetroValidationError("oversized_state", "$.signals");

  const userPrompt = buildSynthesisPrompt(signals, resolved.maxCandidates);
  if (userPrompt.length > resolved.maxPromptChars) throw new RetroValidationError("oversized_state", "$.prompt");
  const rawCompletion = await currentModel.complete(
    { systemPrompt: SYNTHESIS_SYSTEM_PROMPT, userPrompt, maxTokens: resolved.synthesisMaxTokens },
    signal,
  );
  const jsonText = extractCurrentModelJson(rawCompletion);
  const candidates = parseRuleCandidatesJson(
    jsonText,
    new Set(signals.map((item) => item.id)),
    resolved.maxCandidates,
  );
  const evaluated = await evaluateCandidates(candidates, signals, jev, signal, resolved);
  const sourceCompactionAttemptIds = [
    ...new Set(
      context.sourceCompactionAttemptIds ?? batches.map((batch) => batch.provenance.compactionAttemptId),
    ),
  ].sort((left, right) => left.localeCompare(right));
  if (
    sourceCompactionAttemptIds.length === 0 ||
    sourceCompactionAttemptIds.some((attemptId) => !isStableDigest(attemptId))
  ) {
    throw new RetroValidationError("malformed_model_json", "$.sourceCompactionAttemptIds");
  }
  const sourceBatchDigests = batches.map((batch) => stableDigest(batch));
  const sourceSignalIds = signals.map((item) => item.id);

  return {
    schema: "a4s.rule-proposal-batch/v1",
    idempotencyKey: stableDigest({
      schema: "a4s.rule-proposal-idempotency/v1",
      sourceCompactionAttemptIds,
      sourceBatchDigests,
      sourceSignalIds,
    }),
    createdAt: canonicalTimestamp(context.createdAt),
    sourceCompactionAttemptIds,
    sourceBatchDigests,
    sourceSignalIds,
    synthesisModel: {
      provider: requireBoundedString(context.model.provider, 1, 120, "$.model.provider"),
      id: requireBoundedString(context.model.id, 1, 200, "$.model.id"),
    },
    jevModel: DEFAULT_JEV_MODEL,
    candidates: evaluated,
  };
}

export function extractCurrentModelJson(response: unknown): string {
  const record = requireRecord(response, "$response", "model_failure");
  if (record.stopReason !== "stop") throw new RetroValidationError("model_failure", "$response.stopReason");
  if (!Array.isArray(record.content)) throw new RetroValidationError("model_failure", "$response.content");

  const text: string[] = [];
  for (const [index, block] of record.content.entries()) {
    const item = requireRecord(block, `$response.content[${index}]`, "model_failure");
    if (item.type === "thinking") continue;
    if (item.type !== "text" || typeof item.text !== "string") {
      throw new RetroValidationError("model_failure", `$response.content[${index}]`);
    }
    text.push(item.text);
  }
  const joined = text.join("\n").trim();
  if (!joined) throw new RetroValidationError("model_failure", "$response.content");
  const fenced = joined.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  return (fenced?.[1] ?? joined).trim();
}

export function parseRuleCandidatesJson(
  text: string,
  allowedSourceRefs: ReadonlySet<string>,
  maxCandidates = 20,
): RuleCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RetroValidationError("malformed_model_json", "$");
  }

  const root = requireRecord(parsed, "$", "malformed_model_json");
  requireExactKeys(root, ["candidates"], "$", "malformed_model_json");
  if (!Array.isArray(root.candidates) || root.candidates.length > maxCandidates) {
    throw new RetroValidationError("malformed_model_json", "$.candidates");
  }

  const candidates = root.candidates.map((candidate, index) =>
    parseCandidate(candidate, index, allowedSourceRefs),
  );
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (ids.has(candidate.id)) throw new RetroValidationError("malformed_model_json", "$.candidates");
    ids.add(candidate.id);
  }
  return candidates;
}

function parseCandidate(value: unknown, index: number, allowedSourceRefs: ReadonlySet<string>): RuleCandidate {
  const path = `$.candidates[${index}]`;
  const record = requireRecord(value, path, "malformed_model_json");
  requireExactKeys(
    record,
    ["scope", "trigger", "obligation", "exceptions", "source_refs", "proposed_check"],
    path,
    "malformed_model_json",
  );

  const scopeRecord = requireRecord(record.scope, `${path}.scope`, "malformed_model_json");
  requireExactKeys(scopeRecord, ["kind", "target"], `${path}.scope`, "malformed_model_json");
  if (typeof scopeRecord.kind !== "string" || !RULE_SCOPE_KINDS.includes(scopeRecord.kind as RuleScopeKind)) {
    throw new RetroValidationError("malformed_model_json", `${path}.scope.kind`);
  }
  const scopeKind = scopeRecord.kind as RuleScopeKind;
  const scopeTarget = parseScopeTarget(scopeKind, scopeRecord.target, `${path}.scope.target`);

  if (!Array.isArray(record.exceptions) || record.exceptions.length > 12) {
    throw new RetroValidationError("malformed_model_json", `${path}.exceptions`);
  }
  const exceptions = record.exceptions.map((exception, exceptionIndex) =>
    sanitizeBoundedString(exception, 1, 500, `${path}.exceptions[${exceptionIndex}]`),
  );

  if (!Array.isArray(record.source_refs) || record.source_refs.length === 0 || record.source_refs.length > 20) {
    throw new RetroValidationError("malformed_model_json", `${path}.source_refs`);
  }
  const sourceRefs = record.source_refs.map((sourceRef, sourceIndex) => {
    if (typeof sourceRef !== "string" || !allowedSourceRefs.has(sourceRef)) {
      throw new RetroValidationError("malformed_model_json", `${path}.source_refs[${sourceIndex}]`);
    }
    return sourceRef;
  });
  if (new Set(sourceRefs).size !== sourceRefs.length) {
    throw new RetroValidationError("malformed_model_json", `${path}.source_refs`);
  }

  const checkRecord = requireRecord(record.proposed_check, `${path}.proposed_check`, "malformed_model_json");
  requireExactKeys(
    checkRecord,
    ["kind", "description", "command"],
    `${path}.proposed_check`,
    "malformed_model_json",
  );
  if (typeof checkRecord.kind !== "string" || !CHECK_KINDS.includes(checkRecord.kind as ProposedCheckKind)) {
    throw new RetroValidationError("malformed_model_json", `${path}.proposed_check.kind`);
  }
  const checkKind = checkRecord.kind as ProposedCheckKind;
  const command = parseCheckCommand(checkKind, checkRecord.command, `${path}.proposed_check.command`);

  const normalized = {
    scope: { kind: scopeKind, target: scopeTarget },
    trigger: sanitizeBoundedString(record.trigger, 1, 500, `${path}.trigger`),
    obligation: sanitizeBoundedString(record.obligation, 1, 1_000, `${path}.obligation`),
    exceptions,
    sourceRefs,
    proposedCheck: {
      kind: checkKind,
      description: sanitizeBoundedString(checkRecord.description, 1, 500, `${path}.proposed_check.description`),
      command,
    },
  };

  return {
    id: stableDigest(normalized),
    ...normalized,
  };
}

async function evaluateCandidates(
  candidates: readonly RuleCandidate[],
  signals: readonly RuleSignal[],
  jev: JevClient,
  signal: AbortSignal,
  options: ResolvedRetroOptions,
): Promise<EvaluatedRuleCandidate[]> {
  if (candidates.length === 0) return [];

  const state = {
    schema: "a4s.rule-candidate-evaluation-state/v1",
    signals: signals.map((item) => ({
      id: item.id,
      sourceDigest: item.sourceDigest,
      sourceMessageDigest: item.sourceMessageDigest,
      authority: item.authority,
      sanitizedExcerpt: item.sanitizedExcerpt,
    })),
    candidates,
  };
  if (JSON.stringify(state).length > options.maxStageTwoStateChars) {
    throw new RetroValidationError("oversized_state", "$.stageTwo.state");
  }
  const questions: Record<string, JevQuestion> = {};
  for (const [index] of candidates.entries()) Object.assign(questions, evaluationQuestions(index));
  const request: JevRequest = { state, model: DEFAULT_JEV_MODEL, questions };
  if (JSON.stringify(request).length > options.maxStageTwoRequestChars) {
    throw new RetroValidationError("oversized_state", "$.stageTwo.request");
  }
  const raw = await jev.evaluate(request, { signal });
  const response = validateJevResponse(raw, questions, request.model);

  return candidates.map((candidate, index) => {
    const ids = evaluationQuestionIds(index);
    const relationAnswer = requireChoice(response.answers[ids.evidenceRelation], ids.evidenceRelation);
    const supportAnswer = requireScore(response.answers[ids.support], ids.support);
    const generalityAnswer = requireScore(response.answers[ids.generality], ids.generality);
    const enforceabilityAnswer = requireScore(response.answers[ids.enforceability], ids.enforceability);
    const authorityAnswer = requireChoice(response.answers[ids.authority], ids.authority);
    const ruleClassAnswer = requireChoice(response.answers[ids.ruleClass], ids.ruleClass);
    const evidenceRelation = requireOneOf(relationAnswer.choice, EVIDENCE_RELATIONS, ids.evidenceRelation);
    const authority = requireOneOf(authorityAnswer.choice, AUTHORITIES, ids.authority);
    const ruleClass = requireOneOf(ruleClassAnswer.choice, RULE_CLASSES, ids.ruleClass);
    const support = normalizeScore(supportAnswer);
    const generality = normalizeScore(generalityAnswer);
    const enforceability = normalizeScore(enforceabilityAnswer);
    const acceptableEvidence = evidenceRelation === "direct" || evidenceRelation === "consistent";
    const acceptableAuthority =
      authority === "explicit_user" || authority === "repository_policy" || authority === "team_convention";

    return {
      ...candidate,
      evaluation: {
        evidenceRelation,
        evidenceRelationConfidence: relationAnswer.confidence,
        support,
        supportConfidence: supportAnswer.confidence,
        generality,
        generalityConfidence: generalityAnswer.confidence,
        enforceability,
        enforceabilityConfidence: enforceabilityAnswer.confidence,
        authority,
        authorityConfidence: authorityAnswer.confidence,
        ruleClass,
        ruleClassConfidence: ruleClassAnswer.confidence,
        disposition:
          acceptableEvidence &&
          acceptableAuthority &&
          support >= options.supportMinimum &&
          generality >= options.generalityMinimum &&
          enforceability >= options.enforceabilityMinimum
            ? "propose"
            : "hold",
      },
    };
  });
}

function evaluationQuestions(index: number): Record<string, JevQuestion> {
  const ids = evaluationQuestionIds(index);
  const candidatePath = `candidates[${index}]`;
  return {
    [ids.evidenceRelation]: {
      type: "choice",
      instructions: `How does the evidence referenced by \`${candidatePath}.sourceRefs\` relate to \`${candidatePath}\`?`,
      criteria: { ...EVIDENCE_RELATION_CRITERIA },
    },
    [ids.support]: {
      type: "score",
      instructions: `How strongly do the referenced \`signals\` support the complete obligation in \`${candidatePath}\`?`,
      criteria: [...SUPPORT_LEVELS],
    },
    [ids.generality]: {
      type: "score",
      instructions: `How reusable is \`${candidatePath}\` within its declared scope?`,
      criteria: [
        "Only useful for one transient action.",
        "Useful elsewhere in the same task.",
        "Reusable across tasks in the declared scope.",
        "A broadly durable rule in the declared scope.",
      ],
    },
    [ids.enforceability]: {
      type: "score",
      instructions: `How enforceable is \`${candidatePath}\` using its proposed check?`,
      criteria: [...ENFORCEABILITY_LEVELS],
    },
    [ids.authority]: {
      type: "choice",
      instructions: `What is the strongest authority supported by the evidence for \`${candidatePath}\`?`,
      criteria: {
        explicit_user: "Directly required or corrected by the user.",
        repository_policy: "Required by an authoritative repository policy or accepted decision.",
        team_convention: "Supported as a repeated team convention.",
        agent_inference: "Introduced mainly by the synthesizing or prior agent.",
        incidental: "Derived from a one-off detail rather than a rule source.",
        unknown: "Authority cannot be established from the evidence.",
      },
    },
    [ids.ruleClass]: {
      type: "choice",
      instructions: `Which single rule class best describes \`${candidatePath}\`?`,
      criteria: { ...RULE_CLASS_CRITERIA },
    },
  };
}

function evaluationQuestionIds(index: number): {
  evidenceRelation: string;
  support: string;
  generality: string;
  enforceability: string;
  authority: string;
  ruleClass: string;
} {
  const suffix = String(index).padStart(3, "0");
  return {
    evidenceRelation: `retro_evidence_relation_${suffix}`,
    support: `retro_support_${suffix}`,
    generality: `retro_generality_${suffix}`,
    enforceability: `retro_enforceability_${suffix}`,
    authority: `retro_authority_${suffix}`,
    ruleClass: `retro_rule_class_${suffix}`,
  };
}

function buildSynthesisPrompt(signals: readonly RuleSignal[], maxCandidates: number): string {
  const state = {
    evidence: signals.map((signal) => ({
      source_ref: signal.id,
      source_role: signal.sourceRole,
      authority: signal.authority,
      candidate_probability: signal.candidateProbability,
      generality: signal.generality,
      excerpt: signal.sanitizedExcerpt,
    })),
  };
  return `Normalize at most ${maxCandidates} rule candidates from this evidence. Return exactly this JSON shape:
{"candidates":[{"scope":{"kind":"global|project|path|task","target":null},"trigger":"when the rule applies","obligation":"one testable must/must-not statement","exceptions":["bounded exception"],"source_refs":["an exact source_ref from evidence"],"proposed_check":{"kind":"manual|command|static_analysis","description":"how to verify","command":null}}]}
Use null scope target for global/project scope; use a safe relative target for path scope. Manual checks require command null; command and static_analysis checks require a non-empty command string. Return an empty candidates array when evidence is insufficient.

Evidence:
${stableJson(state)}`;
}

function uniqueSignals(batches: readonly RuleSignalBatch[]): RuleSignal[] {
  const byId = new Map<string, RuleSignal>();
  for (const batch of batches) {
    for (const signal of batch.signals) {
      const existing = byId.get(signal.id);
      if (existing && stableJson(existing) !== stableJson(signal)) {
        throw new RetroValidationError("malformed_model_json", "$.signals");
      }
      byId.set(signal.id, signal);
    }
  }
  return [...byId.values()];
}

function parseScopeTarget(kind: RuleScopeKind, value: unknown, path: string): string | null {
  if (kind === "global" || kind === "project") {
    if (value !== null) throw new RetroValidationError("malformed_model_json", path);
    return null;
  }
  if (kind === "task" && value === null) return null;
  const target = sanitizeBoundedString(value, 1, 240, path);
  if (kind === "path" && (target.startsWith("/") || target.split(/[\\/]/).includes(".."))) {
    throw new RetroValidationError("malformed_model_json", path);
  }
  return target;
}

function parseCheckCommand(kind: ProposedCheckKind, value: unknown, path: string): string | null {
  if (kind === "manual") {
    if (value !== null) throw new RetroValidationError("malformed_model_json", path);
    return null;
  }
  return sanitizeBoundedString(value, 1, 500, path);
}

function sanitizeBoundedString(value: unknown, minimum: number, maximum: number, path: string): string {
  const text = requireBoundedString(value, minimum, maximum, path).trim();
  const redacted = redactPrivateData(text).text;
  if (redacted.length < minimum || redacted.length > maximum) {
    throw new RetroValidationError("malformed_model_json", path);
  }
  return redacted;
}

function requireBoundedString(value: unknown, minimum: number, maximum: number, path: string): string {
  if (typeof value !== "string" || value.trim().length < minimum || value.length > maximum) {
    throw new RetroValidationError("malformed_model_json", path);
  }
  return value;
}

function requireRecord(
  value: unknown,
  path: string,
  code: "model_failure" | "malformed_model_json",
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RetroValidationError(code, path);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  code: "model_failure" | "malformed_model_json",
): void {
  const actual = Object.keys(record).sort((left, right) => left.localeCompare(right));
  const expected = [...keys].sort((left, right) => left.localeCompare(right));
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new RetroValidationError(code, path);
  }
}

function requireChoice(answer: unknown, id: string): ChoiceAnswer {
  if (!answer || typeof answer !== "object" || (answer as { type?: unknown }).type !== "choice") {
    throw new JevValidationError(`$.answers.${id}`);
  }
  return answer as ChoiceAnswer;
}

function requireScore(answer: unknown, id: string): ScoreAnswer {
  if (!answer || typeof answer !== "object" || (answer as { type?: unknown }).type !== "score") {
    throw new JevValidationError(`$.answers.${id}`);
  }
  return answer as ScoreAnswer;
}

function requireOneOf<T extends string>(value: string, allowed: readonly T[], path: string): T {
  if (!allowed.includes(value as T)) throw new JevValidationError(`$.answers.${path}`);
  return value as T;
}

function canonicalTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new RetroValidationError("malformed_model_json", "$.createdAt");
  return new Date(value).toISOString();
}

function resolveRetroOptions(options: RetroOptions): ResolvedRetroOptions {
  return {
    maxSignals: positiveInteger(options.maxSignals ?? 100, "maxSignals"),
    maxCandidates: positiveInteger(options.maxCandidates ?? 8, "maxCandidates"),
    maxPromptChars: positiveInteger(options.maxPromptChars ?? 100_000, "maxPromptChars"),
    synthesisMaxTokens: positiveInteger(options.synthesisMaxTokens ?? 8_192, "synthesisMaxTokens"),
    maxStageTwoStateChars: positiveInteger(
      options.maxStageTwoStateChars ?? 90_000,
      "maxStageTwoStateChars",
    ),
    maxStageTwoRequestChars: positiveInteger(
      options.maxStageTwoRequestChars ?? 140_000,
      "maxStageTwoRequestChars",
    ),
    supportMinimum: unitOption(options.supportMinimum ?? 2 / 3, "supportMinimum"),
    generalityMinimum: unitOption(options.generalityMinimum ?? 0.5, "generalityMinimum"),
    enforceabilityMinimum: unitOption(options.enforceabilityMinimum ?? 1 / 3, "enforceabilityMinimum"),
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function unitOption(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${name} must be in [0, 1]`);
  return value;
}
