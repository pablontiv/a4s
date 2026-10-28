import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import YAML from "yaml";
import { liveDagu, liveDaguVersion } from "./fixtures/live-dagu.ts";
import { testRunId } from "./fixtures/run-id.ts";
import { readEscalationDiagnostic } from "../src/status/repository.ts";
import { Transitions, type RunDetails } from "../src/status/progress.ts";

const execute = promisify(execFile);
const helper = fileURLToPath(new URL("../skills/issue-execution/escalation.py", import.meta.url));
const feature = readFileSync(new URL("../skills/issue-execution/feature.yaml", import.meta.url), "utf8");
interface FixtureStep {
  id: string;
  depends?: string;
  preconditions?: unknown;
  run?: string;
  with: {
    push_back: { rewind_to: string };
    form: { properties: { ACTION: { enum: string[] } } };
  };
}
interface FixtureDag { steps: FixtureStep[] }
function repository(root: string): string {
  const primary = join(root, "primary");
  execFileSync("git", ["init", "-b", "main", primary], { stdio: "pipe" });
  return primary;
}

test("durable budget uses native iterations and retry-safe finding occurrences, renewal and decision provenance", async () => {
  const root = mkdtempSync(join(tmpdir(), "escalation558-unit-"));
  const primary = repository(root);
  const state = join(primary, ".git/dagu-feature/runs/budget558");
  mkdirSync(state, { recursive: true });
  const server = createServer((_request, response) => response.end(JSON.stringify({ dagRunDetails: { startedAt: new Date().toISOString(),
    nodes: [{ pushBackHistory: [{ iteration: Number(env.DAG_PUSHBACK_ITERATION), by: "operator", byId: "os:test" }] }] } })));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const env = { ...process.env, PRIMARY: primary, RUN: "budget558", OMP_SESSION_ID: "owner",
    DAGU_URL: `http://127.0.0.1:${address.port}`, DAGU_OUTPUT_FILE: join(root, "outputs"), ESCALATION_SECONDS: "3600", DAG_PUSHBACK_ITERATION: "0" };
  const run = (...args: string[]) => execute("python3", [helper, ...args], { env });
  const budget = () => JSON.parse(readFileSync(join(state, "escalation.json"), "utf8"));
  const iteration = (value: number) => { env.DAG_PUSHBACK_ITERATION = String(value); };
  const finding = join(root, "finding");
  try {
    await run("check");
    assert.equal(budget().iteration, 0);
    writeFileSync(finding, " Same   finding \n");
    await Promise.all([run("finding", "gate", finding), run("finding", "gate", finding)]);
    assert.equal(budget().findings.length, 1);
    iteration(1);
    writeFileSync(finding, "same finding\n");
    await run("finding", "gate", finding);
    await run("check");
    assert.deepEqual(budget().trigger.reasons, ["repeated finding fingerprint"]);
    const request = budget().trigger.id;
    await run("check");
    assert.equal(budget().trigger.id, request);
    await execute("python3", [helper, "decision"], { env: { ...env, ACTION: "continue", REASON: "Authorized repair", DECIDED_BY: "operator" } });
    assert.equal(budget().trigger, null);
    assert.equal(budget().windowIteration, 1);
    assert.equal(budget().decisions[0].provenance.attributedTo, "operator");
    await execute("python3", [helper, "decision"], { env: { ...env, ACTION: "continue", REASON: "Authorized repair", DECIDED_BY: "operator" } });
    assert.equal(budget().decisions.length, 1);
    iteration(4);
    await run("check");
    assert.match(budget().trigger.reasons.join(" "), /push-back/);
    iteration(5);
    await run("route");
    assert.equal(budget().decisions[1].action, "change-route");
    assert.equal(budget().decisions[1].provenance.nativeAudit.byId, "os:test");
    assert.equal(budget().windowIteration, 5);
    for (const next of [6, 7]) {
      iteration(next);
      writeFileSync(finding, next === 6 ? "b.ts\na.ts\nb.ts\n" : "a.ts\nb.ts\n");
      await run("finding", "conflict", finding);
      writeFileSync(finding, next === 6 ? "\u001b[31mFAIL  required test\u001b[0m\n" : "fail required test\n");
      await run("finding", "gate", finding);
      await run("check");
      assert.equal(Boolean(budget().trigger), next === 7);
    }
    const recorded = budget().findings;
    assert.equal(recorded.filter((item: { kind: string }) => item.kind === "conflict").length, 2);
    assert.equal(recorded[0].fingerprint, recorded[2].fingerprint);
    assert.equal(recorded[1].fingerprint, recorded[3].fingerprint);
    iteration(8);
    await run("route");
    const old = budget();
    old.windowStartedAt = new Date(Date.now() - 3_700_000).toISOString();
    writeFileSync(join(state, "escalation.json"), JSON.stringify(old));
    await run("check");
    assert.deepEqual(budget().trigger.reasons, ["elapsed budget exhausted"]);
    await assert.rejects(execute("python3", [helper, "decision"], { env: { ...env, ACTION: "stop", REASON: "Defer", DECIDED_BY: "operator" } }), error => error instanceof Error && "code" in error && error.code === 77);
    assert.equal(budget().stopped, true);
    await assert.rejects(run("check"), error => error instanceof Error && "code" in error && error.code === 77);
  } finally {
    const closed = once(server, "close");
    server.close();
    await closed;
    rmSync(root, { recursive: true, force: true });
  }
});

test("escalation reads admitted receipt versions 1 and 2 and rejects unsupported versions before budget effects", () => {
  const root = mkdtempSync(join(tmpdir(), "escalation-receipt-version-"));
  const primary = repository(root);
  const state = join(primary, ".git/dagu-feature/runs/versions");
  mkdirSync(state, { recursive: true });
  const receipt = join(state, "receipt.json");
  const env = { ...process.env, PRIMARY: primary, RUN: "versions", OMP_SESSION_ID: "owner", DAG_PUSHBACK_ITERATION: "0", DAGU_OUTPUT_FILE: join(root, "outputs") };
  try {
    for (const schemaVersion of [1, 2, 3, "2", null]) {
      const bytes = JSON.stringify({ schemaVersion, initial: { admittedAt: new Date().toISOString() } });
      writeFileSync(receipt, bytes);
      const before = existsSync(join(state, "escalation.json")) ? readFileSync(join(state, "escalation.json"), "utf8") : undefined;
      const result = spawnSync("python3", [helper, "check"], { env, encoding: "utf8" });
      if (schemaVersion === 1 || schemaVersion === 2) assert.equal(result.status, 0, result.stderr);
      else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Unsupported admission receipt schemaVersion=/);
        assert.equal(readFileSync(join(state, "escalation.json"), "utf8"), before);
      }
      assert.equal(readFileSync(receipt, "utf8"), bytes);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("repair paths enter budget boundaries while preserving native static destinations", () => {
  const dag: FixtureDag = YAML.parse(feature);
  const steps = new Map(dag.steps.map(step => [step.id, step]));
  for (const id of ["conflict_review", "recover_gate", "validation", "await_ci"]) {
    assert.equal(steps.get(id)!.with.push_back.rewind_to, "implement_budget", id);
  }
  assert.equal(steps.get("await_merge")!.with.push_back.rewind_to, "rebase_budget");
  assert.equal(steps.get("implement")!.depends, "escalation_decision");
  assert.equal(steps.get("rebase")!.depends, "rebase_escalation_decision");
  assert.equal(steps.get("escalation")!.with.push_back.rewind_to, "triage");
  assert.deepEqual(steps.get("escalation")!.with.form.properties.ACTION.enum, ["continue", "stop"]);
  assert.match(steps.get("gate")!.run!, /escalation finding gate/);
  assert.match(steps.get("rebase")!.run!, /escalation finding conflict/);
});

test(`Dagu ${liveDaguVersion} escalation persists through restart, rejects stale push-back, renews, changes route and stops with onExit`, {
  ...liveDagu, timeout: 180_000,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), "escalation558-live-"));
  const primary = repository(root);
  const home = join(root, "dagu-home");
  mkdirSync(join(home, "dags"), { recursive: true });
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  const listenerClosed = once(listener, "close");
  listener.close();
  await listenerClosed;
  assert.notEqual(port, 8080);
  const id = testRunId("escalation558");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DAGU_")));
  Object.assign(env, { DAGU_HOME: home, DAGU_COORDINATOR_ENABLED: "false", DAGU_URL: `http://127.0.0.1:${port}` });
  writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\nscheduler:\n  port: 0\n`);
  const original: FixtureDag = YAML.parse(feature);
  const selected = original.steps.filter(step => ["implement_budget", "escalation", "escalation_cancellation", "escalation_decision"].includes(step.id));
  selected[0]!.depends = "triage";
  delete selected[0]!.preconditions;
  for (const step of selected) if (step.run) step.run = step.run.replace("dagu-feature-bundle escalation", `python3 '${helper}'`);
  const evidence = join(root, "gate-output.log");
  const definition = {
    type: "graph", shell: "bash", max_active_steps: 1,
    env: [{ PRIMARY: primary }, { RUN: "${context.run.id}" }, { DAGU_URL: env.DAGU_URL }, { PATH: process.env.PATH }, { OMP_SESSION_ID: "owner" },
      { ESCALATION_PUSHBACKS: "3" }, { ESCALATION_FINDINGS: "2" }, { ESCALATION_SECONDS: "3600" }],
    steps: [
      { id: "triage", run: `python3 '${helper}' route` }, ...selected,
      { id: "implement", depends: "escalation_decision", action: "human.task", with: { prompt: "Isolated implementation" } },
      { id: "gate", depends: "implement", run: `python3 '${helper}' finding gate '${evidence}'` },
      { id: "recover_gate", depends: "gate", action: "human.task", with: { prompt: "Isolated gate failure return", push_back: { rewind_to: "implement_budget" } } },
    ], handler_on: { exit: { run: `printf executed > '${root}/onExit'` } },
  };
  const path = join(home, "dags/feature.yaml");
  writeFileSync(path, YAML.stringify(definition));
  const state = join(primary, ".git/dagu-feature/runs", id, "escalation.json");
  const budget = () => JSON.parse(readFileSync(state, "utf8"));
  let service: ChildProcess | undefined;
  let logs = "";
  const dagu = (...args: string[]) => execFileSync("dagu", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  async function until<T>(description: string, probe: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + 35_000;
    while (Date.now() < deadline) {
      const value = await probe();
      if (value !== undefined) return value;
      await delay(100);
    }
    throw new Error(`Timeout ${description}\n${logs}`);
  }
  async function details(): Promise<RunDetails | undefined> {
    const response = await fetch(`${env.DAGU_URL}/api/v1/dag-runs/feature/${id}`);
    if (!response.ok) return undefined;
    const body: { dagRunDetails: RunDetails } = await response.json();
    return body.dagRunDetails;
  }
  async function waiting(step: string, iteration: number) {
    return until(`${step}/${iteration}`, async () => {
      const run = await details();
      assert.ok(!run || !["failed", "aborted"].includes(run.statusLabel), JSON.stringify(run));
      return run?.statusLabel === "waiting" && run.nodes?.some(node => (node.step.id ?? node.step.name) === step && node.statusLabel === "waiting" && (node.approvalIteration ?? 0) === iteration) ? run : undefined;
    });
  }
  async function start() {
    service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
    service.stdout!.on("data", data => { logs += data; });
    service.stderr!.on("data", data => { logs += data; });
    await until("isolated service ready", async () => {
      try { return (await fetch(`${env.DAGU_URL}/api/v1/dag-runs`)).ok ? true : undefined; } catch { return undefined; }
    });
  }
  async function stop() {
    if (service && service.exitCode === null) {
      const ended = once(service, "exit");
      service.kill("SIGTERM");
      await ended;
    }
  }
  async function human(verb: string, step: string, iteration?: number, inputs: string[] = []) {
    // Native Waiting is published before the previous attempt releases its lock.
    const args = ["human-task", verb, "feature", "--run-id", id, "--step", step,
      ...(iteration === undefined ? [] : ["--expected-iteration", String(iteration)]), ...inputs.flatMap(input => ["--input", input])];
    await until(`native attempt finalized for ${step}`, async () => {
      const result = spawnSync("dagu", args, { env, encoding: "utf8" });
      if (result.status === 0) return true;
      if (/still finalizing; retry human-task/.test(result.stderr)) return undefined;
      assert.fail(result.stderr || result.stdout || `dagu exited ${result.status}`);
    });
  }
  async function loop(iteration: number, same = false) {
    await waiting("implement", iteration);
    writeFileSync(evidence, same ? "Repeated gate finding\n" : `Distinct finding ${iteration}\n`);
    await human("complete", "implement");
    await waiting("recover_gate", iteration);
    await human("push-back", "recover_gate", iteration);
  }
  try {
    assert.equal(dagu("version").trim(), liveDaguVersion);
    dagu("validate", path);
    await start();
    dagu("enqueue", "--run-id", id, path);
    await loop(0);
    await waiting("implement", 1);
    const unsupported = spawnSync("dagu", ["human-task", "complete", "feature", "--run-id", id, "--step", "implement", "--expected-iteration", "1"], { env, encoding: "utf8" });
    assert.equal(unsupported.status, 1);
    assert.match(unsupported.stderr, /unknown flag: --expected-iteration/);
    await loop(1);
    await waiting("implement", 2);
    // Waiting is visible before the native attempt releases its heartbeat.
    // Restart only after that attempt has drained, preserving a resumable wait.
    await until("waiting attempt drained before restart", async () =>
      JSON.parse(dagu("ps", "--dag", "feature", "--run-id", id, "--format", "json")).length === 0 ? true : undefined);
    const before = budget();
    await stop();
    await start();
    await waiting("implement", 2);
    assert.deepEqual(budget(), before);
    await loop(2);
    const parked = await waiting("escalation", 3);
    assert.equal(budget().iteration, 3);
    const diagnostic = await readEscalationDiagnostic(primary, id, new AbortController().signal);
    const notice = new Transitions("owner").observe({ ...parked, params: "OMP_SESSION_ID=owner" }, { escalationDiagnostic: diagnostic! }).wakeMessage!;
    assert.match(notice, /iteration=3.*elapsedSeconds=.*spend=unknown/);
    t.diagnostic(notice);
    await human("complete", "escalation", undefined, ["ACTION=continue", "REASON=Renew repair", "DECIDED_BY=operator"]);
    await waiting("implement", 3);
    assert.equal(budget().windowIteration, 3);
    await loop(3, true);
    await loop(4, true);
    await waiting("escalation", 5);
    assert.match(budget().trigger.reasons.join(" "), /repeated finding/);
    const stale = spawnSync("dagu", ["human-task", "push-back", "feature", "--run-id", id, "--step", "escalation", "--expected-iteration", "4", "--input", "REASON=Change route", "--input", "DECIDED_BY=operator"], { env, encoding: "utf8" });
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /iteration 5, not 4/);
    await human("push-back", "escalation", 5, ["REASON=Change delivery route", "DECIDED_BY=operator"]);
    await waiting("implement", 6);
    assert.equal(budget().decisions[1].action, "change-route");
    await loop(6, true);
    await loop(7, true);
    await waiting("escalation", 8);
    await human("complete", "escalation", undefined, ["ACTION=stop", "REASON=Defer", "DECIDED_BY=operator"]);
    await until("native Failed/77 + onExit", async () => (await details())?.statusLabel === "failed" ? true : undefined);
    assert.equal(readFileSync(join(root, "onExit"), "utf8"), "executed");
    assert.equal(budget().decisions.at(-1).action, "stop");
    t.diagnostic(JSON.stringify({ home, port, run: id, iterations: [0, 1, 2, 3, 5, 6, 8], restart: "preserved", stop: "Failed/77 + onExit" }));
  } finally {
    await stop();
    rmSync(root, { recursive: true, force: true });
  }
});
