import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";
import { qualityDecision } from "../src/triage/quality.ts";
import type { QualityContext } from "../src/triage/quality.ts";
import { nativeQualityFixture, qualityFixture } from "./quality-fixtures.ts";
import { waitingSnapshot } from "./fixtures/waiting-snapshot.ts";

const historical = readFileSync(new URL("./fixtures/quality-disposal-0.3.77.yaml", import.meta.url), "utf8");
const current = readFileSync(new URL("../skills/dagu-feature/feature.yaml", import.meta.url), "utf8");
const command = "dagu human-task complete feature --run-id historical-run --step quality_review --input QA=dispose-inert-qa --input REVIEW=dispose-inert-review";

function fixture(t: test.TestContext, snapshot = historical) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-quality-disposal-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const primary = join(root, "primary space");
  execFileSync("git", ["init", "--quiet", primary]);
  const state = join(primary, ".git", "dagu-feature", "runs", "historical-run");
  mkdirSync(join(state, "snapshot"), { recursive: true });
  writeFileSync(join(state, "snapshot", "feature.yaml"), snapshot);
  const details = {
    resolvedPrimary: primary, params: "ISSUE=545 OMP_SESSION_ID=owner-session", statusLabel: "waiting",
    nodes: [{ step: { id: "quality_review" }, statusLabel: "waiting", startedAt: "2026-10-16T00:00:00Z" }],
  };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    if (String(input).endsWith("/spec")) return Response.json({ spec: `env:\n  - PRIMARY: ${JSON.stringify(primary)}\n` });
    assert.ok(String(input).endsWith("/feature/historical-run"));
    return Response.json({ dagRunDetails: details });
  });
  const ctx: QualityContext = { cwd: primary, sessionManager: {
    getSessionDir: () => join(root, "sessions"), getSessionId: () => "owner-session",
  } };
  const complete = (text = command, toolName = "bash") => qualityDecision({
    toolName, toolCallId: "dispose", input: toolName === "bash" ? { command: text } : { code: text },
  }, ctx);
  return { root, primary, state, details, ctx, complete };
}

for (const evidence of [undefined, { verdicts: [{ subagent: "OldQA" }, { subagent: "OldReview" }] }]) {
  test(`historical snapshot admits owner disposal with ${evidence ? "unrelated" : "missing"} quality evidence`, async t => {
    const f = fixture(t);
    if (evidence) writeFileSync(join(f.state, "quality.json"), JSON.stringify(evidence));
    const before = readdirSync(f.state).map(name => [name, name === "snapshot" ? historical : readFileSync(join(f.state, name), "utf8")]);
    assert.equal(await f.complete(), undefined);
    assert.deepEqual(readdirSync(f.state).map(name => [name, name === "snapshot" ? historical : readFileSync(join(f.state, name), "utf8")]), before,
      "disposal admission preserves stored evidence");
  });
}

for (const source of ["adopted snapshot env", "historical PRIMARY param"] as const) {
  test(`disposal shares run PRIMARY resolution through ${source}`, async t => {
    const f = fixture(t);
    const primary = f.details.resolvedPrimary;
    Reflect.deleteProperty(f.details, "resolvedPrimary");
    if (source === "historical PRIMARY param") f.details.params += ` PRIMARY=${primary}`;
    assert.equal(await f.complete(), undefined);
  });
}

type SnapshotFixture = { steps: [
  { id: string; depends: string | string[]; with: { push_back?: { rewind_to: string } } },
  { id: string; depends: string | string[]; run: string; env: [{ QA: string }, { REVIEW: string }]; continue_on?: { failure: boolean } },
  ...{ id: string; depends: string | string[] }[],
] };
const rejectedSnapshots: [string, (snapshot: SnapshotFixture) => void, RegExp][] = [
  ["push_back", snapshot => { snapshot.steps[0].with.push_back = { rewind_to: "implement" }; }, /has push_back/],
  ["cancellation step", snapshot => { snapshot.steps.push({ id: "quality_review_cancellation", depends: "implement" }); }, /another quality_review route/],
  ["other cancellation route", snapshot => { snapshot.steps.push({ id: "cancel_quality", depends: ["quality_review"] }); }, /another quality_review route/],
  ["continue_on", snapshot => { snapshot.steps[1].continue_on = { failure: true }; }, /has continue_on/],
  ["additional dependency", snapshot => { snapshot.steps[1].depends = ["quality_review", "gate"]; }, /depend only on quality_review/],
  ["missing QA binding", snapshot => { snapshot.steps[1].run = snapshot.steps[1].run.replace(".verdicts[0].subagent == $qa and ", ""); }, /fail-closed QA\/REVIEW binding/],
  ["missing reviewer binding", snapshot => { snapshot.steps[1].run = snapshot.steps[1].run.replace(".verdicts[1].subagent == $review and ", ""); }, /fail-closed QA\/REVIEW binding/],
  ["missing shell strictness", snapshot => { snapshot.steps[1].run = snapshot.steps[1].run.replace("set -euo pipefail", "set -eu"); }, /fail-closed QA\/REVIEW binding/],
  ["non-exiting fail", snapshot => { snapshot.steps[1].run = snapshot.steps[1].run.replace("exit 1", "return 0"); }, /fail-closed QA\/REVIEW binding/],
  ["unchecked jq", snapshot => { snapshot.steps[1].run = snapshot.steps[1].run.replace('|| fail "missing, stale or malformed effective verdict evidence"', '|| true'); }, /fail-closed QA\/REVIEW binding/],
  ["rebound input", snapshot => { snapshot.steps[1].env[0].QA = "OldQA"; }, /fail-closed QA\/REVIEW binding/],
  ["bypassed prelude", snapshot => { snapshot.steps[1].run = `exit 0\n${snapshot.steps[1].run}`; }, /fail-closed QA\/REVIEW binding/],
];
for (const [name, change, reason] of rejectedSnapshots) {
  test(`disposal rejects snapshot with ${name}`, async t => {
    // This checked-in test fixture has the two fixed historical checkpoint shapes.
    const snapshot = parse(historical) as SnapshotFixture;
    change(snapshot);
    const f = fixture(t, stringify(snapshot));
    const decision = await f.complete();
    assert.ok(decision && "block" in decision && decision.block);
    assert.match(decision.reason, /^QUALITY_BLOCKED:/);
    assert.match(decision.reason, reason);
  });
}

test("current bundle snapshot retains its native quality role stage", async t => {
  const f = fixture(t, current);
  const decision = await f.complete();
  assert.ok(decision && "block" in decision && decision.block);
  assert.match(decision.reason, /^QUALITY_BLOCKED: disposal snapshot quality_review is ambiguous/);
});

test("historical cancellation snapshot retains its terminal cancellation route", async t => {
  const f = fixture(t, waitingSnapshot(current));
  const decision = await f.complete();
  assert.ok(decision && "block" in decision && decision.block);
  assert.match(decision.reason, /^QUALITY_BLOCKED: disposal snapshot has another quality_review route \(including cancellation\)/);
});

for (const identity of ["dispose-inert-qa", "dispose-inert-review"]) {
  test(`disposal rejects quality.json naming ${identity}`, async t => {
    const f = fixture(t);
    writeFileSync(join(f.state, "quality.json"), JSON.stringify({ verdicts: [{ subagent: identity }] }));
    const decision = await f.complete();
    assert.ok(decision && "block" in decision && decision.block);
    assert.match(decision.reason, /^QUALITY_BLOCKED: disposal identity is already named in quality.json/);
  });
}

for (const scenario of ["non-owner", "unknown owner", "run not waiting", "checkpoint not waiting", "missing snapshot", "malformed snapshot", "malformed quality evidence"] as const) {
  test(`disposal fails closed for ${scenario}`, async t => {
    const f = fixture(t);
    if (scenario === "non-owner") f.ctx.sessionManager.getSessionId = () => "another-session";
    if (scenario === "unknown owner") f.details.params = "ISSUE=545";
    if (scenario === "run not waiting") f.details.statusLabel = "failed";
    if (scenario === "checkpoint not waiting") f.details.nodes[0]!.statusLabel = "succeeded";
    if (scenario === "missing snapshot") rmSync(join(f.state, "snapshot", "feature.yaml"));
    if (scenario === "malformed snapshot") writeFileSync(join(f.state, "snapshot", "feature.yaml"), "steps: [");
    if (scenario === "malformed quality evidence") writeFileSync(join(f.state, "quality.json"), "{");
    const decision = await f.complete();
    assert.ok(decision && "block" in decision && decision.block);
    assert.match(decision.reason, /^QUALITY_BLOCKED:/);
    if (scenario === "non-owner" || scenario === "unknown owner") assert.match(decision.reason, /run owner session/);
    if (scenario.includes("not waiting")) assert.match(decision.reason, /Waiting quality_review/);
  });
}

for (const alter of [
  (text: string) => `${text} | cat`,
  (text: string) => `${text} > output`,
  (text: string) => `${text}; true`,
  (text: string) => `false && ${text}`,
  (text: string) => text.replace("historical-run", '"$RUN"'),
  (text: string) => text.replace("QA=dispose-inert-qa", 'QA="${QA:-dispose-inert-qa}"'),
  (text: string) => `${text} --input QA=OtherQA`,
  (text: string) => text.replace("complete feature", "complete other"),
]) {
  test(`disposal requires literal single command: ${alter(command)}`, async t => {
    const f = fixture(t);
    const decision = await f.complete(alter(command));
    assert.ok(decision && "block" in decision && decision.block);
    assert.match(decision.reason, /^QUALITY_BLOCKED:/);
  });
}

test("eval wrapper is outside the literal disposal command admission", async t => {
  const f = fixture(t);
  const decision = await f.complete(`await bash(${JSON.stringify(command)})`, "eval");
  assert.ok(decision && "block" in decision && decision.block);
  assert.match(decision.reason, /one literal dagu human-task complete feature command/);
});

test("normal completion still requires structured verdict evidence", async t => {
  const f = fixture(t);
  const worktree = join(f.primary, ".workspace", "worktrees", "issue-545");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(f.state, "candidate.json"), JSON.stringify({ sha: "a".repeat(40), iteration: 0, implementer: "ImplementTest" }));
  const evidence = qualityFixture({ root: f.root, primary: f.primary, state: f.state, worktree });
  evidence.request.run = "historical-run";
  writeFileSync(join(f.state, "quality-request.json"), JSON.stringify(evidence.request));
  f.details.params = "ISSUE=545 OMP_SESSION_ID=parent-id";
  f.details.nodes.push({ step: { id: "implement" }, startedAt: evidence.request.implementStartedAt, statusLabel: "succeeded" });
  f.ctx.models = evidence.models;
  for (const path of [evidence.parent, ...Object.values(evidence.paths)]) {
    writeFileSync(path, readFileSync(path, "utf8").replaceAll("test-run", "historical-run"));
  }
  const qa = evidence.paths.qa!;
  const rows = readFileSync(qa, "utf8").trim().split("\n").map(line => JSON.parse(line));
  rows.at(-1)!.message.content = "QA complete without a structured verdict";
  writeFileSync(qa, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const decision = await f.complete(command.replace("dispose-inert-qa", "QATest").replace("dispose-inert-review", "ReviewTest"));
  assert.ok(decision && "block" in decision && decision.block);
  assert.match(decision.reason, /^QUALITY_BLOCKED: missing runtime-authored structured verdict/);
});

test("native quality completion uses authorized role receipts without a coordinator transcript", async t => {
  const f = fixture(t);
  execFileSync("git", ["-C", f.primary, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "fixture"]);
  const worktree = join(f.primary, ".workspace", "worktrees", "issue-545");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(f.state, "candidate.json"), JSON.stringify({ sha: "a".repeat(40), iteration: 0, implementer: "ImplementTest" }));
  const evidence = nativeQualityFixture({ root: f.root, primary: f.primary, state: f.state, worktree }, "PASS", {
    repo: f.primary, worktree, run: "historical-run", sha: "a".repeat(40), iteration: 0,
    attempt: "2026-10-16T01:00:00Z", implementer: "ImplementTest", session: "parent-id",
    implementStartedAt: "2026-10-16T00:00:00Z",
  });
  f.details.params = "ISSUE=545 OMP_SESSION_ID=parent-id";
  f.details.nodes.push({ step: { id: "implement" }, startedAt: evidence.request.implementStartedAt, statusLabel: "succeeded" });
  f.ctx.models = evidence.models;
  const decision = await f.complete(command.replace("dispose-inert-qa", evidence.ids.qa!).replace("dispose-inert-review", evidence.ids.reviewer!));
  assert.equal(decision, undefined);
  const quality = JSON.parse(readFileSync(join(f.state, "quality.json"), "utf8"));
  assert.equal(quality.action, "complete");
  assert.deepEqual(quality.verdicts.map((verdict: { subagent: string }) => verdict.subagent), [evidence.ids.qa, evidence.ids.reviewer]);
});
