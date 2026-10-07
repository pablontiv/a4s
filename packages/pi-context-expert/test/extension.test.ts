import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { convertToLlm, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piContextExpertExtension, {
  collectCorpus,
  corpusDigest,
  CORPUS_ENTRY_TYPE,
  DEFAULT_MAX_COMPACTION_CHARS,
  EVIDENCE_RECEIPT_ENTRY_TYPE,
  estimateJevTokens,
  JevApiError,
  LADDER_PROJECTION_FAILURE_TYPE,
  LADDER_PROJECTION_RECEIPT_TYPE,
  observeCompactionRules,
  registerPiContextExpert,
  RETRO_PENDING_ENTRY_TYPE,
  RULE_PROPOSAL_ENTRY_TYPE,
  RULE_SIGNAL_ENTRY_TYPE,
  stableDigest,
  stageCorpus,
  TRIGGER_DECISION_ENTRY_TYPE,
  type JevClient,
  type RuleSignalBatch,
  type JevCompactionResult,
  type JevRequest,
} from "../src/index.ts";
import { collectOperationalFailureReceipts } from "../src/storage.ts";
import { choiceAnswer, validJevResponse } from "./fixtures.ts";

type EventHandler = (event: unknown, context: unknown) => unknown;
type CommandHandler = (args: string, context: unknown) => Promise<void>;

interface StoredEntry {
  type: string;
  customType?: string;
  data?: unknown;
  details?: unknown;
  message?: unknown;
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
  // SAFETY: this test double implements every ExtensionAPI member exercised by registerPiContextExpert.
  return { pi: api as unknown as ExtensionAPI, handlers, commands, entries, registeredProviders };
}

function createContext(
  entries: StoredEntry[],
  options: {
    mode?: "tui" | "rpc";
    editorText?: string;
    editorReadFails?: boolean;
    projectionEntries?: Array<{ sourceEntry: { type: string }; messages: unknown[] }>;
  } = {},
) {
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  const context = {
    mode: options.mode ?? "tui",
    ui: {
      getEditorText: () => {
        if (options.editorReadFails) throw new Error("editor unavailable");
        return options.editorText ?? "";
      },
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
    },
    sessionManager: {
      getEntries: () => entries,
      getBranch: () => entries,
      buildSessionProjection: () => ({
        entries: options.projectionEntries ?? [],
        messages: (options.projectionEntries ?? []).flatMap((entry) => entry.messages),
      }),
    },
    modelRegistry: {
      async getProviderAuth(_provider: string) {
        return undefined;
      },
    },
    compact: () => undefined,
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

function compactableToolMessages(
  resultText = "tool result ".repeat(200),
  toolCallId = "call-1",
  path = "src/file.ts",
): unknown[] {
  return [
    { role: "user", content: "Inspect the file.", timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Reading the file." },
        { type: "toolCall", id: toolCallId, name: "read", arguments: { path } },
      ],
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId,
      toolName: "read",
      content: [{ type: "text", text: resultText }],
      isError: false,
      timestamp: 3,
    },
    { role: "user", content: "Continue.", timestamp: 4 },
  ];
}

function compactionEvent(
  messages: unknown[] = [{ role: "user", content: "Always run deterministic tests." }],
  lifecycle: {
    reason?: "manual" | "threshold" | "overflow";
    willRetry?: boolean;
    turnPrefixMessages?: unknown[];
    isSplitTurn?: boolean;
  } = {},
) {
  return {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "kept-entry",
      messagesToSummarize: messages,
      turnPrefixMessages: lifecycle.turnPrefixMessages ?? [],
      isSplitTurn: lifecycle.isSplitTurn ?? false,
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

class CompactTriggerJev extends ValidFakeJev {
  override async evaluate(request: JevRequest): Promise<unknown> {
    this.calls += 1;
    this.requests.push(request);
    assert.deepEqual(Object.keys(request.questions), ["done", "shape"]);
    return validJevResponse(request);
  }
}

class WaitTriggerJev extends ValidFakeJev {
  override async evaluate(request: JevRequest): Promise<unknown> {
    this.calls += 1;
    this.requests.push(request);
    return validJevResponse(request, (id, question) => {
      if (question.type !== "choice") return undefined;
      return choiceAnswer(
        Object.keys(question.criteria),
        id === "done" ? "not_finished" : "coordinating",
      );
    });
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

function hasRuleArtifact(entries: readonly StoredEntry[]): boolean {
  return entries.some((entry) =>
    entry.customType === RULE_SIGNAL_ENTRY_TYPE ||
    entry.customType === RULE_PROPOSAL_ENTRY_TYPE ||
    entry.customType === RETRO_PENDING_ENTRY_TYPE,
  );
}

class LadderFullJev extends ValidFakeJev {
  override async evaluate(request: JevRequest): Promise<unknown> {
    this.calls += 1;
    this.requests.push(request);
    return validJevResponse(request, (_id, question) =>
      question.type === "choice" && Object.hasOwn(question.criteria, "full")
        ? {
          type: "choice",
          choice: "full",
          probabilities: Object.fromEntries(
            Object.keys(question.criteria).map((level) => [level, level === "full" ? 1 : 0]),
          ),
          confidence: 1,
        }
        : undefined,
    );
  }
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
  registerPiContextExpert(fake.pi, { jevClient: new ValidFakeJev() });
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

test("basic does not publish rule artifacts when Evidence is off", async () => {
  const jev = new ValidFakeJev();
  const fake = createFakePi();
  registerPiContextExpert(fake.pi, {
    jevClient: jev,
    evidence: { strategy: "off" },
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
  if ("schema" in compaction.details) assert.fail("expected HostBinding details");
  assert.deepEqual(compaction.details.fastJev.decisions, []);
  assert.match(compaction.summary, /^<compacted-conversation engine="a4s-context-expert">/);
  assert.doesNotMatch(JSON.stringify(compaction), /private-fixture-value|alice@example\.com/);
  assert.equal(fake.entries.length, 0, "before hook must not publish RuleSignals");

  const compactionEntry = appendSuccessfulCompaction(fake, compaction);
  await fake.handlers.get("session_compact")?.(
    { type: "session_compact", compactionEntry, fromExtension: true, reason: "threshold", willRetry: false },
    context,
  );
  assert.equal(hasRuleArtifact(fake.entries), false);
  assert.equal(notifications.some((notification) => /compaction succeeded/.test(notification.message)), false);

  await fake.handlers.get("session_compact")?.(
    { type: "session_compact", compactionEntry, fromExtension: true, reason: "threshold", willRetry: false },
    context,
  );
  assert.equal(hasRuleArtifact(fake.entries), false);
});

test("a long session without tool calls bounds the summary and persisted details", async () => {
  const jev = new ValidFakeJev();
  const fake = createFakePi();
  registerPiContextExpert(fake.pi, { jevClient: jev });
  const { context } = createContext(fake.entries);
  const messages = Array.from({ length: 80 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `LONG-${index} ${"content ".repeat(1_500)}`,
  }));

  const compaction = requireCompactionResult(
    await fake.handlers.get("session_before_compact")?.(compactionEvent(messages), context),
  );

  assert.equal(jev.calls, 0);
  assert.ok(compaction.summary.length <= DEFAULT_MAX_COMPACTION_CHARS);
  assert.ok(JSON.stringify(compaction.details).length <= DEFAULT_MAX_COMPACTION_CHARS);
  assert.match(compaction.summary, / …\[truncated\]… /);
  if ("schema" in compaction.details) assert.fail("expected HostBinding details");
  assert.equal(compaction.details.fastJev.messages.length, messages.length);
  assert.ok(compaction.details.summary.budgetTruncatedMessages > 0);
});

test("split-turn compaction pins every converted turn prefix message", async () => {
  const oldMessages = compactableToolMessages("old result ".repeat(100), "old-call", "old.ts");
  const turnPrefixMessages = compactableToolMessages(
    "recent result must remain",
    "recent-call",
    "recent.ts",
  ).slice(0, 3);
  const jev: JevClient = {
    async evaluate(request) {
      return validJevResponse(request, (_id, question) =>
        question.type === "noul" ? { type: "noul", noul: 0 } : undefined
      );
    },
  };
  const fake = createFakePi();
  registerPiContextExpert(fake.pi, { jevClient: jev });
  const { context } = createContext(fake.entries);
  const event = compactionEvent(oldMessages, {
    turnPrefixMessages,
    isSplitTurn: true,
  });

  const compaction = requireCompactionResult(
    await fake.handlers.get("session_before_compact")?.(event, context),
  );

  assert.equal(compaction.firstKeptEntryId, event.preparation.firstKeptEntryId);
  assert.match(compaction.summary, /recent\.ts/);
  assert.match(compaction.summary, /recent result must remain/);
  assert.doesNotMatch(compaction.summary, /old\.ts|old result/);
  if ("schema" in compaction.details) assert.fail("expected HostBinding details");
  assert.deepEqual(
    compaction.details.fastJev.decisions.map((decision) => [decision.reason, decision.source]),
    [["call_dropped", "jev"], ["pinned", "pinned"]],
  );
  const recent = compaction.details.fastJev.decisions[1];
  assert.ok(recent);
  assert.equal("keepCall" in recent, false);
  assert.equal("keepResult" in recent, false);
});

test("a cancelled compaction publishes no corpus while a successful one is reloadable", async () => {
  const fake = createFakePi();
  registerPiContextExpert(fake.pi, { jevClient: new ValidFakeJev() });
  const { context } = createContext(fake.entries);
  const event = compactionEvent([{ role: "user", content: "password=canary-secret" }]);

  assert.ok(requireCompactionResult(await fake.handlers.get("session_before_compact")?.(event, context)));
  await fake.handlers.get("session_compact_failed")?.(
    { type: "session_compact_failed", reason: "threshold", aborted: true, willRetry: false, fromExtension: true },
    context,
  );
  assert.deepEqual(fake.entries.filter((entry) => entry.customType === CORPUS_ENTRY_TYPE), []);

  const result = requireCompactionResult(await fake.handlers.get("session_before_compact")?.(event, context));
  const compactionEntry = appendSuccessfulCompaction(fake, result);
  await fake.handlers.get("session_compact")?.(
    { type: "session_compact", compactionEntry, fromExtension: true, reason: "threshold", willRetry: false },
    context,
  );
  assert.equal(fake.entries.filter((entry) => entry.customType === CORPUS_ENTRY_TYPE).length, 2);
  assert.equal(JSON.stringify(fake.entries).includes("canary-secret"), false);

  const reloaded = createFakePi(fake.entries);
  registerPiContextExpert(reloaded.pi, { jevClient: new ValidFakeJev() });
  const reloadedContext = createContext(reloaded.entries).context;
  await reloaded.handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, reloadedContext);
  assert.equal(collectCorpus(reloaded.entries).length, 1);
  await reloaded.handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, reloadedContext);
  assert.equal(reloaded.entries.filter((entry) => entry.customType === CORPUS_ENTRY_TYPE).length, 2);
});

test("el fallo de publicación del corpus guarda un receipt y conserva la compactación", async () => {
  const fake = createFakePi();
  const originalAppend = fake.pi.appendEntry.bind(fake.pi);
  let failCorpus = true;
  Object.defineProperty(fake.pi, "appendEntry", {
    value(customType: string, data: unknown) {
      if (customType === CORPUS_ENTRY_TYPE && failCorpus) {
        failCorpus = false;
        throw new Error("path=/private/corpus password=private-corpus-error");
      }
      return originalAppend(customType, data);
    },
  });
  registerPiContextExpert(fake.pi, {
    jevClient: new ValidFakeJev(),
    now: () => new Date("2026-09-22T12:01:00.000Z"),
  });
  const { context } = createContext(fake.entries);
  const result = requireCompactionResult(
    await fake.handlers.get("session_before_compact")?.(
      compactionEvent([{ role: "user", content: "password=private-corpus-source" }]),
      context,
    ),
  );
  const compactionEntry = appendSuccessfulCompaction(fake, result);

  await fake.handlers.get("session_compact")?.(
    { type: "session_compact", compactionEntry, fromExtension: true, reason: "manual", willRetry: false },
    context,
  );
  await fake.handlers.get("session_compact")?.(
    { type: "session_compact", compactionEntry, fromExtension: true, reason: "manual", willRetry: false },
    context,
  );

  assert.deepEqual(collectOperationalFailureReceipts(fake.entries), [{
    schema: "a4s.operational-failure/v1",
    timestamp: "2026-09-22T12:01:00.000Z",
    phase: "corpus",
    code: "storage_failure",
    attemptId: result.details.attemptId,
    reason: "manual",
    willRetry: false,
  }]);
  assert.equal(fake.entries.includes(compactionEntry), true);
  assert.doesNotMatch(JSON.stringify(collectOperationalFailureReceipts(fake.entries)), /private-corpus/);
});

test("el fallo de Evidence guarda un receipt sin publicar artefactos", async () => {
  const jev: JevClient = {
    async evaluate(request) {
      if ((request.state as { profile?: unknown }).profile === "conservative-evidence") {
        throw new Error("transcript=private-evidence-error");
      }
      return validJevResponse(request);
    },
  };
  const fake = createFakePi();
  registerPiContextExpert(fake.pi, {
    jevClient: jev,
    config: {
      "compaction.strategy": "ladder",
      "trigger.mode": "off",
      "evidence.strategy": "ladder",
    },
    now: () => new Date("2026-09-22T12:02:00.000Z"),
  });
  const { context } = createContext(fake.entries);
  const result = requireCompactionResult(
    await fake.handlers.get("session_before_compact")?.(compactionEvent(), context),
  );
  const compactionEntry = appendSuccessfulCompaction(fake, result);

  await fake.handlers.get("session_compact")?.(
    { type: "session_compact", compactionEntry, fromExtension: true, reason: "threshold", willRetry: false },
    context,
  );

  assert.deepEqual(collectOperationalFailureReceipts(fake.entries), [{
    schema: "a4s.operational-failure/v1",
    timestamp: "2026-09-22T12:02:00.000Z",
    phase: "evidence",
    code: "internal_failure",
    attemptId: result.details.attemptId,
    reason: "threshold",
    willRetry: false,
  }]);
  assert.equal(fake.entries.some((entry) => entry.customType === EVIDENCE_RECEIPT_ENTRY_TYPE), false);
  assert.equal(fake.entries.some((entry) => entry.customType === RULE_SIGNAL_ENTRY_TYPE), false);
  assert.doesNotMatch(JSON.stringify(collectOperationalFailureReceipts(fake.entries)), /private-evidence/);
});

test("basic does not register or consume Ladder context projection", () => {
  const fake = createFakePi();
  registerPiContextExpert(fake.pi, { jevClient: new ValidFakeJev() });

  assert.equal(fake.handlers.has("context_with_system"), false);
});

test("installed entrypoint reads only the fixed global configuration path at startup", (t) => {
  const home = mkdtempSync(join(tmpdir(), "a4s-context-expert-home-"));
  const priorHome = process.env.HOME;
  const rejectedEnvironmentName = "A4S_PI_RULE_COMPILER_COMPACTION_STRATEGY";
  const priorRejectedEnvironment = process.env[rejectedEnvironmentName];
  t.after(() => {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorRejectedEnvironment === undefined) delete process.env[rejectedEnvironmentName];
    else process.env[rejectedEnvironmentName] = priorRejectedEnvironment;
    rmSync(home, { recursive: true, force: true });
  });
  process.env.HOME = home;
  process.env[rejectedEnvironmentName] = "ladder";

  const missing = createFakePi();
  piContextExpertExtension(missing.pi);
  assert.equal(missing.handlers.has("context_with_system"), false);

  const configDirectory = join(home, ".pi", "agent");
  mkdirSync(configDirectory, { recursive: true });
  const ladderConfig = JSON.stringify({
    "compaction.strategy": "ladder",
    "trigger.mode": "off",
    "evidence.strategy": "off",
  });
  writeFileSync(join(configDirectory, "pi-rule-compiler.json"), ladderConfig);

  const legacyOnly = createFakePi();
  piContextExpertExtension(legacyOnly.pi);
  assert.equal(legacyOnly.handlers.has("context_with_system"), false);

  writeFileSync(join(configDirectory, "pi-context-expert.json"), ladderConfig);
  const configured = createFakePi();
  piContextExpertExtension(configured.pi);
  assert.equal(configured.handlers.has("context_with_system"), true);
});

test("Ladder projects branch corpus through context_with_system and falls back unchanged on failure", async () => {
  const chunk = stageCorpus([
    { index: 2, role: "user", text: "durable ladder corpus material", sourceDigest: stableDigest({ source: "ladder" }), redactionCount: 0 },
  ])[0];
  assert.ok(chunk);
  const entries: StoredEntry[] = [{ type: "custom", customType: CORPUS_ENTRY_TYPE, data: chunk }];
  const selected = createFakePi(entries);
  const selectedJev = new LadderFullJev();
  registerPiContextExpert(selected.pi, {
    jevClient: selectedJev,
    config: { "compaction.strategy": "ladder" },
  });
  const selectedContext = createContext(selected.entries).context;
  const emptyUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const supplied = [
    { role: "system", content: "Pi normal", timestamp: 0 },
    { role: "user", content: "retrieve ladder corpus", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "text", text: "checking" }],
      api: "test",
      provider: "test",
      model: "test",
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "result" }],
      isError: false,
      timestamp: 3,
    },
  ];
  const initialSupplied = supplied.slice(0, 2);
  const selectedResult = await selected.handlers.get("context_with_system")?.(
    { type: "context_with_system", messages: initialSupplied },
    selectedContext,
  );

  assert.equal(selectedJev.calls, 1);
  assert.ok(selectedResult && typeof selectedResult === "object" && "messages" in selectedResult);
  const initialProjected = (selectedResult as {
    messages: Array<{ role: string; content: string; customType?: string }>;
  }).messages;
  assert.equal(initialProjected.length, 3);
  assert.deepEqual(initialProjected.slice(0, 2), initialSupplied);
  assert.equal(initialProjected[2]?.role, "custom");
  assert.equal(initialProjected[2]?.customType, "a4s.ladder-context/v1");
  assert.match(initialProjected[2]?.content ?? "", /^\[a4s ladder context\]/);

  const continuedResult = await selected.handlers.get("context_with_system")?.(
    { type: "context_with_system", messages: supplied },
    selectedContext,
  );
  assert.equal(selectedJev.calls, 1);
  const projected = (continuedResult as {
    messages: Array<{ role: string; content: string; customType?: string }>;
  }).messages;
  assert.equal(projected.length, 5);
  assert.deepEqual(projected.slice(0, 3), initialProjected);
  assert.deepEqual(projected.slice(3), supplied.slice(2));
  assert.deepEqual(supplied[0], { role: "system", content: "Pi normal", timestamp: 0 });

  const converted = convertToLlm(projected as Parameters<typeof convertToLlm>[0]);
  assert.deepEqual(converted.map((message) => message.role), ["system", "user", "user", "assistant", "toolResult"]);
  assert.equal(converted[0]?.content, "Pi normal");

  const receipts = selected.entries.filter((entry) => entry.customType === LADDER_PROJECTION_RECEIPT_TYPE);
  assert.equal(receipts.length, 2);
  const firstReceipt = receipts[0]?.data as Record<string, unknown>;
  const cachedReceipt = receipts[1]?.data as Record<string, unknown>;
  assert.equal(firstReceipt.schema, "a4s.ladder-projection-receipt/v1");
  assert.equal(firstReceipt.cacheHit, false);
  assert.equal(cachedReceipt.cacheHit, true);
  assert.equal(firstReceipt.selectedChunks, 1);
  assert.equal(firstReceipt.sourceChunks, 1);
  assert.equal(firstReceipt.candidateChunks, 1);
  assert.equal(firstReceipt.shortlistStrategy, "full");
  assert.equal(firstReceipt.rendered, true);
  assert.equal(cachedReceipt.projectionDigest, firstReceipt.projectionDigest);
  assert.equal(cachedReceipt.queryDigest, firstReceipt.queryDigest);
  assert.equal(cachedReceipt.corpusDigest, firstReceipt.corpusDigest);
  assert.doesNotMatch(JSON.stringify(receipts), /durable ladder corpus material|retrieve ladder corpus/);

  const failing = createFakePi(entries);
  let failingCalls = 0;
  registerPiContextExpert(failing.pi, {
    jevClient: {
      evaluate: async () => {
        failingCalls += 1;
        throw new Error("Jev failed with private details");
      },
    },
    config: { "compaction.strategy": "ladder" },
  });
  const failingContext = createContext(failing.entries).context;
  const failedResult = await failing.handlers.get("context_with_system")?.(
    { type: "context_with_system", messages: supplied },
    failingContext,
  );
  const repeatedFailure = await failing.handlers.get("context_with_system")?.(
    { type: "context_with_system", messages: supplied },
    failingContext,
  );
  assert.deepEqual(failedResult, { messages: supplied });
  assert.deepEqual(repeatedFailure, { messages: supplied });
  assert.equal(failingCalls, 1);
  assert.equal(
    failing.entries.some((entry) => entry.customType === LADDER_PROJECTION_RECEIPT_TYPE),
    false,
  );
  const failures = failing.entries.filter((entry) => entry.customType === LADDER_PROJECTION_FAILURE_TYPE);
  assert.equal(failures.length, 1);
  assert.deepEqual(failures[0]?.data, {
    schema: "a4s.ladder-projection-failure/v1",
    candidateChunks: 1,
    code: "internal_failure",
    corpusDigest: corpusDigest([chunk]),
    queryDigest: stableDigest("retrieve ladder corpus"),
    sourceChunks: 1,
    stage: "evaluate",
  });
  assert.doesNotMatch(JSON.stringify(failures), /private details|durable ladder corpus material|retrieve ladder corpus/);
});

test("Ladder bounds a live-scale corpus before Jev evaluation", async () => {
  const chunks = stageCorpus(Array.from({ length: 180 }, (_, index) => ({
    index,
    role: index % 2 === 0 ? "user" : "assistant",
    text: index === 7
      ? `rare migration needle ${"a".repeat(1_200)}`
      : `routine historical material ${index} ${"b".repeat(1_200)}`,
    sourceDigest: stableDigest({ source: `large-${index}` }),
    redactionCount: 0,
  })));
  assert.equal(chunks.length, 180);
  const entries: StoredEntry[] = chunks.map((item) => ({
    type: "custom",
    customType: CORPUS_ENTRY_TYPE,
    data: item,
  }));
  const fake = createFakePi(entries);
  const jev = new LadderFullJev();
  registerPiContextExpert(fake.pi, {
    jevClient: jev,
    config: { "compaction.strategy": "ladder" },
  });
  const messages = [
    { role: "system", content: "Pi normal", timestamp: 0 },
    { role: "user", content: "rare migration needle", timestamp: 1 },
  ];

  const result = await fake.handlers.get("context_with_system")?.(
    { type: "context_with_system", messages },
    createContext(fake.entries).context,
  );

  assert.equal(jev.calls, 1);
  const request = jev.requests[0];
  assert.ok(request);
  const requestCorpus = (request.state as { corpus?: Array<{ id: string; text: string }> }).corpus ?? [];
  assert.ok(requestCorpus.length > 0 && requestCorpus.length <= 48);
  assert.equal(Object.keys(request.questions).length, requestCorpus.length);
  assert.ok(estimateJevTokens(JSON.stringify(request)) <= 30_000);
  assert.ok(requestCorpus.some((item) => item.text.includes("rare migration needle")));
  assert.ok(result && typeof result === "object" && "messages" in result);
  const receipt = fake.entries.find((entry) => entry.customType === LADDER_PROJECTION_RECEIPT_TYPE)?.data as
    | Record<string, unknown>
    | undefined;
  assert.ok(receipt);
  assert.equal(receipt.sourceChunks, 180);
  assert.equal(receipt.candidateChunks, requestCorpus.length);
  assert.equal(receipt.shortlistStrategy, "lexical-recency");
  assert.equal(typeof receipt.estimatedStateTokens, "number");
  assert.ok((receipt.estimatedStateTokens as number) <= 20_000);
});

test("Ladder reports an unfittable shortlist without calling Jev", async () => {
  const chunk = stageCorpus([{
    index: 1,
    role: "user",
    text: "durable oversized shortlist material",
    sourceDigest: stableDigest({ source: "oversized-shortlist" }),
    redactionCount: 0,
  }])[0];
  assert.ok(chunk);
  const fake = createFakePi([{ type: "custom", customType: CORPUS_ENTRY_TYPE, data: chunk }]);
  const jev = new LadderFullJev();
  registerPiContextExpert(fake.pi, {
    jevClient: jev,
    config: { "compaction.strategy": "ladder" },
    ladder: { maxStateTokens: 1 },
  });
  const messages = [
    { role: "system", content: "Pi normal", timestamp: 0 },
    { role: "user", content: "retrieve material", timestamp: 1 },
  ];

  const result = await fake.handlers.get("context_with_system")?.(
    { type: "context_with_system", messages },
    createContext(fake.entries).context,
  );

  assert.deepEqual(result, { messages });
  assert.equal(jev.calls, 0);
  const failure = fake.entries.find((entry) => entry.customType === LADDER_PROJECTION_FAILURE_TYPE)?.data as
    | Record<string, unknown>
    | undefined;
  assert.ok(failure);
  assert.equal(failure.code, "oversized_state");
  assert.equal(failure.stage, "shortlist");
  assert.equal(failure.sourceChunks, 1);
});

test("Ladder projection cache invalidates on query, corpus, and session changes", async () => {
  const firstChunk = stageCorpus([
    {
      index: 1,
      role: "user",
      text: "first durable fact",
      sourceDigest: stableDigest({ source: "first" }),
      redactionCount: 0,
    },
  ])[0];
  assert.ok(firstChunk);
  const entries: StoredEntry[] = [{ type: "custom", customType: CORPUS_ENTRY_TYPE, data: firstChunk }];
  const fake = createFakePi(entries);
  const jev = new LadderFullJev();
  registerPiContextExpert(fake.pi, {
    jevClient: jev,
    config: { "compaction.strategy": "ladder" },
  });
  const context = createContext(fake.entries).context;
  const project = async (query: string) => fake.handlers.get("context_with_system")?.(
    {
      type: "context_with_system",
      messages: [
        { role: "system", content: "Pi normal", timestamp: 0 },
        { role: "user", content: query, timestamp: 1 },
      ],
    },
    context,
  );

  await project("query one");
  await project("query one");
  assert.equal(jev.calls, 1);

  await project("query two");
  assert.equal(jev.calls, 2);

  const secondChunk = stageCorpus([
    {
      index: 2,
      role: "assistant",
      text: "second durable fact",
      sourceDigest: stableDigest({ source: "second" }),
      redactionCount: 0,
    },
  ])[0];
  assert.ok(secondChunk);
  fake.entries.push({ type: "custom", customType: CORPUS_ENTRY_TYPE, data: secondChunk });
  await project("query two");
  assert.equal(jev.calls, 3);

  fake.handlers.get("session_start")?.({ type: "session_start" }, context);
  await project("query two");
  assert.equal(jev.calls, 4);

  const receipts = fake.entries
    .filter((entry) => entry.customType === LADDER_PROJECTION_RECEIPT_TYPE)
    .map((entry) => entry.data as Record<string, unknown>);
  assert.deepEqual(receipts.map((receipt) => receipt.cacheHit), [false, true, false, false, false]);
  assert.equal(receipts[0]?.queryDigest, receipts[1]?.queryDigest);
  assert.notEqual(receipts[1]?.queryDigest, receipts[2]?.queryDigest);
  assert.notEqual(receipts[2]?.corpusDigest, receipts[3]?.corpusDigest);
  assert.equal(receipts[3]?.projectionDigest, receipts[4]?.projectionDigest);
});

test("Evidence ladder requires both flags and publishes only after successful compaction", async () => {
  const singlyEnabled = createFakePi();
  registerPiContextExpert(singlyEnabled.pi, {
    jevClient: new ValidFakeJev(),
    evidence: { strategy: "ladder" },
  });
  const singleContext = createContext(singlyEnabled.entries).context;
  const singleCompaction = requireCompactionResult(
    await singlyEnabled.handlers.get("session_before_compact")?.(compactionEvent(), singleContext),
  );
  const singleEntry = appendSuccessfulCompaction(singlyEnabled, singleCompaction);
  await singlyEnabled.handlers.get("session_compact")?.(
    { type: "session_compact", compactionEntry: singleEntry, fromExtension: true, reason: "threshold", willRetry: false },
    singleContext,
  );
  assert.equal(hasRuleArtifact(singlyEnabled.entries), false);

  const enabled = createFakePi();
  const jev = new LadderFullJev();
  registerPiContextExpert(enabled.pi, {
    jevClient: jev,
    config: {
      "compaction.strategy": "ladder",
      "trigger.mode": "off",
      "evidence.strategy": "ladder",
    },
  });
  const enabledContext = createContext(enabled.entries).context;
  const compaction = requireCompactionResult(
    await enabled.handlers.get("session_before_compact")?.(compactionEvent(), enabledContext),
  );
  assert.equal(hasRuleArtifact(enabled.entries), false);
  const compactionEntry = appendSuccessfulCompaction(enabled, compaction);
  await enabled.handlers.get("session_compact")?.(
    { type: "session_compact", compactionEntry, fromExtension: true, reason: "threshold", willRetry: false },
    enabledContext,
  );

  assert.equal(enabled.entries.filter((entry) => entry.customType === RULE_SIGNAL_ENTRY_TYPE).length, 1);
  assert.equal(enabled.entries.filter((entry) => entry.customType === RETRO_PENDING_ENTRY_TYPE).length, 1);
  assert.equal(enabled.entries.filter((entry) => entry.customType === EVIDENCE_RECEIPT_ENTRY_TYPE).length, 1);
  assert.equal(enabled.entries.filter((entry) => entry.customType === CORPUS_ENTRY_TYPE).length, 2);
  assert.equal(jev.requests.filter((request) => (request.state as { profile?: unknown }).profile === "conservative-evidence").length, 1);

  await enabled.handlers.get("session_compact")?.(
    { type: "session_compact", compactionEntry, fromExtension: true, reason: "threshold", willRetry: false },
    enabledContext,
  );
  assert.equal(enabled.entries.filter((entry) => entry.customType === RULE_SIGNAL_ENTRY_TYPE).length, 1);
  assert.equal(enabled.entries.filter((entry) => entry.customType === EVIDENCE_RECEIPT_ENTRY_TYPE).length, 1);
});

test("Evidence success stores a review-only proposal idempotently", async () => {
  const fake = createFakePi();
  const jev = new LadderFullJev();
  registerPiContextExpert(fake.pi, {
    jevClient: jev,
    config: {
      "compaction.strategy": "ladder",
      "trigger.mode": "off",
      "evidence.strategy": "ladder",
    },
    now: () => new Date("2026-09-22T12:00:00.000Z"),
  });
  const runtime = createRetroCapableContext(fake.entries);
  const compaction = requireCompactionResult(
    await fake.handlers.get("session_before_compact")?.(compactionEvent(), runtime.context),
  );
  const compactionEntry = appendSuccessfulCompaction(fake, compaction);
  await fake.handlers.get("session_compact")?.(
    { type: "session_compact", compactionEntry, fromExtension: true, reason: "manual", willRetry: false },
    runtime.context,
  );

  assert.equal(fake.entries.filter((entry) => entry.customType === RULE_PROPOSAL_ENTRY_TYPE).length, 1);
  assert.equal(runtime.modelCalls(), 1);
  assert.match(runtime.notifications.at(-1)?.message ?? "", /Nothing was activated/);
  await fake.commands.get("retro-rules")?.("", runtime.context);
  assert.equal(fake.entries.filter((entry) => entry.customType === RULE_PROPOSAL_ENTRY_TYPE).length, 1);
  assert.equal(runtime.modelCalls(), 1);
});

test("overflow Evidence defers review-only proposal synthesis until agent_settled", async () => {
  const fake = createFakePi();
  registerPiContextExpert(fake.pi, {
    jevClient: new LadderFullJev(),
    config: {
      "compaction.strategy": "ladder",
      "trigger.mode": "off",
      "evidence.strategy": "ladder",
    },
  });
  const runtime = createRetroCapableContext(fake.entries);
  const compaction = requireCompactionResult(
    await fake.handlers.get("session_before_compact")?.(
      compactionEvent(undefined, { reason: "overflow", willRetry: true }),
      runtime.context,
    ),
  );
  const compactionEntry = appendSuccessfulCompaction(fake, compaction);
  await fake.handlers.get("session_compact")?.(
    { type: "session_compact", compactionEntry, fromExtension: true, reason: "overflow", willRetry: true },
    runtime.context,
  );
  assert.equal(fake.entries.filter((entry) => entry.customType === RULE_PROPOSAL_ENTRY_TYPE).length, 0);
  assert.equal(runtime.modelCalls(), 0);

  await fake.handlers.get("agent_settled")?.({ type: "agent_settled" }, runtime.context);
  assert.equal(fake.entries.filter((entry) => entry.customType === RULE_PROPOSAL_ENTRY_TYPE).length, 1);
  assert.equal(runtime.modelCalls(), 1);
});

test("basic success never publishes RuleSignals or starts retro", async (t) => {
  for (const reason of ["manual", "threshold", "overflow"] as const) {
    await t.test(reason, async () => {
      const fake = createFakePi();
      registerPiContextExpert(fake.pi, { jevClient: new ValidFakeJev() });
      const runtime = createRetroCapableContext(fake.entries);
      const result = requireCompactionResult(
        await fake.handlers.get("session_before_compact")?.(
          compactionEvent(undefined, { reason, willRetry: reason === "overflow" }),
          runtime.context,
        ),
      );
      const compactionEntry = appendSuccessfulCompaction(fake, result);
      await fake.handlers.get("session_compact")?.(
        {
          type: "session_compact",
          compactionEntry,
          fromExtension: true,
          reason,
          willRetry: reason === "overflow",
        },
        runtime.context,
      );
      assert.equal(hasRuleArtifact(fake.entries), false);
      assert.equal(runtime.modelCalls(), 0);
    });
  }
});

test("compaction failures return undefined and activate the native fallback", async (t) => {
  const priorKey = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  t.after(() => {
    if (priorKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = priorKey;
  });
  const cases: Array<{
    name: string;
    options: Parameters<typeof registerPiContextExpert>[1];
    expectedCode: "missing_key" | "timeout" | "malformed_response" | "api_failure" | "internal_failure";
    expectedDiagnostic: RegExp;
  }> = [
    {
      name: "missing credential",
      options: { hookTimeoutMs: 30 },
      expectedCode: "missing_key",
      expectedDiagnostic: /TypeSafe credentials/,
    },
    {
      name: "timeout",
      options: { hookTimeoutMs: 10, jevClient: { evaluate: async () => new Promise<never>(() => undefined) } },
      expectedCode: "timeout",
      expectedDiagnostic: /timed out/,
    },
    {
      name: "HTTP failure",
      options: { jevClient: { evaluate: async () => { throw new JevApiError(503); } } },
      expectedCode: "api_failure",
      expectedDiagnostic: /Jev request failed/,
    },
    {
      name: "invalid response",
      options: {
        jevClient: {
          evaluate: async (request: JevRequest) => ({ ...validJevResponse(request), unexpected: true }),
        },
      },
      expectedCode: "malformed_response",
      expectedDiagnostic: /strict validation/,
    },
    {
      name: "rejected request",
      options: { jevClient: { evaluate: async () => { throw new Error("rejected"); } } },
      expectedCode: "internal_failure",
      expectedDiagnostic: /internal bounded failure/,
    },
    {
      name: "unprocessable state",
      options: { jevClient: new ValidFakeJev(), coreCompaction: { maxStateTokens: 1 } },
      expectedCode: "internal_failure",
      expectedDiagnostic: /internal bounded failure/,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const fake = createFakePi();
      registerPiContextExpert(fake.pi, {
        ...scenario.options,
        now: () => new Date("2026-09-22T12:04:00.000Z"),
      });
      const { context, notifications } = createContext(fake.entries);
      const result = await fake.handlers.get("session_before_compact")?.(
        compactionEvent(compactableToolMessages()),
        context,
      );
      assert.equal(result, undefined);
      const failures = collectOperationalFailureReceipts(fake.entries);
      assert.equal(failures.length, 1);
      assert.equal(failures[0]?.code, scenario.expectedCode);
      assert.equal(failures[0]?.phase, "compaction");
      assert.match(failures[0]?.attemptId ?? "", /^sha256:[0-9a-f]{64}$/);
      assert.match(notifications.at(-1)?.message ?? "", scenario.expectedDiagnostic);
      assert.match(notifications.at(-1)?.message ?? "", /native compaction once/);
    });
  }
});

test("native classification accepts stored credentials first and TYPESAFE_API_KEY as fallback", async (t) => {
  const priorKey = process.env.TYPESAFE_API_KEY;
  t.after(() => {
    if (priorKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = priorKey;
  });

  for (const scenario of [
    { name: "stored credential", nativeKey: "stored-key", environmentKey: "environment-key" },
    { name: "environment fallback", nativeKey: undefined, environmentKey: "environment-key" },
  ]) {
    await t.test(scenario.name, async () => {
      process.env.TYPESAFE_API_KEY = scenario.environmentKey;
      const fake = createFakePi();
      const base = createContext(fake.entries);
      const order: string[] = [];
      let classifyCalls = 0;
      const context = {
        ...base.context,
        modelRegistry: {
          async getProviderAuth() {
            order.push("auth");
            return scenario.nativeKey ? { auth: { apiKey: scenario.nativeKey }, source: "stored" } : undefined;
          },
          findOfType() {
            order.push("model");
            return { type: "classifier", provider: "typesafe", id: "jev-latest", api: "typesafe-system-one" };
          },
          async classify(
            _model: unknown,
            request: { questions: Record<string, { type: string }> },
          ) {
            order.push("classify");
            classifyCalls += 1;
            return {
              api: "typesafe-system-one",
              provider: "typesafe",
              model: "jev-latest",
              stopReason: "stop",
              timestamp: 1,
              answers: Object.fromEntries(Object.keys(request.questions).map((id) => [
                id,
                { type: "bool", probability: 0.1 },
              ])),
              usage: {
                input: 10,
                output: 2,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 12,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            };
          },
        },
      };
      registerPiContextExpert(fake.pi);
      const result = await fake.handlers.get("session_before_compact")?.(
        compactionEvent(compactableToolMessages()),
        context,
      );

      assert.ok(requireCompactionResult(result));
      assert.equal(classifyCalls, 1);
      assert.deepEqual(order, ["auth", "model", "classify"]);
    });
  }
});

test("Trigger checks stored credentials first and accepts TYPESAFE_API_KEY as fallback", async (t) => {
  const priorKey = process.env.TYPESAFE_API_KEY;
  t.after(() => {
    if (priorKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = priorKey;
  });

  for (const scenario of [
    { name: "stored credential", nativeKey: "stored-key", environmentKey: "environment-key" },
    { name: "environment fallback", nativeKey: undefined, environmentKey: "environment-key" },
  ]) {
    await t.test(scenario.name, async () => {
      process.env.TYPESAFE_API_KEY = scenario.environmentKey;
      const fake = createFakePi();
      const base = createContext(fake.entries, { projectionEntries: compactableTriggerProjection() });
      const order: string[] = [];
      const context = {
        ...base.context,
        hasUI: true,
        isIdle: () => true,
        hasPendingMessages: () => false,
        getContextUsage: () => ({ tokens: 62_000, contextWindow: 128_000, percent: 48.4375 }),
        signal: undefined,
        modelRegistry: {
          async getProviderAuth() {
            order.push("auth");
            return scenario.nativeKey ? { auth: { apiKey: scenario.nativeKey }, source: "stored" } : undefined;
          },
          findOfType() {
            order.push("model");
            return { type: "classifier", provider: "typesafe", id: "jev-latest", api: "typesafe-system-one" };
          },
          async classify(
            _model: unknown,
            request: { questions: Record<string, { type: string; criteria: Record<string, string> }> },
          ) {
            order.push("classify");
            assert.deepEqual(Object.keys(request.questions), ["done", "shape"]);
            return {
              api: "typesafe-system-one",
              provider: "typesafe",
              model: "jev-latest",
              stopReason: "stop",
              timestamp: 1,
              answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
                const choices = Object.keys(question.criteria);
                return [id, {
                  type: "choice",
                  choice: choices[0],
                  probabilities: Object.fromEntries(choices.map((choice, index) => [choice, index === 0 ? 1 : 0])),
                  confidence: 1,
                }];
              })),
              usage: {
                input: 10,
                output: 2,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 12,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            };
          },
        },
      };
      registerPiContextExpert(fake.pi, {
        config: { "trigger.mode": "hint" },
        trigger: { resolveCompactionSettings: () => ({ keepRecentTokens: 20_000 }) },
      });

      await fake.handlers.get("agent_settled")?.({ type: "agent_settled" }, context);

      assert.deepEqual(order, ["auth", "model", "classify"]);
      assert.equal(base.notifications.length, 1);
    });
  }
});

test("an aborted compaction returns undefined for native fallback", async () => {
  const controller = new AbortController();
  controller.abort();
  const event = compactionEvent();
  event.signal = controller.signal;
  const fake = createFakePi();
  registerPiContextExpert(fake.pi, { jevClient: new ValidFakeJev() });
  const { context, notifications } = createContext(fake.entries);
  const result = await fake.handlers.get("session_before_compact")?.(event, context);
  assert.equal(result, undefined);
  assert.match(notifications.at(-1)?.message ?? "", /aborted/);
  assert.match(notifications.at(-1)?.message ?? "", /native compaction once/);
});

test("an aborted compaction under RPC mode also emits a best-effort stderr diagnostic", async () => {
  const controller = new AbortController();
  controller.abort();
  const event = compactionEvent();
  event.signal = controller.signal;
  const fake = createFakePi();
  registerPiContextExpert(fake.pi, { jevClient: new ValidFakeJev() });
  const { context, notifications } = createContext(fake.entries, { mode: "rpc" });
  const stderr = captureStderr();
  let result: unknown;
  let stderrChunks: string[];
  try {
    result = await fake.handlers.get("session_before_compact")?.(event, context);
  } finally {
    stderrChunks = stderr.restore();
  }
  assert.equal(result, undefined);
  assert.match(notifications.at(-1)?.message ?? "", /aborted/);
  assert.equal(stderrChunks.length, 1);
  assert.match(stderrChunks[0] ?? "", /\[a4s-pi-context-expert:rpc-stdin-guard]/);
  assert.match(stderrChunks[0] ?? "", /compaction aborted under RPC mode/);
});

test("an aborted compaction outside RPC mode never writes the stderr diagnostic", async () => {
  const controller = new AbortController();
  controller.abort();
  const event = compactionEvent();
  event.signal = controller.signal;
  const fake = createFakePi();
  registerPiContextExpert(fake.pi, { jevClient: new ValidFakeJev() });
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
  registerPiContextExpert(fake.pi, { hookTimeoutMs: 30 });
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

test("session_compact_failed ajeno no crea un receipt", async () => {
  const jev = new ValidFakeJev();
  const fake = createFakePi();
  registerPiContextExpert(fake.pi, { jevClient: jev });
  const { context } = createContext(fake.entries);
  const event = compactionEvent(compactableToolMessages());
  assert.ok(requireCompactionResult(await fake.handlers.get("session_before_compact")?.(event, context)));
  const callsBeforeFailure = jev.calls;
  const failedEvent = {
    type: "session_compact_failed",
    reason: "threshold",
    aborted: true,
    willRetry: false,
    fromExtension: true,
    errorMessage: "password=private-failure-message",
  };
  await fake.handlers.get("session_compact_failed")?.(failedEvent, context);

  assert.deepEqual(collectOperationalFailureReceipts(fake.entries), []);
  assert.doesNotMatch(JSON.stringify(fake.entries), /private-failure-message/);
  assert.ok(requireCompactionResult(await fake.handlers.get("session_before_compact")?.(event, context)));
  assert.ok(jev.calls > callsBeforeFailure, "cleared pending work must be re-evaluated on retry");
});

test("session_compact_failed ignora una compactación ajena", async () => {
  const fake = createFakePi();
  registerPiContextExpert(fake.pi, { jevClient: new ValidFakeJev() });
  const { context } = createContext(fake.entries);
  assert.ok(requireCompactionResult(
    await fake.handlers.get("session_before_compact")?.(compactionEvent(), context),
  ));

  await fake.handlers.get("session_compact_failed")?.(
    { type: "session_compact_failed", reason: "threshold", aborted: false, willRetry: false, fromExtension: false },
    context,
  );

  assert.deepEqual(collectOperationalFailureReceipts(fake.entries), []);
});

test("el fallo al guardar el receipt conserva la cancelación", async () => {
  const fake = createFakePi();
  registerPiContextExpert(fake.pi, { hookTimeoutMs: 30 });
  const { context, notifications } = createContext(fake.entries);
  Object.defineProperty(fake.pi, "appendEntry", {
    value() {
      throw new Error("receipt storage unavailable");
    },
  });

  const result = await fake.handlers.get("session_before_compact")?.(compactionEvent(), context);

  assert.equal(result, undefined);
  assert.deepEqual(fake.entries, []);
  assert.match(notifications.at(-1)?.message ?? "", /native compaction once/);
});

test("large text-only sessions use the shared core, cache pending work, and retain no RuleSignals", async () => {
  const jev = new ValidFakeJev();
  const fake = createFakePi();
  registerPiContextExpert(fake.pi, {
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
  assert.equal(jev.calls, 0);
  if ("schema" in first.details) assert.fail("expected HostBinding details");
  assert.equal(first.details.fastJev.decisions.length, 0);
  assert.equal(first.details.fastJev.messages.length, 70);
  const calls = jev.calls;

  const cached = requireCompactionResult(await fake.handlers.get("session_before_compact")?.(event, context));
  assert.equal(cached.details.attemptId, first.details.attemptId);
  assert.equal(jev.calls, calls);

  const compactionEntry = appendSuccessfulCompaction(fake, first);
  await fake.handlers.get("session_compact")?.(
    { type: "session_compact", compactionEntry, fromExtension: true, reason: "threshold", willRetry: false },
    context,
  );
  assert.equal(fake.entries.filter((entry) => entry.customType === RULE_SIGNAL_ENTRY_TYPE).length, 0);

  const reloaded = createFakePi([compactionEntry]);
  registerPiContextExpert(reloaded.pi, { jevClient: new ValidFakeJev() });
  const reloadedContext = createContext(reloaded.entries).context;
  await reloaded.handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, reloadedContext);
  assert.equal(reloaded.entries.filter((entry) => entry.customType === RULE_SIGNAL_ENTRY_TYPE).length, 0);
  await reloaded.handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, reloadedContext);
  assert.equal(reloaded.entries.filter((entry) => entry.customType === RULE_SIGNAL_ENTRY_TYPE).length, 0);
});

test("/retro-rules preserves manually stored evidence after failure and retries idempotently", async () => {
  const batch = await batchFor(
    [{ role: "user", content: "Always preserve deterministic validation evidence." }],
    new ValidFakeJev(),
    "retry",
  );
  const fake = createFakePi([asSignalEntry(batch)]);
  registerPiContextExpert(fake.pi, {
    jevClient: new ValidFakeJev(),
    now: () => new Date("2026-09-18T13:30:00.000Z"),
  });

  const failing = createRetroCapableContext(fake.entries, { failModel: true });
  await fake.commands.get("retro-rules")?.("", failing.context);
  assert.equal(fake.entries.filter((entry) => entry.customType === RULE_SIGNAL_ENTRY_TYPE).length, 1);
  assert.equal(fake.entries.filter((entry) => entry.customType === RULE_PROPOSAL_ENTRY_TYPE).length, 0);
  assert.deepEqual(collectOperationalFailureReceipts(fake.entries), [{
    schema: "a4s.operational-failure/v1",
    timestamp: "2026-09-18T13:30:00.000Z",
    phase: "retro",
    code: "model_unavailable",
    attemptId: batch.provenance.compactionAttemptId,
    reason: "manual",
    willRetry: true,
  }]);

  const recovered = createRetroCapableContext(fake.entries);
  await fake.commands.get("retro-rules")?.("", recovered.context);
  assert.equal(fake.entries.filter((entry) => entry.customType === RULE_PROPOSAL_ENTRY_TYPE).length, 1);
  assert.equal(recovered.modelCalls(), 1);
  await fake.commands.get("retro-rules")?.("", recovered.context);
  assert.equal(fake.entries.filter((entry) => entry.customType === RULE_PROPOSAL_ENTRY_TYPE).length, 1);
  assert.equal(recovered.modelCalls(), 1);
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
  registerPiContextExpert(fake.pi, { jevClient: stageTwoJev });
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
  registerPiContextExpert(fake.pi, {
    jevClient: new ValidFakeJev(),
    now: () => new Date("2026-09-18T14:11:00.000Z"),
  });
  const notifications: string[] = [];
  await fake.commands.get("retro-rules")?.("", {
    waitForIdle: async () => undefined,
    sessionManager: { getBranch: () => fake.entries },
    model: undefined,
    modelRegistry: {},
    ui: { notify: (message: string) => notifications.push(message) },
  });
  assert.deepEqual(collectOperationalFailureReceipts(fake.entries), [{
    schema: "a4s.operational-failure/v1",
    timestamp: "2026-09-18T14:11:00.000Z",
    phase: "retro",
    code: "model_unavailable",
    attemptId: batch.provenance.compactionAttemptId,
    reason: "manual",
    willRetry: true,
  }]);
  assert.match(notifications.at(-1) ?? "", /current Pi model is unavailable/);
});

test("uses Pi's built-in TypeSafe provider instead of registering an override", () => {
  const fake = createFakePi();
  registerPiContextExpert(fake.pi, { jevClient: new ValidFakeJev() });
  assert.deepEqual(fake.registeredProviders, []);
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

function compactableTriggerProjection() {
  return [
    {
      sourceEntry: { type: "message" },
      messages: [{ role: "user", content: "old request" }],
    },
    {
      sourceEntry: { type: "message" },
      messages: [{ role: "user", content: "x".repeat(80_000) }],
    },
  ];
}

test("agent_settled dispatches only after adaptive and compactable-history gates pass", async () => {
  for (const scenario of [
    {
      mode: "tui" as const,
      editorText: "",
      tokens: 174_400,
      contextWindow: 872_000,
      projectionEntries: compactableTriggerProjection(),
      expectedNotifications: 1,
    },
    {
      mode: "tui" as const,
      editorText: "",
      tokens: 87_200,
      contextWindow: 872_000,
      projectionEntries: compactableTriggerProjection(),
      expectedNotifications: 0,
    },
    {
      mode: "tui" as const,
      editorText: "",
      tokens: 174_400,
      contextWindow: 872_000,
      projectionEntries: [],
      expectedNotifications: 0,
    },
    {
      mode: "tui" as const,
      editorText: "Continue editing this request",
      tokens: 174_400,
      contextWindow: 872_000,
      projectionEntries: compactableTriggerProjection(),
      expectedNotifications: 0,
    },
    {
      mode: "rpc" as const,
      editorText: "",
      tokens: 174_400,
      contextWindow: 872_000,
      projectionEntries: compactableTriggerProjection(),
      expectedNotifications: 0,
    },
    {
      mode: "tui" as const,
      editorReadFails: true,
      tokens: 174_400,
      contextWindow: 872_000,
      projectionEntries: compactableTriggerProjection(),
      expectedNotifications: 0,
    },
  ]) {
    const jev = new CompactTriggerJev();
    const fake = createFakePi();
    registerPiContextExpert(fake.pi, {
      jevClient: jev,
      config: { "trigger.mode": "hint" },
      trigger: { resolveCompactionSettings: () => ({ keepRecentTokens: 20_000 }) },
      now: () => new Date("2026-09-22T12:00:00.000Z"),
    });
    const { context, notifications } = createContext(fake.entries, scenario);
    const triggerContext = {
      ...context,
      hasUI: true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      getContextUsage: () => ({
        tokens: scenario.tokens,
        contextWindow: scenario.contextWindow,
        percent: scenario.tokens / scenario.contextWindow * 100,
      }),
      signal: undefined,
    };

    await fake.handlers.get("agent_settled")?.({ type: "agent_settled" }, triggerContext);

    assert.equal(notifications.length, scenario.expectedNotifications);
    assert.equal(jev.calls, 0, "the adaptive ceiling must not call timing Jev");
  }
});

test("una sesión larga conserva un receipt por evaluación fallida del Trigger", async () => {
  const fake = createFakePi();
  registerPiContextExpert(fake.pi, {
    jevClient: {
      evaluate: async () => {
        throw new Error("argv=private-trigger-error");
      },
    },
    config: { "trigger.mode": "hint" },
    trigger: { resolveCompactionSettings: () => ({ keepRecentTokens: 20_000 }) },
    now: () => new Date("2026-09-22T12:03:00.000Z"),
  });
  const { context, notifications } = createContext(fake.entries, {
    projectionEntries: compactableTriggerProjection(),
  });
  const triggerContext = {
    ...context,
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 62_000, contextWindow: 128_000, percent: 48.4375 }),
    signal: undefined,
  };

  for (let index = 0; index < 128; index += 1) {
    await fake.handlers.get("agent_settled")?.({ type: "agent_settled" }, triggerContext);
  }

  const failures = collectOperationalFailureReceipts(fake.entries);
  assert.equal(failures.length, 128);
  assert.equal(failures.every((failure) =>
    failure.phase === "trigger" &&
    failure.code === "internal_failure" &&
    failure.reason === "agent_settled" &&
    failure.willRetry
  ), true);
  assert.deepEqual(notifications, []);
  assert.doesNotMatch(JSON.stringify(fake.entries), /private-trigger-error/);
});

test("agent_settled recalculates the trigger ratio after a model window change", async () => {
  const jev = new CompactTriggerJev();
  const fake = createFakePi();
  registerPiContextExpert(fake.pi, {
    jevClient: jev,
    config: { "trigger.mode": "hint" },
    trigger: { resolveCompactionSettings: () => ({ keepRecentTokens: 20_000 }) },
    now: () => new Date("2026-09-22T12:00:00.000Z"),
  });
  const { context, notifications } = createContext(fake.entries, {
    projectionEntries: compactableTriggerProjection(),
  });
  let contextWindow = 872_000;
  const triggerContext = {
    ...context,
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 62_000, contextWindow, percent: 62_000 / contextWindow * 100 }),
    signal: undefined,
  };

  await fake.handlers.get("agent_settled")?.({ type: "agent_settled" }, triggerContext);
  assert.equal(jev.calls, 0);

  contextWindow = 128_000;
  await fake.handlers.get("agent_settled")?.({ type: "agent_settled" }, triggerContext);
  assert.equal(jev.calls, 1);
  assert.equal(notifications.length, 1);
});

test("agent_settled resolves active-model keepRecentTokens from Pi project settings", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "a4s-trigger-settings-"));
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
      compaction: {
        modelOverrides: {
          "fake-provider/fake-model": { keepRecentTokens: 0 },
        },
      },
    }));

    const jev = new CompactTriggerJev();
    const fake = createFakePi();
    registerPiContextExpert(fake.pi, {
      jevClient: jev,
      config: { "trigger.mode": "hint" },
      now: () => new Date("2026-09-22T12:00:00.000Z"),
    });
    const { context } = createContext(fake.entries, {
      projectionEntries: [
        { sourceEntry: { type: "message" }, messages: [{ role: "user", content: "old" }] },
        { sourceEntry: { type: "message" }, messages: [{ role: "user", content: "recent" }] },
      ],
    });
    const triggerContext = {
      ...context,
      cwd,
      model: { provider: "fake-provider", id: "fake-model" },
      isProjectTrusted: () => true,
      hasUI: true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      getContextUsage: () => ({ tokens: 62_000, contextWindow: 128_000, percent: 48.4375 }),
      signal: undefined,
    };

    await fake.handlers.get("agent_settled")?.({ type: "agent_settled" }, triggerContext);

    assert.equal(jev.calls, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("agent_settled auto trigger ignores an aborted assistant branch tip", async () => {
  const jev = new CompactTriggerJev();
  const fake = createFakePi([{
    type: "message",
    message: { role: "assistant", stopReason: "aborted", content: [] },
  }]);
  registerPiContextExpert(fake.pi, {
    jevClient: jev,
    config: { "trigger.mode": "auto" },
    trigger: {
      editorHasText: () => false,
      minimumContextRatio: 0.2,
      resolveCompactionSettings: () => ({ keepRecentTokens: 20_000 }),
    },
  });
  let compactCalls = 0;
  const { context } = createContext(fake.entries, {
    projectionEntries: compactableTriggerProjection(),
  });
  const triggerContext = {
    ...context,
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 62_000, contextWindow: 128_000, percent: 48.4375 }),
    signal: undefined,
    compact: () => { compactCalls += 1; },
  };

  await fake.handlers.get("agent_settled")?.({ type: "agent_settled" }, triggerContext);

  assert.equal(compactCalls, 0);
  assert.equal(jev.calls, 0, "the aborted-turn gate must run before Jev");
});

test("agent_settled auto trigger retries failure and starts cooldown only after success", async () => {
  const jev = new CompactTriggerJev();
  const fake = createFakePi();
  registerPiContextExpert(fake.pi, {
    jevClient: jev,
    config: { "trigger.mode": "auto" },
    trigger: {
      editorHasText: () => false,
      minimumContextRatio: 0.2,
      resolveCompactionSettings: () => ({ keepRecentTokens: 20_000 }),
    },
    now: () => new Date("2026-09-22T12:00:00.000Z"),
  });
  let compactCalls = 0;
  let onComplete: ((result: { estimatedTokensAfter?: number }) => void) | undefined;
  let onError: ((error: Error) => void) | undefined;
  const { context } = createContext(fake.entries, {
    projectionEntries: compactableTriggerProjection(),
  });
  const triggerContext = {
    ...context,
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 62_000, contextWindow: 128_000, percent: 48.4375 }),
    signal: undefined,
    compact: (callbacks?: {
      onComplete?: (result: { estimatedTokensAfter?: number }) => void;
      onError?: (error: Error) => void;
    }) => {
      compactCalls += 1;
      onComplete = callbacks?.onComplete;
      onError = callbacks?.onError;
    },
  };

  await Promise.all([
    fake.handlers.get("agent_settled")?.({ type: "agent_settled" }, triggerContext),
    fake.handlers.get("agent_settled")?.({ type: "agent_settled" }, triggerContext),
  ]);
  assert.equal(jev.calls, 1, "overlapping settlements must share one automatic attempt");
  assert.equal(compactCalls, 1, "an in-flight automatic compaction must not duplicate");
  assert.equal(fake.entries.some((entry) => entry.customType?.includes("cooldown")), false);

  onError?.(new Error("compaction failed"));
  await fake.handlers.get("agent_settled")?.({ type: "agent_settled" }, triggerContext);
  assert.equal(compactCalls, 2, "a failed automatic compaction must be retryable");
  assert.equal(fake.entries.some((entry) => entry.customType?.includes("cooldown")), false);

  onComplete?.({ estimatedTokensAfter: 20_000 });
  await fake.handlers.get("agent_settled")?.({ type: "agent_settled" }, triggerContext);
  assert.equal(compactCalls, 2, "a successful automatic compaction starts the cooldown");
  assert.equal(fake.entries.some((entry) => entry.customType?.includes("cooldown")), true);
});

test("agent_settled dispatches once and FastJev runs only in session_before_compact", async () => {
  const jev = new ValidFakeJev();
  const fake = createFakePi();
  registerPiContextExpert(fake.pi, {
    jevClient: jev,
    config: { "trigger.mode": "auto" },
    trigger: {
      editorHasText: () => false,
      minimumContextRatio: 0.2,
      resolveCompactionSettings: () => ({ keepRecentTokens: 20_000 }),
    },
    now: () => new Date("2026-09-22T12:00:00.000Z"),
  });
  let compactCalls = 0;
  let beforeCompactCalls = 0;
  const { context, notifications } = createContext(fake.entries, {
    projectionEntries: compactableTriggerProjection(),
  });
  const triggerContext = {
    ...context,
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 62_000, contextWindow: 128_000, percent: 48.4375 }),
    signal: undefined,
    compact: async (callbacks?: { onComplete?: (result: { estimatedTokensAfter?: number }) => void }) => {
      compactCalls += 1;
      beforeCompactCalls += 1;
      await fake.handlers.get("session_before_compact")?.(
        compactionEvent(compactableToolMessages()),
        triggerContext,
      );
      callbacks?.onComplete?.({ estimatedTokensAfter: 20_000 });
    },
  };

  assert.equal(fake.commands.has("compaction-trigger-acknowledge"), false);

  await fake.handlers.get("agent_settled")?.({ type: "agent_settled" }, triggerContext);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(compactCalls, 1);
  assert.equal(beforeCompactCalls, 1, "auto uses ctx.compact and the existing compaction hook");
  const timingRequests = jev.requests.filter(
    (request) => Object.keys(request.questions).join(",") === "done,shape",
  );
  const fastJevRequests = jev.requests.filter(
    (request) => Object.keys(request.questions).join(",") !== "done,shape",
  );
  assert.equal(timingRequests.length, 1);
  assert.equal(fastJevRequests.length, 1, "FastJev enters once through session_before_compact");
  const triggerState = timingRequests[0]?.state as { recent?: Array<{ text?: string }> };
  assert.ok(triggerState.recent?.some((message) => (message.text?.length ?? 0) > 0));
  assert.equal(notifications.length, 0);
  assert.equal(fake.entries.some((entry) => entry.customType?.includes("acknowledgement")), false);
  assert.equal(fake.entries.some((entry) => entry.customType?.includes("cooldown")), true);
  assert.doesNotMatch(JSON.stringify(jev.requests), /credential|secret|chunk text/i);
});

test("adaptive Trigger bands avoid credentials and timing Jev outside the semantic band", async () => {
  for (const scenario of [
    { name: "below floor", tokens: 59_999, expectedCompactions: 0, expectedLogs: 0 },
    { name: "at ceiling", tokens: 70_000, expectedCompactions: 1, expectedLogs: 1 },
  ]) {
    await test(scenario.name, async () => {
      let authCalls = 0;
      let classifyCalls = 0;
      let compactCalls = 0;
      const fake = createFakePi();
      registerPiContextExpert(fake.pi, {
        config: { "trigger.mode": "hint" },
        trigger: {
          resolveCompactionSettings: () => ({
            enabled: true,
            reserveTokens: 20_000,
            keepRecentTokens: 20_000,
          }),
        },
        now: () => new Date("2026-09-22T12:00:00.000Z"),
      });
      const base = createContext(fake.entries, { projectionEntries: compactableTriggerProjection() });
      const context = {
        ...base.context,
        model: { provider: "fake-provider", id: "fake-model" },
        hasUI: true,
        isIdle: () => true,
        hasPendingMessages: () => false,
        getContextUsage: () => ({
          tokens: scenario.tokens,
          contextWindow: 200_000,
          percent: scenario.tokens / 2_000,
        }),
        modelRegistry: {
          async getProviderAuth() {
            authCalls += 1;
            return { auth: { apiKey: "credential-canary" }, source: "stored" };
          },
          findOfType() {
            classifyCalls += 1;
            return undefined;
          },
        },
        compact: () => { compactCalls += 1; },
      };

      await fake.handlers.get("agent_settled")?.({ type: "agent_settled" }, context);

      assert.equal(authCalls, 0);
      assert.equal(classifyCalls, 0);
      assert.equal(compactCalls, scenario.expectedCompactions);
      const logs = fake.entries.filter((entry) => entry.customType === TRIGGER_DECISION_ENTRY_TYPE);
      assert.equal(logs.length, scenario.expectedLogs);
      if (scenario.tokens === 70_000) {
        assert.deepEqual(
          logs[0]?.data && {
            basis: (logs[0].data as { basis?: unknown }).basis,
            nativeOverflowThreshold: (logs[0].data as { nativeOverflowThreshold?: unknown }).nativeOverflowThreshold,
          },
          { basis: "ceiling", nativeOverflowThreshold: 180_000 },
        );
      }
    });
  }
});

test("Trigger decision logging failure does not block ceiling compaction", async () => {
  const fake = createFakePi();
  Object.defineProperty(fake.pi, "appendEntry", {
    value() {
      throw new Error("trigger log unavailable");
    },
  });
  registerPiContextExpert(fake.pi, {
    config: { "trigger.mode": "hint" },
    trigger: { resolveCompactionSettings: () => ({ keepRecentTokens: 20_000 }) },
  });
  let compactCalls = 0;
  const base = createContext(fake.entries, { projectionEntries: compactableTriggerProjection() });
  const context = {
    ...base.context,
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 70_000, contextWindow: 200_000, percent: 35 }),
    compact: () => { compactCalls += 1; },
  };

  await fake.handlers.get("agent_settled")?.({ type: "agent_settled" }, context);

  assert.equal(compactCalls, 1);
});

test("semantic Trigger decisions preserve wait and compact policy metadata", async () => {
  for (const scenario of [
    { name: "wait", jev: new WaitTriggerJev(), expectedDecision: "wait", expectedCompactions: 0 },
    { name: "compact", jev: new CompactTriggerJev(), expectedDecision: "compact", expectedCompactions: 1 },
  ]) {
    await test(scenario.name, async () => {
      let compactCalls = 0;
      const fake = createFakePi();
      registerPiContextExpert(fake.pi, {
        jevClient: scenario.jev,
        config: { "trigger.mode": "auto" },
        trigger: {
          editorHasText: () => false,
          resolveCompactionSettings: () => ({ keepRecentTokens: 20_000 }),
        },
      });
      const base = createContext(fake.entries, { projectionEntries: compactableTriggerProjection() });
      const context = {
        ...base.context,
        hasUI: true,
        isIdle: () => true,
        hasPendingMessages: () => false,
        getContextUsage: () => ({ tokens: 62_000, contextWindow: 200_000, percent: 31 }),
        compact: () => { compactCalls += 1; },
      };

      await fake.handlers.get("agent_settled")?.({ type: "agent_settled" }, context);

      assert.equal(scenario.jev.calls, 1);
      assert.equal(compactCalls, scenario.expectedCompactions);
      const log = fake.entries.find((entry) => entry.customType === TRIGGER_DECISION_ENTRY_TYPE)?.data as {
        decision?: unknown;
        basis?: unknown;
        done?: unknown;
        shape?: unknown;
        score?: unknown;
        floor?: unknown;
      };
      assert.equal(log.decision, scenario.expectedDecision);
      assert.equal(log.basis, "semantic");
      assert.equal(log.done, undefined, "durable logs must not store Jev answers");
      assert.equal(log.shape, undefined, "durable logs must not store Jev answers");
      assert.equal(typeof log.score, "number");
      assert.equal(typeof log.floor, "number");
    });
  }
});

test("hint and auto dispatch one compaction for one positive decision", async () => {
  for (const mode of ["hint", "auto"] as const) {
    let compactCalls = 0;
    const fake = createFakePi();
    const jev = new CompactTriggerJev();
    const base = createContext(fake.entries, { projectionEntries: compactableTriggerProjection() });
    registerPiContextExpert(fake.pi, {
      jevClient: jev,
      config: { "trigger.mode": mode },
      trigger: {
        editorHasText: () => false,
        resolveCompactionSettings: () => ({ keepRecentTokens: 20_000 }),
      },
    });
    const context = {
      ...base.context,
      hasUI: true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      getContextUsage: () => ({ tokens: 62_000, contextWindow: 200_000, percent: 31 }),
      compact: () => { compactCalls += 1; },
    };

    await fake.handlers.get("agent_settled")?.({ type: "agent_settled" }, context);

    assert.equal(jev.calls, 1);
    assert.equal(compactCalls, 1);
    assert.equal(base.notifications.length, mode === "hint" ? 1 : 0);
  }
});

test("Trigger correlation survives an interleaved in-flight attempt and rearm blocks duplicates", async () => {
  const jev = new CompactTriggerJev();
  const fake = createFakePi();
  let current = new Date("2026-09-22T12:00:00.000Z");
  let tokens = 62_000;
  let compactCalls = 0;
  let onComplete: ((result: { estimatedTokensAfter?: number }) => void) | undefined;
  registerPiContextExpert(fake.pi, {
    jevClient: jev,
    config: { "trigger.mode": "auto" },
    trigger: {
      editorHasText: () => false,
      resolveCompactionSettings: () => ({ keepRecentTokens: 20_000 }),
    },
    now: () => current,
  });
  const base = createContext(fake.entries, {
    projectionEntries: [{
      sourceEntry: { type: "message" },
      messages: [{ role: "user", content: "PRIVATE_CONVERSATION_CANARY" }],
    }, ...compactableTriggerProjection()],
  });
  const context = {
    ...base.context,
    model: { provider: "fake-provider", id: "fake-model" },
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens, contextWindow: 200_000, percent: tokens / 2_000 }),
    compact: (callbacks?: { onComplete?: (result: { estimatedTokensAfter?: number }) => void }) => {
      compactCalls += 1;
      onComplete = callbacks?.onComplete;
    },
  };

  await Promise.all([
    fake.handlers.get("agent_settled")?.({ type: "agent_settled" }, context),
    fake.handlers.get("agent_settled")?.({ type: "agent_settled" }, context),
  ]);
  assert.equal(jev.calls, 1);
  assert.equal(compactCalls, 1);
  assert.ok(fake.entries.some((entry) =>
    entry.customType === TRIGGER_DECISION_ENTRY_TYPE &&
    (entry.data as { reason?: unknown }).reason === "compaction_in_flight"
  ));
  const dispatchedIndex = fake.entries.findIndex((entry) =>
    entry.customType === TRIGGER_DECISION_ENTRY_TYPE &&
    (entry.data as { dispatchOutcome?: unknown }).dispatchOutcome === "dispatched"
  );
  assert.notEqual(dispatchedIndex, -1);

  await fake.handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
  assert.equal(compactCalls, 1, "an interleaved in-flight attempt must not dispatch");
  const interleavedIndex = fake.entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) =>
      entry.customType === TRIGGER_DECISION_ENTRY_TYPE &&
      (entry.data as { reason?: unknown }).reason === "compaction_in_flight"
    )
    .at(-1)?.index ?? -1;
  assert.ok(interleavedIndex > dispatchedIndex, "the in-flight attempt must occur after dispatch");

  onComplete?.({ estimatedTokensAfter: 30_000 });
  const completedIndex = fake.entries.findIndex((entry) =>
    entry.customType === TRIGGER_DECISION_ENTRY_TYPE &&
    (entry.data as { dispatchOutcome?: unknown }).dispatchOutcome === "completed"
  );
  assert.ok(completedIndex > interleavedIndex, "completion must occur after the in-flight attempt");
  const positiveLogs = fake.entries.filter((entry) =>
    entry.customType === TRIGGER_DECISION_ENTRY_TYPE &&
    ["dispatched", "completed"].includes(
      String((entry.data as { dispatchOutcome?: unknown }).dispatchOutcome),
    )
  );
  assert.equal(positiveLogs.filter((entry) =>
    (entry.data as { dispatchOutcome?: unknown }).dispatchOutcome === "dispatched"
  ).length, 1);
  assert.equal(
    (positiveLogs[0]?.data as { id?: unknown }).id,
    (positiveLogs[1]?.data as { id?: unknown }).id,
    "dispatch and completion must share one decision id",
  );
  assert.deepEqual(
    positiveLogs.map((entry) => (entry.data as { dispatchOutcome?: unknown }).dispatchOutcome),
    ["dispatched", "completed"],
  );
  await fake.handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
  assert.equal(compactCalls, 1, "cooldown must block a completed trigger");
  assert.ok(fake.entries.some((entry) =>
    entry.customType === TRIGGER_DECISION_ENTRY_TYPE &&
    (entry.data as { reason?: unknown }).reason === "cooldown"
  ));

  current = new Date("2026-09-22T12:05:01.000Z");
  await fake.handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
  assert.equal(compactCalls, 1, "rearm must block before post-context plus 40000 tokens");
  assert.ok(fake.entries.some((entry) =>
    entry.customType === TRIGGER_DECISION_ENTRY_TYPE &&
    (entry.data as { reason?: unknown }).reason === "rearm"
  ));

  tokens = 70_000;
  await fake.handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
  assert.equal(compactCalls, 2);
  assert.equal(jev.calls, 1, "the ceiling decision must not call timing Jev");

  const logs = fake.entries.filter((entry) => entry.customType === TRIGGER_DECISION_ENTRY_TYPE);
  const serializedLogs = JSON.stringify(logs);
  assert.doesNotMatch(serializedLogs, /PRIVATE_CONVERSATION_CANARY/);
  const completed = logs.find((entry) => (entry.data as { dispatchOutcome?: unknown }).dispatchOutcome === "completed");
  assert.deepEqual(
    completed?.data && {
      postContextTokens: (completed.data as { postContextTokens?: unknown }).postContextTokens,
      actualReclaimTokens: (completed.data as { actualReclaimTokens?: unknown }).actualReclaimTokens,
      rearmTokens: (completed.data as { rearmTokens?: unknown }).rearmTokens,
    },
    { postContextTokens: 30_000, actualReclaimTokens: 32_000, rearmTokens: 70_000 },
  );
});

test("Trigger reload preserves fail-closed rearm when post-context usage is unavailable", async () => {
  const earlierFiniteRearm: StoredEntry = {
    type: "custom",
    customType: TRIGGER_DECISION_ENTRY_TYPE,
    data: {
      schema: "a4s.pi-context-expert.trigger-decision/v1",
      id: "earlier-finite-rearm",
      dispatchOutcome: "completed",
      rearmStatus: "armed",
      rearmTokens: 70_000,
    },
  };
  const fake = createFakePi([earlierFiniteRearm]);
  let current = new Date("2026-09-22T12:00:00.000Z");
  let onComplete: ((result: { estimatedTokensAfter?: number }) => void) | undefined;
  registerPiContextExpert(fake.pi, {
    jevClient: new CompactTriggerJev(),
    config: { "trigger.mode": "auto" },
    trigger: {
      editorHasText: () => false,
      resolveCompactionSettings: () => ({ keepRecentTokens: 20_000 }),
    },
    now: () => current,
  });
  const base = createContext(fake.entries, { projectionEntries: compactableTriggerProjection() });
  const context = {
    ...base.context,
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 62_000, contextWindow: 200_000, percent: 31 }),
    compact: (callbacks?: { onComplete?: (result: { estimatedTokensAfter?: number }) => void }) => {
      onComplete = callbacks?.onComplete;
    },
  };

  await fake.handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
  onComplete?.({});

  const completed = [...fake.entries].reverse().find((entry) =>
    entry.customType === TRIGGER_DECISION_ENTRY_TYPE &&
    (entry.data as { dispatchOutcome?: unknown }).dispatchOutcome === "completed"
  );
  const completedData = completed?.data as Record<string, unknown>;
  assert.equal(completedData.rearmStatus, "post_context_unavailable");
  assert.equal(Object.hasOwn(completedData, "rearmTokens"), false);
  assert.equal(
    Object.values(completedData).some((value) => typeof value === "number" && !Number.isFinite(value)),
    false,
  );
  assert.doesNotMatch(JSON.stringify(completedData), /"rearmTokens":null/);

  current = new Date("2026-09-22T12:05:01.000Z");
  const reloaded = createFakePi(fake.entries);
  const reloadedJev = new CompactTriggerJev();
  let reloadedCompactCalls = 0;
  registerPiContextExpert(reloaded.pi, {
    jevClient: reloadedJev,
    config: { "trigger.mode": "auto" },
    trigger: {
      editorHasText: () => false,
      resolveCompactionSettings: () => ({ keepRecentTokens: 20_000 }),
    },
    now: () => current,
  });
  const reloadedBase = createContext(reloaded.entries, { projectionEntries: compactableTriggerProjection() });
  const reloadedContext = {
    ...reloadedBase.context,
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 70_000, contextWindow: 200_000, percent: 35 }),
    compact: () => { reloadedCompactCalls += 1; },
  };

  await reloaded.handlers.get("session_start")?.(
    { type: "session_start", reason: "reload" },
    reloadedContext,
  );
  await reloaded.handlers.get("agent_settled")?.({ type: "agent_settled" }, reloadedContext);

  assert.equal(reloadedCompactCalls, 0, "reload must retain fail-closed rearm");
  assert.equal(reloadedJev.calls, 0);
  const rearmLog = reloaded.entries.at(-1)?.data as Record<string, unknown>;
  assert.equal(rearmLog.reason, "rearm");
  assert.equal(rearmLog.rearmStatus, "post_context_unavailable");
  assert.equal(Object.hasOwn(rearmLog, "rearmTokens"), false);
  assert.doesNotMatch(JSON.stringify(rearmLog), /"rearmTokens":null/);
});

test("Trigger reload restores a finite rearm value", async () => {
  const fake = createFakePi([{
    type: "custom",
    customType: TRIGGER_DECISION_ENTRY_TYPE,
    data: {
      schema: "a4s.pi-context-expert.trigger-decision/v1",
      id: "finite-rearm",
      dispatchOutcome: "completed",
      rearmStatus: "armed",
      rearmTokens: 70_000,
    },
  }]);
  let tokens = 69_000;
  let compactCalls = 0;
  registerPiContextExpert(fake.pi, {
    config: { "trigger.mode": "auto" },
    trigger: {
      editorHasText: () => false,
      resolveCompactionSettings: () => ({ keepRecentTokens: 20_000 }),
    },
  });
  const base = createContext(fake.entries, { projectionEntries: compactableTriggerProjection() });
  const context = {
    ...base.context,
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens, contextWindow: 200_000, percent: tokens / 2_000 }),
    compact: () => { compactCalls += 1; },
  };

  await fake.handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, context);
  await fake.handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
  assert.equal(compactCalls, 0);
  assert.equal((fake.entries.at(-1)?.data as { rearmTokens?: unknown }).rearmTokens, 70_000);

  tokens = 70_000;
  await fake.handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
  assert.equal(compactCalls, 1, "the restored finite rearm must release at its boundary");
});
