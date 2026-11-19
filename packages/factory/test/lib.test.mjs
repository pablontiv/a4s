import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT, checkVerdict, exitFor, isUnreachable, parseVerdict, resolveT3, threadPhase } from "../src/lib.mjs";
import { instancesFromLines } from "../src/instances.mjs";

const FACTORY = join(dirname(fileURLToPath(import.meta.url)), "..");

test("parseVerdict takes the last JSON line, also inside a code fence", () => {
  const text = 'done\n```json\n{"verdict":"pass","findings":["ok"],"commit":"abc","question":null}\n```';
  assert.equal(parseVerdict(text).verdict, "pass");
  assert.equal(parseVerdict("no json here"), null);
  assert.equal(parseVerdict('{"verdict":"maybe"}'), null);
  assert.equal(parseVerdict('{"verdict":"pass"\n'), null);
});

test("exitFor maps verdicts to station exit codes", () => {
  assert.equal(exitFor({ verdict: "pass" }), EXIT.PASS);
  assert.equal(exitFor({ verdict: "blocked" }), EXIT.PASS);
  assert.equal(exitFor({ verdict: "fail" }), EXIT.WORKER_FAIL);
  assert.equal(exitFor(null), EXIT.MALFORMED);
});

test("isUnreachable recognises T3 server outages, not worker failures", () => {
  assert.ok(isUnreachable("No running T3 Code server uses /x. Start T3 Code, then retry."));
  assert.ok(isUnreachable("Could not reach the T3 Code server (HTTP 503)"));
  assert.ok(!isUnreachable("Run failed: tool error"));
});

test("threadPhase distinguishes idle, waiting and busy", () => {
  assert.equal(threadPhase({ status: "completed", activeRunId: null, pendingBackgroundTasks: [], pendingRequestCount: 0 }), "idle");
  assert.equal(threadPhase({ status: "running", activeRunId: "r", pendingBackgroundTasks: [], pendingRequestCount: 0 }), "busy");
  assert.equal(threadPhase({ status: "completed", activeRunId: null, pendingBackgroundTasks: [{}], pendingRequestCount: 0 }), "busy");
  assert.equal(threadPhase({ status: "waiting", activeRunId: null, pendingBackgroundTasks: [], pendingRequestCount: 1 }), "waiting");
});

test("resolveT3 follows the running server version and fails closed", () => {
  const home = mkdtempSync(join(tmpdir(), "t3home-")); const versions = mkdtempSync(join(tmpdir(), "t3v-"));
  assert.match(resolveT3(home, versions).error, /server-runtime/);
  mkdirSync(join(home, "userdata"));
  writeFileSync(join(home, "userdata", "server-runtime.json"), JSON.stringify({ serverVersion: "9.9.9", origin: "http://x" }));
  assert.match(resolveT3(home, versions).error, /no t3 CLI for server version 9.9.9/);
  mkdirSync(join(versions, "9.9.9")); writeFileSync(join(versions, "9.9.9", "t3"), "");
  assert.equal(resolveT3(home, versions).bin, join(versions, "9.9.9", "t3"));
});

test("line instances are isolated and restricted to their allowlist", () => {
  const inst = instancesFromLines(join(FACTORY, "lines.json"), "/bin/pi")["pi-impl"];
  const args = inst.config.launchArgs;
  for (const flag of ["--no-extensions", "--no-mcp", "--no-skills", "--no-context-files", "--tools"]) assert.ok(args.includes(flag), flag);
  assert.ok(args.includes(join(FACTORY, "prompts", "impl.md")));
  assert.deepEqual(inst.environment, [{ name: "A4S_LINE", value: "impl" }]);
});

test("the qa line gets an isolated, read+bash-only instance of another model family", () => {
  const doc = JSON.parse(readFileSync(join(FACTORY, "lines.json"), "utf8"));
  assert.equal(doc.lines.qa.provider, "pi-qa");
  assert.notEqual(doc.lines.qa.model.split("/")[0], doc.lines.impl.model.split("/")[0]);
  const inst = instancesFromLines(join(FACTORY, "lines.json"), "/bin/pi")["pi-qa"];
  const args = inst.config.launchArgs;
  for (const flag of ["--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes"]) assert.ok(args.includes(flag), flag);
  assert.ok(args.includes("--tools read,bash"));
  assert.ok(!/edit|write/.test(args.split("--tools ")[1].split(" ")[0]));
  assert.ok(args.endsWith(`--append-system-prompt ${join(FACTORY, "prompts", "qa.md")}`));
  assert.deepEqual(inst.environment, [{ name: "A4S_LINE", value: "qa" }]);
});

test("the cycle runs QA between require_pass and validate, checks the worktree is untouched, and retries once via the impl thread", () => {
  const dag = readFileSync(join(FACTORY, "dags", "cycle.yaml"), "utf8");
  const at = (k) => dag.indexOf(k);
  assert.ok(at("id: require_pass") < at("id: qa") && at("id: qa") < at("id: validate"));
  const qa = dag.slice(at("id: qa"), at("id: validate"));
  assert.match(qa, /depends: require_pass/);
  assert.match(qa, /station\.mjs" --line qa/);
  assert.match(qa, /git status --porcelain/);
  assert.match(qa, /git diff/);
  assert.match(qa, /--continue "\$IMPL_THREAD"/);
  assert.match(dag.slice(at("id: validate"), at("id: integrate")), /depends: qa/);
});

test("the cycle DAG declares every station output", () => {
  const dag = readFileSync(join(FACTORY, "dags", "cycle.yaml"), "utf8");
  for (const k of ["result", "thread_id", "model", "question", "commit", "findings", "worktree"]) assert.ok(dag.includes(`{name: ${k}}`), k);
});

test("an absolute prompt path is kept absolute", () => {
  const dir = mkdtempSync(join(tmpdir(), "lines-"));
  const p = join(dir, "lines.json");
  writeFileSync(p, JSON.stringify({ lines: { impl: { provider: "pi-impl", instance: { prompt: "/abs/impl.md" } } } }));
  assert.ok(instancesFromLines(p, "/bin/pi")["pi-impl"].config.launchArgs.endsWith("--append-system-prompt /abs/impl.md"));
});

test("the cycle never uses LINES (shells export it as the terminal height)", () => {
  const dag = readFileSync(join(FACTORY, "dags", "cycle.yaml"), "utf8");
  assert.ok(dag.includes('--lines "$LINE_TABLE"'));
  assert.ok(!/\$LINES\b|name: LINES\b/.test(dag));
});

test("validate-first: nothing is committed before validation, one commit per issue, red CI is reverted", () => {
  const dag = readFileSync(join(FACTORY, "dags", "cycle.yaml"), "utf8");
  const order = ["id: implement", "id: validate", "id: integrate", "id: ci", "id: close"].map((k) => dag.indexOf(k));
  assert.deepEqual([...order].sort((x, y) => x - y), order, "step order");
  const before = dag.slice(0, dag.indexOf("id: integrate"));
  assert.ok(!/git commit/.test(before), "no commit before integrate");
  assert.match(dag, /id: integrate[\s\S]*git commit -q -m "\$\(cat "\$ISSUE_STATE\/title"\) \(#\$ISSUE\)"/);
  assert.match(dag, /id: ci[\s\S]*git -C "\$PRIMARY" revert --no-edit "\$SHA"/);
  assert.ok(!/human\.task/.test(dag), "no human step in the cycle");
  const impl = readFileSync(join(FACTORY, "prompts", "impl.md"), "utf8");
  assert.match(impl, /Do not commit/);
});

test("every factory DAG step resolves params through cycle-env.sh (no repeated blocks)", () => {
  for (const f of ["cycle.yaml", "admit.yaml"]) {
    const dag = readFileSync(join(FACTORY, "dags", f), "utf8");
    assert.ok(!dag.includes('PRIMARY="${PRIMARY:-${A4S_PRIMARY'), f);
    assert.ok(dag.includes("src/cycle-env.sh"), f);
  }
});

test("factory DAGs run under bash (they use ${!var})", () => {
  for (const f of ["cycle.yaml", "admit.yaml"]) {
    const dag = readFileSync(join(FACTORY, "dags", f), "utf8");
    assert.match(dag, /^shell: bash$/m, f);
  }
});

test("the factory test script works on the CI Node major (no bare directory arg)", () => {
  const pkg = JSON.parse(readFileSync(join(FACTORY, "package.json"), "utf8"));
  assert.ok(!/node --test test\/?(\s|$)/.test(pkg.scripts.test), pkg.scripts.test);
});

const okC = { criterion: "c", evidence: "npm test", result: "pass" };
test("checkVerdict keeps a valid pass and non-pass verdicts", () => {
  const v = { verdict: "pass", criteria: [okC], findings: [], question: null };
  assert.deepEqual(checkVerdict(v), { verdict: v, reason: null });
  const b = { verdict: "blocked", question: "q" };
  assert.equal(checkVerdict(b).verdict, b);
});

test("checkVerdict downgrades a pass without proof to fail with a reason", () => {
  for (const criteria of [undefined, [], [{ ...okC, evidence: "  " }], [{ criterion: "c", result: "pass" }], [okC, { ...okC, result: "fail" }]]) {
    const r = checkVerdict({ verdict: "pass", criteria, findings: ["x"] });
    assert.equal(r.verdict.verdict, "fail");
    assert.match(r.reason, /verdict contract/);
    assert.deepEqual(r.verdict.findings, ["x", r.reason]);
    assert.equal(exitFor(r.verdict), EXIT.WORKER_FAIL);
  }
});
