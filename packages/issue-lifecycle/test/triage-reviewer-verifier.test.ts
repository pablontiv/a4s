import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { dispatchStage, verifyTriageResult } from "../src/role-dispatch.ts";
import { roleSchema } from "../src/role-runtime.ts";
import { REVIEW_SCHEMA } from "../src/triage/schema.ts";
import { fixture } from "./fixtures/planning-triage.ts";
import { main as roleJobs } from "../src/commands/role-jobs.ts";


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

for (const iteration of [0, 1, 2]) {
test(`triage command verifies environment iteration ${iteration} without status-text iteration and rejects stale results`, async () => {
  const f = fixture(iteration);
  try {
    const env = { PRIMARY: f.root, RUN: "fixture-run", REVIEW: f.id, POC: "no",
      QUESTION: String(f.result.output!.question), BASIS: String(f.result.output!.reason),
      DAG_PUSHBACK_ITERATION: String(iteration) };
    let statusCalls = 0;
    const verify = async (nativeIteration: string | undefined) => {
      const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
      Object.assign(process.env, env);
      if (nativeIteration === undefined) delete process.env.DAG_PUSHBACK_ITERATION;
      else process.env.DAG_PUSHBACK_ITERATION = nativeIteration;
      let stdout = "", stderr = "", status: number | undefined;
      try {
        await roleJobs(["verify-triage"], {
          log: (...values: unknown[]) => { stdout += `${values.join(" ")}\n`; },
          error: (...values: unknown[]) => { stderr += `${values.join(" ")}\n`; },
          exit: (code: number) => { status = code; },
        }, {
          dispatchStage,
          execFileSync: ((file: string, args: string[], options: object) => {
            if (file === "dagu") {
              statusCalls++;
              return "Status: Running\n";
            }
            assert.equal(file, "git");
            return execFileSync(file, args, options);
          }) as typeof execFileSync,
        });
        return { stdout, stderr, status };
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    };
    const success = await verify(String(iteration));
    assert.equal(success.status, 0, success.stderr);
    assert.ok(success.stdout.includes(`primary.canonical=${f.root}\n`));
    assert.ok(success.stdout.includes(`result.path=${f.path}\n`));
    assert.ok(success.stdout.includes(`transcript.path=${f.transcript}\n`));
    assert.match(success.stdout, /VERIFIER=PASS role_job=/);
    if (iteration === 0) {
      const defaultIteration = await verify(undefined);
      assert.equal(defaultIteration.status, 0, defaultIteration.stderr);
    }
    const stale = await verify(String(iteration + 1));
    assert.equal(stale.status, 1);
    assert.equal(stale.stderr, "DAGU_ROLE_JOB_BLOCKED: Triage result belongs to another native iteration\nVERIFIER=FAIL\n");
    assert.ok(stale.stdout.includes(`result.path=${f.path}\n`));
    rmSync(f.path);
    const missing = await verify(String(iteration));
    assert.equal(missing.status, 1);
    assert.ok(missing.stdout.includes(`result.path=${f.path}\n`));
    assert.match(missing.stderr, /ENOENT[\s\S]*VERIFIER=FAIL/);
    assert.equal(statusCalls, 0, "native iteration must not depend on dagu status");
  } finally { f.cleanup(); }
});
}

