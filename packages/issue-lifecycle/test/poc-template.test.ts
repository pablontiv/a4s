import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { approvedPocScope, assessPocScope, decidePocScope, inconclusiveCause, pocScopeRejection, PocScopeRejection, recordPocScopeRejection, requirePocScope, type PocScopeInput } from "../src/poc-scope.ts";
import { exampleConfig, serializeConfig } from "../../launcher/src/config.ts";
import { preflightAdmission } from "../src/admission.ts";
import { parseReview } from "../src/triage/schema.ts";

function pocFixture() {
  const root = mkdtempSync(join(tmpdir(), "templates-poc-scope-"));
  const primary = join(root, "primary");
  execFileSync("git", ["init", "-b", "main", primary], { stdio: "pipe" });
  return { root, primary, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function withConsumerConfig(primary: string, home: string, run: () => void): void {
  const config = join(primary, ".workspace", "dagu", "config.json");
  mkdirSync(join(config, ".."), { recursive: true });
  writeFileSync(config, serializeConfig(exampleConfig({ lane: "poc-fixture" })));
  execFileSync("git", ["-C", primary, "add", ".workspace/dagu/config.json"], { stdio: "pipe" });
  execFileSync("git", ["-C", primary, "-c", "user.name=PoC test", "-c", "user.email=poc@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "config"], { stdio: "pipe" });
  mkdirSync(home, { recursive: true });
  const previousPrimary = process.env.A4S_PRIMARY;
  const previousHome = process.env.DAGU_HOME;
  process.env.A4S_PRIMARY = primary;
  process.env.DAGU_HOME = home;
  try { run(); }
  finally {
    if (previousPrimary === undefined) delete process.env.A4S_PRIMARY;
    else process.env.A4S_PRIMARY = previousPrimary;
    if (previousHome === undefined) delete process.env.DAGU_HOME;
    else process.env.DAGU_HOME = previousHome;
  }
}
test("triage compares concrete required targets with the operator-authorized route", () => {
  const review = parseReview(JSON.stringify({ poc: "yes", behavior: "native OS behavior", question: "Can all native OS targets run?",
    reason: "Runtime uncertainty", requiredTargets: ["linux-arm64", "windows-x64"], authorizedTargets: ["linux-arm64"],
    scopeBasis: "Operator authorized local Docker Linux arm64 only" }));
  const fixture = pocFixture();
  try {
    const input: PocScopeInput = { issue: "41", question: review.question, requiredTargets: review.requiredTargets!,
      authorizedTargets: review.authorizedTargets!, basis: review.scopeBasis! };
    const first = assessPocScope(fixture.primary, input);
    const replay = assessPocScope(fixture.primary, input);
    assert.deepEqual(replay, first, "duplicate assessment retains one durable decision request");
    assert.equal(first.decisionRequired, true);
    assert.match(first.reason, /windows-x64/);
    assert.throws(() => requirePocScope(fixture.primary, input, first.id), /POC_SCOPE_DECISION_REQUIRED/);
    const dag = join(fixture.root, "poc.yaml");
    writeFileSync(dag, "name: poc\n");
    withConsumerConfig(fixture.primary, join(fixture.root, "dagu-home"), () => {
      assert.throws(() => preflightAdmission({ cwd: fixture.primary, dag, run: "scope-blocked", params: [
        "ISSUE=41", "OMP_SESSION_ID=owner-session", `QUESTION=${input.question}`, `REQUIRED_TARGETS=${JSON.stringify(input.requiredTargets)}`,
        `AUTHORIZED_TARGETS=${JSON.stringify(input.authorizedTargets)}`, `SCOPE_BASIS=${input.basis}`,
      ] }), /POC_SCOPE_DECISION_REQUIRED/, "direct bundle admission enforces the same boundary before enqueue");
    });
    const narrowed = { ...input, question: "Can native Linux arm64 run?", requiredTargets: ["linux-arm64"] };
    const decision = decidePocScope(fixture.primary, "41", first.id, "narrow", narrowed, "operator:fixture", "Narrowed to the authorized target");
    assert.equal(decision.actor, "operator:fixture");
    assert.equal(decision.action, "narrow");
    assert.equal(decidePocScope(fixture.primary, "41", first.id, "narrow", narrowed, "operator:fixture", decision.basis).decidedAt, decision.decidedAt);
    assert.deepEqual(approvedPocScope(fixture.primary, "41", first.id), narrowed);
    requirePocScope(fixture.primary, narrowed, first.id);
    assert.throws(() => requirePocScope(fixture.primary, input, first.id), /differs from its reviewed scope/);
    assert.throws(() => decidePocScope(fixture.primary, "41", first.id, "provide-access",
      { ...input, authorizedTargets: input.requiredTargets }, "operator:fixture", "New access"), /already has a different/);
  } finally { fixture.cleanup(); }
});

test("PoC access decisions grant the reviewed targets or defer admission with provenance", () => {
  const fixture = pocFixture();
  try {
    const input: PocScopeInput = { issue: "41", question: "Can Windows execute the real target?", requiredTargets: ["windows-x64"],
      authorizedTargets: [], basis: "No Windows access authorized" };
    const request = assessPocScope(fixture.primary, input);
    assert.throws(() => decidePocScope(fixture.primary, "41", request.id, "provide-access", input, "operator", "Access unchanged"), /reachable authorized targets/);
    const authorized = { ...input, authorizedTargets: ["windows-x64"], basis: "Operator granted Windows host access" };
    decidePocScope(fixture.primary, "41", request.id, "provide-access", authorized, "operator", "Windows host provided");
    requirePocScope(fixture.primary, authorized, request.id);
    const deferred = assessPocScope(fixture.primary, { ...input, question: "Can Windows execute another target?" });
    decidePocScope(fixture.primary, "41", deferred.id, "defer", input, "operator", "Keep deferred until Windows access exists");
    assert.throws(() => approvedPocScope(fixture.primary, "41", deferred.id), /POC_SCOPE_DEFERRED/);
    assert.throws(() => assessPocScope(fixture.primary, input, 0), /positive integer/);
  } finally { fixture.cleanup(); }
});

test("scope decisions default reviewed access fields, ignore defer fields and retain bound rejection diagnostics", () => {
  const fixture = pocFixture();
  try {
    const input: PocScopeInput = { issue: "41", question: "Can Linux and Windows run?", requiredTargets: ["linux", "windows"],
      authorizedTargets: ["linux"], basis: "Only Linux is authorized" };
    const request = assessPocScope(fixture.primary, input);
    for (const question of [undefined, input.question]) {
      assert.throws(() => decidePocScope(fixture.primary, "41", request.id, "narrow",
        { question, requiredTargets: ["linux"], authorizedTargets: ["linux"] }, "operator", "Narrow the route"),
      (error: unknown) => {
        assert.ok(error instanceof PocScopeRejection);
        assert.equal(error.rule, "narrow.question.changed");
        recordPocScopeRejection(fixture.primary, "scope-test", "41", request.id, error);
        const rejection = JSON.parse(pocScopeRejection(fixture.primary, "scope-test", "41", request.id));
        assert.equal(rejection.rule, error.rule);
        assert.deepEqual(rejection.expected, error.expected);
        assert.deepEqual(rejection.observed, error.observed);
        assert.equal(pocScopeRejection(fixture.primary, "other-run", "41", request.id), "");
        assert.equal(pocScopeRejection(fixture.primary, "scope-test", "42", request.id), "");
        assert.equal(pocScopeRejection(fixture.primary, "scope-test", "41", "a".repeat(64)), "");
        return true;
      });
    }
    const granted = decidePocScope(fixture.primary, "41", request.id, "provide-access",
      { authorizedTargets: ["linux", "windows"] }, "operator", "Windows access granted");
    assert.equal(granted.input.question, input.question);
    assert.deepEqual(granted.input.requiredTargets, input.requiredTargets);
    requirePocScope(fixture.primary, granted.input, request.id);
    const deferred = assessPocScope(fixture.primary, { ...input, question: "Another question?" });
    assert.equal(decidePocScope(fixture.primary, "41", deferred.id, "defer", {}, "operator", "Defer until access exists").action, "defer");
    assert.throws(() => approvedPocScope(fixture.primary, "41", deferred.id), /POC_SCOPE_DEFERRED/);
  } finally { fixture.cleanup(); }
});

test("the second scope/access INCONCLUSIVE PoC requires one decision before a fresh admission", () => {
  const fixture = pocFixture();
  try {
    const input: PocScopeInput = { issue: "41", question: "Can Linux execute the real target?", requiredTargets: ["linux-arm64"],
      authorizedTargets: ["linux-arm64"], basis: "Operator authorized Docker Linux arm64" };
    const history = (run: string, issue: string, cause: string) => {
      const directory = join(fixture.primary, ".git", "poc", "runs", run);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "issue.number"), issue);
      writeFileSync(join(directory, "verdict"), "INCONCLUSIVE\n");
      writeFileSync(join(directory, "result.md"), `VERDICT: INCONCLUSIVE\n## Inconclusive cause\n${cause}\n`);
    };
    history("first", "41", "access");
    history("unrelated-issue", "42", "scope");
    history("other-cause", "41", "other");
    assert.equal(assessPocScope(fixture.primary, input).decisionRequired, false);
    requirePocScope(fixture.primary, input);
    history("second", "41", "scope");
    const request = assessPocScope(fixture.primary, input);
    assert.equal(request.decisionRequired, true);
    assert.match(request.reason, /2 scope\/access INCONCLUSIVE/);
    assert.deepEqual(request.history.map(row => row.run), ["first", "second"]);
    assert.equal(assessPocScope(fixture.primary, input).id, request.id);
    assert.throws(() => requirePocScope(fixture.primary, input), /POC_SCOPE_DECISION_REQUIRED/);
    decidePocScope(fixture.primary, "41", request.id, "provide-access", input, "operator", "Authorization reconfirmed after two unreachable experiments");
    requirePocScope(fixture.primary, input, request.id);
    history("third", "41", "access");
    assert.throws(() => requirePocScope(fixture.primary, input, request.id), /history changed/);
    assert.notEqual(assessPocScope(fixture.primary, input).id, request.id);
    assert.equal(inconclusiveCause("VERDICT: INCONCLUSIVE\n## Inconclusive cause\naccess\n"), "access");
    assert.throws(() => inconclusiveCause("VERDICT: INCONCLUSIVE\nUnclassified"), /requires ## Inconclusive cause/);
  } finally { fixture.cleanup(); }
});
test("run_poc states the sample-first sharded checkpoint contract", () => {
  const source = readFileSync(new URL("../skills/issue-execution/poc.yaml", import.meta.url), "utf8");
  const start = source.indexOf("  - id: run_poc\n");
  const step = source.slice(start, source.indexOf("  - id: run_poc_cancellation\n", start));
  for (const phrase of [
    "bounded representative sample", "measured throughput", "projected duration",
    "durable shard checkpoints", "index, range and completion time", "last completed shard",
    "configured multiple of the measured shard time", "owning OMP session",
    "continue, resize, or stop", "Completed shards stay preserved.",
  ]) assert.ok(step.includes(phrase), phrase);
});
