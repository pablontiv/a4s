import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { AuthResult } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { buildBasicCompactionResult } from "./compaction-core.ts";
import {
  CompactionBuildError,
  type BuildJevCompactionOptions,
} from "./compaction.ts";
import { disabledEvidencePipeline } from "./evidence-pipeline.ts";
import { DeadlineExceededError, OperationAbortedError, runWithDeadline } from "./deadline.ts";
import { isStableDigest, stableDigest } from "./digest.ts";
import { HttpJevClient, JevApiError, JevUnavailableError, JevValidationError } from "./jev.ts";
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
  JevClient,
  JevCompactionResult,
  EvidenceOptions,
  RetroPendingMarker,
  RuleAcceptanceReceipt,
  RuleSignalBatch,
  StoredRuleProposal,
  StoredRuleProposalCandidate,
} from "./types.ts";
import { TYPESAFE_API_KEY_ENV, TYPESAFE_PROVIDER_ID } from "./types.ts";

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
}

interface PendingRetroWork {
  marker: RetroPendingMarker;
  batches: RuleSignalBatch[];
}

class CurrentModelCallError extends Error {}

export function createTypesafeAuthResolver(
  options: Pick<PiRuleCompilerOptions, "env">,
): (ctx: ExtensionContext) => Promise<string | undefined> {
  let cached: AuthResult | undefined;
  return async (ctx: ExtensionContext): Promise<string | undefined> => {
    const envKey = (options.env ?? process.env)[TYPESAFE_API_KEY_ENV];
    if (envKey) return envKey;
    if (!cached) {
      cached = await ctx.modelRegistry.getProviderAuth(TYPESAFE_PROVIDER_ID);
    }
    return cached?.auth.apiKey;
  };
}

function createTypesafeProvider() {
  return createProvider({
    id: TYPESAFE_PROVIDER_ID,
    name: "TypeSafe (Jev)",
    auth: {
      apiKey: {
        name: "TypeSafe API key",
        async login(interaction) {
          return {
            type: "api_key" as const,
            key: await interaction.prompt({ type: "secret", message: "TypeSafe API key" }),
          };
        },
        async resolve({ credential }) {
          return credential?.key
            ? { auth: { apiKey: credential.key }, source: "stored API key" }
            : undefined;
        },
      },
    },
    models: [],
    api: openAICompletionsApi(),
  });
}

export function registerPiRuleCompiler(pi: ExtensionAPI, options: PiRuleCompilerOptions = {}): void {
  const pendingByAttempt = new Map<string, PendingCompaction>();
  const retroInFlight = new Set<string>();
  const now = options.now ?? (() => new Date());
  const hookTimeoutMs = options.hookTimeoutMs ?? 180_000;
  const retroTimeoutMs = options.retroTimeoutMs ?? 120_000;

  pi.registerProvider(createTypesafeProvider());

  const resolveTypesafeApiKey = createTypesafeAuthResolver(options);
  const createJevClient = async (ctx: ExtensionContext): Promise<JevClient> => {
    if (options.jevClient) return options.jevClient;
    return new HttpJevClient({ apiKey: (await resolveTypesafeApiKey(ctx)) ?? "" });
  };

  pi.on("session_start", () => {
    pendingByAttempt.clear();
    retroInFlight.clear();
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
    if (attemptId) pendingByAttempt.delete(attemptId);
    const evidenceStrategy = options.evidence?.strategy ?? "off";
    if (evidenceStrategy === "off" && pending) {
      await disabledEvidencePipeline.afterCompaction(pending.result, ctx);
    }
  });

  pi.on("session_compact_failed", () => {
    pendingByAttempt.clear();
  });

  pi.on("session_shutdown", () => {
    pendingByAttempt.clear();
    retroInFlight.clear();
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

type CandidateResolution =
  | { status: "ok"; proposal: StoredRuleProposal; candidate: StoredRuleProposalCandidate }
  | { status: "empty" }
  | { status: "missing_arg" }
  | { status: "not_found"; query: string }
  | { status: "ambiguous"; query: string; matches: string[] };

function resolveCandidate(entries: readonly unknown[], query: string): CandidateResolution {
  const proposals = collectRuleProposalBatches(entries);
  if (proposals.length === 0) return { status: "empty" };
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
  createJevClient: (ctx: ExtensionContext) => Promise<JevClient>,
  pendingByAttempt: Map<string, PendingCompaction>,
  timeoutMs: number,
  now: () => Date,
  observationOptions: RuleObservationOptions | undefined,
  schedulingOptions: JevRequestSchedulerOptions | undefined,
  compactionOptions: BuildJevCompactionOptions | undefined,
): Promise<{ cancel: true } | { compaction: JevCompactionResult }> {
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
    const jevClient = new ScheduledJevClient(await createJevClient(ctx), schedulingOptions);
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
    pendingByAttempt.set(attemptId, { result });
    return { compaction: result };
  } catch (error) {
    safeNotify(ctx, "compaction", classifyCompactionError(error));
    return { cancel: true };
  }
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
  createJevClient: (ctx: ExtensionContext) => Promise<JevClient>,
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
      const jevClient = new ScheduledJevClient(await createJevClient(ctx), schedulingOptions);
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
