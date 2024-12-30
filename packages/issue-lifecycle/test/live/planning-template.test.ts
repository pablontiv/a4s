import { stationEnvironment } from "../fixtures/service-environment.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse, stringify } from "yaml";
import { nativeEvidence } from "../../src/role-runtime.ts";
import { planningReviewer } from "../../src/transcript-identity.ts";
import { liveDagu, liveDaguVersion } from "../fixtures/live-dagu.ts";
import { testRunId } from "../fixtures/run-id.ts";
import { compiledA4sBin } from "../fixtures/admission.ts";

const a4sBin = compiledA4sBin();

const definition = parse(readFileSync(new URL("../../skills/issue-execution/planning.yaml", import.meta.url), "utf8"));
function script(id: string): string {
  const step = definition.steps.find((step: { id: string }) => step.id === id);
  assert.equal(typeof step?.run, "string", `${id} exposes an executable backend operation`);
  return step.run;
}
function jsonl(file: string, rows: unknown[]): void {
  writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
}
function unit(id = "unit-feature", dag = "feature"): Record<string, unknown> {
  return { id, title: `Deliver ${id}`, dag, labels: ["change"], ...(dag === "poc" ? { question: "Can the real target perform the operation?" } : {}),
    body: dag === "poc" ? "## PoC\nReal target question\n## Verdict\nRecord observed output\n## After PASS\nRetain capability" : "## Problem\nFull problem\n## Change\nComplete scope\n## Acceptance\nRun npm test and observe result" };
}
function executable(file: string, body: string): void { writeFileSync(file, body); chmodSync(file, 0o755); }
interface Fixture {
  root: string;
  bin: string;
  out: string;
  upstream: string;
  env: NodeJS.ProcessEnv;
  run(id: string, extra?: NodeJS.ProcessEnv): SpawnSyncReturns<string>;
  importRows(rows: unknown[]): SpawnSyncReturns<string>;
  close(): void;
}
function fixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "breakdown-")));
  const bin = join(root, "bin"), out = join(root, "out"), primary = join(root, "primary"), upstream = join(root, "upstream.jsonl");
  for (const dir of [bin, out, primary, join(root, "tmp")]) mkdirSync(dir);
  writeFileSync(join(root, "external-issues.json"), JSON.stringify([{ number: 442 }]));
  writeFileSync(join(root, "issues.json"), "[]\n");
  executable(join(bin, "gh"), `#!/usr/bin/env bash\nexport PLANNING_GH_STATE=${JSON.stringify(root)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fileURLToPath(new URL("../fixtures/planning-github-state.cjs", import.meta.url)))} "$@"\n`);
  executable(join(bin, "curl"), `#!/usr/bin/env bash
set -euo pipefail
jq -nc --argjson iteration "\${FAKE_ITERATION:-0}" --argjson nodes "\${FAKE_REVIEW_NODES:-null}" '
  {dagRunDetails:{nodes:(if $nodes != null then $nodes else
    [{step:{id:"review"},statusLabel:"succeeded",startedAt:"2026-10-17T00:00:01Z"} +
      (if $iteration == 0 then {} else {approvalIteration:$iteration} end)] end)}}
'
`);
  const env = { ...process.env, A4S_BIN: a4sBin, HOME: root, TMPDIR: join(root, "tmp"), PRIMARY: primary, OUT_DIR: out, UNITS_FROM: upstream, NWO: "owner/repo", RUN: testRunId("repo-breakdown-test"), SOURCE: "plan", OMP_SESSION_ID: "owner-session", DAGU_OUTPUT_FILE: join(root, "outputs"), PATH: `${bin}:${process.env.PATH}` };
  const run = (id: string, extra: NodeJS.ProcessEnv = {}) => spawnSync("bash", ["--noprofile", "--norc", "-c", script(id)], { env: { ...env, ...extra }, encoding: "utf8" });
  const importRows = (rows: unknown[]) => { jsonl(upstream, rows); return run("import_units"); };
  return { root, bin, out, upstream, env, run, importRows, close: () => rmSync(root, { recursive: true, force: true }) };
}
function successful(result: SpawnSyncReturns<string>): void { assert.equal(result.status, 0, result.stderr); }
function transcript(f: Fixture, data: unknown = { verdict: "accept", findings: [] }, extra: { parent?: string; timestamp?: string; agent?: string; marker?: string; last?: unknown; sessions?: number; inits?: number; session?: string; provider?: string; model?: string; resolvedModel?: string; changes?: { id?: string; timestamp?: string; model?: string; resolvedModelIsFallback: boolean }[]; refresh?: { agent?: string; task?: string; timestamp?: string } } = {}) {
  const sessions = join(f.root, ".omp", "agent", "sessions", "-primary", "date_owner-session");
  mkdirSync(sessions, { recursive: true });
  const init = { type: "session_init", agent: extra.agent ?? "plan-reviewer", task: extra.marker ?? readFileSync(join(f.out, "generation"), "utf8").trim(), timestamp: extra.timestamp ?? "2026-10-17T00:00:01.001Z", ...(extra.resolvedModel ? { resolvedModel: extra.resolvedModel } : {}) };
  const changes = extra.changes ?? (extra.refresh ? [{ resolvedModelIsFallback: true }] : []);
  jsonl(join(sessions, "PlanReviewTest.jsonl"), [
    ...Array.from({ length: extra.sessions ?? 1 }, () => ({ type: "session", id: extra.session ?? "reviewer-session", parentSession: extra.parent ?? `${sessions}.jsonl` })),
    ...Array.from({ length: extra.inits ?? 1 }, () => init),
    ...changes.map(change => ({ type: "model_change", ...change })),
    ...(extra.refresh ? [{ ...init, ...extra.refresh }] : []),
    { type: "message", id: "assistant-final", message: { role: "assistant", provider: extra.provider ?? "fixture-provider", model: extra.model ?? "fixture-model", stopReason: "stop" } },
    { type: "message", message: { role: "toolResult", toolName: "yield", details: { data } } },
    ...(extra.last === undefined ? [] : [{ type: "message", message: { role: "toolResult", toolName: "yield", details: { data: extra.last } } }]),
  ]);
}
function accepted(f: Fixture, rows: unknown[] = [unit()]): void {
  successful(f.importRows(rows)); successful(f.run("check_plan")); transcript(f);
  successful(f.run("check_review", { REVIEW: "PlanReviewTest" }));
}

test("planning approval cancellation stops writes and CANCEL=no preserves approved publication", () => {
  for (const CANCEL of ["yes", "no"]) {
    const f = fixture();
    try {
      accepted(f);
      if (CANCEL === "yes") executable(join(f.bin, "dagu"), `#!/usr/bin/env bash
[[ "$*" == "stop --run-id $RUN planning" ]] || exit 1
printf '%s\\n' "$*" > "$OUT_DIR/stop-request"
exit 77
`);
      const result = f.run("approve_cancellation", { CANCEL, APPROVED: "all" });
      assert.equal(result.status, CANCEL === "yes" ? 77 : 0, result.stderr);
      if (CANCEL === "yes") {
        assert.deepEqual(JSON.parse(readFileSync(join(f.out, "cancellation.json"), "utf8")), {
          run: f.env.RUN, checkpoint: "approve", outcome: "cancelled", nativeExpected: "aborted",
        });
        assert.equal(readFileSync(join(f.out, "stop-request"), "utf8"), `stop --run-id ${f.env.RUN} planning\n`);
        assert.deepEqual(JSON.parse(readFileSync(join(f.root, "issues.json"), "utf8")), []);
        assert.throws(() => readFileSync(join(f.root, "github.log")), { code: "ENOENT" });
      } else {
        successful(f.run("materialize", { APPROVED: "all" }));
        assert.equal(JSON.parse(readFileSync(join(f.root, "issues.json"), "utf8")).length, 1);
        assert.throws(() => readFileSync(join(f.out, "cancellation.json")), { code: "ENOENT" });
        for (const APPROVED of ["", "${steps.approve.outputs.APPROVED}"]) {
          const missing = f.run("approve_cancellation", { CANCEL, APPROVED });
          assert.equal(missing.status, 1);
          assert.match(missing.stderr, /Normal completion requires APPROVED/);
        }
      }
    } finally { f.close(); }
  }
});

test("import consumes only an explicit absolute upstream JSONL snapshot and reimports corrected units", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "source.md"), "Original need\n");
    writeFileSync(join(f.root, "plan.md"), "Approved local context\n");
    successful(f.importRows([unit()]));
    assert.equal(readFileSync(join(f.out, "units.jsonl"), "utf8"), readFileSync(f.upstream, "utf8"));
    assert.equal(readFileSync(join(f.out, "source.md"), "utf8"), "Original need\n");
    assert.equal(readFileSync(join(f.out, "plan.md"), "utf8"), "Approved local context\n");
    writeFileSync(join(f.root, "source.md"), "Corrected need\n");
    writeFileSync(join(f.root, "plan.md"), "Corrected local context\n");
    jsonl(f.upstream, [unit("corrected")]);
    assert.equal(JSON.parse(readFileSync(join(f.out, "units.jsonl"), "utf8")).id, "unit-feature");
    successful(f.run("import_units")); successful(f.run("check_plan"));
    assert.equal(JSON.parse(readFileSync(join(f.out, "units.jsonl"), "utf8")).id, "corrected");
    assert.equal(readFileSync(join(f.out, "source.md"), "utf8"), "Corrected need\n");
    assert.equal(readFileSync(join(f.out, "plan.md"), "utf8"), "Corrected local context\n");
    rmSync(join(f.root, "source.md")); rmSync(join(f.root, "plan.md"));
    successful(f.run("import_units", { SOURCE: "refine" }));
    assert.equal(readFileSync(join(f.out, "source.md"), "utf8"), "refine\n");
    assert.throws(() => readFileSync(join(f.out, "plan.md")), { code: "ENOENT" });
    for (const UNITS_FROM of ["relative.jsonl", join(f.root, "missing.jsonl")]) {
      assert.notEqual(f.run("import_units", { UNITS_FROM }).status, 0);
      assert.equal(JSON.parse(f.run("check_plan").stderr).rule, "import-units");
      assert.notEqual(f.run("materialize", { APPROVED: "all" }).status, 0);
    }
    writeFileSync(f.upstream, "");
    assert.notEqual(f.run("import_units").status, 0);
    assert.notEqual(f.run("import_units", { SOURCE: "unknown" }).status, 0);
  } finally { f.close(); }
});

test("upstream package CLI and native check_plan emit identical complete diagnostics and retain corrected canonical bytes", () => {
  const f = fixture();
  try {
    const cli = fileURLToPath(new URL("../../bin/dagu-feature-bundle.ts", import.meta.url));
    const upstream = () => spawnSync(process.execPath, ["--import", "tsx", cli, "validate-planning-units", "--input", f.upstream], { encoding: "utf8" });
    writeFileSync(f.upstream, JSON.stringify({ ...unit(), id: "Bad ID", title: null, body: null, labels: [7] }) + '\n{invalid}\n' +
      JSON.stringify({ ...unit("second", "poc"), question: null, source: "other" }) + "\n");
    successful(f.run("import_units"));
    const native = f.run("check_plan"), prepared = upstream();
    assert.equal(native.status, 1);
    assert.equal(prepared.status, 1);
    assert.equal(native.stderr, prepared.stderr);
    assert.equal(readFileSync(join(f.out, "findings.md"), "utf8"), prepared.stderr);
    assert.equal(prepared.stderr.trim().split("\n").length, 7);
    const canonical = "  " + JSON.stringify({ ...unit("consumer"), relationships: [{ kind: "blocked_by", target: { unit: "contract" } }] }) +
      "\r\n" + JSON.stringify(unit("contract"));
    writeFileSync(f.upstream, canonical);
    successful(upstream());
    successful(f.run("import_units"));
    successful(f.run("check_plan"));
    assert.equal(readFileSync(join(f.out, "validated-units.jsonl"), "utf8"), canonical);
    transcript(f);
    successful(f.run("check_review", { REVIEW: "PlanReviewTest" }));
    assert.equal(readFileSync(join(f.out, "reviewed-units.jsonl"), "utf8"), canonical);
  } finally { f.close(); }
});

test("all mechanical consumers require one review node and its valid structured native counter", () => {
  const f = fixture();
  try {
    const review = { step: { id: "review" }, statusLabel: "succeeded", startedAt: "2026-10-17T00:00:01Z" };
    const invalid = [
      [], [review, review],
      ...[null, -1, 1.5, "1", true].map(approvalIteration => [{ ...review, approvalIteration }]),
    ];
    for (const nodes of invalid) {
      accepted(f);
      for (const id of ["check_plan", "materialize", "check_review"]) {
        assert.notEqual(f.run(id, { FAKE_REVIEW_NODES: JSON.stringify(nodes), REVIEW: "PlanReviewTest", APPROVED: "all" }).status, 0, `${id}: ${JSON.stringify(nodes)}`);
      }
    }
    accepted(f);
    successful(f.run("materialize", { APPROVED: "all" }));
  } finally { f.close(); }
});

test("typed prerequisites and parent intent retain the exact snapshot through review and closed subset approval", () => {
  const f = fixture();
  try {
    const rows = [
      { ...unit("consumer"), relationships: [
        { kind: "blocked_by", target: { unit: "contract" } },
        { kind: "blocked_by", target: { issue: 442 } },
        { kind: "parent", target: { unit: "umbrella" } },
      ] },
      unit("contract"), unit("umbrella"), unit("unrelated"),
    ];
    accepted(f, rows);
    assert.equal(readFileSync(join(f.out, "reviewed-units.jsonl"), "utf8"), readFileSync(f.upstream, "utf8"));
    for (const APPROVED of ["consumer", "consumer,contract", "consumer,umbrella"]) {
      assert.match(f.run("materialize", { APPROVED }).stderr, /rule=approved-relationship-target/);
      assert.deepEqual(JSON.parse(readFileSync(join(f.root, "issues.json"), "utf8")), []);
    }
    successful(f.run("materialize", { APPROVED: "consumer,contract,umbrella" }));
    const issues = JSON.parse(readFileSync(join(f.root, "issues.json"), "utf8"));
    assert.equal(issues.length, 3);
    assert.match(issues[0].body, /Relationship intent: blocked_by unit:contract/);
    assert.match(issues[0].body, /Relationship intent: blocked_by issue:#442/);
    assert.match(issues[0].body, /Relationship intent: parent unit:umbrella/);
    jsonl(join(f.out, "units.jsonl"), [{ ...rows[0], relationships: [{ kind: "blocked_by", target: { issue: 999 } }] }, ...rows.slice(1)]);
    assert.notEqual(f.run("check_review", { REVIEW: "PlanReviewTest" }).status, 0);
    assert.notEqual(f.run("materialize", { APPROVED: "all" }).status, 0);
  } finally { f.close(); }
});

test("review generation marker tolerates only the leading native OMP assignment prefix", () => {
  const f = fixture();
  try {
    successful(f.importRows([unit()])); successful(f.run("check_plan"));
    const marker = readFileSync(join(f.out, "generation"), "utf8").trim();
    for (const task of [
      `${marker}\nReview these units.`,
      `Complete assignment thoroughly:\n\n${marker}\nReview these units.`,
      ` \ncomplete ASSIGNMENT thoroughly:\t\n\n${marker}\nReview these units.`,
    ]) {
      transcript(f, undefined, { marker: task });
      successful(f.run("check_review", { REVIEW: "PlanReviewTest" }));
    }
    for (const task of [
      `Review these units.\n${marker}`,
      `Complete assignment thoroughly:\n\nReview these units.\n${marker}`,
      `Review these units.\nComplete assignment thoroughly:\n\n${marker}`,
      marker.replace("ITERATION=0", "ITERATION=1"),
      `Complete assignment thoroughly:\n\n${marker.replace(`RUN=${f.env.RUN}`, "RUN=wrong-run")}`,
      `Complete assignment thoroughly:\n\n${marker} extra`,
    ]) {
      transcript(f, undefined, { marker: task });
      const result = f.run("check_review", { REVIEW: "PlanReviewTest" });
      assert.notEqual(result.status, 0, task);
      assert.ok(result.stderr.includes(`generation marker missing from reviewer session_init.task; expected ${marker}`), result.stderr);
    }
  } finally { f.close(); }
});


test("review binds parent, generation, agent, cutoff and final structured verdict before publication", () => {
  const f = fixture();
  try {
    successful(f.importRows([unit()])); successful(f.run("check_plan"));
    const check = () => f.run("check_review", { REVIEW: "PlanReviewTest" });
    assert.notEqual(check().status, 0);
    for (const extra of [
      { parent: "/foreign/session.jsonl" }, { timestamp: "2026-10-17T00:00:00Z" },
      { timestamp: "2026-10-17T00:00:01Z" }, { agent: "worker" }, { marker: "wrong-generation" },
      { sessions: 0 }, { sessions: 2 }, { inits: 0 },
      { refresh: { agent: "worker" } }, { refresh: { task: "foreign task" } },
      { timestamp: "2026-10-17T00:00:00Z", refresh: { timestamp: "2026-10-17T00:00:02Z" } },
      { last: "not-json" }, { last: { verdict: "accept" } },
    ]) {
      transcript(f, undefined, extra);
      const result = check();
      assert.notEqual(result.status, 0, JSON.stringify(extra));
      if (extra.marker === "wrong-generation") {
        const expected = readFileSync(join(f.out, "generation"), "utf8").trim();
        assert.match(result.stderr, /session_init\.task/);
        assert.ok(result.stderr.includes(expected), result.stderr);
      }
      assert.notEqual(f.run("materialize", { APPROVED: "all" }).status, 0);
    }
    transcript(f, undefined, { refresh: { timestamp: "2026-10-17T00:00:02Z" } }); successful(check());
    assert.deepEqual(JSON.parse(readFileSync(join(f.out, "review-0.json"), "utf8")), {
      verdict: "accept", findings: [],
      reviewer: { agent: "plan-reviewer", session: "reviewer-session", provider: "fixture-provider", model: "fixture-model", fallbacks: [{ resolvedModelIsFallback: true }] },
    });
    assert.notEqual(f.run("check_review", { REVIEW: "PlanReviewTest", FAKE_ITERATION: "1" }).status, 0);
    const duplicate = join(f.root, ".omp", "agent", "sessions", "-primary", "other_owner-session");
    mkdirSync(duplicate); writeFileSync(join(duplicate, "PlanReviewTest.jsonl"), "{}\n");
    assert.notEqual(check().status, 0); rmSync(duplicate, { recursive: true });
    for (const data of [
      { verdict: "revise", findings: [] },
      { verdict: "accept", findings: [{ unit: "unit-feature", severity: "blocker", text: "Missing evidence" }] },
      { verdict: "accept", findings: [{ unit: "unit-feature", severity: "unknown", text: "Missing evidence" }] },
    ]) { transcript(f, data); assert.notEqual(check().status, 0); }
    transcript(f, { verdict: "revise", findings: [{ unit: "unit-feature", severity: "blocker", text: "Add exact test command" }] });
    successful(check());
    assert.match(readFileSync(join(f.out, "findings.md"), "utf8"), /Add exact test command/);
    assert.notEqual(f.run("materialize", { APPROVED: "all" }).status, 0, "completing approval cannot bypass revise");
    assert.deepEqual(JSON.parse(readFileSync(join(f.root, "issues.json"), "utf8")), []);
    accepted(f, [unit("corrected")]); successful(f.run("materialize", { APPROVED: "corrected" }));
  } finally { f.close(); }
});

test("accepted review records the final assistant model rather than session_init.resolvedModel", () => {
  const f = fixture();
  try {
    const findings = [{ unit: "unit-feature", severity: "concern", text: "Note the fallback" }];
    successful(f.importRows([unit()])); successful(f.run("check_plan"));
    transcript(f, { verdict: "accept", findings }, {
      resolvedModel: "xai-oauth/grok-4.7",
      session: "reviewer-session-648",
      provider: "openai-codex",
      model: "gpt-6.1-sol",
      changes: [{ id: "fallback-1", timestamp: "2026-10-23T22:38:42Z", model: "openai-codex/gpt-6.1-sol", resolvedModelIsFallback: true }],
    });
    successful(f.run("check_review", { REVIEW: "PlanReviewTest" }));
    const review = JSON.parse(readFileSync(join(f.out, "review-0.json"), "utf8"));
    const transcriptPath = join(f.root, ".omp", "agent", "sessions", "-primary", "date_owner-session", "PlanReviewTest.jsonl");
    const rows = readFileSync(transcriptPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const reviewer = planningReviewer(rows);
    const native = nativeEvidence(transcriptPath, { agent: "plan-reviewer" });
    assert.equal(review.verdict, "accept");
    assert.deepEqual(review.findings, findings);
    assert.equal(review.reviewer.provider, "openai-codex");
    assert.equal(review.reviewer.model, "gpt-6.1-sol");
    assert.equal(review.reviewer.session, "reviewer-session-648");
    assert.equal(review.reviewer.agent, "plan-reviewer");
    assert.deepEqual(review.reviewer.fallbacks, [{ event: "fallback-1", timestamp: "2026-10-23T22:38:42Z", model: "openai-codex/gpt-6.1-sol", resolvedModelIsFallback: true }]);
    assert.deepEqual(review.reviewer, reviewer);
    assert.equal(native.provider, reviewer.provider);
    assert.equal(native.model, reviewer.model);
    assert.equal(native.session, reviewer.session);
    assert.deepEqual(native.fallbacks, reviewer.fallbacks);
    assert.equal(rows.find((row: { type?: string }) => row.type === "session_init").resolvedModel, "xai-oauth/grok-4.7");
  } finally { f.close(); }
});

test("publication requires review of the unchanged snapshot and the current generation", () => {
  const f = fixture();
  try {
    accepted(f);
    assert.notEqual(f.run("materialize", { APPROVED: "all", FAKE_ITERATION: "1" }).status, 0);
    jsonl(join(f.out, "units.jsonl"), [unit("tampered")]);
    assert.notEqual(f.run("materialize", { APPROVED: "all" }).status, 0);
    assert.notEqual(f.run("check_review", { REVIEW: "PlanReviewTest" }).status, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(f.root, "issues.json"), "utf8")), []);
    accepted(f); successful(f.run("import_units"));
    assert.notEqual(f.run("materialize", { APPROVED: "all" }).status, 0, "explicit reimport requires fresh review");
  } finally { f.close(); }
});

test("operator subset approval preserves labels, paginated idempotence, markers and finding lineage", () => {
  const f = fixture();
  try {
    accepted(f, [unit(), { ...unit("probe", "poc"), source: "discovery", findings: ["bug-1", "bug-2"], body: unit("probe", "poc").body + "\n<!-- discovery-unit: probe -->" }]);
    for (const APPROVED of ["", "missing", "unit-feature,unit-feature", ",unit-feature", "unit-feature,", "unit-feature,,probe"]) {
      assert.notEqual(f.run("materialize", { APPROVED }).status, 0, APPROVED);
    }
    successful(f.run("materialize", { APPROVED: "probe" }));
    let issues = JSON.parse(readFileSync(join(f.root, "issues.json"), "utf8"));
    assert.equal(issues.length, 1); assert.equal(issues[0].title, "Deliver probe");
    assert.ok(issues[0].body.includes(`<!-- breakdown-unit: ${f.env.RUN}/probe -->`));
    assert.match(issues[0].body, /<!-- discovery-unit: probe -->/);
    assert.match(issues[0].body, /Breakdown source: discovery/);
    assert.match(issues[0].body, /Finding lineage: bug-1, bug-2/);
    successful(f.run("materialize", { APPROVED: "all" }));
    successful(f.run("materialize", { APPROVED: "all" }));
    issues = JSON.parse(readFileSync(join(f.root, "issues.json"), "utf8"));
    assert.equal(issues.length, 2);
    assert.match(issues[1].body, /Breakdown source: plan/);
    const rows = readFileSync(join(f.out, "issues.jsonl"), "utf8").trim().split("\n").map(row => JSON.parse(row));
    assert.deepEqual(rows.map(row => [row.id, row.reused]), [["unit-feature", true], ["probe", true]]);
    assert.ok(rows.every(row => Number.isInteger(row.number) && row.url.endsWith(`/${row.number}`)));
    const creates = readFileSync(join(f.root, "github.log"), "utf8").trim().split("\n");
    assert.equal(creates.length, 2);
    for (const line of creates) assert.deepEqual(JSON.parse(line).payload.labels, ["change"]);
    writeFileSync(join(f.root, "issues.json"), JSON.stringify([...issues, issues[0]]));
    assert.match(f.run("materialize", { APPROVED: "probe" }).stderr, /rule=unique-issue-marker unit=probe/);
  } finally { f.close(); }
});

test("discovery source identity reuses a persistent unit across distinct backend runs", () => {
  const f = fixture();
  try {
    const row = { ...unit("persistent-finding"), source: "discovery", findings: ["persistent-finding"],
      body: unit().body + "\n<!-- discovery-unit: persistent-finding -->" };
    accepted(f, [row]); successful(f.run("materialize", { APPROVED: "all" }));
    const first = JSON.parse(readFileSync(join(f.out, "issues.jsonl"), "utf8"));
    f.env.RUN = "second-breakdown-run";
    accepted(f, [row]); successful(f.run("materialize", { APPROVED: "all" }));
    const second = JSON.parse(readFileSync(join(f.out, "issues.jsonl"), "utf8"));
    assert.equal(second.reused, true);
    assert.equal(second.number, first.number);
    assert.equal(second.url, first.url);
    assert.equal(JSON.parse(readFileSync(join(f.root, "issues.json"), "utf8")).length, 1);
    assert.equal(readFileSync(join(f.root, "github.log"), "utf8").trim().split("\n").length, 1);
  } finally { f.close(); }
});

test("native planning push-back and cancellation preserve guarded materialization", {
  ...liveDagu,
  timeout: 120_000,
}, async t => {
  const f = fixture();
  const home = join(f.root, "dagu");
  mkdirSync(join(home, "dags"), { recursive: true });
  rmSync(join(f.bin, "curl"));
  const port = async () => {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await new Promise<void>(resolve => server.close(() => resolve()));
    return address.port;
  };
  const httpPort = await port(), schedulerPort = await port();
  Object.assign(f.env, { DAGU_HOME: home, DAGU_CONFIG: join(home, "config.yaml"), DAGU_PORT: String(httpPort), DAGU_COORDINATOR_ENABLED: "false" });
  Object.assign(f.env, stationEnvironment(f.env));
  writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${httpPort}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\nscheduler:\n  port: ${schedulerPort}\n`);
  jsonl(f.upstream, [{ ...unit("consumer"), relationships: [{ kind: "blocked_by", target: { unit: "contract" } }] }, unit("contract")]);
  const native = structuredClone(definition);
  native.labels = ["workspace=planning-regression"];
  delete native.queue;
  native.env = Object.entries(f.env).filter(([key]) => ["A4S_BIN", "HOME", "TMPDIR", "PATH", "A4S_SERVICE_ENV", "DAGU_URL", "DAGU_HOME", "DAGU_PORT", "PRIMARY"].includes(key))
    .map(([key, value]) => ({ [key]: value }));
  native.env.push({ RUN: "${context.run.id}" }, { FEEDBACK: "" });
  native.steps.find((step: { id: string }) => step.id === "init").run =
    `printf 'OUT_DIR=%s\\nNWO=owner/repo\\n' '${f.out}' >> "$DAGU_OUTPUT_FILE"`;
  const holds = ["check_plan", "check_review", "materialize"];
  for (const id of holds) {
    const step = native.steps.find((step: { id: string }) => step.id === id);
    step.run = `while test -f '${f.root}/hold-${id}'; do sleep 0.05; done\n` + step.run;
    writeFileSync(join(f.root, `hold-${id}`), "");
  }
  const path = join(home, "dags/planning.yaml");
  writeFileSync(path, stringify(native));
  let logs = "";
  const service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(httpPort)], { env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  service.stdout.on("data", data => { logs += data; });
  service.stderr.on("data", data => { logs += data; });
  const api = `http://127.0.0.1:${httpPort}/api/v1`;
  const dagu = (...args: string[]) => execFileSync("dagu", args, { env: f.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  type Node = { step: { id: string; humanTask?: { prompt: string } }; statusLabel: string; startedAt: string; approvalIteration?: number };
  type Run = { statusLabel: string; nodes: Node[] };
  async function until<T>(description: string, probe: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const result = await probe();
      if (result !== undefined) return result;
      await delay(50);
    }
    throw new Error(`Timed out ${description}\n${logs}`);
  }
  async function state(step: string, status: string): Promise<Run> {
    return until(`${step} ${status}`, async () => {
      const response = await fetch(`${api}/dag-runs/planning/${f.env.RUN}`);
      if (!response.ok) return undefined;
      const run = (await response.json() as { dagRunDetails: Run }).dagRunDetails;
      assert.ok(!["failed", "aborted"].includes(run.statusLabel), JSON.stringify(run));
      return run.nodes.some(node => node.step.id === step && node.statusLabel === status) ? run : undefined;
    });
  }
  function reviewNode(run: Run): Node {
    const matches = run.nodes.filter(node => node.step.id === "review");
    assert.equal(matches.length, 1);
    return matches[0]!;
  }
  function mechanical(run: Run, step: string, iteration: number): void {
    assert.equal(run.nodes.find(node => node.step.id === step)?.statusLabel, "running");
    const review = reviewNode(run);
    assert.notEqual(review.statusLabel, "waiting");
    assert.equal(review.approvalIteration ?? 0, iteration);
  }
  const marker = (iteration: number) => `PLAN_REVIEW AGENT=plan-reviewer DAG=planning RUN=${f.env.RUN} ITERATION=${iteration} END`;
  try {
    await until("loopback service", async () => {
      try { return (await fetch(`${api}/dag-runs`)).ok ? true : undefined; } catch { return undefined; }
    });
    dagu("validate", path);
    dagu("enqueue", "--run-id", f.env.RUN!, path, "--", `UNITS_FROM=${f.upstream}`, "SOURCE=refine", `OMP_SESSION_ID=${f.env.OMP_SESSION_ID}`);
    const initial = await state("check_plan", "running");
    mechanical(initial, "check_plan", 0);
    assert.equal(Object.hasOwn(reviewNode(initial), "approvalIteration"), false, "present initial review node omits its zero counter");
    rmSync(join(f.root, "hold-check_plan"));
    const first = await state("review", "waiting");
    assert.equal(readFileSync(join(f.out, "generation"), "utf8").trim(), marker(0));
    assert.ok(reviewNode(first).step.humanTask?.prompt.includes(marker(0)));
    writeFileSync(join(f.root, "hold-check_plan"), "");
    dagu("human-task", "push-back", "planning", "--run-id", f.env.RUN!, "--step", "review", "--expected-iteration", "0", "--input", "FEEDBACK=Exercise the native next generation");
    const reimport = await state("check_plan", "running");
    mechanical(reimport, "check_plan", 1);
    assert.equal(reviewNode(reimport).approvalIteration, 1);
    rmSync(join(f.root, "hold-check_plan"));
    const current = await state("review", "waiting");
    assert.equal(readFileSync(join(f.out, "generation"), "utf8").trim(), marker(1));
    assert.ok(reviewNode(current).step.humanTask?.prompt.includes(marker(1)));
    assert.equal(readFileSync(join(f.out, "validated-units.jsonl"), "utf8"), readFileSync(f.upstream, "utf8"));
    const cutoff = reviewNode(current).startedAt;
    transcript(f, undefined, { timestamp: cutoff, refresh: { timestamp: new Date().toISOString() } });
    dagu("human-task", "complete", "planning", "--run-id", f.env.RUN!, "--step", "review", "--input", "REVIEW=PlanReviewTest");
    const verifying = await state("check_review", "running");
    mechanical(verifying, "check_review", 1);
    assert.notEqual(f.run("check_review", { REVIEW: "PlanReviewTest" }).status, 0, "current marker cannot admit a transcript at the current cutoff");
    for (const extra of [{ parent: "/foreign/session.jsonl" }, { agent: "worker" }, { marker: marker(0) }]) {
      transcript(f, undefined, { timestamp: new Date().toISOString(), ...extra });
      assert.notEqual(f.run("check_review", { REVIEW: "PlanReviewTest" }).status, 0, "native generation preserves actor and provenance binding");
    }
    transcript(f, undefined, { timestamp: new Date().toISOString(), refresh: { timestamp: new Date().toISOString() } });
    jsonl(join(f.out, "units.jsonl"), [unit("tampered")]);
    assert.notEqual(f.run("check_review", { REVIEW: "PlanReviewTest" }).status, 0, "native generation preserves snapshot binding");
    copyFileSync(f.upstream, join(f.out, "units.jsonl"));
    rmSync(join(f.root, "hold-check_review"));
    await state("approve", "waiting");
    assert.deepEqual(JSON.parse(readFileSync(join(f.out, "review-1.json"), "utf8")), {
      verdict: "accept", findings: [],
      reviewer: { agent: "plan-reviewer", session: "reviewer-session", provider: "fixture-provider", model: "fixture-model", fallbacks: [{ resolvedModelIsFallback: true }] },
    });
    assert.equal(readFileSync(join(f.out, "review-accepted"), "utf8").trim(), marker(1));
    assert.equal(readFileSync(join(f.out, "reviewed-units.jsonl"), "utf8"), readFileSync(f.upstream, "utf8"));
    dagu("human-task", "complete", "planning", "--run-id", f.env.RUN!, "--step", "approve", "--input", "CANCEL=no", "--input", "APPROVED=all");
    const publishing = await state("materialize", "running");
    mechanical(publishing, "materialize", 1);
    rmSync(join(f.root, "hold-materialize"));
    await state("materialize", "succeeded");
    assert.deepEqual(readFileSync(join(f.out, "issues.jsonl"), "utf8").trim().split("\n").map(row => JSON.parse(row).id), ["consumer", "contract"]);
    t.diagnostic(JSON.stringify({ version: liveDaguVersion, run: f.env.RUN, iteration: 1, consumers: holds, review: "review-1.json", sessionInits: 2, fixture: "real native runtime/push-back/approval/materialize; synthetic consistent fallback-refresh reviewer transcript and GitHub provider" }));
    const published = readFileSync(join(f.root, "github.log"), "utf8");
    for (const { approved, missingInput } of [
      { approved: false, missingInput: false },
      { approved: true, missingInput: false },
      { approved: false, missingInput: true },
    ]) {
      f.env.RUN = testRunId(`repo-breakdown-cancel-${missingInput ? "import" : approved ? "approved" : "only"}`);
      rmSync(join(f.out, "cancellation.json"), { force: true });
      dagu("enqueue", "--run-id", f.env.RUN, path, "--", `UNITS_FROM=${missingInput ? join(f.root, "missing-units.jsonl") : f.upstream}`, "SOURCE=refine", `OMP_SESSION_ID=${f.env.OMP_SESSION_ID}`);
      await state("review", "waiting");
      dagu("human-task", "complete", "planning", "--run-id", f.env.RUN, "--step", "review", "--input", "REVIEW=UnknownReviewer");
      await state("approve", "waiting");
      assert.equal(existsSync(join(f.out, "review-accepted")), false, "rejected handoff cannot authorize publication");
      dagu("human-task", "complete", "planning", "--run-id", f.env.RUN, "--step", "approve", "--input", "CANCEL=yes", ...(approved ? ["--input", "APPROVED=all"] : []));
      let lastCancellationState: Run | undefined;
      const cancelled = await until("native cancellation terminal state", async () => {
        const response = await fetch(`${api}/dag-runs/planning/${f.env.RUN}`);
        assert.ok(response.ok);
        const run = (await response.json() as { dagRunDetails: Run }).dagRunDetails;
        lastCancellationState = run;
        return run.statusLabel === "aborted" ? run : undefined;
      }).catch(error => {
        t.diagnostic(JSON.stringify({ run: f.env.RUN, status: lastCancellationState?.statusLabel, nodes: lastCancellationState?.nodes.map(node => ({ id: node.step.id, status: node.statusLabel })) }));
        throw error;
      });
      assert.equal(cancelled.nodes.find(node => node.step.id === "approve_cancellation")?.statusLabel, "aborted");
      assert.equal(cancelled.nodes.find(node => node.step.id === "materialize")?.statusLabel, "not_started");
      assert.equal(readFileSync(join(f.root, "github.log"), "utf8"), published, "cancellation performs no GitHub writes");
      assert.deepEqual(JSON.parse(readFileSync(join(f.out, "cancellation.json"), "utf8")), {
        run: f.env.RUN, checkpoint: "approve", outcome: "cancelled", nativeExpected: "aborted",
      });
      t.diagnostic(JSON.stringify({ version: liveDaguVersion, run: f.env.RUN, CANCEL: "yes", APPROVED: approved ? "all" : "omitted", missingInput, native: cancelled.statusLabel, materialize: "not_started", githubWrites: 0 }));
    }
  } finally {
    for (const id of holds) rmSync(join(f.root, `hold-${id}`), { force: true });
    service.kill("SIGTERM");
    await new Promise<void>(resolve => service.exitCode !== null ? resolve() : service.once("exit", () => resolve()));
    f.close();
  }
});
