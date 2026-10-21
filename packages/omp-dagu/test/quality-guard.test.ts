import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { inspectImplementer, inspectVerdict, qualityDecision, qualityMarker } from "../src/triage/quality.ts";
import type { TranscriptRow } from "../src/triage/quality.ts";
import { qualityFixture, readQualityPolicies } from "./quality-fixtures.ts";

function fixture(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-quality-guard-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const primary = join(root, "primary space");
  const worktree = join(primary, ".workspace", "worktrees", "issue-189");
  const state = join(primary, ".git", "dagu-feature", "runs", "test-run");
  execFileSync("git", ["init", "--quiet", primary]);
  mkdirSync(worktree, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "candidate.json"), JSON.stringify({ sha: "a".repeat(40), iteration: 0, implementer: "ImplementTest" }));
  return { ...qualityFixture({ root, primary, worktree, state }), primary, state };
}

for (const primarySource of ["adopted env literal", "resolvedPrimary", "historical param"]) {
  test(`quality spawn and completion resolve PRIMARY from ${primarySource}`, async t => {
    const f = fixture(t);
    const requests: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/spec")) return new Response(JSON.stringify({ spec: `env:\n  - PRIMARY: ${JSON.stringify(f.primary)}\n` }));
      return new Response(JSON.stringify({ dagRunDetails: {
        params: `ISSUE=189 OMP_SESSION_ID=parent-id${primarySource === "historical param" ? ` PRIMARY=${f.primary}` : ""}`,
        ...(primarySource === "resolvedPrimary" ? { resolvedPrimary: f.primary } : {}),
        nodes: [{ step: { id: "implement" }, startedAt: f.request.implementStartedAt }],
      } }));
    });
    const ctx = { cwd: f.primary, sessionManager: { getSessionDir: () => dirname(f.parent) }, models: f.models };
    for (const [agent, name] of [["qa", "QATest"], ["reviewer", "ReviewTest"]] as const) {
      const decision = await qualityDecision({ toolName: "task", toolCallId: `spawn-${name}`, input: {
        agent, name, task: qualityMarker(f.request, agent),
      } }, ctx, readQualityPolicies);
      assert.ok(decision && "input" in decision, JSON.stringify(decision));
      assert.ok(decision.input.outputSchema);
    }
    // A plugin reload appends the same assignment to an otherwise completed child.
    const child: TranscriptRow[] = readFileSync(f.paths.qa!, "utf8").trim().split("\n").map(line => JSON.parse(line));
    child.push({ ...child[1]!, timestamp: "2026-10-16T02:00:00Z" });
    writeFileSync(f.paths.qa!, child.map(row => JSON.stringify(row)).join("\n") + "\n");
    const completion = await qualityDecision({ toolName: "bash", toolCallId: "complete", input: {
      command: "dagu human-task complete feature --run-id test-run --step quality_review --input QA=QATest --input REVIEW=ReviewTest",
    } }, ctx);
    assert.equal(completion, undefined);
    const evidence = JSON.parse(readFileSync(join(f.state, "quality.json"), "utf8"));
    assert.equal(evidence.action, "complete");
    assert.equal(evidence.verdicts.length, 2);
    assert.equal(requests.filter(url => url.endsWith("/spec")).length, primarySource === "adopted env literal" ? 3 : 0);
  });
}

for (const scenario of ["configured fallback", "exhausted", "missing policy", "malformed initial config", "native reader unavailable"]) {
  test(`quality preflight preserves independent safety with ${scenario}`, async t => {
    const f = fixture(t);
    t.mock.method(globalThis, "fetch", async () => Response.json({ dagRunDetails: {
      params: `PRIMARY=${f.primary} ISSUE=189 OMP_SESSION_ID=parent-id`,
      nodes: [{ step: { id: "implement" }, startedAt: f.request.implementStartedAt }],
    } }));
    const models = {
      ...f.models,
      resolve: (spec: string) => spec === "@custom" ? f.models.resolve("anthropic/alternate")
        : ["@slow", "@default", "@task"].includes(spec) ? f.models.resolve("openai-codex/effective") : f.models.resolve(spec),
    };
    const decision = await qualityDecision({ toolName: "task", toolCallId: "policy-preflight", input: {
      agent: "qa", name: "ConfiguredQuality359", task: qualityMarker(f.request, "qa"),
    } }, { cwd: f.primary, sessionManager: { getSessionDir: () => dirname(f.parent) }, models }, scenario === "native reader unavailable" ? undefined : () => {
      if (scenario === "malformed initial config") throw new Error("crossFamilyReview.policies: invalid policy");
      return scenario === "missing policy" ? {} : {
        qa: { fallbackRoles: scenario === "configured fallback" ? ["@custom"] : [], excludeTaskFamily: true },
      };
    });
    if (scenario === "configured fallback") assert.ok(decision && "input" in decision);
    else {
      assert.ok(decision && "block" in decision && decision.block);
      assert.match(decision.reason, /QUALITY_BLOCKED:.*(EXHAUSTED|requires a configured|invalid policy|settings reader required)/);
    }
  });
}

for (const role of ["implementer", "qa", "reviewer"] as const) {
  for (const change of ["identical", "agent", "task", "stale first timestamp"] as const) {
    test(`${role} session_init repetition: ${change}`, t => {
      const f = fixture(t);
      const path = f.paths[role]!;
      const rows: TranscriptRow[] = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
      const init = rows[1]!;
      rows.push({ ...init, timestamp: "2026-10-16T02:00:00Z",
        ...(change === "agent" ? { agent: "other-agent" } : {}),
        ...(change === "task" ? { task: `${init.task} changed assignment` } : {}),
      });
      if (change === "stale first timestamp") init.timestamp = "2026-10-15T00:00:00Z";
      writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
      const inspect = () => role === "implementer"
        ? inspectImplementer(f.parent, f.request, f.models)
        : inspectVerdict(f.parent, f.request, role, role === "qa" ? "QATest" : "ReviewTest", f.models);
      if (change === "identical") assert.doesNotThrow(inspect);
      else assert.throws(inspect, change === "stale first timestamp" ? /stale invocation/ : /ambiguous session identity/);
    });
  }
}

for (const [form, command] of [
  ["feature first", "dagu human-task complete feature --run-id test-run --step implement --input IMPLEMENTER=ImplementTest"],
  ["documented feature last", "dagu human-task complete --run-id test-run --step implement --input SUMMARY='change summary' --input MESSAGE='fix(dagu): reject stale implementers before implement completion' --input IMPLEMENTER='ImplementTest' feature"],
  ["equals flags", 'dagu human-task complete --input="SUMMARY=change summary" --step=implement --input=IMPLEMENTER=ImplementTest --run-id=test-run --input="MESSAGE=fix(dagu): reject stale implementers" feature'],
  ["interleaved flags", "dagu human-task complete --input SUMMARY='delivery for --run-id wrong-run with IMPLEMENTER=Other feature' --step implement feature --input IMPLEMENTER=ImplementTest --input MESSAGE='fix: current delivery' --run-id test-run"],
  ["documented line continuations", "dagu human-task complete --run-id test-run --step implement \\\n  --input SUMMARY='change summary' --input MESSAGE='fix(dagu): reject stale implementers' \\\n  --input IMPLEMENTER='ImplementTest' feature"],
  ["boolean and short flags", "dagu human-task complete --quiet --input SUMMARY='feature delivery' --step implement feature -r test-run --input MESSAGE='fix: current delivery' --input IMPLEMENTER=ImplementTest"],
  ["attached short run id", "dagu human-task complete feature -rtest-run --step implement --input SUMMARY='change # summary' --input MESSAGE='fix: current delivery' --input IMPLEMENTER=ImplementTest"],
] as const) {
  for (const offset of [-695, 0, 1]) {
    test(`${form} implement completion enforces first-init cutoff offset ${offset}ms`, async t => {
      const f = fixture(t);
      const cutoff = Date.parse(f.request.implementStartedAt);
      const child: TranscriptRow[] = readFileSync(f.paths.implementer!, "utf8").trim().split("\n").map(line => JSON.parse(line));
      child[1]!.timestamp = new Date(cutoff + offset).toISOString();
      child.push({ ...child[1]!, timestamp: new Date(cutoff + 5000).toISOString() });
      writeFileSync(f.paths.implementer!, child.map(row => JSON.stringify(row)).join("\n") + "\n");
      const parent: TranscriptRow[] = readFileSync(f.parent, "utf8").trim().split("\n").map(line => JSON.parse(line));
      parent[1]!.timestamp = new Date(cutoff - 1000).toISOString();
      writeFileSync(f.parent, parent.map(row => JSON.stringify(row)).join("\n") + "\n");
      const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ dagRunDetails: {
        statusLabel: "waiting", resolvedPrimary: f.primary,
        params: "ISSUE=189 OMP_SESSION_ID=parent-id",
        nodes: [{ step: { id: "implement" }, statusLabel: "waiting", startedAt: f.request.implementStartedAt }],
      } })));
      const decision = await qualityDecision({ toolName: "bash", toolCallId: "complete-implement", input: {
        command,
      } }, { cwd: f.primary, sessionManager: { getSessionDir: () => dirname(f.parent) }, models: f.models });
      assert.equal(fetchMock.mock.callCount(), 1);
      if (offset > 0) {
        assert.equal(decision, undefined);
      } else {
        assert.ok(decision && "block" in decision && decision.block);
        assert.match(decision.reason!, /IMPLEMENT_BLOCKED: stale invocation.*Implement<issue>v<N>.*Waiting implement/);
      }
    });
  }
}

for (const [form, suffix] of [
  ["single quoted hash", "--input SUMMARY='quoted # text'"],
  ["double quoted hash", '--input SUMMARY="quoted # text"'],
  ["escaped hash", "--input SUMMARY=escaped\\#text"],
  ["embedded hash", "--input SUMMARY=foo#bar"],
  ["fresh id before comment", "--input SUMMARY=s # --input IMPLEMENTER=StaleId"],
  ["terminal newline after comment", "--input SUMMARY=s # --input IMPLEMENTER=StaleId\n"],
  ["terminal newline", "--input SUMMARY=s\n"],
  ["continued comment", "--input SUMMARY=s \\\n # --input IMPLEMENTER=StaleId"],
] as const) {
  test(`literal implement completion preserves ${form}`, async t => {
    const f = fixture(t);
    const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({ dagRunDetails: {
      statusLabel: "waiting", resolvedPrimary: f.primary, params: "ISSUE=189 OMP_SESSION_ID=parent-id",
      nodes: [{ step: { id: "implement" }, statusLabel: "waiting", startedAt: f.request.implementStartedAt }],
    } }));
    const decision = await qualityDecision({ toolName: "bash", toolCallId: "hash", input: {
      command: `dagu human-task complete feature --run-id test-run --step implement --input IMPLEMENTER=ImplementTest ${suffix}`,
    } }, { cwd: f.primary, sessionManager: { getSessionDir: () => dirname(f.parent) }, models: f.models });
    assert.equal(decision, undefined);
    assert.equal(fetchMock.mock.callCount(), 1);
  });
}

test("commented fresh id cannot replace the effective stale implementer", async t => {
  const f = fixture(t);
  const child: TranscriptRow[] = readFileSync(f.paths.implementer!, "utf8").trim().split("\n").map(line => JSON.parse(line));
  child[1]!.timestamp = f.request.implementStartedAt;
  writeFileSync(f.paths.implementer!, child.map(row => JSON.stringify(row)).join("\n") + "\n");
  t.mock.method(globalThis, "fetch", async () => Response.json({ dagRunDetails: {
    statusLabel: "waiting", resolvedPrimary: f.primary, params: "ISSUE=189 OMP_SESSION_ID=parent-id",
    nodes: [{ step: { id: "implement" }, statusLabel: "waiting", startedAt: f.request.implementStartedAt }],
  } }));
  const decision = await qualityDecision({ toolName: "bash", toolCallId: "stale-comment", input: {
    command: "dagu human-task complete feature --run-id test-run --step implement --input IMPLEMENTER=ImplementTest # --input IMPLEMENTER=FreshId",
  } }, { cwd: f.primary, sessionManager: { getSessionDir: () => dirname(f.parent) }, models: f.models });
  assert.ok(decision && "block" in decision && decision.block);
  assert.match(decision.reason!, /IMPLEMENT_BLOCKED: stale invocation/);
});

for (const suffix of [
  "\n--input IMPLEMENTER=ImplementTest",
  "; --input IMPLEMENTER=ImplementTest",
  " && --input IMPLEMENTER=ImplementTest",
  " || dagu human-task complete feature --run-id test-run --step implement --input IMPLEMENTER=ImplementTest",
  " | cat",
  " > /tmp/implement-output",
  ' --input SUMMARY="$SUMMARY"',
  " --input SUMMARY=`printf summary`",
  " --input SUMMARY=summary*",
  " --input SUMMARY='unfinished",
] as const) {
  test(`feature implement completion fails closed for nonliteral syntax ${JSON.stringify(suffix)}`, async t => {
    const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("literal syntax admission precedes HTTP"); });
    const decision = await qualityDecision({ toolName: "bash", toolCallId: "boundary", input: {
      command: `dagu human-task complete feature --run-id test-run --step implement --input IMPLEMENTER=StaleId${suffix}`,
    } }, { cwd: "/unrelated", sessionManager: { getSessionDir: () => "/unrelated" } });
    assert.ok(decision && "block" in decision && decision.block);
    assert.match(decision.reason!, /IMPLEMENT_BLOCKED: one literal implement completion command required/);
    assert.equal(fetchMock.mock.callCount(), 0);
  });
}

for (const form of ["two calls", "fresh decoy", "parenthesized fresh decoy"] as const) {
  test(`nested Eval rejects ${form} before lookup or stale execution`, async t => {
    const f = fixture(t);
    const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({ dagRunDetails: {
      statusLabel: "waiting", resolvedPrimary: f.primary, params: "ISSUE=189 OMP_SESSION_ID=parent-id",
      nodes: [{ step: { id: "implement" }, statusLabel: "waiting", startedAt: f.request.implementStartedAt }],
    } }));
    const fresh = "dagu human-task complete feature --run-id test-run --step implement --input IMPLEMENTER=ImplementTest";
    const stale = fresh.replace("ImplementTest", "StaleId");
    const code = form === "two calls" ? `await bash(${JSON.stringify(fresh)}); await bash(${JSON.stringify(stale)})`
      : form === "fresh decoy" ? `if (false) await bash(${JSON.stringify(fresh)}); await bash(${JSON.stringify(stale)})`
      : `(false && await bash(${JSON.stringify(fresh)})); (await bash(${JSON.stringify(stale)}))`;
    const decision = await qualityDecision({ toolName: "eval", toolCallId: "ambiguous", input: { code } },
      { cwd: f.primary, sessionManager: { getSessionDir: () => dirname(f.parent) }, models: f.models });
    // Model the consumer: only an admitted Eval reaches its shell executor.
    const executed: string[] = [];
    if (!decision || !("block" in decision && decision.block)) {
      const execute = new Function("bash", `return (async () => { ${code} })()`);
      await execute(async (command: string) => { executed.push(command); });
    }
    assert.deepEqual(executed, [], "ambiguous Eval must not execute the later stale completion");
    assert.ok(decision && "block" in decision && decision.block);
    assert.match(decision.reason!, /IMPLEMENT_BLOCKED: one literal implement completion command required/);
    assert.equal(fetchMock.mock.callCount(), 0);
  });
}

test("single nested Eval literal remains supported", async t => {
  const f = fixture(t);
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({ dagRunDetails: {
    statusLabel: "waiting", resolvedPrimary: f.primary, params: "ISSUE=189 OMP_SESSION_ID=parent-id",
    nodes: [{ step: { id: "implement" }, statusLabel: "waiting", startedAt: f.request.implementStartedAt }],
  } }));
  assert.equal(await qualityDecision({ toolName: "eval", toolCallId: "single", input: {
    code: '(await bash("dagu human-task complete feature --run-id test-run --step implement --input IMPLEMENTER=ImplementTest"))',
  } }, { cwd: f.primary, sessionManager: { getSessionDir: () => dirname(f.parent) }, models: f.models }), undefined);
  assert.equal(fetchMock.mock.callCount(), 1);
});

const evalWrappers: [string, (command: string) => string][] = [
  ["double quoted string", command => `await bash(${JSON.stringify(command)})`],
  ["single quoted string", command => `await bash('${command}')`],
  ["static backtick argument", command => `await bash(\`${command}\`)`],
  ["Bun tagged template", command => `await Bun.$\`${command}\``],
  ["assigned tagged template", command => `const result = await $\`${command}\`;`],
  ["hash in block comment", command => `/* # "ignored" */ await bash(${JSON.stringify(command)})`],
  ["hash in line comment", command => `// # ignored\n(await bash(${JSON.stringify(command)}));`],
  ["hash in trailing comment", command => `await bash(${JSON.stringify(command)}) /* # */`],
];

for (const [form, wrap] of evalWrappers) {
  for (const offset of [-695, 0, 1]) {
    test(`Eval ${form} uses actual literal provenance at ${offset}ms`, async t => {
      const f = fixture(t);
      const cutoff = Date.parse(f.request.implementStartedAt);
      const child: TranscriptRow[] = readFileSync(f.paths.implementer!, "utf8").trim().split("\n").map(line => JSON.parse(line));
      child[1]!.timestamp = new Date(cutoff + offset).toISOString();
      writeFileSync(f.paths.implementer!, child.map(row => JSON.stringify(row)).join("\n") + "\n");
      const parent: TranscriptRow[] = readFileSync(f.parent, "utf8").trim().split("\n").map(line => JSON.parse(line));
      parent[1]!.timestamp = new Date(cutoff - 1000).toISOString();
      writeFileSync(f.parent, parent.map(row => JSON.stringify(row)).join("\n") + "\n");
      const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({ dagRunDetails: {
        statusLabel: "waiting", resolvedPrimary: f.primary, params: "ISSUE=189 OMP_SESSION_ID=parent-id",
        nodes: [{ step: { id: "implement" }, statusLabel: "waiting", startedAt: f.request.implementStartedAt }],
      } }));
      const command = "dagu human-task complete feature --run-id test-run --step implement --input IMPLEMENTER=ImplementTest";
      const code = wrap(command);
      const decision = await qualityDecision({ toolName: "eval", toolCallId: "literal-consumer", input: { code } },
        { cwd: f.primary, sessionManager: { getSessionDir: () => dirname(f.parent) }, models: f.models });
      const executed: string[] = [];
      const execute = async (input: string | TemplateStringsArray) => { executed.push(typeof input === "string" ? input : input[0]!); };
      if (!decision || !("block" in decision && decision.block)) {
        await new Function("bash", "Bun", "$", `return (async () => { ${code} })()`)(execute, { $: execute }, execute);
      }
      assert.equal(fetchMock.mock.callCount(), 1);
      assert.deepEqual(executed, offset > 0 ? [command] : []);
      if (offset > 0) assert.equal(decision, undefined);
      else {
        assert.ok(decision && "block" in decision && decision.block);
        assert.match(decision.reason, /IMPLEMENT_BLOCKED: stale invocation/);
      }
    });
  }
}

test("Eval inspects decoded shell quoting and hashes", async t => {
  const f = fixture(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({ dagRunDetails: {
    statusLabel: "waiting", resolvedPrimary: f.primary, params: "ISSUE=189 OMP_SESSION_ID=parent-id",
    nodes: [{ step: { id: "implement" }, statusLabel: "waiting", startedAt: f.request.implementStartedAt }],
  } }));
  const command = 'dagu human-task complete feature --run-id test-run --step implement --input IMPLEMENTER=ImplementTest --input SUMMARY="quoted # text"';
  assert.equal(await qualityDecision({ toolName: "eval", toolCallId: "decoded", input: {
    code: `/* # */ await bash(${JSON.stringify(command)})`,
  } }, { cwd: f.primary, sessionManager: { getSessionDir: () => dirname(f.parent) }, models: f.models }), undefined);
});

for (const [form, wrap] of [
  ["dynamic template", (c: string) => `await Bun.$\`${c} \${suffix}\``],
  ["concatenation", (c: string) => `await bash(${JSON.stringify(c)} + suffix)`],
  ["command variable", (c: string) => `const command = ${JSON.stringify(c)}; await bash(command)`],
  ["unquoted visible command", (c: string) => `await bash(${c})`],
  ["split visible arguments", (c: string) => `await bash(${JSON.stringify(c.split(" ").slice(0, 3).join(" "))}, "feature", "--step", "implement")`],
  ["unsupported JS escape", (c: string) => `await bash("${c} --input SUMMARY=\\x41")`],
  ["unfinished string", (c: string) => `await bash("${c})`],
  ["unfinished comment", (c: string) => `/* # await bash("${c}")`],
  ["alternate wrapper", (c: string) => `await bash({ command: ${JSON.stringify(c)} })`],
  ["tagged fresh decoy", (c: string) => `if (false) await Bun.$\`${c}\`; await bash(\`${c.replace("ImplementTest", "StaleId")}\`)`],
  ["commented fresh decoy", (c: string) => `/* await bash("${c}") */ await bash(\`${c.replace("ImplementTest", "StaleId")}\` + suffix)`],
] as const) {
  test(`visible Eval ${form} fails closed before lookup and execution`, async t => {
    const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("guard precedes lookup"); });
    const command = "dagu human-task complete feature --run-id test-run --step implement --input IMPLEMENTER=ImplementTest";
    const decision = await qualityDecision({ toolName: "eval", toolCallId: "visible", input: { code: wrap(command) } },
      { cwd: "/unrelated", sessionManager: { getSessionDir: () => "/unrelated" } });
    const executed: string[] = [];
    if (!decision || !("block" in decision && decision.block)) executed.push("consumer reached");
    assert.deepEqual(executed, []);
    assert.ok(decision && "block" in decision && decision.block);
    assert.match(decision.reason, /IMPLEMENT_BLOCKED: one literal implement completion command required/);
    assert.equal(fetchMock.mock.callCount(), 0);
  });
}

test("unrecognized visible Bash implement intent fails closed before lookup", async t => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("guard precedes lookup"); });
  for (const command of [
    'dagu "human-task complete" feature --run-id test-run --step implement --input IMPLEMENTER=ImplementTest',
    'dagu human-task "complete feature" --run-id test-run --step implement --input IMPLEMENTER=ImplementTest',
    'dagu human-task complete "$DAG" --run-id test-run --step implement --input IMPLEMENTER=ImplementTest',
    'dagu human-task complete feature --run-id test-run --step "${STEP:-implement}" --input IMPLEMENTER=ImplementTest',
  ]) {
    const decision = await qualityDecision({ toolName: "bash", toolCallId: "visible-bash", input: { command } },
      { cwd: "/unrelated", sessionManager: { getSessionDir: () => "/unrelated" } });
    assert.ok(decision && "block" in decision && decision.block);
    assert.match(decision.reason, /IMPLEMENT_BLOCKED: one literal implement completion command required/);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

for (const failure of ["wrong run", "missing allocation", "ambiguous allocation", "wrong allocated agent", "unfinished"]) {
  test(`implement completion rejects ${failure}`, async t => {
    const f = fixture(t);
    const child: TranscriptRow[] = readFileSync(f.paths.implementer!, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const parent: TranscriptRow[] = readFileSync(f.parent, "utf8").trim().split("\n").map(line => JSON.parse(line));
    if (failure === "wrong run") child[1]!.task += "-other";
    if (failure === "missing allocation") parent.splice(1, 1);
    if (failure === "ambiguous allocation") parent.push(parent[1]!);
    if (failure === "wrong allocated agent") child[1]!.agent = "other-agent";
    if (failure === "unfinished") child.at(-1)!.message!.stopReason = "toolUse";
    writeFileSync(f.paths.implementer!, child.map(row => JSON.stringify(row)).join("\n") + "\n");
    writeFileSync(f.parent, parent.map(row => JSON.stringify(row)).join("\n") + "\n");
    t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ dagRunDetails: {
      statusLabel: "waiting", resolvedPrimary: f.primary, params: "ISSUE=189 OMP_SESSION_ID=parent-id",
      nodes: [{ step: { id: "implement" }, statusLabel: "waiting", startedAt: f.request.implementStartedAt }],
    } })));
    const decision = await qualityDecision({ toolName: "eval", toolCallId: "complete", input: {
      code: 'await bash("dagu human-task complete feature --run-id test-run --step implement --input IMPLEMENTER=ImplementTest")',
    } }, { cwd: f.primary, sessionManager: { getSessionDir: () => dirname(f.parent) }, models: f.models });
    assert.ok(decision && "block" in decision && decision.block);
    assert.match(decision.reason!, /IMPLEMENT_BLOCKED:.*launch a new Implement<issue>v<N>/);
    assert.throws(() => inspectImplementer(f.parent, f.request, f.models));
  });
}

test("other DAG implement completion preserves its own workflow without feature lookup", async t => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("feature lookup is outside this workflow"); });
  for (const command of [
    "dagu human-task complete discovery --run-id discovery-run --step implement",
    "dagu human-task complete --run-id discovery-run --step implement discovery",
    "dagu human-task complete discovery --run-id discovery-run --step implement --input SUMMARY='feature' --input MESSAGE='fix: deliver feature changes' --input IMPLEMENTER=Other",
    "dagu human-task complete --input='SUMMARY=feature' --run-id=discovery-run --step=implement --input='MESSAGE=feature delivery' --input=IMPLEMENTER=Other discovery",
    "dagu human-task complete --config feature --input SUMMARY='human-task complete feature --step implement' --run-id discovery-run --step implement discovery",
    "echo safe # dagu human-task complete feature --run-id test-run --step implement --input IMPLEMENTER=Other",
  ]) {
    const decision = await qualityDecision({ toolName: "bash", toolCallId: "other-dag", input: { command } },
      { cwd: "/unrelated", sessionManager: { getSessionDir: () => { throw new Error("feature session lookup is outside this workflow"); } } });
    assert.equal(decision, undefined);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

