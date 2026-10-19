import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type Api,
  type AssistantMessage,
  type ClassifierContext,
  type ClassifierModel,
  type ClassifierResult,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import { TRIGGER_DECISION_ENTRY_TYPE } from "../src/index.ts";

const CANARY = "PI_CONVERSATION_CANARY_DO_NOT_LOG";
const WINDOWS = [
  { contextWindow: 128_000, floorTokens: 60_000, ceilingTokens: 66_400 },
  { contextWindow: 200_000, floorTokens: 60_000, ceilingTokens: 70_000 },
  { contextWindow: 272_000, floorTokens: 60_000, ceilingTokens: 73_600 },
  { contextWindow: 872_000, floorTokens: 130_800, ceilingTokens: 174_400 },
] as const;

type StoredEntry = {
  type: string;
  customType?: string;
  data?: Record<string, unknown>;
  details?: { fastJev?: { version?: number } };
};

function usage(input: number) {
  return {
    input,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistant(model: Model<Api>, text: string, inputTokens: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: usage(inputTokens),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function deterministicStream(inputTokens: () => number) {
  return (model: Model<Api>, _context: TranscriptContext, options?: SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(async () => {
      await options?.onResponse?.({ status: 200, headers: {} }, model);
      const message = assistant(model, "offline answer", inputTokens() - 1);
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
    });
    return stream;
  };
}

function classifierAnswer(
  model: ClassifierModel<Api>,
  context: ClassifierContext,
): ClassifierResult {
  const answers: ClassifierResult["answers"] = {};
  for (const [id, question] of Object.entries(context.questions)) {
    if (question.type === "bool") {
      answers[id] = { type: "bool", probability: 0.95 };
    } else if (question.type === "choice") {
      const choices = Object.keys(question.criteria);
      const selected = choices[0]!;
      answers[id] = {
        type: "choice",
        choice: selected,
        probabilities: Object.fromEntries(choices.map((choice) => [choice, choice === selected ? 1 : 0])),
        confidence: 1,
      };
    } else {
      answers[id] = { type: "score", score: question.criteria.length - 1, confidence: 1 };
    }
  }
  return {
    api: model.api,
    provider: model.provider,
    model: model.id,
    answers,
    usage: usage(1),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function waitForCompaction(session: { subscribe: (listener: (event: { type: string }) => void) => () => void }) {
  return new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("timed out waiting for real AgentSession compaction"));
    }, 5_000);
    const unsubscribe = session.subscribe((event) => {
      if (event.type !== "compaction_end") return;
      clearTimeout(timer);
      unsubscribe();
      resolvePromise();
    });
  });
}

function uiContext(notifications: string[]) {
  return {
    getEditorText: () => "",
    setEditorText: () => undefined,
    notify: (message: string) => notifications.push(message),
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    setStatus: () => undefined,
    setWorkingMessage: () => undefined,
    setWidget: () => undefined,
    setFooter: () => undefined,
    setHeader: () => undefined,
    setTitle: () => undefined,
    custom: async () => undefined,
    pasteToEditor: () => undefined,
  };
}

async function runScenario(
  root: string,
  mode: "hint" | "auto",
  matrix: (typeof WINDOWS)[number],
  setNow: (value: number) => void,
) {
  const name = `${mode}-${matrix.contextWindow}`;
  const home = join(root, name, "home");
  const cwd = join(root, name, "cwd");
  const agentDir = join(home, ".pi", "agent");
  const rearmScenario = mode === "auto" && matrix.contextWindow === 872_000;
  const keepRecentTokens = rearmScenario ? 130_000 : 0;
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(agentDir, "pi-context-expert.json"),
    JSON.stringify({
      "compaction.strategy": "basic",
      "trigger.mode": mode,
      "evidence.strategy": "off",
    }),
  );
  writeFileSync(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({ compaction: { enabled: false, keepRecentTokens, reserveTokens: 0 } }),
  );

  process.env.HOME = home;
  process.env.PI_OFFLINE = "1";
  delete process.env.TYPESAFE_API_KEY;

  let requestedTokens: number = matrix.ceilingTokens;
  let beforeCompactCalls = 0;
  let classifierCalls = 0;
  const classifierQuestionSets: string[][] = [];
  const notifications: string[] = [];
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider("offline-e2e", {
    apiKey: "offline-model-key",
    api: "offline-e2e" as Api,
    streamSimple: deterministicStream(() => requestedTokens),
    models: [{
      id: `offline-${matrix.contextWindow}`,
      name: "Offline E2E",
      api: "offline-e2e" as Api,
      baseUrl: "http://offline.invalid",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: matrix.contextWindow,
      maxTokens: 1_024,
    }],
  });
  modelRuntime.registerProvider("typesafe", {
    apiKey: "offline-jev-key",
    classifiers: {
      "typesafe-system-one": {
        async classify(model, context) {
          classifierCalls += 1;
          classifierQuestionSets.push(Object.keys(context.questions));
          return classifierAnswer(model, context);
        },
      },
    },
    models: [{
      type: "classifier",
      id: "jev-latest",
      name: "Offline Jev",
      api: "typesafe-system-one",
      baseUrl: "http://offline.invalid",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
    }],
  });
  const model = modelRuntime.getModel("offline-e2e", `offline-${matrix.contextWindow}`);
  assert.ok(model);

  const sessionManager = SessionManager.inMemory(cwd);
  sessionManager.appendMessage({ role: "user", content: "Inspect the old result.", timestamp: Date.now() });
  sessionManager.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: "I inspected it." },
      { type: "toolCall", id: "old-call", name: "read", arguments: { path: "old.txt" } },
    ],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: usage(1),
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
  sessionManager.appendMessage({
    role: "toolResult",
    toolCallId: "old-call",
    toolName: "read",
    content: [{ type: "text", text: "old result ".repeat(rearmScenario ? 150_000 : 12_000) }],
    isError: false,
    timestamp: Date.now(),
  });
  if (rearmScenario) {
    sessionManager.appendMessage({
      role: "user",
      content: `retained recent history ${"retained ".repeat(70_000)}`,
      timestamp: Date.now(),
    });
  }

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false, keepRecentTokens, reserveTokens: 0 },
      retry: { enabled: false },
      cacheWarming: "off",
    }, { projectTrusted: true }),
    additionalExtensionPaths: [resolve("src/index.ts")],
    extensionFactories: [
      (pi: ExtensionAPI) => {
        pi.on("session_before_compact", () => {
          beforeCompactCalls += 1;
        });
      },
    ],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime,
    resourceLoader,
    sessionManager,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false, keepRecentTokens, reserveTokens: 0 },
      retry: { enabled: false },
      cacheWarming: "off",
    }, { projectTrusted: true }),
    noTools: "all",
  });

  try {
    await session.bindExtensions({
      mode: "tui",
      uiContext: uiContext(notifications) as never,
    });
    const compacted = mode === "auto" ? waitForCompaction(session) : undefined;
    await session.prompt(`controlled ceiling turn ${CANARY}`);
    await compacted;
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));

    const entries = sessionManager.getBranch() as StoredEntry[];
    const compactions = entries.filter((entry) => entry.type === "compaction");
    const decisions = entries.filter((entry) => entry.customType === TRIGGER_DECISION_ENTRY_TYPE);
    const positive = decisions.find((entry) =>
      entry.data?.decision === "compact" &&
      entry.data?.dispatchOutcome === (mode === "hint" ? "not_dispatched" : "completed")
    );

    assert.ok(positive, "the real extension must append a positive trigger decision");
    assert.equal(positive.data?.effectiveFloorTokens, matrix.floorTokens);
    assert.equal(positive.data?.effectiveCeilingTokens, matrix.ceilingTokens);
    assert.equal(positive.data?.preContextTokens, matrix.ceilingTokens);
    assert.equal(positive.data?.mode, mode);
    assert.equal(positive.data?.reason, "adaptive_ceiling");
    assert.equal(JSON.stringify(decisions).includes(CANARY), false);

    if (mode === "hint") {
      assert.equal(beforeCompactCalls, 0, "hint must not emit session_before_compact");
      assert.equal(compactions.length, 0, "hint must not compact the consumer session");
      assert.equal(classifierCalls, 0, "ceiling hint must not run timing Jev or FastJev");
      assert.equal(positive.data?.dispatchOutcome, "not_dispatched");
      assert.equal(positive.data?.uiOutcome, "hinted");
      assert.match(notifications[0] ?? "", /\/compact/);

      await session.prompt("hint cooldown probe");
      const currentDecisions = (sessionManager.getBranch() as StoredEntry[])
        .filter((entry) => entry.customType === TRIGGER_DECISION_ENTRY_TYPE);
      assert.equal(currentDecisions.at(-1)?.data?.reason, "cooldown");
      assert.equal(notifications.length, 1);
      assert.equal(beforeCompactCalls, 0);
    } else {
      assert.equal(beforeCompactCalls, 1, "auto must emit session_before_compact once");
      assert.equal(compactions.length, 1, "auto must compact the consumer once");
      assert.equal(compactions[0]?.details?.fastJev?.version, 1);
      assert.equal(classifierCalls, 1, "ceiling auto must skip timing Jev and run one FastJev selection");
      assert.notDeepEqual(classifierQuestionSets[0], ["done", "shape"]);
      assert.equal(positive.data?.dispatchOutcome, "completed");
      assert.equal(notifications.length, 0);
    }

    if (mode === "auto" && matrix.contextWindow === 872_000) {
      requestedTokens = matrix.ceilingTokens;
      await session.prompt("cooldown probe");
      let currentDecisions = (sessionManager.getBranch() as StoredEntry[])
        .filter((entry) => entry.customType === TRIGGER_DECISION_ENTRY_TYPE);
      assert.equal(currentDecisions.at(-1)?.data?.reason, "cooldown");
      assert.equal(beforeCompactCalls, 1);

      setNow(Date.now() + 301_000);
      requestedTokens = matrix.floorTokens;
      await session.prompt("rearm probe");
      currentDecisions = (sessionManager.getBranch() as StoredEntry[])
        .filter((entry) => entry.customType === TRIGGER_DECISION_ENTRY_TYPE);
      assert.equal(currentDecisions.at(-1)?.data?.reason, "rearm");
      assert.equal(beforeCompactCalls, 1);
      assert.equal(classifierCalls, 1);
    }
  } finally {
    session.dispose();
  }
}

test("Pi 1.0.3 consumer distinguishes offline hint and auto lifecycles for every adaptive window", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "a4s-pi-consumer-e2e-"));
  const originalHome = process.env.HOME;
  const originalOffline = process.env.PI_OFFLINE;
  const originalKey = process.env.TYPESAFE_API_KEY;
  const originalFetch = globalThis.fetch;
  const OriginalDate = Date;
  let currentTime = OriginalDate.parse("2026-10-01T12:00:00.000Z");

  class ControlledDate extends OriginalDate {
    constructor(value?: string | number | Date) {
      super(value === undefined ? currentTime : value);
    }
    static override now(): number {
      return currentTime;
    }
  }

  globalThis.Date = ControlledDate as DateConstructor;
  globalThis.fetch = async () => {
    throw new Error("network access is disabled in the Pi consumer E2E");
  };
  t.after(() => {
    globalThis.Date = OriginalDate;
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = originalOffline;
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = originalKey;
    rmSync(root, { recursive: true, force: true });
  });

  for (const mode of ["hint", "auto"] as const) {
    for (const matrix of WINDOWS) {
      currentTime += 1_000_000;
      await t.test(`${mode} ${matrix.contextWindow}`, async () => {
        await runScenario(root, mode, matrix, (value) => {
          currentTime = value;
        });
      });
    }
  }
});
