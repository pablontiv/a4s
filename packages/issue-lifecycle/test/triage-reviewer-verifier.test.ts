import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { verifyTriageResult } from "../src/role-dispatch.ts";
import { atomicJson, executorIdentity, jobId, type JobBinding, type JobResult } from "../src/role-jobs.ts";
import { nativeEvidence, roleSchema } from "../src/role-runtime.ts";
import { REVIEW_SCHEMA } from "../src/triage/schema.ts";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-dagu-triage-role-")));
  execFileSync("git", ["init", "--quiet", root]);
  const binding: JobBinding = { repo: root, worktree: root, lane: "feature", dag: "feature", run: "fixture-run", stage: "triage", role: "triage", sha: "a".repeat(40), iteration: 0, attempt: "0" };
  const id = jobId(binding);
  const directory = join(root, ".git", "dagu-feature", "runs", binding.run, "role-jobs", id);
  mkdirSync(directory, { recursive: true });
  const transcript = join(directory, `${id}.jsonl`);
  const output = { poc: "no", behavior: "demonstrated", question: "Already proven runtime?", reason: "PoC PASS" };
  const rows = [{ type: "session", id: "native-triage" }, { type: "session_init", agent: "triage-reviewer", task: `Authorized Dagu role job ${id}.` },
    { type: "message", id: "response", message: { role: "assistant", provider: "actual-provider", model: "actual-model", stopReason: "toolUse", content: [{ type: "toolCall", id: "yield-1", name: "yield", arguments: { data: output } }] } },
    { type: "message", id: "outcome", message: { role: "toolResult", toolCallId: "yield-1", toolName: "yield", details: { status: "success", data: output } } }];
  const seal = () => {
    writeFileSync(transcript, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    return nativeEvidence(transcript, { agent: "triage-reviewer", patterns: ["@slow", "provider/fallback"] });
  };
  const result: JobResult = { schemaVersion: 1, id, binding, executor: executorIdentity(), state: "completed", readyAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), readyToStartMs: 0, output, native: seal() };
  const path = join(directory, "result.json");
  const save = () => atomicJson(path, result);
  save();
  return { root, id, path, result, transcript, rows, seal, save, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("triage verifies bound native execution and sealed structured decision", () => {
  const f = fixture();
  try {
    assert.equal(verifyTriageResult(f.root, "fixture-run", f.id).output?.poc, "no");
    writeFileSync(f.transcript, readFileSync(f.transcript, "utf8") + JSON.stringify({ type: "session_exit" }) + "\n");
    assert.equal(verifyTriageResult(f.root, "fixture-run", f.id).native?.model, "actual-model");
    f.result.output = { ...f.result.output, reason: "unobserved replacement" }; f.save();
    assert.throws(() => verifyTriageResult(f.root, "fixture-run", f.id), /output differs/);
  } finally { f.cleanup(); }
});

test("triage preserves PoC-required decisions and fails closed on identity changes", () => {
  const f = fixture();
  try {
    assert.throws(() => verifyTriageResult(f.root, "fixture-run", "../foreign"), /Invalid/);
    f.result.state = "failed"; f.save();
    assert.throws(() => verifyTriageResult(f.root, "fixture-run", f.id), /completed native/);
    f.result.state = "completed";
    f.result.native!.session = "foreign-session"; f.save();
    assert.throws(() => verifyTriageResult(f.root, "fixture-run", f.id), /provenance/);
    f.rows[1]!.task = `Authorized Dagu role job ${"b".repeat(64)}.`;
    f.result.native = f.seal(); f.save();
    assert.throws(() => verifyTriageResult(f.root, "fixture-run", f.id), /assignment identity/);
    f.rows[1]!.task = `Authorized Dagu role job ${f.id}.`;
    f.result.output!.poc = "yes";
    f.result.output!.requiredTargets = ["linux-arm64"];
    f.result.output!.authorizedTargets = ["linux-arm64"];
    f.result.output!.scopeBasis = "Operator authorized local Linux";
    f.result.native = f.seal(); f.save();
    assert.throws(() => verifyTriageResult(f.root, "fixture-run", f.id), /requires a PoC/);
    writeFileSync(f.transcript, "changed prefix\n");
    assert.throws(() => verifyTriageResult(f.root, "fixture-run", f.id), /transcript changed/);
  } finally { f.cleanup(); }
});

test("native triage shares the distributed agent's canonical decision schema", () => {
  const definition = readFileSync(new URL("../agents/triage-reviewer.md", import.meta.url), "utf8");
  assert.deepEqual(JSON.parse(/^output: (.+)$/m.exec(definition)![1]!), REVIEW_SCHEMA);
  const f = fixture();
  try { assert.deepEqual(roleSchema(f.result.binding), REVIEW_SCHEMA); }
  finally { f.cleanup(); }
});

test("triage binds the job marker across agent types and review prose", () => {
  const f = fixture();
  try {
    for (const agent of ["task", "reviewer", "worker", "triage-reviewer"]) {
      f.rows[1]!.agent = agent;
      f.rows[1]!.task = `Review this runtime scope.\nAuthorized Dagu role job ${f.id}.\nUse linked PASS evidence.`;
      f.result.native = f.seal(); f.save();
      assert.equal(verifyTriageResult(f.root, "fixture-run", f.id).output?.poc, "no");
    }
    for (const task of [
      "Review the issue without an authorized job marker.",
      `XAuthorized Dagu role job ${f.id}.`,
      `Authorized Dagu role job ${f.id}.suffix`,
      `Authorized Dagu role job ${"c".repeat(64)}.`,
    ]) {
      f.rows[1]!.task = task;
      f.result.native = f.seal(); f.save();
      assert.throws(() => verifyTriageResult(f.root, "fixture-run", f.id), /assignment identity/);
    }
  } finally { f.cleanup(); }
});

test("bound triage output retains field expected observed diagnostics", () => {
  for (const [changes, diagnostic] of [
    [{ extra: "surprise" }, 'field=extra expected=additionalProperties=false observed="surprise"'],
    [{ question: "" }, 'field=question expected=nonempty string observed=""'],
    [{ behavior: " " }, 'field=behavior expected=nonempty string observed=" "'],
    [{ reason: 42 }, "field=reason expected=string observed=42"],
    [{ poc: "maybe" }, 'field=poc expected=["yes","no"] observed="maybe"'],
    [{ reason: undefined }, "field=reason expected=string observed=<missing>"],
  ] as const) {
    const f = fixture();
    try {
      Object.assign(f.result.output!, changes);
      f.result.native = f.seal(); f.save();
      assert.throws(() => verifyTriageResult(f.root, "fixture-run", f.id),
        (error: unknown) => error instanceof Error && error.message === `TRIAGE_REVIEW_INVALID: ${diagnostic}`);
    } finally { f.cleanup(); }
  }
});

test("triage command retains receipt diagnostics and rejects stale native iterations", () => {
  const f = fixture();
  try {
    const bin = join(f.root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "dagu"), '#!/bin/sh\nprintf "push-back iteration: %s\\n" "${TEST_ITERATION:-0}"\n');
    chmodSync(join(bin, "dagu"), 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PRIMARY: f.root,
      RUN: "fixture-run", REVIEW: f.id, POC: "no", QUESTION: String(f.result.output!.question),
      BASIS: String(f.result.output!.reason) };
    const cli = fileURLToPath(new URL("../bin/dagu-role-jobs.ts", import.meta.url));
    const verify = (overrides: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath,
      ["--import", import.meta.resolve("tsx"), cli, "verify-triage"], { env: { ...env, ...overrides }, encoding: "utf8" });
    const success = verify();
    assert.equal(success.status, 0, success.stderr);
    assert.ok(success.stdout.includes(`primary.canonical=${f.root}\n`));
    assert.ok(success.stdout.includes(`result.path=${f.path}\n`));
    assert.ok(success.stdout.includes(`transcript.path=${f.transcript}\n`));
    assert.match(success.stdout, /VERIFIER=PASS role_job=/);
    const stale = verify({ TEST_ITERATION: "1" });
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /another native iteration[\s\S]*VERIFIER=FAIL/);
    assert.ok(stale.stdout.includes(`result.path=${f.path}\n`));
    rmSync(f.path);
    const missing = verify();
    assert.equal(missing.status, 1);
    assert.ok(missing.stdout.includes(`result.path=${f.path}\n`));
    assert.match(missing.stderr, /ENOENT[\s\S]*VERIFIER=FAIL/);
  } finally { f.cleanup(); }
});

test("template verifies the exact role receipt before state or publication effects", () => {
  const f = fixture();
  try {
    const bin = join(f.root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "dagu-role-jobs"), '#!/bin/sh\nexec "$TEST_NODE" --import "$TEST_TSX" "$TEST_CLI" "$@"\n');
    chmodSync(join(bin, "dagu-role-jobs"), 0o755);
    const yaml = readFileSync(new URL("../skills/issue-execution/feature.yaml", import.meta.url), "utf8");
    const step = yaml.split("  - id: triage_decision\n")[1]!.split("\n  - id: detect_start_primary\n")[0]!;
    const script = step.split("    run: |\n")[1]!.split("\n").map(line => line.startsWith("      ") ? line.slice(6) : line).join("\n");
    writeFileSync(f.transcript, "invalid transcript prefix\n");
    const triage = join(f.root, ".git", "dagu-feature", "runs", "fixture-run", "triage.md");
    writeFileSync(triage, "Retained prior triage evidence\n");
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, PRIMARY: f.root, RUN: "fixture-run",
      REVIEW: f.id, POC: "no", QUESTION: "Already proven runtime?", BASIS: "PoC PASS",
      TEST_NODE: process.execPath, TEST_TSX: import.meta.resolve("tsx"),
      TEST_CLI: fileURLToPath(new URL("../bin/dagu-role-jobs.ts", import.meta.url)),
    } });
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stdout.includes(`result.path=${f.path}\n`));
    assert.match(result.stderr, /transcript changed[\s\S]*VERIFIER=FAIL/);
    assert.equal(readFileSync(triage, "utf8"), "Retained prior triage evidence\n");
  } finally { f.cleanup(); }
});
