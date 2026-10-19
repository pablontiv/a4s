import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const template = readFileSync(new URL("../skills/dagu-feature/planning.yaml", import.meta.url), "utf8");
const rendered = readFileSync(new URL("../../../.workspace/dagu/dags/planning.yaml", import.meta.url), "utf8");
function script(source: string, id: string): string {
  const lines = source.split("\n");
  const start = lines.indexOf(`  - id: ${id}`);
  assert.ok(start >= 0, id);
  const run = lines.indexOf("    run: |", start);
  assert.ok(run > start, id);
  let end = run + 1;
  while (end < lines.length && (lines[end]!.startsWith("      ") || lines[end] === "")) end++;
  return lines.slice(run + 1, end).map(line => line.slice(6)).join("\n");
}
function jsonl(file: string, rows: unknown[]): void {
  writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
}
function unit(id = "unit-feature", dag = "feature"): Record<string, unknown> {
  return { id, title: `Deliver ${id}`, dag, labels: ["change"], ...(dag === "poc" ? { question: "Can the real target perform the operation?" } : {}),
    body: dag === "poc" ? "## PoC\nReal target question\n## Veredicto\nRecord observed output\n## Después del PASS\nRetain capability" : "## Problema\nFull problem\n## Cambio\nComplete scope\n## Aceptación\nRun npm test and observe result" };
}
function executable(file: string, body: string): void { writeFileSync(file, body); chmodSync(file, 0o755); }
function fixture(realDagu = "") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "planning-")));
  const bin = join(root, "bin"), out = join(root, "out"), primary = join(root, "primary");
  for (const dir of [bin, out, primary, join(root, "tmp")]) mkdirSync(dir);
  writeFileSync(join(out, "plan.md"), "Approved local plan\n");
  writeFileSync(join(root, "issues.json"), "[]\n");
  executable(join(bin, "gh"), `#!/bin/bash
set -euo pipefail
FAKE_STATE=${JSON.stringify(root)}
if [[ "$1 $2" == "repo view" ]]; then echo owner/repo
elif [[ "$1" == api ]]; then jq -c '[.]' "$FAKE_STATE/issues.json"
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
  executable(join(bin, "dagu"), `#!/bin/bash
set -euo pipefail
FAKE_STATE=${JSON.stringify(root)}
REAL_DAGU=${JSON.stringify(realDagu)}
if [[ "$1" == status && "$*" == *planning* ]]; then
  if test -n "${"$"}{REAL_DAGU:-}"; then exec "$REAL_DAGU" "$@"; fi
  echo 'Running -'; echo "push-back iteration: ${"$"}{FAKE_ITERATION:-0}"
elif [[ "$1" == status ]]; then test -f "$FAKE_STATE/$3.enqueued"
elif [[ "$1" == enqueue && "$*" != *planning.yaml* ]]; then
  printf '%s\\n' "$*" >> "$FAKE_STATE/enqueues.log"
  touch "$FAKE_STATE/$3.enqueued"
elif test -n "${"$"}{REAL_DAGU:-}"; then exec "$REAL_DAGU" "$@"
else echo "Unexpected dagu $*" >&2; exit 1; fi
`);
  executable(join(bin, "dagu-feature-bundle"), '#!/bin/bash\nexec dagu "$@"\n');
  const env = { ...process.env, HOME: root, TMPDIR: join(root, "tmp"), PRIMARY: primary, OUT_DIR: out, NWO: "owner/repo", RUN: "repo-planning-test", SOURCE: "Operator request", OMP_SESSION_ID: "owner-session", DAGU_OUTPUT_FILE: join(root, "outputs"), FAKE_STATE: root, PATH: `${bin}:${process.env.PATH}` };
  return { root, bin, out, primary, env, run: (body: string, extra: NodeJS.ProcessEnv = {}) => spawnSync("bash", ["-c", body], { env: { ...env, ...extra }, encoding: "utf8" }), close: () => rmSync(root, { recursive: true, force: true }) };
}

for (const [name, source] of [["template", template], ["render", rendered]] as const) {
  test(`${name} carries the planning graph, bundle stamp and approval boundary`, () => {
    const ids = [...source.matchAll(/^  - id: (\w+)$/gm)].map(match => match[1]);
    assert.deepEqual(ids, ["init", "plan", "check_plan", "review", "check_review", "approve", "materialize", "dispose"]);
    assert.match(source, /^# dagu-feature-bundle: /);
    for (const step of ["plan", "review", "approve"]) assert.match(source, new RegExp(`- id: ${step}\\n[\\s\\S]*?action: human\\.task`));
    for (const step of ["init", "check_plan", "check_review"]) assert.doesNotMatch(script(source, step), /gh issue create|dagu enqueue/);
    assert.match(source, /rewind_to: plan/);
  });
  test(`${name} validates every planning unit rule with line-local diagnostics`, () => {
    const f = fixture();
    try {
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ ...unit(), id: "Bad ID" }, "kebab-id"], [{ ...unit(), title: " " }, "title"],
        [{ ...unit(), dag: "other" }, "dag"], [{ ...unit("probe", "poc"), question: undefined }, "poc-question"],
        ...["depends", "blocks", "blocked_by"].map(key => [{ ...unit(), [key]: [] }, "self-contained"] as [Record<string, unknown>, string]),
        [{ ...unit(), body: "## Problema\nMissing sections" }, "required-sections"],
        [{ ...unit("probe", "poc"), body: "## PoC\nMissing sections" }, "required-sections"],
        [{ ...unit(), labels: "change" }, "labels"],
        [{ ...unit(), id: null }, "kebab-id"], [{ ...unit(), title: 7 }, "title"],
        [{ ...unit("probe", "poc"), question: null }, "poc-question"],
        [{ ...unit(), body: null }, "body"], [{ ...unit(), labels: [7] }, "labels"],
      ];
      for (const [row, rule] of cases) {
        jsonl(join(f.out, "units.jsonl"), [unit("first"), row]);
        const result = f.run(script(source, "check_plan"));
        assert.notEqual(result.status, 0, rule);
        assert.match(result.stderr, new RegExp(`units\\.jsonl:2: rule=${rule}`));
        assert.ok(existsSync(join(f.out, "review-rewind")));
      }
      jsonl(join(f.out, "units.jsonl"), [unit(), unit()]);
      assert.match(f.run(script(source, "check_plan")).stderr, /units\.jsonl:2: rule=unique-id/);
      writeFileSync(join(f.out, "units.jsonl"), "{invalid}\n");
      assert.match(f.run(script(source, "check_plan")).stderr, /units\.jsonl:1: rule=json-object/);
      jsonl(join(f.out, "units.jsonl"), [unit(), unit("probe", "poc")]);
      const accepted = f.run(script(source, "check_plan"));
      assert.equal(accepted.status, 0, accepted.stderr);
      assert.equal(existsSync(join(f.out, "review-rewind")), false);
    } finally { f.close(); }
  });
}

test("planning render retains adoption identity and exactly renders the template", () => {
  const stamp = rendered.split("\n")[0]!.replace("# dagu-feature-bundle: ", "");
  const version = rendered.match(/dagu-feature-bundle=(\d+\.\d+\.\d+)/)![1]!;
  const identity = rendered.match(/- DAGU_FEATURE_BUNDLE: "([^"]+)"/)![1]!;
  assert.equal(rendered, template.replaceAll("__DAGU_FEATURE_STAMP__", stamp).replaceAll("__DAGU_FEATURE_VERSION__", version).replaceAll("__DAGU_FEATURE_IDENTITY__", identity).replaceAll("TEMPLATE_REPO", "a4s"));
});

interface PlanningArtifacts {
  root: string;
  out: string;
  env: NodeJS.ProcessEnv;
}
function transcript(f: PlanningArtifacts, data: unknown = { verdict: "accept", findings: [] }, extra: { parent?: string; timestamp?: string; agent?: string; marker?: string; last?: unknown } = {}) {
  const sessions = join(f.root, ".omp", "agent", "sessions", "-primary", "date_owner-session");
  mkdirSync(sessions, { recursive: true });
  const marker = `PLAN_REVIEW AGENT=plan-reviewer DAG=planning RUN=${f.env.RUN} ITERATION=0 END`;
  writeFileSync(join(f.out, "generation"), marker + "\n");
  jsonl(join(sessions, "PlanReviewTest.jsonl"), [
    { type: "session", parentSession: extra.parent ?? `${sessions}.jsonl` },
    { type: "session_init", agent: extra.agent ?? "plan-reviewer", task: extra.marker ?? marker, timestamp: extra.timestamp ?? "2026-10-17T00:00:01.001Z" },
    { type: "message", message: { role: "toolResult", toolName: "yield", details: { data } } },
    ...(extra.last === undefined ? [] : [{ type: "message", message: { role: "toolResult", toolName: "yield", details: { data: extra.last } } }]),
  ]);
}

test("review verifier binds parent, generation, agent, cutoff and the last structured yield", () => {
  const f = fixture();
  try {
    executable(join(f.bin, "curl"), '#!/bin/sh\nprintf \'%s\\n\' \'{"dagRunDetails":{"nodes":[{"step":{"id":"review"},"startedAt":"2026-10-17T00:00:01Z"}]}}\'\n');
    const check = () => f.run(script(template, "check_review"), { REVIEW: "PlanReviewTest" });
    assert.notEqual(check().status, 0, "a unique reviewer transcript is required");
    for (const extra of [
      { parent: "/foreign/session.jsonl" }, { timestamp: "2026-10-17T00:00:00Z" },
      { timestamp: "2026-10-17T00:00:01Z" }, { agent: "worker" }, { marker: "wrong-generation" },
      { last: "not-json" }, { last: { verdict: "accept" } },
    ]) {
      transcript(f, undefined, extra);
      assert.notEqual(check().status, 0, JSON.stringify(extra));
    }
    transcript(f);
    const accepted = check();
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(f.out, "review-0.json"), "utf8")), { verdict: "accept", findings: [] });
    assert.notEqual(f.run(script(template, "check_review"), { REVIEW: "PlanReviewTest", FAKE_ITERATION: "1" }).status, 0);
    const duplicateSession = join(f.root, ".omp", "agent", "sessions", "-primary", "other_owner-session");
    mkdirSync(duplicateSession);
    writeFileSync(join(duplicateSession, "PlanReviewTest.jsonl"), "{}\n");
    assert.notEqual(check().status, 0, "ambiguous reviewer paths fail closed");
    rmSync(duplicateSession, { recursive: true });
    transcript(f, { verdict: "revise", findings: [] });
    assert.notEqual(check().status, 0);
    transcript(f, { verdict: "revise", findings: [{ unit: "unit-feature", severity: "blocker", text: "Add an exact test command" }] });
    const revised = check();
    assert.equal(revised.status, 0, revised.stderr);
    assert.ok(existsSync(join(f.out, "approve-rewind")));
    assert.match(readFileSync(join(f.out, "findings.md"), "utf8"), /Add an exact test command/);
  } finally { f.close(); }
});

test("approved materialization preserves labels and run markers and reuses issues and feature/PoC runs", () => {
  const f = fixture();
  try {
    jsonl(join(f.out, "units.jsonl"), [unit(), unit("probe", "poc")]);
    const materialize = () => f.run(script(template, "materialize"), { APPROVED: "all" });
    assert.equal(materialize().status, 0);
    assert.equal(f.run(script(template, "dispose")).status, 0);
    const issues = JSON.parse(readFileSync(join(f.root, "issues.json"), "utf8"));
    assert.equal(issues.length, 2);
    assert.match(issues[0].body, /<!-- planning-unit: repo-planning-test\/unit-feature -->/);
    assert.match(readFileSync(join(f.root, "github.log"), "utf8"), /--label change/);
    assert.equal(materialize().status, 0);
    const rows = readFileSync(join(f.out, "issues.jsonl"), "utf8").trim().split("\n").map(row => JSON.parse(row));
    assert.equal(rows.every(row => row.reused), true);
    assert.equal(f.run(script(template, "dispose")).status, 0);
    const enqueues = readFileSync(join(f.root, "enqueues.log"), "utf8").trim().split("\n");
    assert.equal(enqueues.length, 2);
    assert.match(enqueues[0]!, /--run-id repo-issue-41 .*feature.yaml -- ISSUE=41 OMP_SESSION_ID=owner-session PR_NUMBER=$/);
    assert.match(enqueues[1]!, /--run-id repo-poc-42 .*poc.yaml -- ISSUE=42 OMP_SESSION_ID=owner-session QUESTION=Can the real target/);
    assert.equal(readFileSync(join(f.root, "github.log"), "utf8").trim().split("\n").length, 2);
  } finally { f.close(); }
});

async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
const version = spawnSync("dagu", ["version"], { encoding: "utf8" });
test("isolated real Dagu rewinds invalid plans and revise findings, then approves and disposes", {
  skip: version.status !== 0 || version.stdout.trim() !== "2.20.1" ? "Dagu 2.20.1 required" : false,
  timeout: 240_000,
}, async () => {
  const realDagu = execFileSync("which", ["dagu"], { encoding: "utf8" }).trim();
  const f = fixture(realDagu);
  const home = join(f.root, "dagu-home"); mkdirSync(join(home, "dags"), { recursive: true });
  const httpPort = await port(), schedulerPort = await port();
  const env = { ...f.env, DAGU_HOME: home, DAGU_PORT: String(httpPort), DAGU_HOST: "127.0.0.1", DAGU_COORDINATOR_ENABLED: "false" };
  writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${httpPort}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\nscheduler:\n  port: ${schedulerPort}\n`);
  execFileSync("git", ["init", "-b", "main", f.primary], { encoding: "utf8" });
  const definition = join(home, "dags", "planning.yaml");
  writeFileSync(definition, rendered.replace("env:\n", `env:\n  - HOME: ${JSON.stringify(f.root)}\n  - TMPDIR: ${JSON.stringify(join(f.root, "tmp"))}\n  - DAGU_PORT: "${httpPort}"\n`));
  const service = spawn(realDagu, ["start-all", "--host", "127.0.0.1", "--port", String(httpPort)], { env, cwd: f.root, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; service.stdout.on("data", value => { log += value; }); service.stderr.on("data", value => { log += value; });
  const dagu = (...args: string[]) => execFileSync(realDagu, args, { env, cwd: f.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const runId = f.env.RUN;
  const out = join(home, "data", "planning", "owner__repo", runId);
  type Details = { statusLabel: string; nodes: Array<{ statusLabel: string; stderr?: string; step: { id: string; name: string; humanTask?: { prompt?: string } } }> };
  async function until<T>(label: string, probe: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) { const result = await probe(); if (result !== undefined) return result; await delay(150); }
    const current = await detail();
    const paths = [
      ...current?.nodes.map(node => node.stderr).filter((path): path is string => !!path) ?? [],
      join(out, "review-transition.log"), join(out, "approve-transition.log"),
    ];
    const diagnostics = paths.filter(path => existsSync(path)).map(path => `${path}:\n${readFileSync(path, "utf8")}`).join("\n");
    throw new Error(`Timed out ${label}\n${JSON.stringify(current)}\n${diagnostics}\n${log}`);
  }
  async function detail(): Promise<Details | undefined> {
    try { const response = await fetch(`http://127.0.0.1:${httpPort}/api/v1/dag-runs/planning/${runId}`); return response.ok ? (await response.json() as { dagRunDetails: Details }).dagRunDetails : undefined; } catch { return undefined; }
  }
  async function waiting(step: string, iteration: number): Promise<Details> {
    return until(`${step} iteration=${iteration}`, async () => {
      const d = await detail();
      if (d?.statusLabel === "failed") throw new Error(JSON.stringify(d) + "\n" + log);
      if (d?.statusLabel !== "waiting" || !d.nodes.some(n => (n.step.id ?? n.step.name) === step && n.statusLabel === "waiting")) return undefined;
      const status = dagu("status", "planning", "--run-id", runId);
      return Number(status.match(/push-back iteration: (\d+)/)?.[1] ?? 0) === iteration ? d : undefined;
    });
  }
  try {
    await until("server ready", async () => { try { return (await fetch(`http://127.0.0.1:${httpPort}/api/v1/dag-runs`)).ok ? true : undefined; } catch { return undefined; } });
    dagu("validate", definition);
    dagu("enqueue", "--run-id", runId, definition, "--", "SOURCE=Operator request", `PRIMARY=${f.primary}`, "OMP_SESSION_ID=owner-session");
    await waiting("plan", 0);
    writeFileSync(join(out, "plan.md"), "Approved local plan\n");
    const invalids = [ { ...unit("probe", "poc"), question: undefined }, { ...unit(), depends: [] }, { ...unit(), body: "Missing sections" } ];
    for (let i = 0; i < invalids.length; i++) {
      jsonl(join(out, "units.jsonl"), [invalids[i]]);
      dagu("human-task", "complete", "planning", "--run-id", runId, "--step", "plan");
      const d = await waiting("plan", i + 1);
      const findings = readFileSync(join(out, "findings.md"), "utf8").trim();
      assert.match(findings, /units\.jsonl:1: rule=/);
      assert.ok(d.nodes.find(n => (n.step.id ?? n.step.name) === "plan")?.step.humanTask?.prompt?.includes(findings), JSON.stringify(d));
    }
    jsonl(join(out, "units.jsonl"), [unit(), unit("probe", "poc")]);
    dagu("human-task", "complete", "planning", "--run-id", runId, "--step", "plan");
    await waiting("review", 3);
    assert.equal(existsSync(join(f.root, "github.log")), false);
    assert.equal(existsSync(join(f.root, "enqueues.log")), false);
    function liveTranscript(verdict: "accept" | "revise") {
      const sessions = join(f.root, ".omp", "agent", "sessions", "-primary", "date_owner-session"); mkdirSync(sessions, { recursive: true });
      jsonl(join(sessions, "PlanReviewLive.jsonl"), [
        { type: "session", parentSession: `${sessions}.jsonl` },
        { type: "session_init", agent: "plan-reviewer", task: readFileSync(join(out, "generation"), "utf8").trim(), timestamp: new Date(Date.now() + 100).toISOString() },
        { type: "message", message: { role: "toolResult", toolName: "yield", details: { data: { verdict, findings: verdict === "revise" ? [{ unit: "unit-feature", severity: "blocker", text: "Use an exact test command" }] : [] } } } },
      ]);
    }
    liveTranscript("revise");
    dagu("human-task", "complete", "planning", "--run-id", runId, "--step", "review", "--input", "REVIEW=PlanReviewLive");
    const revised = await waiting("plan", 4);
    assert.ok(revised.nodes.find(n => (n.step.id ?? n.step.name) === "plan")?.step.humanTask?.prompt?.includes("Use an exact test command"));
    dagu("human-task", "complete", "planning", "--run-id", runId, "--step", "plan");
    await waiting("review", 4);
    liveTranscript("accept");
    dagu("human-task", "complete", "planning", "--run-id", runId, "--step", "review", "--input", "REVIEW=PlanReviewLive");
    await waiting("approve", 4);
    assert.equal(existsSync(join(f.root, "github.log")), false);
    assert.equal(existsSync(join(f.root, "enqueues.log")), false);
    dagu("human-task", "complete", "planning", "--run-id", runId, "--step", "approve", "--input", "APPROVED=all");
    await until("succeeded", async () => { const d = await detail(); if (d?.statusLabel === "failed") throw new Error(JSON.stringify(d)); return d?.statusLabel === "succeeded" ? d : undefined; });
    assert.equal(JSON.parse(readFileSync(join(f.root, "issues.json"), "utf8")).length, 2);
    assert.equal(readFileSync(join(f.root, "enqueues.log"), "utf8").trim().split("\n").length, 2);
  } finally {
    service.kill("SIGTERM");
    await new Promise<void>(resolve => { if (service.exitCode !== null) resolve(); else service.once("exit", () => resolve()); });
    f.close();
  }
});
