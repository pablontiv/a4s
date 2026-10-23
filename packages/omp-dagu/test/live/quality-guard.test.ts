import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { qualityDecision } from "../../src/triage/quality.ts";
import type { TranscriptRow } from "../../src/triage/quality.ts";
import { liveDagu } from "../fixtures/live-dagu.ts";
import { qualityFixture } from "../quality-fixtures.ts";
import { testRunId } from "../fixtures/run-id.ts";

test("real Dagu implement guard and quality push-back", {
  ...liveDagu, timeout: 90_000,
}, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-quality-guard-live-")));
  const id = testRunId("quality-guard");
  let service: ChildProcess | undefined;
  t.after(async () => {
    if (service && service.exitCode === null && service.signalCode === null) {
      const exited = new Promise<void>(resolve => service!.once("exit", () => resolve()));
      service.kill("SIGTERM");
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false, "private fixtures removed after service exit");
  });
  const primary = join(root, "primary space");
  const worktree = join(primary, ".workspace", "worktrees", "issue-189");
  const state = join(primary, ".git", "dagu-feature", "runs", id);
  execFileSync("git", ["init", "--quiet", primary]);
  mkdirSync(worktree, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "candidate.json"), JSON.stringify({ sha: "a".repeat(40), iteration: 0, implementer: "ImplementTest" }));
  const f = { ...qualityFixture({ root, primary, worktree, state }), primary, state };
  const home = join(dirname(f.primary), "dagu-home");
  mkdirSync(join(home, "dags"), { recursive: true });
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\nscheduler:\n  port: 0\n`);
  const env = { ...process.env, DAGU_HOME: home, DAGU_COORDINATOR_ENABLED: "false" };
  const previous = process.env.DAGU_URL;
  process.env.DAGU_URL = `http://127.0.0.1:${port}`;
  service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(port)], { env, stdio: "ignore" });
  t.after(() => {
    if (previous === undefined) delete process.env.DAGU_URL; else process.env.DAGU_URL = previous;
  });
  const dag = join(home, "dags", "feature.yaml");
  // This admitted human-task snapshot exercises retained completion guards and rewind.
  const implementForm = `      form:
        type: object
        required: [SUMMARY, MESSAGE, IMPLEMENTER]
        properties:
          SUMMARY:
            type: string
          MESSAGE:
            type: string
          IMPLEMENTER:
            type: string
`;
  const quality = `  - id: quality_review
    depends: seal
    action: human.task
    with:
      prompt: Synthetic QA and reviewer join for retained checkpoint acceptance.
      form:
        type: object
        properties:
          QA:
            type: string
          REVIEW:
            type: string
        required: [QA, REVIEW]
      push_back:
        rewind_to: implement
`;
  const sealed = join(root, "sealed.txt");
  writeFileSync(dag, `type: graph\nparams:\n  - ISSUE: "189"\n  - OMP_SESSION_ID: parent-id\n  - PRIMARY: ${JSON.stringify(f.primary)}\nsteps:\n  - id: implement\n    action: human.task\n    with:\n      prompt: Deliver fixture\n${implementForm}  - id: seal\n    depends: implement\n    env:\n      - SEALED: \${steps.implement.outputs.IMPLEMENTER}\n      - SUMMARY: \${steps.implement.outputs.SUMMARY}\n    run: |\n      printf 'SEALED=%s\\nSUMMARY=%s\\n' "$SEALED" "$SUMMARY" > '${sealed}'\n${quality}`);
  const cli = (...args: string[]) => execFileSync("dagu", args, { env, encoding: "utf8" });
  async function until<T>(probe: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const result = await probe();
      if (result !== undefined) return result;
      await delay(100);
    }
    throw new Error("isolated Dagu observation timed out");
  }
  await until(async () => {
    try { return (await fetch(`${process.env.DAGU_URL}/api/v1/dag-runs`)).ok ? true : undefined; } catch { return undefined; }
  });
  cli("enqueue", "--run-id", id, dag);
  const waiting = (step: string) => until(async () => {
    const response = await fetch(`${process.env.DAGU_URL}/api/v1/dag-runs/feature/${id}`);
    if (!response.ok) return undefined;
    const run = (await response.json() as { dagRunDetails: { statusLabel: string; pushBackIteration?: number; nodes: Array<{ step: { id: string }; statusLabel: string; startedAt: string }> } }).dagRunDetails;
    return run.statusLabel === "waiting" && run.nodes.some(node => node.step.id === step && node.statusLabel === "waiting") ? run : undefined;
  });
  const run = await waiting("implement");
  const cutoff = run.nodes.find(node => node.step.id === "implement")!.startedAt;
  const child: TranscriptRow[] = readFileSync(f.paths.implementer!, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const parent: TranscriptRow[] = readFileSync(f.parent, "utf8").trim().split("\n").map(line => JSON.parse(line));
  parent[1]!.timestamp = new Date(Date.parse(cutoff) - 1000).toISOString();
  writeFileSync(f.parent, parent.map(row => JSON.stringify(row)).join("\n") + "\n");
  const ctx = { cwd: f.primary, sessionManager: { getSessionDir: () => dirname(f.parent) }, models: f.models };
  const event = { toolName: "bash", toolCallId: "live-complete", input: {
    command: `dagu human-task complete --run-id ${id} --step implement \\\n  --input SUMMARY='change summary' --input MESSAGE='fix(dagu): reject stale implementers before implement completion' \\\n  --input IMPLEMENTER='ImplementTest' feature`,
  } };
  child[1]!.timestamp = new Date(Date.parse(cutoff) - 695).toISOString();
  writeFileSync(f.paths.implementer!, child.map(row => JSON.stringify(row)).join("\n") + "\n");
  // A second synthetic allocation represents the previous, stale delivery.
  writeFileSync(join(dirname(f.paths.implementer!), "StaleId.jsonl"),
    child.map(row => JSON.stringify(row).replaceAll("ImplementTest", "StaleId")).join("\n") + "\n");
  parent.push(JSON.parse(JSON.stringify(parent[1]!).replaceAll("ImplementTest", "StaleId")));
  writeFileSync(f.parent, parent.map(row => JSON.stringify(row)).join("\n") + "\n");
  const stale = await qualityDecision(event, ctx);
  assert.ok(stale && "block" in stale && stale.block);
  assert.match(stale.reason!, /stale invocation/);
  assert.equal((await waiting("implement")).nodes.find(node => node.step.id === "implement")!.startedAt, cutoff);
  child[1]!.timestamp = new Date(Date.parse(cutoff) + 1).toISOString();
  writeFileSync(f.paths.implementer!, child.map(row => JSON.stringify(row)).join("\n") + "\n");
  assert.equal(await qualityDecision(event, ctx), undefined);
  const staleComment = {
    ...event, input: { command: `dagu human-task complete feature --run-id ${id} --step implement --input SUMMARY=s --input MESSAGE=m --input IMPLEMENTER=StaleId # --input IMPLEMENTER=ImplementTest` },
  };
  const staleCommentDecision = await qualityDecision(staleComment, ctx);
  assert.ok(staleCommentDecision && "block" in staleCommentDecision && staleCommentDecision.block);
  assert.match(staleCommentDecision.reason!, /IMPLEMENT_BLOCKED: stale invocation/);
  assert.equal((await waiting("implement")).nodes.find(node => node.step.id === "implement")!.startedAt, cutoff);
  const attachedStale = { ...event, input: {
    command: `dagu human-task complete feature -r${id} --step implement --input SUMMARY=s --input MESSAGE=m --input IMPLEMENTER=StaleId`,
  } };
  const attachedStaleDecision = await qualityDecision(attachedStale, ctx);
  assert.ok(attachedStaleDecision && "block" in attachedStaleDecision && attachedStaleDecision.block);
  assert.match(attachedStaleDecision.reason!, /IMPLEMENT_BLOCKED: stale invocation/);
  assert.equal((await waiting("implement")).nodes.find(node => node.step.id === "implement")!.startedAt, cutoff);
  const staleLiteral = attachedStale.input.command;
  for (const code of [
    `await bash(\`${staleLiteral}\`)`,
    `await Bun.$\`${staleLiteral}\``,
    `const result = await $\`${staleLiteral}\`;`,
    `/* # "ignored" */ await bash(${JSON.stringify(staleLiteral)})`,
    `// # ignored\nawait bash(\`${staleLiteral}\`)`,
  ]) {
    const decision = await qualityDecision({ toolName: "eval", toolCallId: "stale-template-live", input: { code } }, ctx);
    assert.ok(decision && "block" in decision && decision.block);
    assert.match(decision.reason, /IMPLEMENT_BLOCKED: stale invocation/);
    const unchanged = await waiting("implement");
    assert.equal(unchanged.nodes.find(node => node.step.id === "implement")!.startedAt, cutoff);
  }
  for (const boundary of ["\n", "; ", " && "]) {
    const decision = await qualityDecision({ ...event, input: { command:
      `dagu human-task complete feature --run-id ${id} --step implement --input SUMMARY=s --input MESSAGE=m --input IMPLEMENTER=StaleId${boundary}--input IMPLEMENTER=ImplementTest`,
    } }, ctx);
    assert.ok(decision && "block" in decision && decision.block);
    assert.match(decision.reason!, /one literal implement completion command required: command boundary/);
    assert.equal((await waiting("implement")).nodes.find(node => node.step.id === "implement")!.startedAt, cutoff);
  }
  // Consumer-visible regression: a fresh literal in an unexecuted branch must
  // not authorize the stale command that the Eval actually sends to native Dagu.
  const decoy = event.input.command.replace(/\\\n/g, " ");
  const executedStale = attachedStale.input.command;
  const ambiguousCode = `if (false) await bash(${JSON.stringify(decoy)}); await bash(${JSON.stringify(executedStale)})`;
  const ambiguous = await qualityDecision({ toolName: "eval", toolCallId: "consumer-live", input: { code: ambiguousCode } }, ctx);
  if (!ambiguous || !("block" in ambiguous && ambiguous.block)) {
    const execute = new Function("bash", `return (async () => { ${ambiguousCode} })()`);
    await execute(async (command: string) => execFileSync("bash", ["-euo", "pipefail", "-c", command], { env, encoding: "utf8" }));
    await waiting("quality_review");
  }
  const guardedRun = (await (await fetch(`${process.env.DAGU_URL}/api/v1/dag-runs/feature/${id}`)).json()).dagRunDetails;
  assert.equal(guardedRun.nodes.find((node: { step: { id: string } }) => node.step.id === "implement").statusLabel, "waiting",
    "ambiguous Eval must preserve native Waiting implement instead of sealing a stale delivery");
  assert.ok(ambiguous && "block" in ambiguous && ambiguous.block);
  for (const form of ["two calls", "fresh decoy", "parenthesized fresh decoy"]) {
    const fresh = `dagu human-task complete feature --run-id ${id} --step implement --input SUMMARY=s --input MESSAGE=m --input IMPLEMENTER=ImplementTest`;
    const stale = fresh.replace("ImplementTest", "StaleId");
    const code = form === "two calls" ? `await bash(${JSON.stringify(fresh)}); await bash(${JSON.stringify(stale)})`
      : form === "fresh decoy" ? `if (false) await bash(${JSON.stringify(fresh)}); await bash(${JSON.stringify(stale)})`
      : `(false && await bash(${JSON.stringify(fresh)})); (await bash(${JSON.stringify(stale)}))`;
    const decision = await qualityDecision({ toolName: "eval", toolCallId: "ambiguous-live", input: { code } }, ctx);
    assert.ok(decision && "block" in decision && decision.block);
    assert.match(decision.reason!, /IMPLEMENT_BLOCKED: one literal implement completion command required/);
    assert.equal((await waiting("implement")).nodes.find(node => node.step.id === "implement")!.startedAt, cutoff);
  }
  assert.equal(await qualityDecision({ toolName: "eval", toolCallId: "single-live", input: {
    code: `await bash(${JSON.stringify(event.input.command.replace(/\\\n/g, " "))})`,
  } }, ctx), undefined);
  const request = { ...f.request, implementStartedAt: cutoff };
  execFileSync("bash", ["-euo", "pipefail", "-c", event.input.command], { env, encoding: "utf8" });
  const qualityRun = await waiting("quality_review");
  assert.equal(qualityRun.nodes.find(node => node.step.id === "implement")!.statusLabel, "succeeded");
  assert.equal(readFileSync(sealed, "utf8"), "SEALED=ImplementTest\nSUMMARY=change summary\n");
  writeFileSync(join(f.state, "quality-request.json"), JSON.stringify(request));
  assert.equal(await qualityDecision({ toolName: "bash", toolCallId: "quality", input: {
    command: `dagu human-task complete feature --run-id ${id} --step quality_review --input QA=QATest --input REVIEW=ReviewTest`,
  } }, ctx), undefined);
  assert.equal(JSON.parse(readFileSync(join(f.state, "quality.json"), "utf8")).action, "complete");
  cli("human-task", "push-back", "feature", "--run-id", id, "--step", "quality_review", "--expected-iteration", "0");
  const rewound = await waiting("implement");
  const freshCutoff = rewound.nodes.find(node => node.step.id === "implement")!.startedAt;
  assert.match(cli("status", "feature", "--run-id", id), /push-back iteration: 1/);
  child[1]!.timestamp = new Date(Date.parse(freshCutoff) + 1).toISOString();
  writeFileSync(f.paths.implementer!, child.map(row => JSON.stringify(row)).join("\n") + "\n");
  const freshComment = { ...event, input: {
    command: `dagu human-task complete feature -r${id} --step implement --input SUMMARY='quoted # text'\\#foo#bar --input MESSAGE='fix(dagu): bind literal shell completion' --input IMPLEMENTER=ImplementTest # --input IMPLEMENTER=StaleId`,
  } };
  assert.equal(await qualityDecision(freshComment, ctx), undefined);
  execFileSync("bash", ["-euo", "pipefail", "-c", freshComment.input.command], { env, encoding: "utf8" });
  const commentRun = await waiting("quality_review");
  assert.equal(commentRun.nodes.find(node => node.step.id === "implement")!.statusLabel, "succeeded");
  assert.equal(readFileSync(sealed, "utf8"), "SEALED=ImplementTest\nSUMMARY=quoted # text#foo#bar\n");
  // Each supported Eval form crosses the real native boundary exactly once,
  // after its own rewind and freshly bound synthetic implementer timestamp.
  let executions = 0;
  const execute = async (input: string | TemplateStringsArray) => {
    executions++;
    execFileSync("bash", ["-euo", "pipefail", "-c", typeof input === "string" ? input : input[0]!], { env, encoding: "utf8" });
  };
  const freshLiteral = `dagu human-task complete feature --run-id ${id} --step implement --input SUMMARY='template # summary' --input MESSAGE=m --input IMPLEMENTER=ImplementTest`;
  const wrappers = [
    `await bash(\`${freshLiteral}\`)`,
    `await Bun.$\`${freshLiteral}\``,
    `const result = await $\`${freshLiteral}\`;`,
    `/* # */ await bash(${JSON.stringify(freshLiteral)})`,
  ];
  for (const [index, code] of wrappers.entries()) {
    cli("human-task", "push-back", "feature", "--run-id", id, "--step", "quality_review", "--expected-iteration", String(index + 1));
    const next = await waiting("implement");
    const nextCutoff = next.nodes.find(node => node.step.id === "implement")!.startedAt;
    child[1]!.timestamp = new Date(Date.parse(nextCutoff) + 1).toISOString();
    writeFileSync(f.paths.implementer!, child.map(row => JSON.stringify(row)).join("\n") + "\n");
    const actualFetch = globalThis.fetch;
    let lookups = 0;
    const fetchMock = t.mock.method(globalThis, "fetch", async (...args: Parameters<typeof fetch>) => {
      lookups++;
      return actualFetch(...args);
    });
    const dynamic = `${code.replace(freshLiteral, freshLiteral.replace("ImplementTest", "StaleId"))} + suffix`;
    const rejected = await qualityDecision({ toolName: "eval", toolCallId: "dynamic-live", input: { code: dynamic } }, ctx);
    assert.ok(rejected && "block" in rejected && rejected.block);
    assert.match(rejected.reason, /IMPLEMENT_BLOCKED: one literal implement completion command required/);
    assert.equal(lookups, 0, "ambiguity blocked before Dagu lookup");
    fetchMock.mock.restore();
    assert.equal((await waiting("implement")).nodes.find(node => node.step.id === "implement")!.startedAt, nextCutoff);
    assert.equal(await qualityDecision({ toolName: "eval", toolCallId: "fresh-template-live", input: { code } }, ctx), undefined);
    await new Function("bash", "Bun", "$", `return (async () => { ${code} })()`)(execute, { $: execute }, execute);
    const completed = await waiting("quality_review");
    assert.equal(completed.nodes.find(node => node.step.id === "implement")!.statusLabel, "succeeded");
    assert.equal(readFileSync(sealed, "utf8"), "SEALED=ImplementTest\nSUMMARY=template # summary\n");
    assert.equal(executions, index + 1);
  }
  t.diagnostic(`Guarded and executed raw command: ${event.input.command}`);
  t.diagnostic(`Guarded and executed raw command: ${freshComment.input.command}`);
  t.diagnostic("Synthetic provider/model JSONL fixtures; official isolated loopback Dagu: stale static/tagged templates and JS #-comment wrappers retain identical Waiting implement/startedAt; ambiguous/dynamic intent blocks with zero lookups; four fresh Eval literal forms each execute once and seal correct implementer/summary after native iteration-preserving rewinds. Private service stopped before fixture cleanup.");
});
