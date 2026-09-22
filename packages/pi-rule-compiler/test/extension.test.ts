import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createTypesafeAuthResolver,
  JevApiError,
  observeCompactionRules,
  parseRetroPendingMarker,
  parseRuleProposalReceipt,
  registerPiRuleCompiler,
  RETRO_PENDING_ENTRY_TYPE,
  RULE_PROPOSAL_ENTRY_TYPE,
  RULE_SIGNAL_ENTRY_TYPE,
  TYPESAFE_PROVIDER_ID,
  stableDigest,
  type JevClient,
  type RuleSignalBatch,
  type JevCompactionResult,
  type JevRequest,
} from "../src/index.ts";
import { validJevResponse } from "./fixtures.ts";

type EventHandler = (event: unknown, context: unknown) => unknown;
type CommandHandler = (args: string, context: unknown) => Promise<void>;

interface StoredEntry {
  type: string;
  customType?: string;
  data?: unknown;
  details?: unknown;
}

function createFakePi(initialEntries: StoredEntry[] = []) {
  const handlers = new Map<string, EventHandler>();
  const commands = new Map<string, CommandHandler>();
  const entries = [...initialEntries];
  const registeredProviders: unknown[] = [];
  const api = {
    on(name: string, handler: EventHandler) {
      handlers.set(name, handler);
    },
    registerCommand(name: string, options: { handler: CommandHandler }) {
      commands.set(name, options.handler);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    registerProvider(provider: unknown) {
      registeredProviders.push(provider);
    },
  };
  // SAFETY: this test double implements every ExtensionAPI member exercised by registerPiRuleCompiler.
  return { pi: api as unknown as ExtensionAPI, handlers, commands, entries, registeredProviders };
}

function createContext(entries: StoredEntry[], options: { mode?: "tui" | "rpc" } = {}) {
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  const context = {
    mode: options.mode ?? "tui",
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
    },
    sessionManager: {
      getEntries: () => entries,
      getBranch: () => entries,
    },
    modelRegistry: {
      async getProviderAuth(_provider: string) {
        return undefined;
      },
    },
  };
  return { context, notifications };
}

function captureStderr(): { restore: () => string[] } {
  const original = process.stderr.write;
  const chunks: string[] = [];
  const spy = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  // SAFETY: only ever assigned/restored within a single synchronous test body.
  process.stderr.write = spy as unknown as typeof process.stderr.write;
  return {
    restore() {
      process.stderr.write = original;
      return chunks;
    },
  };
}

function createRetroCapableContext(entries: StoredEntry[], options: { failModel?: boolean } = {}) {
  const base = createContext(entries);
  let modelCalls = 0;
  const context = {
    ...base.context,
    waitForIdle: async () => undefined,
    model: { provider: "fake-provider", id: "current-model" },
    modelRegistry: {
      hasConfiguredAuth: () => true,
      async getProviderAuth(_provider: string) {
        return undefined;
      },
      async complete(
        _model: unknown,
        request: { messages: Array<{ content: Array<{ text?: string }> }> },
      ) {
        modelCalls += 1;
        if (options.failModel) throw new Error("model failed");
        const prompt = request.messages[0]?.content[0]?.text ?? "";
        const sourceRef = prompt.match(/sha256:[a-f0-9]{64}/)?.[0];
        if (!sourceRef) throw new Error("missing source ref in synthesis prompt");
        return {
          stopReason: "stop",
          content: [{
            type: "text",
            text: JSON.stringify({
              candidates: [{
                scope: { kind: "project", target: null },
                trigger: "before completion",
                obligation: "Run applicable deterministic checks.",
                exceptions: [],
                source_refs: [sourceRef],
                proposed_check: { kind: "command", description: "Run tests.", command: "npm test" },
              }],
            }),
          }],
        };
      },
    },
  };
  return { ...base, context, modelCalls: () => modelCalls };
}

function compactionEvent(
  messages: unknown[] = [{ role: "user", content: "Always run deterministic tests." }],
  lifecycle: { reason?: "manual" | "threshold" | "overflow"; willRetry?: boolean } = {},
) {
  return {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "kept-entry",
      messagesToSummarize: messages,
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 10_000,
      fileOps: { read: [], modified: [] },
      settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    },
    branchEntries: [],
    reason: lifecycle.reason ?? "threshold",
    willRetry: lifecycle.willRetry ?? false,
    signal: new AbortController().signal,
  };
}

class ValidFakeJev implements JevClient {
  calls = 0;
  readonly requests: JevRequest[] = [];

  async evaluate(request: JevRequest): Promise<unknown> {
    this.calls += 1;
    this.requests.push(request);
    return validJevResponse(request);
  }
}

function requireCompactionResult(value: unknown): JevCompactionResult {
  assert.ok(value && typeof value === "object" && "compaction" in value);
  const result = (value as { compaction: JevCompactionResult }).compaction;
  assert.ok(result);
  return result;
}

function appendSuccessfulCompaction(fake: ReturnType<typeof createFakePi>, result: JevCompactionResult): StoredEntry {
  const entry = { type: "compaction", details: result.details };
  fake.entries.push(entry);
  return entry;
}

class NoRuleSignalJev extends ValidFakeJev {
  override async evaluate(request: JevRequest): Promise<unknown> {
    this.calls += 1;
    this.requests.push(request);
    return validJevResponse(request, (id, question) =>
      id.startsWith("rule_candidate_") && question.type === "noul"
        ? { type: "noul", noul: 0 }
        : undefined,
    );
  }
}

async function batchFor(
  messages: unknown[],
  jev: JevClient,
  attempt: string,
): Promise<RuleSignalBatch> {
  return observeCompactionRules(
    { messagesToSummarize: messages, turnPrefixMessages: [] },
    {
      reason: "manual",
      willRetry: false,
      observedAt: "2026-09-22T12:00:00.000Z",
      attemptId: stableDigest({ attempt }),
    },
    jev,
    new AbortController().signal,
  );
}

function asSignalEntry(batch: RuleSignalBatch): StoredEntry {
  return { type: "custom", customType: RULE_SIGNAL_ENTRY_TYPE, data: batch };
}

async function runRulesReview(entries: StoredEntry[]): Promise<string> {
  return runRuleCommand(entries, "rules-review", "");
}

async function runRuleCommand(entries: StoredEntry[], command: string, args: string): Promise<string> {
  const fake = createFakePi(entries);
  registerPiRuleCompiler(fake.pi, { jevClient: new ValidFakeJev() });
  const { context, notifications } = createContext(fake.entries);
  await fake.commands.get(command)?.(args, context);
  return notifications.at(-1)?.message ?? "";
}

function storedProposalEntry(): StoredEntry {
  const digest = stableDigest({ proposal: "existing" });
  return {
    type: "custom",
    customType: RULE_PROPOSAL_ENTRY_TYPE,
    data: {
      schema: "a4s.rule-proposal-batch/v1",
      idempotencyKey: digest,
      createdAt: "2026-09-22T12:00:00.000Z",
      sourceCompactionAttemptIds: [digest],
      sourceBatchDigests: [digest],
      sourceSignalIds: [digest],
      synthesisModel: { provider: "fake", id: "model" },
      jevModel: "jev-1.13.0",
      candidates: [],
    },
  };
}

test("before hook always returns Jev custom compaction and signals persist only after success", async () => {
  const jev = new ValidFakeJev();
  const fake = createFakePi();
  registerPiRuleCompiler(fake.pi, {
    jevClient: jev,
    now: () => new Date("2026-09-18T12:00:00.000Z"),
  });
  const { context, notifications } = createContext(fake.entries);
  await fake.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
  const event = compactionEvent([
    {
      role: "user",
      content: "Always run deterministic tests. password=private-fixture-value alice@example.com",
    },
  ]);
  const before = structuredClone(event.preparation);
  const hookResult = await fake.handlers.get("session_before_compact")?.(event, context);
  const compaction = requireCompactionResult(hookResult);

  assert.deepEqual(event.preparation, before);
  assert.equal(compaction.firstKeptEntryId, "kept-entry");
  assert.equal(compaction.tokensBefore, 10_000);
  assert.deepEqual(compaction.details.scheduler, {
    maxConcurrency: 1,
    maxRetries: 3,
    logicalRequests: 1,
    attempts: 1,
    retries: 0,
    maxObservedConcurrency: 1,
  });
  assert.deepEqual(compaction.details.decisions[0]?.forcedBy, ["boundary", "newest", "rule_candidate"]);
  assert.match(compaction.summary, /^# Jev-authoritative compaction/);
  assert.doesNotMatch(JSON.stringify(compaction), /private-fixture-value|alice@example\.com/);
  assert.equal(fake.entries.length, 0, "before hook must not publish RuleSignals");

  const compactionEntry = appendSuccessfulCompaction(fake, compaction);
  await fake.handlers.get("session_compact")?.(
    { type: "session_compact", compactionEntry, fromExtension: true, reason: "threshold", willRetry: false },
    context,
  );
  assert.equal(fake.entries.filter((entry) => entry.customType === RULE_SIGNAL_ENTRY_TYPE).length, 1);
  assert.ok(notifications.some((notification) => /compaction succeeded/.test(notification.message)));

  await fake.handlers.get("session_compact")?.(
    { type: "session_compact", compactionEntry, fromExtension: true, reason: "threshold", willRetry: false },
    context,
  );
  assert.equal(fake.entries.filter((entry) => entry.customType === RULE_SIGNAL_ENTRY_TYPE).length, 1);
});

test("manual and threshold success run retro automatically and replay is idempotent", async (t) => {
  for (const reason of ["manual", "threshold"] as const) {
    await t.test(reason, async () => {
      const jev = new ValidFakeJev();
      const fake = createFakePi();
      registerPiRuleCompiler(fake.pi, {
        jevClient: jev,
        now: () => new Date("2026-09-18T12:05:00.000Z"),
      });
      const runtime = createRetroCapableContext(fake.entries);
      const event = compactionEvent(undefined, { reason });
      const result = requireCompactionResult(
        await fake.handlers.get("session_before_compact")?.(event, runtime.context),
      );
      const compactionEntry = appendSuccessfulCompaction(fake, result);
      const successEvent = {
        type: "session_compact",
        compactionEntry,
        fromExtension: true,
        reason,
        willRetry: false,
      };

      await fake.handlers.get("session_compact")?.(successEvent, runtime.context);
      assert.equal(fake.entries.filter((entry) => entry.customType === RULE_SIGNAL_ENTRY_TYPE).length, 1);
      assert.equal(fake.entries.filter((entry) => entry.customType === RETRO_PENDING_ENTRY_TYPE).length, 1);
      assert.equal(fake.entries.filter((entry) => entry.customType === RULE_PROPOSAL_ENTRY_TYPE).length, 1);
      assert.equal(runtime.modelCalls(), 1);
      const marker = parseRetroPendingMarker(
        fake.entries.find((entry) => entry.customType === RETRO_PENDING_ENTRY_TYPE)?.data,
      );
      assert.equal(marker.compactionReason, reason);
      assert.equal(marker.deferredUntilAgentSettled, false);
      const receipt = parseRuleProposalReceipt(
        fake.entries.find((entry) => entry.customType === RULE_PROPOSAL_ENTRY_TYPE)?.data,
      );
      assert.deepEqual(receipt.sourceCompactionAttemptIds, [result.details.attemptId]);

      await fake.handlers.get("session_compact")?.(successEvent, runtime.context);
      assert.equal(fake.entries.filter((entry) => entry.customType === RULE_SIGNAL_ENTRY_TYPE).length, 1);
      assert.equal(fake.entries.filter((entry) => entry.customType === RETRO_PENDING_ENTRY_TYPE).length, 1);
      assert.equal(fake.entries.filter((entry) => entry.customType === RULE_PROPOSAL_ENTRY_TYPE).length, 1);
      assert.equal(runtime.modelCalls(), 1);
    });
  }
});

test("overflow success defers retro until agent_settled", async () => {
  const fake = createFakePi();
  registerPiRuleCompiler(fake.pi, {
    jevClient: new ValidFakeJev(),
    now: () => new Date("2026-09-18T12:10:00.000Z"),
  });
  const runtime = createRetroCapableContext(fake.entries);
  const event = compactionEvent(undefined, { reason: "overflow", willRetry: true });
  const result = requireCompactionResult(
    await fake.handlers.get("session_before_compact")?.(event, runtime.context),
  );
  const compactionEntry = appendSuccessfulCompaction(fake, result);

  await fake.handlers.get("session_compact")?.(
    { type: "session_compact", compactionEntry, fromExtension: true, reason: "overflow", willRetry: true },
    runtime.context,
  );
  assert.equal(runtime.modelCalls(), 0);
  assert.equal(fake.entries.filter((entry) => entry.customType === RETRO_PENDING_ENTRY_TYPE).length, 1);
  assert.equal(fake.entries.filter((entry) => entry.customType === RULE_PROPOSAL_ENTRY_TYPE).length, 0);
  const marker = parseRetroPendingMarker(
    fake.entries.find((entry) => entry.customType === RETRO_PENDING_ENTRY_TYPE)?.data,
  );
  assert.equal(marker.compactionReason, "overflow");
  assert.equal(marker.deferredUntilAgentSettled, true);

  await fake.handlers.get("agent_settled")?.({ type: "agent_settled" }, runtime.context);
  assert.equal(runtime.modelCalls(), 1);
  assert.equal(fake.entries.filter((entry) => entry.customType === RULE_PROPOSAL_ENTRY_TYPE).length, 1);
  await fake.handlers.get("agent_settled")?.({ type: "agent_settled" }, runtime.context);
  assert.equal(runtime.modelCalls(), 1);
});

test("missing key, timeout, malformed response, API failure, and unfittable state cancel without native fallback", async (t) => {
  const cases: Array<{
    name: string;
    options: Parameters<typeof registerPiRuleCompiler>[1];
    expectedDiagnostic: RegExp;
  }> = [
    { name: "missing key", options: { env: {}, hookTimeoutMs: 30 }, expectedDiagnostic: /missing TYPESAFE_API_KEY/ },
    {
      name: "timeout",
      options: { hookTimeoutMs: 10, jevClient: { evaluate: async () => new Promise<never>(() => undefined) } },
      expectedDiagnostic: /timed out/,
    },
    {
      name: "429 retry bounded by hook deadline",
      options: {
        hookTimeoutMs: 10,
        jevClient: { evaluate: async () => { throw new JevApiError(429, 1_000); } },
      },
      expectedDiagnostic: /timed out/,
    },
    {
      name: "malformed response",
      options: {
        jevClient: {
          evaluate: async (request: JevRequest) => ({ ...validJevResponse(request), unexpected: true }),
        },
      },
      expectedDiagnostic: /strict validation/,
    },
    {
      name: "API failure",
      options: { jevClient: { evaluate: async () => { throw new JevApiError(503); } } },
      expectedDiagnostic: /Jev request failed/,
    },
    {
      name: "unfittable state",
      options: { jevClient: new ValidFakeJev(), observation: { maxStateTokens: 1, minimumExcerptChars: 48 } },
      expectedDiagnostic: /exceeded configured bounds/,
    },
    {
      name: "impossible summary budget",
      options: { jevClient: new ValidFakeJev(), compaction: { maxSummaryChars: 20 } },
      expectedDiagnostic: /exceeded configured bounds/,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const fake = createFakePi();
      registerPiRuleCompiler(fake.pi, scenario.options);
      const { context, notifications } = createContext(fake.entries);
      const result = await fake.handlers.get("session_before_compact")?.(compactionEvent(), context);
      assert.deepEqual(result, { cancel: true });
      assert.equal(fake.entries.length, 0);
      assert.match(notifications.at(-1)?.message ?? "", scenario.expectedDiagnostic);
      assert.match(notifications.at(-1)?.message ?? "", /native fallback is disabled/);
    });
  }
});

test("an aborted compaction cancels without native fallback", async () => {
  const controller = new AbortController();
  controller.abort();
  const event = compactionEvent();
  event.signal = controller.signal;
  const fake = createFakePi();
  registerPiRuleCompiler(fake.pi, { jevClient: new ValidFakeJev() });
  const { context, notifications } = createContext(fake.entries);
  const result = await fake.handlers.get("session_before_compact")?.(event, context);
  assert.deepEqual(result, { cancel: true });
  assert.match(notifications.at(-1)?.message ?? "", /aborted/);
  assert.match(notifications.at(-1)?.message ?? "", /native fallback is disabled/);
});

test("an aborted compaction under RPC mode also emits a best-effort stderr diagnostic", async () => {
  const controller = new AbortController();
  controller.abort();
  const event = compactionEvent();
  event.signal = controller.signal;
  const fake = createFakePi();
  registerPiRuleCompiler(fake.pi, { jevClient: new ValidFakeJev() });
  const { context, notifications } = createContext(fake.entries, { mode: "rpc" });
  const stderr = captureStderr();
  let result: unknown;
  let stderrChunks: string[];
  try {
    result = await fake.handlers.get("session_before_compact")?.(event, context);
  } finally {
    stderrChunks = stderr.restore();
  }
  assert.deepEqual(result, { cancel: true });
  assert.match(notifications.at(-1)?.message ?? "", /aborted/);
  assert.equal(stderrChunks.length, 1);
  assert.match(stderrChunks[0] ?? "", /\[a4s-pi-rule-compiler:rpc-stdin-guard]/);
  assert.match(stderrChunks[0] ?? "", /compaction aborted under RPC mode/);
});

test("an aborted compaction outside RPC mode never writes the stderr diagnostic", async () => {
  const controller = new AbortController();
  controller.abort();
  const event = compactionEvent();
  event.signal = controller.signal;
  const fake = createFakePi();
  registerPiRuleCompiler(fake.pi, { jevClient: new ValidFakeJev() });
  const { context } = createContext(fake.entries, { mode: "tui" });
  const stderr = captureStderr();
  let stderrChunks: string[];
  try {
    await fake.handlers.get("session_before_compact")?.(event, context);
  } finally {
    stderrChunks = stderr.restore();
  }
  assert.deepEqual(stderrChunks, []);
});

test("a non-aborted cancel under RPC mode never writes the stderr diagnostic", async () => {
  const fake = createFakePi();
  registerPiRuleCompiler(fake.pi, { env: {}, hookTimeoutMs: 30 });
  const { context } = createContext(fake.entries, { mode: "rpc" });
  const stderr = captureStderr();
  let stderrChunks: string[];
  try {
    await fake.handlers.get("session_before_compact")?.(compactionEvent(), context);
  } finally {
    stderrChunks = stderr.restore();
  }
  assert.deepEqual(stderrChunks, []);
});

test("failed compaction clears pending work and never publishes signals", async () => {
  const jev = new ValidFakeJev();
  const fake = createFakePi();
  registerPiRuleCompiler(fake.pi, { jevClient: jev });
  const { context } = createContext(fake.entries);
  const event = compactionEvent();
  assert.ok(requireCompactionResult(await fake.handlers.get("session_before_compact")?.(event, context)));
  const callsBeforeFailure = jev.calls;
  await fake.handlers.get("session_compact_failed")?.(
    { type: "session_compact_failed", reason: "threshold", aborted: true, willRetry: false, fromExtension: true },
    context,
  );
  assert.equal(fake.entries.length, 0);
  assert.ok(requireCompactionResult(await fake.handlers.get("session_before_compact")?.(event, context)));
  assert.ok(jev.calls > callsBeforeFailure, "cleared pending work must be re-evaluated on retry");
});

test("large sessions evaluate every message once, cache pending work, and recover signals idempotently", async () => {
  const jev = new ValidFakeJev();
  const fake = createFakePi();
  registerPiRuleCompiler(fake.pi, {
    jevClient: jev,
    observation: { maxMessagesPerWindow: 32, maxQuestionsPerRequest: 10 },
    now: () => new Date("2026-09-18T12:30:00.000Z"),
  });
  const { context } = createContext(fake.entries);
  const messages = Array.from({ length: 70 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `Message ${index}: preserve deterministic validation evidence.`,
  }));
  const event = compactionEvent(messages);
  const first = requireCompactionResult(await fake.handlers.get("session_before_compact")?.(event, context));
  const actionQuestionIds = jev.requests.flatMap((request) =>
    Object.keys(request.questions).filter((id) => id.startsWith("compaction_action_")),
  );
  assert.equal(actionQuestionIds.length, 70);
  assert.equal(new Set(actionQuestionIds).size, 70);
  assert.equal(first.details.ruleSignalBatches.length, 3);
  assert.equal(first.details.decisions.length, 70);
  const calls = jev.calls;

  const cached = requireCompactionResult(await fake.handlers.get("session_before_compact")?.(event, context));
  assert.equal(cached.details.attemptId, first.details.attemptId);
  assert.equal(jev.calls, calls);

  const compactionEntry = appendSuccessfulCompaction(fake, first);
  await fake.handlers.get("session_compact")?.(
    { type: "session_compact", compactionEntry, fromExtension: true, reason: "threshold", willRetry: false },
    context,
  );
  assert.equal(fake.entries.filter((entry) => entry.customType === RULE_SIGNAL_ENTRY_TYPE).length, 3);

  const reloaded = createFakePi([compactionEntry]);
  registerPiRuleCompiler(reloaded.pi, { jevClient: new ValidFakeJev() });
  const reloadedContext = createContext(reloaded.entries).context;
  await reloaded.handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, reloadedContext);
  assert.equal(reloaded.entries.filter((entry) => entry.customType === RULE_SIGNAL_ENTRY_TYPE).length, 3);
  await reloaded.handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, reloadedContext);
  assert.equal(reloaded.entries.filter((entry) => entry.customType === RULE_SIGNAL_ENTRY_TYPE).length, 3);
});

test("retro failure preserves pending work and /retro-rules retries idempotently", async () => {
  const fake = createFakePi();
  registerPiRuleCompiler(fake.pi, {
    jevClient: new ValidFakeJev(),
    now: () => new Date("2026-09-18T13:30:00.000Z"),
  });
  const failing = createRetroCapableContext(fake.entries, { failModel: true });
  const event = compactionEvent();
  const result = requireCompactionResult(
    await fake.handlers.get("session_before_compact")?.(event, failing.context),
  );
  const compactionEntry = appendSuccessfulCompaction(fake, result);
  await fake.handlers.get("session_compact")?.(
    { type: "session_compact", compactionEntry, fromExtension: true, reason: "threshold", willRetry: false },
    failing.context,
  );

  assert.equal(fake.entries.filter((entry) => entry.customType === RULE_SIGNAL_ENTRY_TYPE).length, 1);
  assert.equal(fake.entries.filter((entry) => entry.customType === RETRO_PENDING_ENTRY_TYPE).length, 1);
  assert.equal(fake.entries.filter((entry) => entry.customType === RULE_PROPOSAL_ENTRY_TYPE).length, 0);

  const recovered = createRetroCapableContext(fake.entries);
  await fake.commands.get("retro-rules")?.("", recovered.context);
  assert.equal(fake.entries.filter((entry) => entry.customType === RULE_PROPOSAL_ENTRY_TYPE).length, 1);
  assert.equal(recovered.modelCalls(), 1);
  await fake.commands.get("retro-rules")?.("", recovered.context);
  assert.equal(fake.entries.filter((entry) => entry.customType === RULE_PROPOSAL_ENTRY_TYPE).length, 1);
  assert.equal(recovered.modelCalls(), 1);
});

test("reload recovers signals and pending retro without duplicate proposals", async () => {
  const source = createFakePi();
  registerPiRuleCompiler(source.pi, {
    jevClient: new ValidFakeJev(),
    now: () => new Date("2026-09-18T13:40:00.000Z"),
  });
  const sourceContext = createContext(source.entries).context;
  const result = requireCompactionResult(
    await source.handlers.get("session_before_compact")?.(compactionEvent(), sourceContext),
  );
  const compactionEntry = { type: "compaction", details: result.details };

  const reloaded = createFakePi([compactionEntry]);
  registerPiRuleCompiler(reloaded.pi, {
    jevClient: new ValidFakeJev(),
    now: () => new Date("2026-09-18T13:41:00.000Z"),
  });
  const runtime = createRetroCapableContext(reloaded.entries);
  await reloaded.handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, runtime.context);
  assert.equal(reloaded.entries.filter((entry) => entry.customType === RULE_SIGNAL_ENTRY_TYPE).length, 1);
  assert.equal(reloaded.entries.filter((entry) => entry.customType === RETRO_PENDING_ENTRY_TYPE).length, 1);
  await reloaded.handlers.get("agent_settled")?.({ type: "agent_settled" }, runtime.context);
  assert.equal(reloaded.entries.filter((entry) => entry.customType === RULE_PROPOSAL_ENTRY_TYPE).length, 1);

  await reloaded.handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, runtime.context);
  await reloaded.handlers.get("agent_settled")?.({ type: "agent_settled" }, runtime.context);
  assert.equal(reloaded.entries.filter((entry) => entry.customType === RULE_SIGNAL_ENTRY_TYPE).length, 1);
  assert.equal(reloaded.entries.filter((entry) => entry.customType === RETRO_PENDING_ENTRY_TYPE).length, 1);
  assert.equal(reloaded.entries.filter((entry) => entry.customType === RULE_PROPOSAL_ENTRY_TYPE).length, 1);
  assert.equal(runtime.modelCalls(), 1);
});

test("/retro-rules remains current-model synthesis plus Jev stage 2 and review-only", async () => {
  const batch = await observeCompactionRules(
    {
      messagesToSummarize: [{ role: "user", content: "Always run tests before completion." }],
      turnPrefixMessages: [],
    },
    { reason: "manual", willRetry: false, observedAt: "2026-09-18T14:00:00.000Z" },
    new ValidFakeJev(),
    new AbortController().signal,
  );
  const signal = batch.signals[0];
  assert.ok(signal);
  const fake = createFakePi([{ type: "custom", customType: RULE_SIGNAL_ENTRY_TYPE, data: batch }]);
  const stageTwoJev = new ValidFakeJev();
  registerPiRuleCompiler(fake.pi, { jevClient: stageTwoJev });
  const order: string[] = [];
  const notifications: string[] = [];
  const currentModel = { provider: "fake-provider", id: "current-model" };
  const context = {
    async waitForIdle() { order.push("idle"); },
    sessionManager: { getBranch: () => { order.push("read"); return fake.entries; } },
    model: currentModel,
    modelRegistry: {
      hasConfiguredAuth: () => true,
      async complete() {
        order.push("model");
        return {
          stopReason: "stop",
          content: [{
            type: "text",
            text: JSON.stringify({
              candidates: [{
                scope: { kind: "project", target: null },
                trigger: "before completion",
                obligation: "Run applicable tests.",
                exceptions: [],
                source_refs: [signal.id],
                proposed_check: { kind: "command", description: "Run tests.", command: "npm test" },
              }],
            }),
          }],
        };
      },
    },
    ui: { notify: (message: string) => notifications.push(message) },
  };
  await fake.commands.get("retro-rules")?.("", context);
  assert.equal(order[0], "idle");
  assert.equal(order.filter((step) => step === "model").length, 1);
  assert.ok(order.indexOf("model") > order.indexOf("read"));
  assert.equal(stageTwoJev.calls, 1);
  assert.equal(fake.entries.at(-1)?.customType, RULE_PROPOSAL_ENTRY_TYPE);
  assert.match(notifications.at(-1) ?? "", /Nothing was activated/);
});

test("/retro-rules fails closed when the current model is unavailable", async () => {
  const batch = await observeCompactionRules(
    { messagesToSummarize: [{ role: "user", content: "Preserve evidence." }], turnPrefixMessages: [] },
    { reason: "manual", willRetry: false, observedAt: "2026-09-18T14:10:00.000Z" },
    new ValidFakeJev(),
    new AbortController().signal,
  );
  const fake = createFakePi([{ type: "custom", customType: RULE_SIGNAL_ENTRY_TYPE, data: batch }]);
  registerPiRuleCompiler(fake.pi, { jevClient: new ValidFakeJev() });
  const notifications: string[] = [];
  await fake.commands.get("retro-rules")?.("", {
    waitForIdle: async () => undefined,
    sessionManager: { getBranch: () => fake.entries },
    model: undefined,
    modelRegistry: {},
    ui: { notify: (message: string) => notifications.push(message) },
  });
  assert.equal(fake.entries.length, 1);
  assert.match(notifications.at(-1) ?? "", /current Pi model is unavailable/);
});

test("registers a credential-only typesafe provider wired into /login", async () => {
  const fake = createFakePi();
  registerPiRuleCompiler(fake.pi, { jevClient: new ValidFakeJev() });
  assert.equal(fake.registeredProviders.length, 1);

  const provider = fake.registeredProviders[0] as {
    id: string;
    getModels(): unknown[];
    auth: {
      oauth?: unknown;
      apiKey: {
        login(interaction: { prompt(prompt: unknown): Promise<string> }): Promise<{ type: string; key: string }>;
        resolve(input: {
          credential?: { key?: string };
        }): Promise<{ auth: { apiKey: string }; source: string } | undefined>;
      };
    };
  };
  assert.equal(provider.id, TYPESAFE_PROVIDER_ID);
  assert.deepEqual(provider.getModels(), []);
  assert.equal(provider.auth.oauth, undefined);

  const prompts: unknown[] = [];
  const credential = await provider.auth.apiKey.login({
    prompt: async (prompt) => {
      prompts.push(prompt);
      return "typesafe-secret";
    },
  });
  assert.deepEqual(credential, { type: "api_key", key: "typesafe-secret" });
  assert.deepEqual(prompts, [{ type: "secret", message: "TypeSafe API key" }]);

  assert.equal(await provider.auth.apiKey.resolve({}), undefined);
  assert.deepEqual(await provider.auth.apiKey.resolve({ credential: { key: "typesafe-secret" } }), {
    auth: { apiKey: "typesafe-secret" },
    source: "stored API key",
  });
});

test("createTypesafeAuthResolver caches a resolved getProviderAuth result and prefers an explicit env override", async () => {
  let calls = 0;
  const ctx = {
    modelRegistry: {
      async getProviderAuth(provider: string) {
        calls += 1;
        assert.equal(provider, TYPESAFE_PROVIDER_ID);
        return { auth: { apiKey: "from-login" } };
      },
    },
  } as unknown as Parameters<ReturnType<typeof createTypesafeAuthResolver>>[0];

  const resolve = createTypesafeAuthResolver({ env: {} });
  assert.equal(await resolve(ctx), "from-login");
  assert.equal(await resolve(ctx), "from-login");
  assert.equal(calls, 1, "getProviderAuth must be cached after the first successful resolution");

  const envResolve = createTypesafeAuthResolver({ env: { TYPESAFE_API_KEY: "from-env" } });
  assert.equal(await envResolve(ctx), "from-env");
  assert.equal(calls, 1, "an explicit env override must short-circuit getProviderAuth entirely");
});

test("/rules-review explains that no rule observation exists", async () => {
  const message = await runRulesReview([]);
  assert.equal(message, "No stored rule proposals or rule observations. Run a successful compaction.");
});

test("/rules-review distinguishes filtered candidates from absent authority sources", async () => {
  const toolOnly = await batchFor(
    [
      { role: "toolResult", content: "SECRET_TOOL_SENTINEL" },
      { role: "bashExecution", content: "SECRET_BASH_SENTINEL" },
    ],
    new ValidFakeJev(),
    "latest",
  );
  assert.match(await runRulesReview([asSignalEntry(toolOnly)]), /no non-empty user or custom messages/i);

  const filtered = await batchFor(
    [{ role: "user", content: "Transient question only" }],
    new NoRuleSignalJev(),
    "latest",
  );
  const filteredMessage = await runRulesReview([asSignalEntry(filtered)]);
  assert.match(filteredMessage, /evaluated 1 rule candidate/i);
  assert.match(filteredMessage, /none passed the conservative filter/i);
  assert.doesNotMatch(filteredMessage, /Transient question|SECRET_TOOL_SENTINEL|SECRET_BASH_SENTINEL/);
  assert.doesNotMatch(filteredMessage, new RegExp(filtered.sourceDigest));
});

test("/rules-review aggregates every window of the latest attempt", async () => {
  const older = await batchFor([{ role: "user", content: "Older candidate" }], new ValidFakeJev(), "older");
  const latestFirst = await batchFor([{ role: "user", content: "Latest one" }], new NoRuleSignalJev(), "latest");
  const latestSecond = await batchFor([{ role: "custom", content: "Latest two" }], new NoRuleSignalJev(), "latest");
  const message = await runRulesReview([
    asSignalEntry(older),
    asSignalEntry(latestFirst),
    asSignalEntry(latestSecond),
  ]);
  assert.match(message, /evaluated 2 rule candidate/i);
  assert.match(message, /none passed the conservative filter/i);
});

test("/rules-review guides retry when signals exist but proposals do not", async () => {
  const batch = await batchFor(
    [{ role: "user", content: "Always run tests." }],
    new ValidFakeJev(),
    "latest",
  );
  const message = await runRulesReview([asSignalEntry(batch)]);
  assert.match(message, /recorded 1 RuleSignal/i);
  assert.match(message, /\/retro-rules/);
});

test("/rules-review identifies a completed retro batch with no candidates", async () => {
  const batch = await batchFor(
    [{ role: "user", content: "Always run deterministic tests." }],
    new ValidFakeJev(),
    "latest",
  );
  const message = await runRulesReview([asSignalEntry(batch), storedProposalEntry()]);
  assert.equal(
    message,
    "Latest retro completed: evaluated 1 rule candidate(s), synthesized no review-only candidates.",
  );
  assert.doesNotMatch(message, /\/rules-show|\/rules-accept/);
});

test("/rules-show treats an empty completed retro batch as having no proposals", async () => {
  const message = await runRuleCommand([storedProposalEntry()], "rules-show", "any-id");
  assert.equal(message, "No stored rule proposals. Run compaction or /retro-rules first.");
});

test("createTypesafeAuthResolver retries getProviderAuth until a credential is stored", async () => {
  let calls = 0;
  let stored: { auth: { apiKey: string } } | undefined;
  const ctx = {
    modelRegistry: {
      async getProviderAuth() {
        calls += 1;
        return stored;
      },
    },
  } as unknown as Parameters<ReturnType<typeof createTypesafeAuthResolver>>[0];

  const resolve = createTypesafeAuthResolver({ env: {} });
  assert.equal(await resolve(ctx), undefined);
  assert.equal(await resolve(ctx), undefined);
  assert.equal(calls, 2, "an unconfigured provider must be retried, never cached as absent");

  stored = { auth: { apiKey: "logged-in-key" } };
  assert.equal(await resolve(ctx), "logged-in-key");
  assert.equal(await resolve(ctx), "logged-in-key");
  assert.equal(calls, 3, "the successful resolution is cached going forward");
});
