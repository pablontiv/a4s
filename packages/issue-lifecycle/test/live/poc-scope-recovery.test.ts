import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import { a4sBin } from "../fixtures/a4s.ts";
import { liveDagu } from "../fixtures/live-dagu.ts";
import { testRunId } from "../fixtures/run-id.ts";

interface Detail {
  statusLabel: string;
  nodes: Array<{ step: { name: string }; statusLabel: string }>;
}

test("PoC scope recovery re-asks invalid narrow decisions and preserves access/defer/cancel routes", { ...liveDagu, timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "a4s-scope-recovery-"));
  const primary = join(root, "primary");
  const home = join(root, "dagu-home");
  mkdirSync(join(home, "dags"), { recursive: true });
  execFileSync("git", ["init", "-b", "main", primary], { stdio: "pipe" });
  const listener = createServer();
  const listening = once(listener, "listening");
  listener.listen(0, "127.0.0.1");
  await listening;
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  const closed = once(listener, "close");
  listener.close();
  await closed;
  const env: NodeJS.ProcessEnv = { ...process.env, DAGU_HOME: home, DAGU_PORT: String(port), DAGU_COORDINATOR_ENABLED: "false" };
  delete env.DAGU_QUEUE_DISPATCH_RETRY;
  delete env.DAG_PUSHBACK_ITERATION;
  writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\nscheduler:\n  port: 0\n`);
  const source = parse(readFileSync(new URL("../../skills/issue-execution/feature.yaml", import.meta.url), "utf8"));
  const ids = ["poc_scope_prepare", "poc_scope_decision", "poc_scope_decision_cancellation", "poc_scope_resolve", "recover_poc_scope", "recover_poc_scope_cancellation", "poc_admit"];
  const steps = ids.map(id => structuredClone(source.steps.find((step: { id: string }) => step.id === id)));
  steps[0].depends = "triage";
  // Exercise the production admission dependency/guard, not external PoC enqueue.
  steps.at(-1).run = 'printf "admitted\\n" > "$PRIMARY/$RUN.admitted"';
  writeFileSync(join(home, "dags", "feature.yaml"), stringify({
    name: "feature", type: "graph", shell: "bash", max_active_steps: 1,
    env: { PRIMARY: primary, WORKTREE: primary, ISSUE: "751", BRANCH: "scope-fixture", A4S_BIN: a4sBin,
      RUN: "${context.run.id}", ESCALATION_POC_INCONCLUSIVE: "2" },
    steps: [{ id: "triage", run: `printf '%s\\n' 'POC=yes' "QUESTION=Can local and remote run? $RUN" 'REQUIRED_TARGETS=["local","remote"]' 'AUTHORIZED_TARGETS=["local"]' 'SCOPE_BASIS=Only local authorized' >> "$DAGU_OUTPUT_FILE"`,
      outputs: ["POC", "QUESTION", "REQUIRED_TARGETS", "AUTHORIZED_TARGETS", "SCOPE_BASIS"].map(name => ({ name })) }, ...steps],
    handler_on: { wait: source.handler_on.wait, exit: { run: 'printf "exit\\n" > "$PRIMARY/$RUN.exit"' } },
  }));
  let serviceLog = "";
  const service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(port)], { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  service.stdout.on("data", data => { serviceLog += data; });
  service.stderr.on("data", data => { serviceLog += data; });
  const api = `http://127.0.0.1:${port}/api/v1`;
  const dagu = (...args: string[]) => execFileSync("dagu", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  async function until<T>(description: string, probe: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const value = await probe();
      if (value !== undefined) return value;
      await delay(100);
    }
    throw new Error(`Timed out: ${description}\n${serviceLog}`);
  }
  async function detail(run: string): Promise<Detail | undefined> {
    const response = await fetch(`${api}/dag-runs/feature/${run}`);
    return response.ok ? (await response.json() as { dagRunDetails: Detail }).dagRunDetails : undefined;
  }
  async function waiting(run: string, iteration: number): Promise<string> {
    return until(`${run} decision waiting at iteration ${iteration}`, async () => {
      const current = await detail(run);
      if (!current) return undefined;
      assert.notEqual(current.statusLabel, "failed", JSON.stringify(current));
      assert.notEqual(current.statusLabel, "partially_succeeded", JSON.stringify(current));
      assert.equal(existsSync(join(primary, `${run}.admitted`)), false);
      if (current.statusLabel !== "waiting" || current.nodes.find(node => node.step.name === "poc_scope_decision")?.statusLabel !== "waiting") return undefined;
      const status = dagu("status", "feature", "--run-id", run);
      const observed = Number(/push-back iteration: (\d+)/.exec(status)?.[1] || 0);
      // CLI status wraps long prompt strings and hashes with tree decorations.
      return observed === iteration ? status.replace(/[\s│├└─]/g, "") : undefined;
    });
  }
  function complete(run: string, inputs: string[]): void {
    dagu("human-task", "complete", "feature", "--run-id", run, "--step", "poc_scope_decision", ...inputs.flatMap(value => ["--input", value]));
  }
  try {
    await until("isolated Dagu ready", async () => {
      try { return (await fetch(`${api}/dag-runs`)).ok ? true : undefined; } catch { return undefined; }
    });
    const run = testRunId("scope-correction");
    dagu("enqueue", "--run-id", run, "feature");
    const initial = await waiting(run, 0);
    assert.match(initial, /defer=ACTIONandBASISonly/);
    const fields = ["ACTION=narrow", "BASIS=Keep only the local target", 'REQUIRED_TARGETS=["local"]', 'AUTHORIZED_TARGETS=["local"]'];
    complete(run, fields);
    const first = await waiting(run, 1);
    assert.match(first, /narrow.question.changed/);
    assert.match(first, /expected/);
    assert.match(first, /observed/);
    complete(run, [...fields, `QUESTION=Can local and remote run? ${run}`]);
    const second = await waiting(run, 2);
    assert.match(second, /differentFrom/);
    const rejectionPath = join(primary, ".git", "dagu-feature", "runs", run, "scope-rejection.json");
    const rejection = JSON.parse(readFileSync(rejectionPath, "utf8"));
    assert.equal(rejection.run, run);
    assert.equal(rejection.issue, "751");
    assert.equal(rejection.observed, `Can local and remote run? ${run}`);
    assert.match(second, new RegExp(rejection.request));
    complete(run, ["ACTION=provide-access", "BASIS=Remote access granted", 'AUTHORIZED_TARGETS=["local","remote"]']);
    await until("corrected decision admitted", async () => {
      const current = await detail(run);
      assert.notEqual(current?.statusLabel, "failed", JSON.stringify(current));
      return current?.statusLabel === "succeeded" ? current : undefined;
    });
    const decision = JSON.parse(readFileSync(join(primary, ".git", "poc", "scope", "751", rejection.request, "decision.json"), "utf8"));
    assert.equal(decision.input.question, `Can local and remote run? ${run}`);
    assert.deepEqual(decision.input.requiredTargets, ["local", "remote"]);
    assert.equal(existsSync(join(primary, `${run}.admitted`)), true);
    for (const mode of ["defer", "cancel"] as const) {
      const terminalRun = testRunId(`scope-${mode}`);
      dagu("enqueue", "--run-id", terminalRun, "feature");
      await waiting(terminalRun, 0);
      complete(terminalRun, mode === "defer" ? ["ACTION=defer", "BASIS=Wait for authorized access"] : ["CANCEL=yes"]);
      const terminal = await until(`${mode} terminal`, async () => {
        const current = await detail(terminalRun);
        return current?.statusLabel === "failed" && existsSync(join(primary, `${terminalRun}.exit`)) ? current : undefined;
      });
      assert.notEqual(terminal.nodes.find(node => node.step.name === "recover_poc_scope")?.statusLabel, "waiting");
      assert.equal(existsSync(join(primary, `${terminalRun}.admitted`)), false);
      assert.equal(existsSync(join(primary, ".git", "dagu-feature", "runs", terminalRun, "scope-rejection.json")), false);
      if (mode === "cancel") assert.equal(JSON.parse(readFileSync(join(primary, ".git", "dagu-feature", "runs", terminalRun, "cancellation.json"), "utf8")).outcome, "cancelled");
    }
  } finally {
    if (service.exitCode === null && service.signalCode === null) {
      const exited = once(service, "exit");
      service.kill("SIGTERM");
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
