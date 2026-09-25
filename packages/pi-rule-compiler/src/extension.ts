import {
  createTypesafeAuthResolver,
  registerTypesafeProvider,
} from "@a4s/typesafe";
import {
  SettingsManager,
  type ContextWithSystemEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import { buildBasicCompactionResult } from "./compaction-core.ts";
import { collectCorpus, publishCorpusAfterCompaction, stageCorpus } from "./corpus.ts";
import {
  BASIC_COMPACTION_CONFIG,
  isLadderCompaction,
  isLadderEvidence,
  resolveCompactionConfig,
} from "./config.ts";
import {
  CompactionBuildError,
  type BuildJevCompactionOptions,
} from "./compaction.ts";
import { disabledEvidencePipeline, runEvidence } from "./evidence-pipeline.ts";
import { DeadlineExceededError, OperationAbortedError, runWithDeadline } from "./deadline.ts";
import { isStableDigest, stableDigest } from "./digest.ts";
import { corpusDigest, renderProjection, selectLadderProjection } from "./ladder.ts";
import { applyContextProjection } from "./projection.ts";
import { redactAndLimitCorpusText } from "./redaction.ts";
import { JevApiError, JevUnavailableError, JevValidationError, TypesafeJevClient } from "./jev.ts";
import {
  observePreparedCompactionRules,
  prepareRuleObservationsWithMessages,
  type RuleObservationOptions,
} from "./observer.ts";
import { canProvideRuleAuthority, ObservationPlanError } from "./questions.ts";
import {
  ScheduledJevClient,
  type JevRequestSchedulerOptions,
} from "./scheduler.ts";
import {
  createRetroProposal,
  RetroValidationError,
  type CurrentModelGateway,
  type RetroOptions,
} from "./retro.ts";
import {
  applyTriggerDecision,
  evaluateTrigger,
  hasConservativeCompactableHistory,
  localTriggerGatesPass,
  type TriggerInput,
} from "./trigger.ts";
import { StateFitError } from "./state.ts";
import {
  collectRetroPendingMarkers,
  collectRuleAcceptanceReceipts,
  collectRuleProposalBatches,
  collectRuleProposalReceipts,
  collectRuleSignalBatches,
  RULE_ACCEPTANCE_ENTRY_TYPE,
  RULE_PROPOSAL_ENTRY_TYPE,
} from "./storage.ts";
import type {
  CorpusChunk,
  JevClient,
  JevCompactionResult,
  EvidenceOptions,
  RetroPendingMarker,
  RuleAcceptanceReceipt,
  RuleSignalBatch,
  StoredRuleProposal,
  StoredRuleProposalCandidate,
} from "./types.ts";

export interface PiRuleCompilerOptions {
  jevClient?: JevClient;
  env?: Readonly<Record<string, string | undefined>>;
  hookTimeoutMs?: number;
  retroTimeoutMs?: number;
  observation?: RuleObservationOptions;
  scheduling?: JevRequestSchedulerOptions;
  compaction?: BuildJevCompactionOptions;
  evidence?: EvidenceOptions;
  retro?: RetroOptions;
  /** Flat extension configuration; invalid values retain the basic safe default. */
  config?: Readonly<Record<string, unknown>>;
  /** Runtime-only gates that Pi's public context cannot otherwise observe. */
  trigger?: {
    minimumContextRatio?: number;
    cooldownMs?: number;
    editorHasText?: (ctx: ExtensionContext) => boolean;
    resolveCompactionSettings?: (ctx: ExtensionContext) => { keepRecentTokens: number };
  };
  now?: () => Date;
}

type DiagnosticCode =
  | "missing_key"
  | "timeout"
  | "malformed_response"
  | "oversized_state"
  | "api_failure"
  | "aborted"
  | "model_unavailable"
  | "no_signals"
  | "no_pending_retro"
  | "storage_failure"
  | "internal_failure";

interface PendingCompaction {
  result: JevCompactionResult;
  corpus: CorpusChunk[];
}

interface PendingRetroWork {
  marker: RetroPendingMarker;
  batches: RuleSignalBatch[];
}

export const LADDER_PROJECTION_RECEIPT_TYPE = "a4s.pi-rule-compiler.ladder-projection-receipt.v1";

class CurrentModelCallError extends Error {}

export function registerPiRuleCompiler(pi: ExtensionAPI, options: PiRuleCompilerOptions = {}): void {
  const pendingByAttempt = new Map<string, PendingCompaction>();
  const retroInFlight = new Set<string>();
  let recoveredCorpus: CorpusChunk[] = [];
  const now = options.now ?? (() => new Date());
  const hookTimeoutMs = options.hookTimeoutMs ?? 180_000;
  const retroTimeoutMs = options.retroTimeoutMs ?? 120_000;
  const config = resolveCompactionConfig(
    options.evidence
      ? { ...options.config, "evidence.strategy": options.evidence.strategy }
      : options.config,
    BASIC_COMPACTION_CONFIG,
  );
  const triggerMinimumContextRatio = options.trigger?.minimumContextRatio ?? 0.2;
  const triggerCooldownMs = options.trigger?.cooldownMs ?? 300_000;
  const resolveTriggerCompactionSettings = options.trigger?.resolveCompactionSettings ?? ((ctx: ExtensionContext) =>
    SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() })
      .getCompactionSettings(ctx.model));
  const editorHasText = options.trigger?.editorHasText ?? ((ctx: ExtensionContext): boolean => {
    if (ctx.mode !== "tui") return true;
    try {
      return ctx.ui.getEditorText().trim().length > 0;
    } catch {
      return true;
    }
  });

  registerTypesafeProvider(pi);

  const resolveTypesafeApiKey = createTypesafeAuthResolver(
    options.env === undefined ? {} : { env: options.env },
  );
  const createJevClient = async (ctx: ExtensionContext, timeoutMs: number): Promise<JevClient> => {
    if (options.jevClient) return options.jevClient;
    return new TypesafeJevClient({ apiKey: await resolveTypesafeApiKey(ctx), timeoutMs });
  };

  // Retrieval is opt-in and request-time only. Basic never registers this hook,
  // so it cannot spend Jev quota or alter Pi's normal context.
  if (isLadderCompaction(config)) {
    pi.on("context_with_system", async (event, ctx) => {
      const normal = { messages: event.messages };
      return applyContextProjection(normal, async () => {
        const query = ladderQuery(event.messages);
        const corpus = collectCorpus(ctx.sessionManager.getBranch());
        const projection = await runWithDeadline(
          async (signal) => selectLadderProjection(
            corpus,
            query,
            new ScheduledJevClient(await createJevClient(ctx, hookTimeoutMs), options.scheduling),
            signal,
          ),
          hookTimeoutMs,
          ctx.signal,
        );
        // Recheck the branch-bound digest immediately before rendering. This is
        // redundant with selectLadderProjection by design: an invalid view must
        // never become a partial omission in Pi's request context.
        if (projection.corpusDigest !== corpusDigest(corpus)) throw new Error("Ladder corpus changed during projection");
        const rendered = renderProjection(projection, corpus);
        if (corpus.length > 0) {
          try {
            pi.appendEntry(LADDER_PROJECTION_RECEIPT_TYPE, {
              schema: "a4s.ladder-projection-receipt/v1",
              selectedChunks: projection.selections.filter((selection) => selection.level !== "hide").length,
              rendered: rendered.length > 0,
            });
          } catch {
            // Observability is best-effort and must not change a valid projection.
          }
        }
        if (rendered.length === 0) return normal;
        return { messages: appendLadderContext(event.messages, rendered) };
      });
    });
  }

  pi.on("session_start", (_event, ctx) => {
    pendingByAttempt.clear();
    retroInFlight.clear();
    // getBranch is Pi's branch-local view, so reload cannot blend sibling branches.
    recoveredCorpus = collectCorpus(ctx.sessionManager.getBranch());
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (isLadderEvidence(config)) {
      await drainPendingRetro(
        pi,
        ctx,
        createJevClient,
        retroTimeoutMs,
        now,
        options.retro,
        options.scheduling,
        retroInFlight,
      );
    }
    if (config.trigger.mode === "off") return;
    const usage = ctx.getContextUsage();
    const branch = ctx.sessionManager.getBranch();
    const baseInput = {
      mode: config.trigger.mode,
      interactive: ctx.hasUI,
      idle: ctx.isIdle(),
      contextTokens: usage?.tokens ?? 0,
      contextWindow: usage?.contextWindow ?? 0,
      minimumContextRatio: triggerMinimumContextRatio,
      compactableHistory: true,
      hasPendingWork: ctx.hasPendingMessages(),
      cooldownActive: hasTriggerCooldown(branch, now(), triggerCooldownMs),
      editorHasText: editorHasText(ctx),
      autoAcknowledged: hasTriggerAcknowledgement(branch),
    };
    if (!localTriggerGatesPass({ ...baseInput, credentialAvailable: true })) return;

    let compactableHistory = false;
    try {
      const settings = resolveTriggerCompactionSettings(ctx);
      const projection = ctx.sessionManager.buildSessionProjection();
      compactableHistory = hasConservativeCompactableHistory(
        projection.entries.map((entry) => ({
          sourceType: entry.sourceEntry.type,
          messages: entry.messages,
        })),
        settings.keepRecentTokens,
        branch.at(-1)?.type === "compaction",
      );
    } catch {
      return;
    }
    if (!compactableHistory) return;

    const credentialAvailable = options.jevClient !== undefined || Boolean(await resolveTypesafeApiKey(ctx));
    if (!credentialAvailable) return;
    const input: TriggerInput = {
      ...baseInput,
      compactableHistory,
      credentialAvailable,
      jevClient: await createJevClient(ctx, hookTimeoutMs),
      signal: ctx.signal ?? new AbortController().signal,
    };
    const decision = await evaluateTrigger(input);
    if (decision.action === "none") return;
    try {
      pi.appendEntry(TRIGGER_COOLDOWN_ENTRY_TYPE, {
        schema: "a4s.compaction-trigger-cooldown/v1",
        action: decision.action,
        triggeredAt: now().toISOString(),
      });
    } catch {
      return;
    }
    await applyTriggerDecision(decision, ctx);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    try {
      return await handleCompaction(
        event,
        ctx,
        createJevClient,
        pendingByAttempt,
        hookTimeoutMs,
        now,
        options.observation,
        options.scheduling,
        options.compaction,
      );
    } catch {
      safeNotify(ctx, "compaction", "internal_failure");
      return { cancel: true };
    }
  });

  pi.on("session_compact", async (event, ctx) => {
    const attemptId = readCompactionAttemptId(event.compactionEntry.details);
    const pending = attemptId ? pendingByAttempt.get(attemptId) : undefined;
    let corpusPublished = pending === undefined;
    if (pending) {
      try {
        publishCorpusAfterCompaction(pending.corpus, ctx.sessionManager.getBranch(), pi);
        recoveredCorpus = collectCorpus(ctx.sessionManager.getBranch());
        const recoveredIds = new Set(recoveredCorpus.map((chunk) => chunk.id));
        corpusPublished = pending.corpus.every((chunk) => recoveredIds.has(chunk.id));
      } catch {
        // Corpus persistence is best-effort after Pi has already committed compaction.
        // Never surface raw corpus through diagnostics or alter basic compaction output.
        corpusPublished = false;
      }
    }

    if (pending && isLadderEvidence(config) && corpusPublished) {
      try {
        const jevClient = new ScheduledJevClient(await createJevClient(ctx, hookTimeoutMs), options.scheduling);
        const evidence = await runWithDeadline(
          (signal) => runEvidence({
            config,
            result: pending.result,
            reason: event.reason,
            willRetry: event.willRetry,
            corpus: collectCorpus(ctx.sessionManager.getBranch()),
            getBranch: () => ctx.sessionManager.getBranch(),
            appender: pi,
            jev: jevClient,
            signal,
            ...(options.observation === undefined ? {} : { observation: options.observation }),
          }),
          hookTimeoutMs,
          ctx.signal,
        );
        if (
          !event.willRetry &&
          evidence.receipt &&
          evidence.receipt.signalIds.length > 0
        ) {
          await drainPendingRetro(
            pi,
            ctx,
            createJevClient,
            retroTimeoutMs,
            now,
            options.retro,
            options.scheduling,
            retroInFlight,
            attemptId,
          );
        }
      } catch (error) {
        safeNotify(ctx, "signals", classifyRetroError(error));
      }
    } else if (pending) {
      await disabledEvidencePipeline.afterCompaction(pending.result, ctx);
    }
    if (attemptId) pendingByAttempt.delete(attemptId);
  });

  pi.on("session_compact_failed", () => {
    pendingByAttempt.clear();
  });

  pi.on("session_shutdown", () => {
    pendingByAttempt.clear();
    retroInFlight.clear();
  });

  pi.registerCommand("compaction-trigger-acknowledge", {
    description: "Persist acknowledgement required before automatic compaction can run",
    handler: async (_args, _ctx) => {
      pi.appendEntry(TRIGGER_ACKNOWLEDGEMENT_ENTRY_TYPE, {
        schema: "a4s.compaction-trigger-acknowledgement/v1",
        acknowledgedAt: now().toISOString(),
      });
    },
  });

  pi.registerCommand("retro-rules", {
    description: "Retry pending review-only rule proposal synthesis",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const result = await drainPendingRetro(
        pi,
        ctx,
        createJevClient,
        retroTimeoutMs,
        now,
        options.retro,
        options.scheduling,
        retroInFlight,
      );
      if (result.eligible === 0) safeNotify(ctx, "retro", "no_pending_retro");
    },
  });

  pi.registerCommand("rules-review", {
    description: "List stored review-only rule proposals and their acceptance state",
    handler: async (_args, ctx) => {
      safeNotifyText(ctx, renderProposalList(ctx.sessionManager.getBranch()), "info");
    },
  });

  pi.registerCommand("rules-show", {
    description: "Show one proposed rule candidate by id (or unique id prefix)",
    handler: async (args, ctx) => {
      const entries = ctx.sessionManager.getBranch();
      const match = resolveCandidate(entries, args.trim());
      if (match.status !== "ok") {
        safeNotifyText(ctx, renderResolutionError(match), "warning");
        return;
      }
      const accepted = isAccepted(entries, match.proposal.idempotencyKey, match.candidate.id);
      safeNotifyText(ctx, renderCandidateDetail(match.candidate, accepted), "info");
    },
  });

  pi.registerCommand("rules-accept", {
    description: "Record manual acceptance of a proposed rule (store-only; no Rootline/AGENTS.md write)",
    handler: async (args, ctx) => {
      const entries = ctx.sessionManager.getBranch();
      const match = resolveCandidate(entries, args.trim());
      if (match.status !== "ok") {
        safeNotifyText(ctx, renderResolutionError(match), "warning");
        return;
      }
      if (match.candidate.disposition !== "propose") {
        safeNotifyText(
          ctx,
          `Rule ${shortId(match.candidate.id)} is held, not proposed, and cannot be accepted. Only 'propose' candidates are acceptable.`,
          "warning",
        );
        return;
      }
      if (isAccepted(entries, match.proposal.idempotencyKey, match.candidate.id)) {
        safeNotifyText(ctx, `Rule ${shortId(match.candidate.id)} was already accepted; no change.`, "info");
        return;
      }
      const receipt: RuleAcceptanceReceipt = {
        schema: "a4s.rule-acceptance/v1",
        proposalIdempotencyKey: match.proposal.idempotencyKey,
        candidateId: match.candidate.id,
        acceptedAt: now().toISOString(),
      };
      try {
        pi.appendEntry(RULE_ACCEPTANCE_ENTRY_TYPE, receipt);
      } catch {
        safeNotify(ctx, "retro", "storage_failure");
        return;
      }
      safeNotifyText(
        ctx,
        `Accepted rule ${shortId(match.candidate.id)} (store-only). Nothing was written to Rootline or AGENTS.md; the durable apply is deferred to ADR 0020.`,
        "info",
      );
    },
  });
}

const TRIGGER_ACKNOWLEDGEMENT_ENTRY_TYPE = "a4s.pi-rule-compiler.compaction-trigger-acknowledgement.v1";
const TRIGGER_COOLDOWN_ENTRY_TYPE = "a4s.pi-rule-compiler.compaction-trigger-cooldown.v1";

function customEntryData(entry: unknown, customType: string): Record<string, unknown> | undefined {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown };
  if (candidate.type !== "custom" || candidate.customType !== customType) return undefined;
  if (candidate.data === null || typeof candidate.data !== "object" || Array.isArray(candidate.data)) return undefined;
  return candidate.data as Record<string, unknown>;
}

function hasTriggerAcknowledgement(entries: readonly unknown[]): boolean {
  return entries.some((entry) => {
    const data = customEntryData(entry, TRIGGER_ACKNOWLEDGEMENT_ENTRY_TYPE);
    return data?.schema === "a4s.compaction-trigger-acknowledgement/v1" && typeof data.acknowledgedAt === "string";
  });
}

function hasTriggerCooldown(entries: readonly unknown[], current: Date, cooldownMs: number): boolean {
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) return false;
  const currentMs = current.getTime();
  return entries.some((entry) => {
    const data = customEntryData(entry, TRIGGER_COOLDOWN_ENTRY_TYPE);
    if (
      data?.schema !== "a4s.compaction-trigger-cooldown/v1" ||
      (data.action !== "hint" && data.action !== "compact") ||
      typeof data.triggeredAt !== "string"
    ) return false;
    const triggeredAt = Date.parse(data.triggeredAt);
    return Number.isFinite(triggeredAt) && triggeredAt <= currentMs && currentMs - triggeredAt < cooldownMs;
  });
}

type CandidateResolution =
  | { status: "ok"; proposal: StoredRuleProposal; candidate: StoredRuleProposalCandidate }
  | { status: "empty" }
  | { status: "missing_arg" }
  | { status: "not_found"; query: string }
  | { status: "ambiguous"; query: string; matches: string[] };

function resolveCandidate(entries: readonly unknown[], query: string): CandidateResolution {
  const proposals = collectRuleProposalBatches(entries);
  if (!hasReviewCandidates(proposals)) return { status: "empty" };
  if (query.length === 0) return { status: "missing_arg" };
  const matches: Array<{ proposal: StoredRuleProposal; candidate: StoredRuleProposalCandidate }> = [];
  for (const proposal of proposals) {
    for (const candidate of proposal.candidates) {
      if (candidate.id === query || candidate.id.startsWith(query)) matches.push({ proposal, candidate });
    }
  }
  if (matches.length === 0) return { status: "not_found", query };
  const exact = matches.filter((match) => match.candidate.id === query);
  if (exact.length === 1) return { status: "ok", ...exact[0]! };
  if (matches.length > 1) {
    return { status: "ambiguous", query, matches: matches.map((match) => shortId(match.candidate.id)) };
  }
  return { status: "ok", ...matches[0]! };
}

function isAccepted(entries: readonly unknown[], proposalIdempotencyKey: string, candidateId: string): boolean {
  return collectRuleAcceptanceReceipts(entries).some(
    (receipt) => receipt.proposalIdempotencyKey === proposalIdempotencyKey && receipt.candidateId === candidateId,
  );
}

function hasReviewCandidates(proposals: readonly StoredRuleProposal[]): boolean {
  return proposals.some((proposal) => proposal.candidates.length > 0);
}

interface LatestRuleObservation {
  candidateCount: number;
  signalCount: number;
}

function latestRuleObservation(
  batches: readonly RuleSignalBatch[],
): LatestRuleObservation | undefined {
  const latest = batches.at(-1);
  if (!latest) return undefined;

  const latestAttemptId = latest.provenance.compactionAttemptId;
  const attemptBatches = batches.filter(
    (batch) => batch.provenance.compactionAttemptId === latestAttemptId,
  );
  const candidateCount = attemptBatches.reduce(
    (total, batch) => total + batch.provenance.sanitizedExcerpts.filter(
      (message) => message.excerpt.trim().length > 0 && canProvideRuleAuthority(message.role),
    ).length,
    0,
  );
  const signalCount = attemptBatches.reduce((total, batch) => total + batch.signals.length, 0);
  return { candidateCount, signalCount };
}

function renderNoProposalState(entries: readonly unknown[]): string {
  const observation = latestRuleObservation(collectRuleSignalBatches(entries));
  if (!observation) {
    return "No stored rule proposals or rule observations. Run a successful compaction.";
  }
  if (observation.candidateCount === 0) {
    return "Latest compaction: no non-empty user or custom messages were eligible as rule sources.";
  }
  if (observation.signalCount === 0) {
    return `Latest compaction: evaluated ${observation.candidateCount} rule candidate(s); none passed the conservative filter.`;
  }
  return `Latest compaction: recorded ${observation.signalCount} RuleSignal(s), but no rule proposal is stored. Run /retro-rules to retry retro processing.`;
}

function renderProposalList(entries: readonly unknown[]): string {
  const proposals = collectRuleProposalBatches(entries);
  if (proposals.length === 0) return renderNoProposalState(entries);
  if (!hasReviewCandidates(proposals)) {
    const observation = latestRuleObservation(collectRuleSignalBatches(entries));
    return observation
      ? `Latest retro completed: evaluated ${observation.candidateCount} rule candidate(s), synthesized no review-only candidates.`
      : "Latest retro completed: synthesized no review-only candidates.";
  }
  const accepted = new Set(
    collectRuleAcceptanceReceipts(entries).map((receipt) => `${receipt.proposalIdempotencyKey}:${receipt.candidateId}`),
  );
  const lines: string[] = [];
  let proposeCount = 0;
  for (const proposal of proposals) {
    for (const candidate of proposal.candidates) {
      const state =
        candidate.disposition === "hold"
          ? "held"
          : accepted.has(`${proposal.idempotencyKey}:${candidate.id}`)
            ? "accepted"
            : "proposed";
      if (candidate.disposition === "propose") proposeCount += 1;
      lines.push(`${shortId(candidate.id)} [${state}] (${candidate.ruleClass}) ${candidate.obligation}`);
    }
  }
  return `${lines.length} candidate(s), ${proposeCount} proposable. Use /rules-show <id> then /rules-accept <id>.\n${lines.join("\n")}`;
}

function renderCandidateDetail(candidate: StoredRuleProposalCandidate, accepted: boolean): string {
  const state = candidate.disposition === "hold" ? "held" : accepted ? "accepted" : "proposed";
  const target = candidate.scope.target ? `:${candidate.scope.target}` : "";
  return [
    `Rule ${shortId(candidate.id)} [${state}]`,
    `scope: ${candidate.scope.kind}${target} · class: ${candidate.ruleClass}`,
    `when: ${candidate.trigger}`,
    `must: ${candidate.obligation}`,
    candidate.exceptions.length > 0 ? `except: ${candidate.exceptions.join("; ")}` : "except: (none)",
  ].join("\n");
}

function renderResolutionError(resolution: CandidateResolution): string {
  switch (resolution.status) {
    case "empty":
      return "No stored rule proposals. Run compaction or /retro-rules first.";
    case "missing_arg":
      return "Usage: /rules-show <id> or /rules-accept <id>. Run /rules-review to list ids.";
    case "not_found":
      return `No proposed rule matches '${resolution.query}'. Run /rules-review to list ids.`;
    case "ambiguous":
      return `'${resolution.query}' matches multiple rules: ${resolution.matches.join(", ")}. Use a longer id.`;
    default:
      return "Unable to resolve rule.";
  }
}

function shortId(id: string): string {
  return id.slice(0, 12);
}

async function handleCompaction(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  createJevClient: (ctx: ExtensionContext, timeoutMs: number) => Promise<JevClient>,
  pendingByAttempt: Map<string, PendingCompaction>,
  timeoutMs: number,
  now: () => Date,
  observationOptions: RuleObservationOptions | undefined,
  schedulingOptions: JevRequestSchedulerOptions | undefined,
  compactionOptions: BuildJevCompactionOptions | undefined,
): Promise<SessionBeforeCompactResult> {
  try {
    const preparation = {
      ...(event.preparation.previousSummary === undefined
        ? {}
        : { previousSummary: event.preparation.previousSummary }),
      messagesToSummarize: event.preparation.messagesToSummarize,
      turnPrefixMessages: event.preparation.turnPrefixMessages,
    };
    const prepared = prepareRuleObservationsWithMessages(preparation, observationOptions);
    const attemptId = stableDigest({
      schema: "a4s.jev-compaction-attempt/v1",
      sourceDigest: prepared.sourceDigest,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
    });
    const existing = pendingByAttempt.get(attemptId);
    if (existing) return { compaction: existing.result };

    const observedAt = now().toISOString();
    const jevClient = new ScheduledJevClient(await createJevClient(ctx, timeoutMs), schedulingOptions);
    const batches = await runWithDeadline(
      (signal) =>
        Promise.all(
          prepared.plans.map((plan, windowIndex) =>
            observePreparedCompactionRules(
              plan,
              {
                attemptId,
                reason: event.reason,
                willRetry: event.willRetry,
                observedAt,
                windowIndex,
                windowCount: prepared.plans.length,
                pins: prepared.pins,
              },
              jevClient,
              signal,
              observationOptions,
            ),
          ),
        ),
      timeoutMs,
      event.signal,
    );
    const result = buildBasicCompactionResult(
      {
        attemptId,
        sourceDigest: prepared.sourceDigest,
        createdAt: observedAt,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        decisions: batches.flatMap((batch) => batch.compaction.decisions),
        scheduler: jevClient.getStats(),
      },
      compactionOptions,
    );
    pendingByAttempt.set(attemptId, {
      result,
      corpus: stageCorpus(prepared.messages, {
        branchId: corpusBranchId(ctx),
        compactionAttemptId: attemptId,
      }),
    });
    return { compaction: result };
  } catch (error) {
    safeNotify(ctx, "compaction", classifyCompactionError(error));
    return { cancel: true };
  }
}

function ladderQuery(messages: ContextWithSystemEvent["messages"]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user") continue;
    const text = messageText(message.content);
    const sanitized = redactAndLimitCorpusText(text).text.trim();
    if (sanitized.length > 0) return sanitized;
  }
  throw new Error("Ladder requires a concrete user query");
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    if (part === null || typeof part !== "object" || Array.isArray(part)) return [];
    const text = (part as { type?: unknown; text?: unknown }).type === "text"
      ? (part as { text?: unknown }).text
      : undefined;
    return typeof text === "string" ? [text] : [];
  }).join("\n");
}

function appendLadderContext(
  messages: ContextWithSystemEvent["messages"],
  rendered: string,
): ContextWithSystemEvent["messages"] {
  // Pi documents a leading system message at this hook. If that contract is not
  // present, do not attempt to reconstruct it: fail open to the caller instead.
  if (messages[0]?.role !== "system") throw new Error("Pi normal system context is unavailable");
  const projection = { role: "system" as const, content: rendered, timestamp: Date.now() };
  return [messages[0], projection, ...messages.slice(1)];
}

function corpusBranchId(ctx: ExtensionContext): string {
  const manager = ctx.sessionManager as ExtensionContext["sessionManager"] & {
    getLeafId?: () => unknown;
  };
  const leafId = manager.getLeafId?.();
  const rawAnchor = typeof leafId === "string" ? leafId : "root";
  // Treat session-provided identifiers as source data: redact and bound them
  // before they can participate in durable corpus provenance.
  const anchor = redactAndLimitCorpusText(rawAnchor, 200).text || "root";
  return stableDigest({ schema: "a4s.corpus-branch/v1", anchor });
}

function readCompactionAttemptId(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const attemptId = (value as { attemptId?: unknown }).attemptId;
  return typeof attemptId === "string" && isStableDigest(attemptId) ? attemptId : undefined;
}

function retroMarkerForBatches(
  attemptId: string,
  batches: readonly RuleSignalBatch[],
  reason: "manual" | "threshold" | "overflow",
  willRetry: boolean,
): RetroPendingMarker {
  const sourceDigests = [...new Set(batches.map((batch) => batch.sourceDigest))];
  const createdAt = batches[0]?.observedAt;
  if (!createdAt || sourceDigests.length === 0) throw new Error("retro marker requires observed batches");
  return {
    schema: "a4s.retro-pending/v1",
    attemptId,
    createdAt,
    sourceDigests,
    compactionReason: reason,
    deferredUntilAgentSettled: willRetry,
  };
}

function collectPendingRetroWork(
  entries: readonly unknown[],
  onlyAttemptId?: string,
): PendingRetroWork[] {
  const batches = collectRuleSignalBatches(entries);
  const batchesBySource = new Map(batches.map((batch) => [batch.sourceDigest, batch]));
  const coveredBatchDigests = new Set(
    collectRuleProposalReceipts(entries).flatMap((receipt) => receipt.sourceBatchDigests),
  );
  const markers = collectRetroPendingMarkers(entries);
  const markedAttempts = new Set(markers.map((marker) => marker.attemptId));

  for (const batch of batches) {
    const attemptId = batch.provenance.compactionAttemptId;
    if (markedAttempts.has(attemptId)) continue;
    const siblings = batches.filter((candidate) => candidate.provenance.compactionAttemptId === attemptId);
    markers.push(
      retroMarkerForBatches(
        attemptId,
        siblings,
        batch.provenance.compactionReason,
        batch.provenance.willRetry,
      ),
    );
    markedAttempts.add(attemptId);
  }

  const work: PendingRetroWork[] = [];
  for (const marker of markers) {
    if (onlyAttemptId && marker.attemptId !== onlyAttemptId) continue;
    const resolved = marker.sourceDigests.map((digest) => batchesBySource.get(digest));
    if (resolved.some((batch) => !batch)) continue;
    const pendingBatches = (resolved as RuleSignalBatch[]).filter(
      (batch) => !coveredBatchDigests.has(stableDigest(batch)),
    );
    if (pendingBatches.reduce((total, batch) => total + batch.signals.length, 0) === 0) continue;
    work.push({ marker, batches: pendingBatches });
  }
  return work;
}

async function drainPendingRetro(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  createJevClient: (ctx: ExtensionContext, timeoutMs: number) => Promise<JevClient>,
  timeoutMs: number,
  now: () => Date,
  retroOptions: RetroOptions | undefined,
  schedulingOptions: JevRequestSchedulerOptions | undefined,
  inFlight: Set<string>,
  onlyAttemptId?: string,
): Promise<{ eligible: number; completed: number }> {
  const work = collectPendingRetroWork(ctx.sessionManager.getBranch(), onlyAttemptId).filter(
    (item) => !inFlight.has(item.marker.attemptId),
  );
  if (work.length === 0) return { eligible: 0, completed: 0 };

  const model = ctx.model;
  if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
    safeNotify(ctx, "retro", "model_unavailable");
    return { eligible: work.length, completed: 0 };
  }
  const currentModel = createCurrentModelGateway(ctx, model, now);
  let completed = 0;

  for (const item of work) {
    const coveredNow = new Set(
      collectRuleProposalReceipts(ctx.sessionManager.getBranch()).flatMap(
        (receipt) => receipt.sourceBatchDigests,
      ),
    );
    if (item.batches.every((batch) => coveredNow.has(stableDigest(batch)))) continue;

    inFlight.add(item.marker.attemptId);
    try {
      const jevClient = new ScheduledJevClient(await createJevClient(ctx, timeoutMs), schedulingOptions);
      const proposal = await runWithDeadline(
        (signal) =>
          createRetroProposal(
            item.batches,
            {
              model: { provider: model.provider, id: model.id },
              createdAt: now().toISOString(),
              sourceCompactionAttemptIds: [item.marker.attemptId],
            },
            currentModel,
            jevClient,
            signal,
            retroOptions,
          ),
        timeoutMs,
        ctx.signal,
      );

      const alreadyStored = collectRuleProposalReceipts(ctx.sessionManager.getBranch()).some(
        (receipt) => receipt.idempotencyKey === proposal.idempotencyKey,
      );
      if (!alreadyStored) pi.appendEntry(RULE_PROPOSAL_ENTRY_TYPE, proposal);
      completed += 1;
      const proposed = proposal.candidates.filter(
        (candidate) => candidate.evaluation.disposition === "propose",
      ).length;
      safeNotifyText(
        ctx,
        `Retro rules stored ${proposal.candidates.length} review-only proposal(s): ${proposed} supported, ${proposal.candidates.length - proposed} held. Nothing was activated.`,
        "info",
      );
    } catch (error) {
      safeNotify(ctx, "retro", classifyRetroError(error));
    } finally {
      inFlight.delete(item.marker.attemptId);
    }
  }
  return { eligible: work.length, completed };
}

function createCurrentModelGateway(
  ctx: ExtensionContext,
  model: NonNullable<ExtensionContext["model"]>,
  now: () => Date,
): CurrentModelGateway {
  return {
    async complete(prompt, signal): Promise<unknown> {
      try {
        return await ctx.modelRegistry.complete(
          model,
          {
            systemPrompt: prompt.systemPrompt,
            messages: [
              {
                role: "user" as const,
                content: [{ type: "text" as const, text: prompt.userPrompt }],
                timestamp: now().getTime(),
              },
            ],
          },
          { signal, maxTokens: prompt.maxTokens, cacheRetention: "none" },
        );
      } catch {
        throw new CurrentModelCallError();
      }
    },
  };
}

function classifyCompactionError(error: unknown): DiagnosticCode {
  if (error instanceof JevUnavailableError) return "missing_key";
  if (error instanceof DeadlineExceededError) return "timeout";
  if (error instanceof OperationAbortedError) return "aborted";
  if (error instanceof JevValidationError) return "malformed_response";
  if (error instanceof StateFitError || error instanceof ObservationPlanError || error instanceof CompactionBuildError) {
    return "oversized_state";
  }
  if (error instanceof JevApiError) return "api_failure";
  return "internal_failure";
}

function classifyRetroError(error: unknown): DiagnosticCode {
  if (error instanceof JevUnavailableError) return "missing_key";
  if (error instanceof DeadlineExceededError) return "timeout";
  if (error instanceof OperationAbortedError) return "aborted";
  if (error instanceof CurrentModelCallError) return "model_unavailable";
  if (error instanceof JevValidationError) return "malformed_response";
  if (error instanceof JevApiError) return "api_failure";
  if (error instanceof RetroValidationError) {
    if (error.code === "no_signals") return "no_signals";
    if (error.code === "oversized_state") return "oversized_state";
    if (error.code === "model_failure" || error.code === "malformed_model_json") return "malformed_response";
  }
  return "internal_failure";
}

const ABORTED_TRANSPORT_DIAGNOSTIC_PREFIX = "[a4s-pi-rule-compiler:rpc-stdin-guard]";

/**
 * Best-effort side channel for the "aborted" diagnostic code specifically.
 * Under RPC mode, an RPC caller that closes stdin before a slow command's
 * response arrives makes pi's vendored RPC transport tear the session down
 * immediately (rpc-mode.js's stdin "end" handler unsubscribes the event
 * forwarder and disposes the runtime without waiting for in-flight work).
 * That race is what typically produces this "aborted" classification, and
 * it can also detach the forwarder ctx.ui.notify() depends on, so the
 * ordinary notify below may never reach the RPC client. Writing to stderr
 * is outside the RPC JSONL stdout protocol, so it cannot corrupt framing,
 * and every step here is wrapped so it can never change compaction/command
 * failure semantics. See README.md's "RPC callers must hold stdin open
 * through compact" section.
 */
function emitAbortedTransportDiagnostic(
  ctx: ExtensionContext,
  phase: "compaction" | "signals" | "retro",
): void {
  if (ctx.mode !== "rpc") return;
  try {
    process.stderr.write(
      `${ABORTED_TRANSPORT_DIAGNOSTIC_PREFIX} ${phase} aborted under RPC mode. If a driver closed ` +
        "stdin before this command's response arrived, that is the likely cause (see README.md's " +
        '"RPC callers must hold stdin open through compact" section).\n',
    );
  } catch {
    // Diagnostics must not change compaction or command failure semantics.
  }
}

function safeNotify(ctx: ExtensionContext, phase: "compaction" | "signals" | "retro", code: DiagnosticCode): void {
  if (code === "aborted") emitAbortedTransportDiagnostic(ctx, phase);
  const descriptions: Record<DiagnosticCode, string> = {
    missing_key: "Jev is unavailable (missing TYPESAFE_API_KEY)",
    timeout: "the bounded analysis timed out",
    malformed_response: "a model response failed strict validation",
    oversized_state: "the sanitized state or summary exceeded configured bounds",
    api_failure: "the Jev request failed",
    aborted: "the analysis was aborted",
    model_unavailable: "the current Pi model is unavailable",
    no_signals: "no persisted RuleSignals are available",
    no_pending_retro: "no pending RuleSignal batch needs retro processing",
    storage_failure: "the proposal or signal entry could not be stored",
    internal_failure: "an internal bounded failure occurred",
  };
  const suffix =
    phase === "compaction"
      ? "Compaction was cancelled; native fallback is disabled."
      : phase === "signals"
        ? "Signals remain recoverable from the successful compaction entry."
        : "Persisted signals were preserved.";
  safeNotifyText(
    ctx,
    `Rule compiler ${phase} skipped: ${descriptions[code]}. ${suffix}`,
    code === "no_signals" ? "info" : "warning",
  );
}

function safeNotifyText(
  ctx: ExtensionContext,
  text: string,
  level: "info" | "warning" | "error",
): void {
  try {
    ctx.ui.notify(text.slice(0, 240), level);
  } catch {
    // Diagnostics must not change compaction or command failure semantics.
  }
}
