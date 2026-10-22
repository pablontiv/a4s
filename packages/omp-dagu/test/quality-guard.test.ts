import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { registerReviewHook } from "@a4s/omp-cross-family-review";
import { inspectImplementer, inspectVerdict, qualityDecision, qualityMarker, verifyQuality } from "../src/triage/quality.ts";
import type { TranscriptRow } from "../src/triage/quality.ts";
import { nativeQualityFixture, qualityFixture, readQualityPolicies } from "./quality-fixtures.ts";
import { nativeEvidence } from "../src/role-runtime.ts";

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

function changeRows(path: string, change: (rows: TranscriptRow[]) => void) {
  const rows: TranscriptRow[] = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
  change(rows);
  writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
}

function mixedFixture(t: test.TestContext) {
  const first = fixture(t);
  const second = fixture(t);
  second.state = join(dirname(second.state), "other-run");
  mkdirSync(second.state);
  Object.assign(second.request, { run: "other-run", sha: "b".repeat(40), iteration: 2,
    attempt: "1792112400.123456", implementer: "ImplementOther" });
  writeFileSync(join(second.state, "quality-request.json"), JSON.stringify(second.request));
  writeFileSync(join(second.state, "candidate.json"), JSON.stringify({
    sha: second.request.sha, iteration: second.request.iteration, implementer: second.request.implementer,
  }));
  const names = { implementer: "ImplementOther", qa: "QAOther", reviewer: "ReviewOther" };
  const parentRows: TranscriptRow[] = [];
  for (const role of ["implementer", "qa", "reviewer"] as const) {
    const name = names[role];
    const marker = role === "implementer" ? `FEATURE_IMPLEMENT RUN=${second.request.run}` : qualityMarker(second.request, role);
    const provider = role === "implementer" ? "anthropic" : "openai-codex";
    const model = role === "implementer" ? "alternate" : "effective";
    const path = join(first.parent.slice(0, -6), `${name}.jsonl`);
    writeFileSync(path, readFileSync(second.paths[role]!));
    changeRows(path, rows => {
      rows[0]!.id = `child-${name}`;
      rows[0]!.parentSession = first.parent;
      rows[1]!.task = marker;
      rows[1]!.timestamp = "2026-10-16T01:00:02Z";
      rows[2]!.role = `subagent:${name}`;
      rows[2]!.model = `${provider}/${model}`;
      for (const row of rows) if (row.message?.role === "assistant") Object.assign(row.message, { provider, model });
      rows[4]!.message!.content = second.request.sha;
      rows.at(-1)!.message!.content = JSON.stringify({ repo: second.request.repo, run: second.request.run,
        sha: second.request.sha, iteration: second.request.iteration, attempt: second.request.attempt,
        role, verdict: "PASS", findings: ["Other candidate checked"] });
    });
    second.paths[role] = path;
    parentRows.push({ type: "message", timestamp: "2026-10-16T01:00:01Z", message: {
      role: "assistant", content: [{ type: "toolCall", id: `invoke-${name}`, name: "task",
        arguments: { tasks: [{ name, agent: role === "implementer" ? "task" : role, task: marker }] } }],
    } });
  }
  changeRows(first.parent, rows => { rows.push(...parentRows); });
  second.parent = first.parent;
  const all = [first, second];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const f = all.find(item => String(input).endsWith(`/${item.request.run}`));
    assert.ok(f, `unexpected quality request ${input}`);
    return Response.json({ dagRunDetails: {
      resolvedPrimary: f.primary, params: "ISSUE=189 OMP_SESSION_ID=parent-id",
      nodes: [{ step: { id: "implement" }, startedAt: f.request.implementStartedAt }],
    } });
  });
  const models = { ...first.models, resolve: (spec: string) =>
    first.models.resolve(spec === "@default" ? "openai-codex/effective" : spec) };
  const ctx = { cwd: first.primary, sessionManager: { getSessionDir: () => dirname(first.parent) }, models };
  const tasks = all.flatMap((f, index) => (["qa", "reviewer"] as const).map(agent => ({
    name: index === 0 ? agent === "qa" ? "QABatch" : "ReviewBatch" : agent === "qa" ? "QAOtherBatch" : "ReviewOtherBatch",
    agent, task: `${qualityMarker(f.request, agent)}\nInspect this candidate independently.`,
  })));
  return { first, second, all, ctx, tasks };
}

for (const reversed of [false, true]) {
  test(`mixed-run quality batch binds every assignment independently (${reversed ? "reverse" : "forward"})`, async t => {
    const f = mixedFixture(t);
    const unrelated = { name: "Unrelated", agent: "task", task: "Inspect unrelated documentation", custom: "preserved" };
    const tasks = reversed ? [...f.tasks].reverse() : f.tasks;
    const input = { context: "Shared acceptance context", tasks: [unrelated, ...tasks], custom: "native batch" };
    const decision = await qualityDecision({ toolName: "task", toolCallId: "mixed", input }, f.ctx, readQualityPolicies);
    assert.ok(decision && "input" in decision, JSON.stringify(decision));
    assert.equal(decision.input.context, input.context);
    assert.equal(decision.input.custom, input.custom);
    assert.deepEqual(decision.input.tasks[0], unrelated);
    let hook: ((event: { agent: string; patterns: string[]; spawnKey: string }, ctx: unknown) => { model?: string[] }) | undefined;
    registerReviewHook({ on: (_event: string, handler: typeof hook) => { hook = handler; } } as never, readQualityPolicies);
    for (const task of decision.input.tasks.slice(1)) {
      const source = f.all.find(item => task.task.includes(qualityMarker(item.request, task.agent)))!;
      assert.ok(source);
      assert.ok(task.outputSchema);
      assert.ok(task.task.includes(`git -C "${source.request.worktree}" rev-parse HEAD`));
      const contract = JSON.parse(task.task.split("\n").find((line: string) => line.startsWith("{"))!);
      assert.deepEqual(contract, { repo: source.request.repo, run: source.request.run, sha: source.request.sha,
        iteration: source.request.iteration, attempt: source.request.attempt, role: task.agent, verdict: "PASS", findings: [] });
      const selected = hook!({ agent: task.agent, spawnKey: task.name, patterns: ["openai-codex/effective", "anthropic/alternate"] }, f.ctx);
      assert.ok(selected.model?.length);
      assert.ok(selected.model.every(spec => f.ctx.models.resolve(spec)?.provider === (source === f.first ? "anthropic" : "openai-codex")));
    }
    assert.deepEqual(input.tasks, [unrelated, ...tasks], "native input stays immutable");
  });
}

test("same-run QA/reviewer batch and a shared single-task marker preserve context", async t => {
  const f = mixedFixture(t);
  const decision = await qualityDecision({ toolName: "task", toolCallId: "same-run", input: {
    context: "Shared instructions", tasks: f.tasks.slice(0, 2),
  } }, f.ctx, readQualityPolicies);
  assert.ok(decision && "input" in decision);
  assert.equal(decision.input.context, "Shared instructions");
  assert.equal(decision.input.tasks.length, 2);
  const single = await qualityDecision({ toolName: "task", toolCallId: "shared", input: {
    context: qualityMarker(f.first.request, "qa"), agent: "qa", name: "SharedQA", task: "Run acceptance",
  } }, f.ctx, readQualityPolicies);
  assert.ok(single && "input" in single);
  assert.equal(single.input.context, qualityMarker(f.first.request, "qa"));
  assert.ok(single.input.task.startsWith("Run acceptance\n"));
});

for (const failure of [
  "candidate", "repo", "worktree", "coordinator", "cutoff", "sha", "iteration", "attempt", "role",
  "marker suffix", "ambiguous marker", "missing name", "invalid name", "duplicate name", "implementer name",
  "stale implementer", "unknown implementer", "missing policy", "exhausted models", "prose marker",
] as const) {
  test(`mixed-run batch fails closed for one assignment: ${failure}`, async t => {
    const f = mixedFixture(t);
    const request = { ...f.second.request };
    const tasks: Record<string, unknown>[] = f.tasks.map(task => ({ ...task, name: `${task.name}-${failure.replaceAll(" ", "-")}` }));
    const target = tasks[2]!;
    if (failure === "candidate") writeFileSync(join(f.second.state, "candidate.json"), JSON.stringify({ sha: "c".repeat(40), iteration: 2, implementer: request.implementer }));
    if (failure === "repo") request.repo = f.first.primary;
    if (failure === "worktree") request.worktree = f.first.request.worktree;
    if (failure === "coordinator") request.session = "another-parent";
    if (failure === "cutoff") request.implementStartedAt = "2026-10-15T00:00:00Z";
    if (["repo", "worktree", "coordinator", "cutoff"].includes(failure)) writeFileSync(join(f.second.state, "quality-request.json"), JSON.stringify(request));
    if (failure === "sha") target.task = qualityMarker({ ...request, sha: f.first.request.sha }, "qa");
    if (failure === "iteration") target.task = qualityMarker({ ...request, iteration: 0 }, "qa");
    if (failure === "attempt") target.task = qualityMarker({ ...request, attempt: f.first.request.attempt }, "qa");
    if (failure === "role") target.agent = "task";
    if (failure === "marker suffix") target.task = qualityMarker(request, "qa") + "-other";
    if (failure === "ambiguous marker") target.task += `\n${qualityMarker(f.first.request, "qa")}`;
    if (failure === "missing name") delete target.name;
    if (failure === "invalid name") target.name = "../QA";
    if (failure === "duplicate name") target.name = tasks[0]!.name;
    if (failure === "implementer name") target.name = request.implementer;
    if (failure === "stale implementer") changeRows(f.second.paths.implementer!, rows => { rows[1]!.timestamp = request.implementStartedAt; });
    if (failure === "unknown implementer") changeRows(f.second.paths.implementer!, rows => { rows.at(-1)!.message!.model = "not-in-catalog"; });
    if (failure === "prose marker") tasks.push({ name: "UnrelatedProse", agent: "task", task: "Explain the FEATURE_QUALITY RUN= marker in prose" });
    const preserved = f.all.flatMap(item => ["candidate.json", "quality-request.json"].map(name => {
      const path = join(item.state, name);
      return { path, contents: readFileSync(path, "utf8") };
    }));
    const decision = await qualityDecision({ toolName: "task", toolCallId: "invalid-mixed", input: { tasks } }, f.ctx, () => ({
      ...(failure === "missing policy" ? {} : readQualityPolicies()),
      ...(failure === "exhausted models" ? { qa: { fallbackRoles: [], excludeTaskFamily: true } } : {}),
    }));
    // @slow is anthropic, so only the second run exhausts with no fallback.
    assert.ok(decision && "block" in decision && decision.block, JSON.stringify(decision));
    assert.match(decision.reason, /^QUALITY_BLOCKED:.*local candidate retained$/);
    for (const entry of preserved) assert.equal(readFileSync(entry.path, "utf8"), entry.contents);
    assert.equal(tasks[0]!.task, f.tasks[0]!.task);
    let hook: ((event: { agent: string; patterns: string[]; spawnKey: string }, ctx: unknown) => { model?: string[] }) | undefined;
    registerReviewHook({ on: (_event: string, handler: typeof hook) => { hook = handler; } } as never,
      () => ({ qa: { ...readQualityPolicies().qa, excludeTaskFamily: false } }));
    const models = { ...f.ctx.models, current: () => f.ctx.models.resolve("anthropic/alternate") };
    const selected = hook!({ agent: "qa", spawnKey: tasks[0]!.name as string,
      patterns: ["openai-codex/effective", "anthropic/alternate"] }, { ...f.ctx, models });
    assert.ok(selected.model?.length);
    assert.ok(selected.model.every(spec => models.resolve(spec)?.provider === "openai-codex"),
      "a blocked batch must not install partial quality authorizations");
  });
}

async function dispatchedFixture(t: test.TestContext) {
  const f = mixedFixture(t);
  const routed = await qualityDecision({ toolName: "task", toolCallId: "native-mixed", input: { tasks: f.tasks } }, f.ctx, readQualityPolicies);
  assert.ok(routed && "input" in routed, JSON.stringify(routed));
  const tasks = routed.input.tasks as { name: string; agent: "qa" | "reviewer"; task: string }[];
  // Persist the native parent invocation and child outputs at the same boundary
  // consumed by verdict admission. This fixture is not a live native dispatch.
  changeRows(f.first.parent, rows => {
    rows.splice(0, rows.length, rows[0]!, ...rows.filter(row => JSON.stringify(row).includes("FEATURE_IMPLEMENT RUN=")),
      { type: "message", timestamp: "2026-10-16T01:00:01Z", message: {
        role: "assistant", content: [{ type: "toolCall", name: "task", id: "native-mixed", arguments: { tasks } }],
      } });
  });
  for (const task of tasks) {
    const source = f.all.find(item => task.task.includes(qualityMarker(item.request, task.agent)))!;
    const oldPath = source.paths[task.agent]!;
    const path = join(f.first.parent.slice(0, -6), `${task.name}.jsonl`);
    writeFileSync(path, readFileSync(oldPath));
    source.paths[task.agent] = path;
    changeRows(path, rows => {
      rows[0]!.id = `child-${task.name}`;
      rows[1]!.task = task.task;
      rows[2]!.role = `subagent:${task.name}`;
      const report = JSON.parse(task.task.split("\n").find(line => line.startsWith("{"))!);
      rows.at(-1)!.message!.content = JSON.stringify({ ...report, findings: ["Bound candidate inspected"] });
    });
  }
  const complete = (index: number, qa = tasks[index * 2]!.name, reviewer = tasks[index * 2 + 1]!.name) =>
    qualityDecision({ toolName: "bash", toolCallId: `complete-${index}`, input: {
      command: `dagu human-task complete feature --run-id ${f.all[index]!.request.run} --step quality_review --input QA=${qa} --input REVIEW=${reviewer}`,
    } }, f.ctx);
  return { ...f, tasks, complete };
}

test("mixed-run verdict admission consumes only each run's fully bound sealed evidence", async t => {
  const f = await dispatchedFixture(t);
  for (const index of [0, 1]) {
    assert.equal(await f.complete(index), undefined);
    const source = f.all[index]!;
    const evidence = JSON.parse(readFileSync(join(source.state, "quality.json"), "utf8"));
    assert.equal(evidence.action, "complete");
    assert.equal(evidence.repo, source.request.repo);
    assert.equal(evidence.run, source.request.run);
    assert.equal(evidence.implementer.subagent, source.request.implementer);
    for (const [offset, verdict] of evidence.verdicts.entries()) {
      assert.equal(verdict.subagent, f.tasks[index * 2 + offset]!.name);
      assert.equal(verdict.invocation, "native-mixed");
      assert.equal(verdict.parentSession, f.first.parent);
      assert.equal(verdict.run, source.request.run);
      assert.equal(verdict.sha, source.request.sha);
      assert.equal(verdict.iteration, source.request.iteration);
      assert.equal(verdict.attempt, source.request.attempt);
      assert.notEqual(verdict.model.family, evidence.implementer.family);
      const contents = readFileSync(verdict.transcript);
      assert.equal(verdict.bytes, contents.length);
      assert.equal(verdict.digest, createHash("sha256").update(contents).digest("hex"));
    }
  }
  const crossRun = await f.complete(1, f.tasks[0]!.name);
  assert.ok(crossRun && "block" in crossRun && crossRun.block);
  assert.match(crossRun.reason, /wrong run, iteration, SHA or role assignment/);
});

for (const failure of [
  "repo", "run", "sha", "iteration", "attempt", "role", "wrong parent", "missing invocation", "ambiguous invocation",
  "stale child", "uncorrelated SHA", "same-family response", "unknown model", "shared session", "shared child",
] as const) {
  test(`mixed-run verdict admission preserves per-assignment provenance: ${failure}`, async t => {
    const f = await dispatchedFixture(t);
    const target = f.second.paths.qa!;
    if (["repo", "run", "sha", "iteration", "attempt", "role"].includes(failure)) changeRows(target, rows => {
      const report = JSON.parse(rows.at(-1)!.message!.content as string);
      report[failure] = failure === "iteration" ? 99 : "mismatched";
      rows.at(-1)!.message!.content = JSON.stringify(report);
    });
    if (failure === "wrong parent") changeRows(target, rows => { rows[0]!.parentSession = "/other/parent.jsonl"; });
    if (failure === "missing invocation") changeRows(f.first.parent, rows => { rows.pop(); });
    if (failure === "ambiguous invocation") changeRows(f.first.parent, rows => { rows.push(rows.at(-1)!); });
    if (failure === "stale child") changeRows(target, rows => { rows[1]!.timestamp = "2026-10-16T01:00:00Z"; });
    if (failure === "uncorrelated SHA") changeRows(target, rows => { rows[4]!.message!.toolCallId = "unrelated"; });
    if (failure === "same-family response") changeRows(target, rows => { Object.assign(rows.at(-1)!.message!, { provider: "anthropic", model: "alternate" }); });
    if (failure === "unknown model") changeRows(target, rows => { rows.at(-1)!.message!.model = "unknown"; });
    if (failure === "shared session") changeRows(target, rows => { rows[0]!.id = "child-ImplementOther"; });
    const decision = await (failure === "shared child" ? f.complete(1, f.tasks[2]!.name, f.tasks[2]!.name) : f.complete(1));
    assert.ok(decision && "block" in decision && decision.block, JSON.stringify(decision));
    assert.match(decision.reason, /^QUALITY_BLOCKED:/);
    if (failure !== "missing invocation" && failure !== "ambiguous invocation") assert.equal(await f.complete(0), undefined);
  });
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

test("project quality fallbacks admit both effective implementer families in policy order", async t => {
  const f = mixedFixture(t);
  const ctx = { ...f.ctx, models: f.first.models };
  const policies = readQualityPolicies();
  for (const role of ["qa", "reviewer"] as const) {
    assert.deepEqual(policies[role], { fallbackRoles: ["@slow", "@default", "@task"], excludeTaskFamily: true });
  }
  const decision = await qualityDecision({
    toolName: "task", toolCallId: "project-policy", input: { tasks: f.tasks },
  }, ctx, readQualityPolicies);
  assert.ok(decision && "input" in decision, JSON.stringify(decision));
  let hook: ((event: { agent: string; patterns: string[]; spawnKey: string }, ctx: unknown) => { model?: string[] }) | undefined;
  registerReviewHook({ on: (_event: string, handler: typeof hook) => { hook = handler; } } as never, readQualityPolicies);
  for (const task of decision.input.tasks) {
    const selected = hook!({ agent: task.agent, spawnKey: task.name, patterns: ["@slow"] }, ctx);
    const anthropicImplementer = task.task.includes(qualityMarker(f.second.request, task.agent));
    assert.deepEqual(selected.model, anthropicImplementer ? ["@task"] : ["@slow"]);
    assert.equal(ctx.models.resolve(selected.model![0]!)?.provider, anthropicImplementer ? "openai-codex" : "anthropic");
  }
});

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

function nativeFixture(t: test.TestContext, verdict: "PASS" | "FAIL" = "PASS") {
  const base = fixture(t);
  execFileSync("git", ["-C", base.primary, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "fixture"]);
  const repo = { root: dirname(dirname(base.parent)), primary: base.primary,
    worktree: base.request.worktree, state: base.state };
  return { ...nativeQualityFixture(repo, verdict), state: base.state };
}

for (const verdict of ["PASS", "FAIL"] as const) {
  test(`authorized native quality ${verdict} joins without coordinator task lineage`, t => {
    const f = nativeFixture(t, verdict);
    writeFileSync(f.parent, JSON.stringify({ type: "session", id: f.request.session }) + "\n");
    const evidence = verifyQuality("", f.request, f.ids.qa!, f.ids.reviewer!, f.models);
    assert.equal(evidence.action, verdict === "PASS" ? "complete" : "rewind");
    assert.ok(evidence.verdicts.every(result => result.verdict === verdict && "parentRun" in result && result.parentRun === f.request.run));
    if (verdict === "FAIL") assert.ok(evidence.verdicts.every(result => result.findings.includes("Fix acceptance regression")));
    assert.equal(new Set(evidence.verdicts.map(result => result.childSession)).size, 2);
  });
}

for (const fault of ["role", "session", "job", "sha", "attempt", "transcript", "fallback", "malformed", "absent artifact", "mismatched artifact"]) {
  test(`native quality rejects ${fault} before publication`, t => {
    const f = nativeFixture(t);
    const result = f.results.qa!;
    const path = join(f.state, "role-jobs", f.ids.qa!, "result.json");
    if (fault === "role") result.binding.role = "reviewer";
    if (fault === "session") result.native!.session = "foreign-session";
    if (fault === "job") result.id = f.ids.reviewer!;
    if (fault === "sha") result.binding.sha = "b".repeat(40);
    if (fault === "attempt") result.binding.attempt = "stale";
    if (fault === "transcript") writeFileSync(result.native!.transcript, "{}\n");
    if (fault === "absent artifact") rmSync(result.native!.transcript);
    if (fault === "mismatched artifact") result.native!.transcript = f.results.reviewer!.native!.transcript;
    if (fault === "fallback" || fault === "malformed") {
      const rows = readFileSync(result.native!.transcript, "utf8").trim().split("\n").map(line => JSON.parse(line));
      if (fault === "fallback") {
        rows.splice(2, 0, { type: "model_change", resolvedModelIsFallback: true, model: "openai-codex/effective" });
        for (const row of rows) if (row.message?.role === "assistant") Object.assign(row.message, { provider: "openai-codex", model: "effective" });
      } else {
        result.output = { ...result.output, findings: 42 };
        rows.at(-1).message.details.data = result.output;
      }
      writeFileSync(result.native!.transcript, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
      result.native = nativeEvidence(result.native!.transcript, { fixture: true });
      const receiptPath = join(f.state, "receipt.json");
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      receipt.runReceipt.observations.find((row: { data: { id: string } }) => row.data.id === result.id).data.native = result.native;
      writeFileSync(receiptPath, JSON.stringify(receipt));
    }
    writeFileSync(path, JSON.stringify(result));
    assert.throws(() => verifyQuality("", f.request, f.ids.qa!, f.ids.reviewer!, f.models));
  });
}

test("native quality remains ticket-bound and requires fresh candidate and attempt evidence", t => {
  const first = nativeFixture(t);
  const second = nativeFixture(t);
  assert.throws(() => verifyQuality("", first.request, second.ids.qa!, first.ids.reviewer!, first.models));
  for (const request of [{ ...first.request, sha: "c".repeat(40) },
    { ...first.request, attempt: "2026-10-17T01:00:00Z" }, { ...first.request, iteration: 1 }]) {
    assert.throws(() => verifyQuality("", request, first.ids.qa!, first.ids.reviewer!, first.models));
  }
  assert.doesNotThrow(() => verifyQuality("", first.request, first.ids.qa!, first.ids.reviewer!, first.models));
  assert.doesNotThrow(() => verifyQuality("", second.request, second.ids.qa!, second.ids.reviewer!, second.models));
});
