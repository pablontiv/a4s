import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { parseAllDocuments } from "yaml";
import { compiledA4sBin } from "./fixtures/admission.ts";
import { reconcileEnvironment } from "./role-job-fixtures.ts";

const a4sBin = compiledA4sBin();

const reconcile = readFileSync(new URL("../skills/issue-execution/reconcile.yaml", import.meta.url), "utf8");
const documents = parseAllDocuments(reconcile).map(document => document.toJS() as Record<string, unknown>);
const rootDag = documents[0]!;
const childDag = documents[1] as { name?: string };
const steps = rootDag.steps as Array<Record<string, unknown>>;
const classify = steps.find(step => step.id === "classify");
const tick = steps.find(step => step.id === "tick");
const act = steps.find(step => step.id === "act");

function stepSource(id: string): string {
  const start = reconcile.indexOf(`  - id: ${id}\n`);
  assert.ok(start >= 0, id);
  const end = reconcile.indexOf("\n  - id:", start + 1);
  return reconcile.slice(start, end < 0 ? reconcile.length : end);
}
function script(id: string): string {
  const block = stepSource(id);
  const literal = block.split("    run: |\n")[1];
  if (literal) {
    const lines = literal.split("\n");
    const end = lines.findIndex(line => line && !line.startsWith("      "));
    return lines.slice(0, end < 0 ? lines.length : end).map(line => line.slice(6)).join("\n");
  }
  const inline = block.match(/\n    run: ([^\n]+)\n/);
  assert.ok(inline, id);
  return inline[1]!;
}
function metrics(stderr: string): Array<Record<string, unknown>> {
  return stderr.split("\n").filter(line => line.startsWith("reconcile-metric ")).map(line => JSON.parse(line.slice("reconcile-metric ".length)) as Record<string, unknown>);
}
function outputMap(stdout: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const mark = line.indexOf("=");
    if (mark <= 0) continue;
    const key = line.slice(0, mark);
    if (key === "children" || key === "actions" || key === "failures" || key === "observation") outputs[key] = line.slice(mark + 1);
  }
  return outputs;
}
// Mirrors Dagu's parseDeclaredStepOutputs for single-line name=value records.
function parseDeclaredStepOutputs(text: string, names: readonly string[]): Record<string, string> {
  const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (normalized === "") throw new Error(`declared step output "${names[0]}" was not emitted`);
  let lines = normalized.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines = lines.slice(0, -1);
  const values: Record<string, string> = {};
  for (const [index, line] of lines.entries()) {
    if (line === "") throw new Error(`empty line at line ${index + 1} is not a valid step output record`);
    const equalsAt = line.indexOf("=");
    if (equalsAt < 0) throw new Error(`invalid step output record at line ${index + 1}`);
    const name = line.slice(0, equalsAt);
    if (name === "") throw new Error(`missing output name at line ${index + 1}`);
    if (!names.includes(name)) throw new Error(`undeclared step output "${name}"`);
    if (Object.hasOwn(values, name)) throw new Error(`duplicate step output "${name}"`);
    values[name] = line.slice(equalsAt + 1);
  }
  for (const name of names) {
    if (!Object.hasOwn(values, name)) throw new Error(`declared step output "${name}" was not emitted`);
  }
  return values;
}
function runBash(source: string, env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  env = reconcileEnvironment(env);
  const started = performance.now();
  return new Promise(resolve => {
    const child = spawn("bash", ["-c", source], { env: { A4S_BIN: a4sBin, ...env } });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", status => resolve({ status, stdout, stderr, started, ended: performance.now() } as { status: number | null; stdout: string; stderr: string }));
  });
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);

function writeMocks(bin: string, calls: string, control: string): void {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const control = JSON.parse(fs.readFileSync(process.env.CI_CONTROL, "utf8"));
const run = process.env.RUN || "";
const spec = (control.runs || {})[run] || {};
fs.appendFileSync(process.env.CI_CALLS, JSON.stringify({ tool: "gh", args, run }) + "\\n");
const issues = control.issues || [];
const emit = (value) => console.log(typeof value === "string" ? value : JSON.stringify(value));
if (args[0] === "repo" && args[1] === "view") emit("example/repo");
else if (args[0] === "issue" && args[1] === "view") {
  const repoFlag = args[args.indexOf("-R") + 1];
  if ((control.failRepos || []).includes(repoFlag)) process.exit(4);
  const found = issues.find(item => String(item.number) === String(args[2]));
  if (!found) process.exit(1);
  emit(String(found.state).toUpperCase() + " closed_at=" + (found.closed_at || ""));
} else if (args[0] === "api") {
  const endpoint = String(args.at(-1));
  const repo = endpoint.split("/")[1] + "/" + endpoint.split("/")[2];
  if ((control.failRepos || []).includes(repo)) process.exit(4);
  if (endpoint.includes("/issues?")) {
    if (control.stuck) {
      emit(Array.from({ length: 100 }, () => ({ number: 1, state: "open", closed_at: null })));
      return;
    }
    const page = Number(new URL(endpoint, "https://example.test").searchParams.get("page") || "1");
    emit(issues.slice((page - 1) * 100, page * 100));
    return;
  }
  if (endpoint.includes("/check-runs")) {
    const sha = spec.mode === "stale-sha" ? "${OTHER}" : "${HEAD}";
    const pending = spec.mode === "pending";
    const failed = spec.mode === "code-fail";
    emit([{ check_runs: [{ id: 456, name: "validate", head_sha: sha, status: pending ? "in_progress" : "completed", conclusion: pending ? null : failed ? "failure" : "success", details_url: "https://github.com/example/repo/actions/runs/123/job/456", output: { summary: failed ? "AssertionError: test failed" : "ok" } }] }]);
    return;
  }
  if (endpoint.endsWith("/status")) { emit({ sha: "${HEAD}", statuses: [] }); return; }
  process.exit(91);
} else if (args[0] === "pr" && args[1] === "view") {
  if (spec.mode === "github-down") process.exit(4);
  const state = spec.mode === "merged" ? "MERGED" : "OPEN";
  if (args.includes("--jq")) {
    emit(spec.mode === "changed-head" && String(args.join(" ")).includes("headRefOid") ? "${OTHER}" : "${HEAD}");
    return;
  }
  emit({ number: 77, state, mergeStateStatus: "CLEAN", autoMergeRequest: null, headRefOid: "${HEAD}", statusCheckRollup: [] });
} else if (args[0] === "pr" && args[1] === "checks") {
  const pending = spec.mode === "pending";
  const failed = spec.mode === "code-fail";
  emit([{ name: "validate", state: pending ? "IN_PROGRESS" : failed ? "FAILURE" : "SUCCESS", link: "https://github.com/example/repo/actions/runs/123/job/456" }]);
  process.exit(pending ? 8 : failed ? 1 : 0);
} else if (args[0] === "run" && args[1] === "view") emit(spec.mode === "code-fail" ? "AssertionError: test failed" : "ok");
else process.exit(92);
`);
  writeFileSync(join(bin, "dagu"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const control = JSON.parse(fs.readFileSync(process.env.CI_CONTROL, "utf8"));
const run = process.env.RUN || args[args.indexOf("--run-id") + 1] || "";
const spec = (control.runs || {})[run] || {};
fs.appendFileSync(process.env.CI_CALLS, JSON.stringify({ tool: "dagu", args, run }) + "\\n");
if (args[0] === "status") {
  if (spec.statusFail) process.exit(1);
  if (spec.running) { console.log("Running - fixture"); process.exit(0); }
  console.log("Waiting - fixture");
  console.log("├─" + (spec.step || "implement") + " [waiting]");
  console.log("│ └─push-back iteration: " + (spec.iteration || 0));
} else if (args[0] === "human-task") {
  control.effects = control.effects || [];
  control.effects.push({ action: args[1], run, step: args[args.indexOf("--step") + 1] });
  fs.writeFileSync(process.env.CI_CONTROL, JSON.stringify(control));
} else process.exit(93);
`);
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "dagu"), 0o755);
  writeFileSync(calls, "");
  writeFileSync(control, "{}");
}

function initPrimary(root: string): string {
  const primary = join(root, "primary");
  execFileSync("git", ["init", "-b", "main", primary], { stdio: "pipe" });
  git(primary, "config", "user.name", "Reconcile test");
  git(primary, "config", "user.email", "reconcile@example.test");
  writeFileSync(join(primary, "README"), "primary\n");
  git(primary, "add", ".");
  git(primary, "commit", "-m", "base");
  return primary;
}

interface CaseRun {
  run: string;
  issue: string;
  step: string;
  repo?: string;
  mode?: string;
  running?: boolean;
  statusFail?: boolean;
  primary?: string;
}
function issuesFor(runs: CaseRun[]): Array<{ number: number; state: string; closed_at: string | null }> {
  const fillers = Array.from({ length: 100 }, (_, index) => ({ number: 1000 + index, state: "open", closed_at: null }));
  const real = runs.filter(run => !["await_ci", "await_merge"].includes(run.step)).map(run => ({
    number: Number(run.issue),
    state: run.mode === "closed" ? "closed" : "open",
    closed_at: run.mode === "closed" ? "2026-01-02T00:00:00Z" : null,
  }));
  return [...fillers, ...real];
}
function row(primary: string, run: CaseRun): Record<string, string> {
  return {
    RUN: run.run,
    ISSUE: run.issue,
    PRIMARY: run.primary || primary,
    BRANCH: `dagu/issue-${run.issue}`,
    PR_NUMBER: ["await_ci", "await_merge"].includes(run.step) ? "77" : "",
    REPO: run.repo || "example/repo",
  };
}
function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
async function legacyOutcome(primary: string, run: CaseRun, env: NodeJS.ProcessEnv): Promise<{ observation: unknown; escalation: unknown; orphan: string; status: number | null }> {
  const childEnv = {
    ...env,
    RUN: run.run,
    ISSUE: run.issue,
    PRIMARY: run.primary || primary,
    BRANCH: `dagu/issue-${run.issue}`,
    PR_NUMBER: ["await_ci", "await_merge"].includes(run.step) ? "77" : "",
    REPO: run.repo || "example/repo",
    DAGU_OUTPUT_FILE: join(env.TMPDIR || tmpdir(), `${run.run}.out`),
  };
  const observed = await runBash(script("observe"), childEnv);
  const state = git(run.primary || primary, "rev-parse", "--path-format=absolute", "--git-path", `dagu-feature/runs/${run.run}`);
  if (observed.status !== 0) return { observation: null, escalation: null, orphan: "", status: observed.status };
  const observation = readJson(join(state, "ci-observation.json"));
  const escalation = readJson(join(state, "ci-no-progress.json"));
  const outputs = Object.fromEntries(observed.stdout.split("\n").filter(line => line.includes("=")).map(line => {
    const mark = line.indexOf("=");
    return [line.slice(0, mark), line.slice(mark + 1)];
  }));
  let orphan = "";
  if (/^(triage|implement) issue=CLOSED /.test(outputs.observation || "")) {
    orphan = `ORPHAN ${outputs.repo}#${outputs.issue} ${outputs.run} ${outputs.observation}`;
  }
  const transition = await runBash(script("transition"), childEnv);
  assert.equal(transition.status, 0, `${run.run} transition\n${transition.stderr}`);
  return { observation, escalation, orphan, status: 0 };
}

test("root classification matches child observation for protected and non-PR runs", async () => {
  assert.equal(childDag.name, "reconcile-run");
  assert.equal((tick?.parallel as { max_concurrent?: number } | undefined)?.max_concurrent, 4);
  assert.equal((tick?.with as { dag?: string } | undefined)?.dag, "reconcile-run");
  assert.equal((tick?.parallel as { items?: string } | undefined)?.items, "${steps.classify.outputs.children}");
  assert.equal((act?.parallel as { items?: string } | undefined)?.items, "${steps.classify.outputs.actions}");
  assert.equal((act?.parallel as { max_concurrent?: number } | undefined)?.max_concurrent, 4);
  assert.ok(classify);
  const root = mkdtempSync(join(tmpdir(), "reconcile-fanout-equiv-"));
  const primary = initPrimary(root);
  const bin = join(root, "bin");
  const calls = join(root, "calls.jsonl");
  const control = join(root, "control.json");
  writeMocks(bin, calls, control);
  const runs: CaseRun[] = [
    { run: "wait-ci", issue: "1", step: "await_ci", mode: "pending" },
    { run: "changed-head", issue: "2", step: "await_ci", mode: "changed-head" },
    { run: "merged", issue: "3", step: "await_merge", mode: "merged" },
    { run: "code-fail", issue: "4", step: "await_ci", mode: "code-fail" },
    { run: "stale-sha", issue: "5", step: "await_ci", mode: "stale-sha" },
    { run: "github-down", issue: "6", step: "await_ci", mode: "github-down" },
    { run: "open-implement", issue: "11", step: "implement" },
    { run: "closed-triage", issue: "12", step: "triage", mode: "closed" },
    { run: "closed-implement", issue: "14", step: "implement", mode: "closed" },
    { run: "open-review", issue: "13", step: "quality_review" },
    { run: "left-waiting", issue: "15", step: "implement", running: true },
    { run: "status-down", issue: "16", step: "implement", statusFail: true },
    { run: "other-repo", issue: "17", step: "implement", repo: "example/beta" },
    { run: "beta-down", issue: "18", step: "triage", repo: "example/beta", mode: "closed" },
    { run: "bad-primary", issue: "19", step: "implement", primary: join(root, "missing-primary") },
  ];
  const baseEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CI_CONTROL: control,
    CI_CALLS: calls,
    CI_OBSERVATION_ID: "tick-equiv",
    ESCALATION_CI_BLOCKED: "2",
    TMPDIR: root,
    DAGU_OUTPUT_FILE: join(root, "classify.output"),
  };
  try {
    writeFileSync(control, JSON.stringify({ runs: Object.fromEntries(runs.map(run => [run.run, run])), issues: issuesFor(runs), failRepos: ["example/beta"], effects: [] }));
    const legacy = new Map<string, Awaited<ReturnType<typeof legacyOutcome>>>();
    for (const run of runs.filter(item => item.primary === undefined)) {
      legacy.set(run.run, await legacyOutcome(primary, run, baseEnv));
    }
    const legacyEffects = (JSON.parse(readFileSync(control, "utf8")) as { effects: unknown[] }).effects;
    rmSync(join(primary, ".git/dagu-feature"), { recursive: true, force: true });
    writeFileSync(calls, "");
    writeFileSync(control, JSON.stringify({ runs: Object.fromEntries(runs.map(run => [run.run, run])), issues: issuesFor(runs), failRepos: ["example/beta"], effects: [] }));
    const classified = await runBash(script("classify"), { ...baseEnv, RUNS: JSON.stringify(runs.map(run => row(primary, run))) });
    assert.equal(classified.status, 0, classified.stderr);
    const outputs = outputMap(classified.stdout);
    const emitted = parseDeclaredStepOutputs(readFileSync(join(root, "classify.output"), "utf8"), ["children", "actions", "failures"]);
    assert.equal(emitted.children, outputs.children);
    assert.equal(emitted.actions, outputs.actions);
    assert.equal(emitted.failures, outputs.failures);
    const children = JSON.parse(outputs.children || "[]") as Array<{ RUN: string }>;
    const actions = JSON.parse(outputs.actions || "[]") as unknown[];
    const failures = JSON.parse(outputs.failures || "[]") as Array<{ run: string }>;
    assert.deepEqual(children.map(item => item.RUN).sort(), ["changed-head", "code-fail", "github-down", "merged", "stale-sha", "wait-ci"]);
    assert.deepEqual(actions, []);
    assert.deepEqual(failures.map(item => item.run), ["bad-primary"]);
    const orphans = classified.stdout.split("\n").filter(line => line.startsWith("ORPHAN "));
    assert.deepEqual(orphans, [
      "ORPHAN example/repo#12 closed-triage triage issue=CLOSED closed_at=2026-01-02T00:00:00Z",
      "ORPHAN example/repo#14 closed-implement implement issue=CLOSED closed_at=2026-01-02T00:00:00Z",
    ]);
    for (const child of children) {
      const run = runs.find(item => item.run === child.RUN)!;
      const outcome = await legacyOutcome(primary, run, baseEnv);
      const previous = legacy.get(run.run)!;
      assert.equal(outcome.status, previous.status, run.run);
      assert.deepEqual(outcome.observation, previous.observation, run.run);
      assert.deepEqual(outcome.escalation, previous.escalation, run.run);
      assert.equal(outcome.orphan, previous.orphan, run.run);
    }
    for (const run of runs.filter(item => !children.some(child => child.RUN === item.run) && item.primary === undefined)) {
      const state = git(primary, "rev-parse", "--path-format=absolute", "--git-path", `dagu-feature/runs/${run.run}`);
      const observation = readJson(join(state, "ci-observation.json"));
      const escalation = readJson(join(state, "ci-no-progress.json"));
      const previous = legacy.get(run.run)!;
      assert.deepEqual(observation, previous.observation, run.run);
      assert.deepEqual(escalation, previous.escalation, run.run);
      const orphan = orphans.find(line => line.includes(` ${run.run} `)) || "";
      assert.equal(orphan, previous.orphan, run.run);
    }
    const candidateEffects = (JSON.parse(readFileSync(control, "utf8")) as { effects: Array<{ action: string; run: string }> }).effects;
    assert.deepEqual(candidateEffects.map(item => `${item.action}:${item.run}`).sort(), legacyEffects.map(item => {
      const effect = item as { action: string; run: string };
      return `${effect.action}:${effect.run}`;
    }).sort());
    const ghCalls = readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line) as { tool: string; args: string[]; run: string });
    const issueViews = ghCalls.filter(call => call.tool === "gh" && call.args[0] === "issue");
    const issuePages = ghCalls.filter(call => call.tool === "gh" && call.args[0] === "api" && String(call.args.at(-1)).includes("/issues?"));
    assert.equal(issueViews.length, 0);
    assert.equal(issuePages.length, 3);
    const summary = metrics(classified.stderr).find(item => item.phase === "classify");
    assert.equal(summary?.prRuns, 6);
    assert.equal(summary?.orphans, 2);
    assert.equal(summary?.failures, 1);
    assert.equal(summary?.issueRepos, 2);
    assert.ok(Number(summary?.issuePages) >= 2);
    const open = readJson(git(primary, "rev-parse", "--path-format=absolute", "--git-path", "dagu-feature/runs/open-implement/ci-observation.json")) as { action: string; class: string };
    const unavailable = readJson(git(primary, "rev-parse", "--path-format=absolute", "--git-path", "dagu-feature/runs/status-down/ci-observation.json")) as { class: string; action: string; observation?: string };
    const beta = readJson(git(primary, "rev-parse", "--path-format=absolute", "--git-path", "dagu-feature/runs/beta-down/ci-observation.json")) as { class: string; action: string };
    assert.equal(open.action, "WAIT");
    assert.equal(unavailable.class, "BLOCKED");
    assert.equal(unavailable.action, "WAIT");
    assert.equal(beta.class, "BLOCKED");
    assert.equal(beta.action, "WAIT");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a repeated issue page is not treated as a partial closed or open state", async () => {
  const root = mkdtempSync(join(tmpdir(), "reconcile-fanout-stuck-"));
  const primary = initPrimary(root);
  const bin = join(root, "bin");
  const calls = join(root, "calls.jsonl");
  const control = join(root, "control.json");
  writeMocks(bin, calls, control);
  const run = { run: "stuck", issue: "11", step: "implement" };
  writeFileSync(control, JSON.stringify({ runs: { stuck: run }, issues: issuesFor([run]), stuck: true, effects: [] }));
  try {
    const result = await runBash(script("classify"), {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, CI_CONTROL: control, CI_CALLS: calls,
      CI_OBSERVATION_ID: "tick-stuck", ESCALATION_CI_BLOCKED: "2", RUNS: JSON.stringify([row(primary, run)]),
      DAGU_OUTPUT_FILE: join(root, "classify.output"),
    });
    assert.equal(result.status, 0, result.stderr);
    const observation = readJson(git(primary, "rev-parse", "--path-format=absolute", "--git-path", "dagu-feature/runs/stuck/ci-observation.json")) as { class: string; action: string };
    assert.equal(observation.class, "BLOCKED");
    assert.equal(observation.action, "WAIT");
    assert.equal(outputMap(result.stdout).children, "[]");
    assert.match(result.stderr, /issue page did not advance/);
    const emitted = parseDeclaredStepOutputs(readFileSync(join(root, "classify.output"), "utf8"), ["children", "actions", "failures"]);
    assert.equal(emitted.children, "[]");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("empty discovery emits declared classify outputs through the Dagu output file", async () => {
  const declared = ((classify?.outputs as Array<{ name?: string }> | undefined) ?? []).map(item => item.name);
  assert.deepEqual(declared, ["children", "actions", "failures"]);
  assert.match(script("classify"), /tee -a "\$\{DAGU_OUTPUT_FILE:\?/);
  assert.throws(
    () => parseDeclaredStepOutputs("", ["children", "actions", "failures"]),
    /declared step output "children" was not emitted/,
  );
  const root = mkdtempSync(join(tmpdir(), "reconcile-classify-empty-"));
  const output = join(root, "classify.output");
  writeFileSync(output, "");
  try {
    const result = await runBash(script("classify"), {
      ...process.env,
      CI_OBSERVATION_ID: "tick-empty",
      ESCALATION_CI_BLOCKED: "2",
      RUNS: "[]",
      DAGU_OUTPUT_FILE: output,
      TMPDIR: root,
    });
    assert.equal(result.status, 0, result.stderr);
    const emitted = parseDeclaredStepOutputs(readFileSync(output, "utf8"), ["children", "actions", "failures"]);
    assert.deepEqual(emitted, { children: "[]", actions: "[]", failures: "[]" });
    assert.equal(outputMap(result.stdout).children, "[]");
    const fanout = (tick?.preconditions as Array<{ expected?: string }> | undefined)?.[0]?.expected;
    assert.equal(fanout, "re:^\\[.+\\]$");
    assert.equal((act?.preconditions as Array<{ expected?: string }> | undefined)?.[0]?.expected, fanout);
    assert.doesNotMatch(emitted.children, /^\[.+\]$/);
    assert.doesNotMatch(emitted.actions, /^\[.+\]$/);
    const summary = metrics(result.stderr).find(item => item.phase === "classify");
    assert.equal(summary?.inputRuns, 0);
    assert.equal(summary?.prRuns, 0);
    assert.equal(summary?.actions, 0);
    assert.equal(summary?.failures, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
function definitionJson(name: string, scripts: Array<[string, string]>): string {
  return JSON.stringify({
    name,
    steps: scripts.map(([id, body]) => ({ id, name: id, script: body })),
    baseConfigData: "b".repeat(14804),
    yamlData: Buffer.from(scripts.map(([, body]) => body).join("\n")).toString("base64"),
  });
}
function statusJsonl(scripts: Array<[string, string]>, stdout: string): string {
  return JSON.stringify({
    status: 4,
    nodes: scripts.map(([id, body]) => ({ step: { id, name: id, script: body }, stdout, stderr: "", status: 4 })),
  }) + "\n";
}
function eventFile(dag: string, count: number): string {
  return Array.from({ length: count }, (_, index) => JSON.stringify({
    schema_version: 1,
    kind: "dag_run",
    type: index === 0 ? "dag.run.running" : index === count - 1 ? "dag.run.succeeded" : "dag.run.updated",
    dag_name: dag,
    dag_run_id: `${dag}-${index}`,
    data: { pad: "x".repeat(1200) },
  })).join("\n") + "\n";
}

test("benchmark ticks keep protected children and cut persisted bytes by at least 80 percent", { timeout: 240_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "reconcile-fanout-bytes-"));
  const primary = initPrimary(root);
  const bin = join(root, "bin");
  const calls = join(root, "calls.jsonl");
  const control = join(root, "control.json");
  writeMocks(bin, calls, control);
  const runs: CaseRun[] = [
    { run: "await-ci", issue: "1", step: "await_ci", mode: "pending" },
    { run: "await-merge", issue: "2", step: "await_merge", mode: "pending" },
    { run: "orphan-implement", issue: "3", step: "implement", mode: "closed" },
    { run: "orphan-triage", issue: "4", step: "triage", mode: "closed" },
  ];
  const openSteps = ["implement", "triage", "quality_review"] as const;
  for (let index = 0; index < 16; index += 1) runs.push({ run: `open-${index}`, issue: String(20 + index), step: openSteps[index % openSteps.length]! });
  assert.equal(runs.length, 20);
  writeFileSync(control, JSON.stringify({ runs: Object.fromEntries(runs.map(run => [run.run, run])), issues: issuesFor(runs), effects: [] }));
  const runsJson = JSON.stringify(runs.map(run => row(primary, run)));
  const childScripts: Array<[string, string]> = [["observe", script("observe")], ["transition", script("transition")], ["orphan", script("orphan")]];
  const baselineRootScripts: Array<[string, string]> = [["recover_stale", script("recover_stale")], ["discover", script("discover")]];
  const candidateRootScripts: Array<[string, string]> = [...baselineRootScripts, ["classify", script("classify")]];
  const childDefinition = definitionJson("reconcile-run", childScripts);
  const baselineRootDefinition = definitionJson("reconcile", [...baselineRootScripts, ...childScripts]);
  const candidateRootDefinition = definitionJson("reconcile", [...candidateRootScripts, ...childScripts]);
  const childStatus = statusJsonl(childScripts, "observation");
  const baselineEvents: number[] = [];
  const candidateEvents: number[] = [];
  const baselineHistory: number[] = [];
  const candidateHistory: number[] = [];
  try {
    for (let tickNumber = 1; tickNumber <= 30; tickNumber += 1) {
      writeFileSync(calls, "");
      const result = await runBash(script("classify"), {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, CI_CONTROL: control, CI_CALLS: calls,
        CI_OBSERVATION_ID: `tick-${tickNumber}`, ESCALATION_CI_BLOCKED: "2", RUNS: runsJson,
        DAGU_OUTPUT_FILE: join(root, `classify-${tickNumber}.output`),
      });
      assert.equal(result.status, 0, result.stderr);
      const outputs = outputMap(result.stdout);
      const children = JSON.parse(outputs.children || "[]") as Array<{ RUN: string }>;
      assert.deepEqual(children.map(item => item.RUN).sort(), ["await-ci", "await-merge"]);
      assert.equal(outputs.actions, "[]");
      assert.equal(outputs.failures, "[]");
      const orphanLines = result.stdout.split("\n").filter(line => line.startsWith("ORPHAN "));
      assert.equal(orphanLines.length, 2);
      const summary = metrics(result.stderr).find(item => item.phase === "classify");
      assert.equal(summary?.issueRepos, 1);
      assert.equal(summary?.issuePages, 2);
      const ghCalls = readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { tool: string; args: string[] });
      assert.equal(ghCalls.filter(call => call.tool === "gh" && call.args[0] === "issue").length, 0);
      assert.equal(ghCalls.filter(call => call.tool === "gh" && call.args[0] === "api" && String(call.args.at(-1)).includes("/issues?")).length, 2);
      const baselineDir = join(root, "baseline", String(tickNumber));
      const candidateDir = join(root, "candidate", String(tickNumber));
      mkdirSync(baselineDir, { recursive: true });
      mkdirSync(candidateDir, { recursive: true });
      writeFileSync(join(baselineDir, "dag.json"), baselineRootDefinition);
      writeFileSync(join(baselineDir, "status.jsonl"), statusJsonl(baselineRootScripts, "[]"));
      writeFileSync(join(baselineDir, "events.jsonl"), eventFile("reconcile", 8));
      for (let child = 0; child < 20; child += 1) {
        const dir = join(baselineDir, "sub", `child-${child}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "dag.json"), childDefinition);
        writeFileSync(join(dir, "status.jsonl"), childStatus);
        writeFileSync(join(dir, "events.jsonl"), eventFile("reconcile-run", 9));
      }
      writeFileSync(join(candidateDir, "dag.json"), candidateRootDefinition);
      writeFileSync(join(candidateDir, "status.jsonl"), statusJsonl(candidateRootScripts, result.stdout));
      writeFileSync(join(candidateDir, "events.jsonl"), eventFile("reconcile", 8));
      for (const child of children) {
        const dir = join(candidateDir, "sub", child.RUN);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "dag.json"), childDefinition);
        writeFileSync(join(dir, "status.jsonl"), childStatus);
        writeFileSync(join(dir, "events.jsonl"), eventFile("reconcile-run", 9));
      }
      const measure = (dir: string) => {
        const files = [join(dir, "dag.json"), join(dir, "status.jsonl")];
        const children = readdirSync(join(dir, "sub"));
        for (const child of children) files.push(join(dir, "sub", child, "dag.json"), join(dir, "sub", child, "status.jsonl"));
        const history = files.reduce((sum, file) => sum + readFileSync(file).byteLength, 0);
        const events = [join(dir, "events.jsonl"), ...children.map(child => join(dir, "sub", child, "events.jsonl"))]
          .reduce((sum, file) => sum + readFileSync(file).byteLength, 0);
        return { history, events };
      };
      const baseline = measure(baselineDir);
      const candidate = measure(candidateDir);
      baselineHistory.push(baseline.history);
      candidateHistory.push(candidate.history);
      baselineEvents.push(baseline.events);
      candidateEvents.push(candidate.events);
    }
    const eventMedian = { baseline: median(baselineEvents), candidate: median(candidateEvents) };
    const historyMedian = { baseline: median(baselineHistory), candidate: median(candidateHistory) };
    const eventReduction = 1 - eventMedian.candidate / eventMedian.baseline;
    const historyReduction = 1 - historyMedian.candidate / historyMedian.baseline;
    t.diagnostic(JSON.stringify({ ticks: 30, population: 20, children: { baseline: 20, candidate: 2 }, eventMedian, historyMedian, eventReduction, historyReduction }));
    assert.ok(eventReduction >= 0.8, `event bytes reduced ${eventReduction}`);
    assert.ok(historyReduction >= 0.8, `history bytes reduced ${historyReduction}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
