import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const definition = parse(readFileSync(new URL("../skills/dagu-feature/planning.yaml", import.meta.url), "utf8"));
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
  writeFileSync(join(root, "issues.json"), "[]\n");
  executable(join(bin, "gh"), `#!/bin/bash
set -euo pipefail
FAKE_STATE=${JSON.stringify(root)}
if [[ "$1" == api ]]; then
  [[ "$*" == *--paginate* && "$*" == *--slurp* ]]
  jq -c '[.[0:1], .[1:]]' "$FAKE_STATE/issues.json"
elif [[ "$1 $2" == "issue create" ]]; then
  printf '%s\\n' "$*" >> "$FAKE_STATE/github.log"
  while (($#)); do
    case "$1" in --body-file) body_file=$2; shift 2;; --title) title=$2; shift 2;; *) shift;; esac
  done
  number=$(jq 'length + 41' "$FAKE_STATE/issues.json")
  url="https://example.test/owner/repo/issues/$number"
  jq --argjson number "$number" --arg url "$url" --rawfile body "$body_file" --arg title "$title" '. + [{number:$number,html_url:$url,body:$body,title:$title}]' "$FAKE_STATE/issues.json" > "$FAKE_STATE/issues.tmp"
  mv "$FAKE_STATE/issues.tmp" "$FAKE_STATE/issues.json"
  echo "$url"
else echo "Unexpected gh $*" >&2; exit 1; fi
`);
  executable(join(bin, "dagu"), '#!/bin/bash\nset -euo pipefail\n[[ "$1" == status ]]\nprintf "Waiting -\\npush-back iteration: %s\\n" "${FAKE_ITERATION:-0}"\n');
  executable(join(bin, "curl"), '#!/bin/sh\nprintf \'%s\\n\' \'{"dagRunDetails":{"nodes":[{"step":{"id":"review"},"startedAt":"2026-10-17T00:00:01Z"}]}}\'\n');
  const env = { ...process.env, HOME: root, TMPDIR: join(root, "tmp"), PRIMARY: primary, OUT_DIR: out, UNITS_FROM: upstream, NWO: "owner/repo", RUN: "repo-breakdown-test", SOURCE: "plan", OMP_SESSION_ID: "owner-session", DAGU_OUTPUT_FILE: join(root, "outputs"), PATH: `${bin}:${process.env.PATH}` };
  const run = (id: string, extra: NodeJS.ProcessEnv = {}) => spawnSync("bash", ["-c", script(id)], { env: { ...env, ...extra }, encoding: "utf8" });
  const importRows = (rows: unknown[]) => { jsonl(upstream, rows); return run("import_units"); };
  return { root, bin, out, upstream, env, run, importRows, close: () => rmSync(root, { recursive: true, force: true }) };
}
function successful(result: SpawnSyncReturns<string>): void { assert.equal(result.status, 0, result.stderr); }
function transcript(f: Fixture, data: unknown = { verdict: "accept", findings: [] }, extra: { parent?: string; timestamp?: string; agent?: string; marker?: string; last?: unknown } = {}) {
  const sessions = join(f.root, ".omp", "agent", "sessions", "-primary", "date_owner-session");
  mkdirSync(sessions, { recursive: true });
  jsonl(join(sessions, "PlanReviewTest.jsonl"), [
    { type: "session", parentSession: extra.parent ?? `${sessions}.jsonl` },
    { type: "session_init", agent: extra.agent ?? "plan-reviewer", task: extra.marker ?? readFileSync(join(f.out, "generation"), "utf8").trim(), timestamp: extra.timestamp ?? "2026-10-17T00:00:01.001Z" },
    { type: "message", message: { role: "toolResult", toolName: "yield", details: { data } } },
    ...(extra.last === undefined ? [] : [{ type: "message", message: { role: "toolResult", toolName: "yield", details: { data: extra.last } } }]),
  ]);
}
function accepted(f: Fixture, rows: unknown[] = [unit()]): void {
  successful(f.importRows(rows)); successful(f.run("check_plan")); transcript(f);
  successful(f.run("check_review", { REVIEW: "PlanReviewTest" }));
}

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
      assert.match(f.run("check_plan").stderr, /rule=import-units/);
      assert.notEqual(f.run("materialize", { APPROVED: "all" }).status, 0);
    }
    writeFileSync(f.upstream, "");
    assert.notEqual(f.run("import_units").status, 0);
    assert.notEqual(f.run("import_units", { SOURCE: "unknown" }).status, 0);
  } finally { f.close(); }
});

test("unit validation reports line-local schema, standalone acceptance and provenance errors", () => {
  const f = fixture();
  try {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...unit(), id: "Bad ID" }, "kebab-id"], [{ ...unit(), title: " " }, "title"],
      [{ ...unit(), dag: "other" }, "dag"], [{ ...unit("probe", "poc"), question: undefined }, "poc-question"],
      ...["depends", "blocks", "blocked_by"].map(key => [{ ...unit(), [key]: [] }, "self-contained"] as [Record<string, unknown>, string]),
      [{ ...unit(), body: "## Problem\nMissing sections" }, "required-sections"],
      [{ ...unit("probe", "poc"), body: "## PoC\nMissing sections" }, "required-sections"],
      [{ ...unit(), labels: "change" }, "labels"], [{ ...unit(), labels: [7] }, "labels"],
      [{ ...unit(), id: null }, "kebab-id"], [{ ...unit(), title: 7 }, "title"],
      [{ ...unit("probe", "poc"), question: null }, "poc-question"], [{ ...unit(), body: null }, "body"],
      [{ ...unit(), source: "unknown" }, "source"], [{ ...unit(), source: null }, "source"],
      [{ ...unit(), findings: "f1" }, "findings"], [{ ...unit(), findings: [""] }, "findings"],
      [{ ...unit(), findings: [7] }, "findings"], [{ ...unit(), findings: ["f1", "f1"] }, "unique-findings"],
    ];
    for (const [row, rule] of cases) {
      successful(f.importRows([unit("first"), row]));
      const result = f.run("check_plan");
      assert.notEqual(result.status, 0, rule);
      assert.match(result.stderr, new RegExp(`units\\.jsonl:2: rule=${rule}`));
      assert.match(readFileSync(join(f.out, "findings.md"), "utf8"), new RegExp(rule));
    }
    successful(f.importRows([unit(), unit()]));
    assert.match(f.run("check_plan").stderr, /units\.jsonl:2: rule=unique-id/);
    writeFileSync(f.upstream, "{invalid}\n"); successful(f.run("import_units"));
    assert.match(f.run("check_plan").stderr, /units\.jsonl:1: rule=json-object/);
    for (const source of ["refine", "discovery", "plan"]) {
      successful(f.importRows([{ ...unit(), source, findings: ["f1"] }, unit("probe", "poc")]));
      successful(f.run("check_plan"));
    }
    successful(f.importRows([{ ...unit(), body: "## Problema\nProblem\n## Cambio\nScope\n## Aceptación\nTest" }]));
    successful(f.run("check_plan"));
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
      { last: "not-json" }, { last: { verdict: "accept" } },
    ]) {
      transcript(f, undefined, extra);
      assert.notEqual(check().status, 0, JSON.stringify(extra));
      assert.notEqual(f.run("materialize", { APPROVED: "all" }).status, 0);
    }
    transcript(f); successful(check());
    assert.deepEqual(JSON.parse(readFileSync(join(f.out, "review-0.json"), "utf8")), { verdict: "accept", findings: [] });
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
    assert.match(issues[0].body, /<!-- breakdown-unit: repo-breakdown-test\/probe -->/);
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
    assert.equal(creates.length, 2); assert.ok(creates.every(line => line.includes("--label change")));
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
