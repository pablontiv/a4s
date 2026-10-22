import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parse, stringify } from "yaml";
import { liveDagu } from "../fixtures/live-dagu.ts";
import { PocDiagnostics } from "../fixtures/poc-diagnostics.ts";
import { qualityDecision } from "../../src/triage/quality.ts";
import { waitingSnapshot } from "../fixtures/waiting-snapshot.ts";

type Step = {
  id: string;
  action?: string;
  depends?: string | string[];
  preconditions?: unknown[];
  with: { form: { properties: Record<string, unknown> }; push_back?: unknown };
};
type Template = { steps: Step[]; env: Record<string, string>[]; handler_on: { exit: unknown; failure?: unknown } };
type Details = { statusLabel: string; onExit?: { statusLabel: string }; nodes: Array<{ step: { name: string }; statusLabel: string; doneCount: number }> };

test("distributed waiting checkpoints cancel before recovery, publication and promotion with native exit cleanup", { ...liveDagu, timeout: 300_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dagu-waiting-recovery-")));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(join(home, "dags"), { recursive: true });
  mkdirSync(bin);
  const effects = join(root, "effects");
  writeFileSync(effects, "");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\ncase "$1 $2" in\n  "pr view") printf '{"state":"OPEN"}\\n' ;;\n  *) printf '%s\\n' "$*" >> '${effects}'; exit 1 ;;\nesac\n`, { mode: 0o755 });
  writeFileSync(join(bin, "dagu-feature-bundle"), `#!/bin/sh\nprintf 'enqueue %s\\n' "$*" >> '${effects}'\nexit 1\n`, { mode: 0o755 });
  const socket = createServer();
  await new Promise<void>(resolve => {
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>(resolve => {
    socket.close(() => resolve());
  });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DAGU_")));
  Object.assign(env, { DAGU_HOME: home, DAGU_PORT: String(port), DAGU_COORDINATOR_ENABLED: "false", PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\n`);
  const service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  service.stdout.on("data", chunk => { logs += chunk; });
  service.stderr.on("data", chunk => { logs += chunk; });
  const command = (exe: string, args: string[]) => execFileSync(exe, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const git = (...args: string[]) => command("git", args);
  const dagu = (...args: string[]) => command("dagu", args);
  async function until<T>(probe: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const result = await probe();
      if (result !== undefined) return result;
      await delay(100);
    }
    throw new Error(`Dagu timeout\n${logs}`);
  }
  const diagnostics = new PocDiagnostics();
  const details = (dag: string, run: string) =>
    diagnostics.runDetails<Details>(`http://127.0.0.1:${port}/api/v1/dag-runs/${dag}/${run}`, true);
  let failed = false;
  try {
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/v1/dag-runs`)).ok ? true : undefined; } catch { return; } });
    for (const variant of ["feature", "historical-feature", "poc", "discovery"]) {
      const kind = variant === "historical-feature" ? "feature" : variant;
      const template = readFileSync(new URL(`../../skills/dagu-feature/${kind}.yaml`, import.meta.url), "utf8");
      const source: Template = parse(variant === "historical-feature" ? waitingSnapshot(template) : template);
      const checkpoints = source.steps.filter(step => step.action === "human.task" &&
        (variant !== "historical-feature" || ["triage", "implement", "quality_review"].includes(step.id)));
      for (const checkpoint of checkpoints) {
        for (const retained of checkpoint.id === "implement" ? [false, true] : [false]) {
          const run = `${variant}-${checkpoint.id}-${retained ? "retained" : "disposable"}`;
          const primary = join(root, run);
          const remote = `${primary}.git`;
          git("init", "--bare", "-b", "main", remote);
          git("init", "-b", "main", primary);
          git("-C", primary, "config", "user.name", "Cancellation Test");
          git("-C", primary, "config", "user.email", "cancel@example.invalid");
          writeFileSync(join(primary, ".gitignore"), "/.workspace/\n");
          writeFileSync(join(primary, "value"), "base\n");
          git("-C", primary, "add", "."); git("-C", primary, "commit", "-m", "seed");
          git("-C", primary, "remote", "add", "origin", remote); git("-C", primary, "push", "-u", "origin", "main");
          const base = git("-C", primary, "rev-parse", "HEAD");
          const branch = kind === "feature" ? "dagu/issue-290" : `poc/${run}`;
          const worktree = join(primary, ".workspace", "worktrees", kind === "feature" ? "issue-290" : `poc-${run}`);
          let out = join(root, `${run}-evidence`);
          if (kind === "discovery") {
            out = join(home, "data", "discovery", "test__repo", run);
            mkdirSync(out, { recursive: true });
            git("-C", primary, "worktree", "add", "--detach", join(out, "snapshot"), base);
          } else {
            git("-C", primary, "worktree", "add", "-b", branch, worktree, base);
            out = join(primary, ".git", kind === "feature" ? "dagu-feature" : "poc", "runs", run);
            mkdirSync(out, { recursive: true });
            writeFileSync(join(out, "base.sha"), base);
            if (kind === "feature") {
              const resource = JSON.stringify({ run, primary, branch, worktree });
              writeFileSync(join(out, "resource.json"), resource);
              const resources = join(primary, ".git", "dagu-feature", "resources");
              mkdirSync(resources, { recursive: true });
              // The branch-key hash is the same Git object hash used by lifecycle cleanup.
              const branchHash = execFileSync("git", ["hash-object", "--stdin"], { input: branch, encoding: "utf8", env }).trim();
              writeFileSync(join(resources, `${branchHash}.json`), resource);
            }
          }
          if (retained) {
            writeFileSync(join(worktree, "value"), "unpublished\n");
            git("-C", worktree, "add", "."); git("-C", worktree, "commit", "-m", "unpublished candidate");
            writeFileSync(join(worktree, "value"), "staged\n"); git("-C", worktree, "add", "value");
            writeFileSync(join(worktree, "value"), "unstaged\n");
            writeFileSync(join(worktree, "untracked.bin"), Buffer.from([0, 255, 17]));
          }
          const before = retained ? [git("-C", worktree, "rev-parse", "HEAD"), git("-C", worktree, "diff", "--binary"), git("-C", worktree, "diff", "--cached", "--binary"), readFileSync(join(worktree, "untracked.bin")).toString("hex")] : [];
          const remoteBefore = git("ls-remote", remote);
          const selected = new Set<string>([checkpoint.id]);
          if (checkpoint.id === "await_ci" || checkpoint.id === "await_merge") { selected.add("await_ci"); selected.add("await_merge"); }
          const dependencies = (step: Step): string[] => step.depends === undefined ? [] : Array.isArray(step.depends) ? step.depends : [step.depends];
          for (let changed = true; changed;) {
            changed = false;
            for (const step of source.steps) if (!selected.has(step.id) && dependencies(step).some(id => selected.has(id))) { selected.add(step.id); changed = true; }
          }
          const steps = source.steps.filter(step => selected.has(step.id)).map(step => ({ ...step, depends: dependencies(step).filter(id => selected.has(id)) }));
          const target = steps.find(step => step.id === checkpoint.id)!;
          delete target.preconditions;
          // Completion is exercised here; rewind targets preceding this isolated suffix are outside the fixture.
          for (const step of steps) if (step.with) delete step.with.push_back;
          delete steps.find(step => step.id === `${checkpoint.id}_cancellation`)!.preconditions;
          const environment = Object.assign({}, ...source.env, { PRIMARY: primary, WORKTREE: worktree, BRANCH: branch, RUN: run, ISSUE: "290", BASE_BRANCH: "main", PR_NUMBER: "", OMP_SESSION_ID: "", VALIDATION: "procedure", REQUIRED_CHECK: "test" });
          const replaceSnapshot = (value: unknown): unknown => typeof value === "string" ? value.replaceAll("${steps.snapshot.outputs.OUT_DIR}", out).replaceAll("${steps.snapshot.outputs.SNAPSHOT}", join(out, "snapshot")) : Array.isArray(value) ? value.map(replaceSnapshot) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceSnapshot(child)])) : value;
          const handler = { exit: source.handler_on.exit, ...(kind === "poc" ? { failure: source.handler_on.failure } : {}) };
          const definition = join(home, "dags", `${kind}.yaml`);
          writeFileSync(definition, stringify(replaceSnapshot({ type: "graph", shell: "bash", max_active_steps: 1, env: Object.entries(environment).map(([key, value]) => ({ [key]: value })), params: [{ ISSUE: "290" }], steps, handler_on: handler }), { defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN", lineWidth: 0 }));
          dagu("enqueue", "--run-id", run, definition);
          await until(async () => { const runState = await details(kind, run); return runState?.statusLabel === "waiting" && runState.nodes.some(node => node.step.name === checkpoint.id && node.statusLabel === "waiting") ? runState : undefined; });
          const rejected = spawnSync("dagu", ["human-task", "complete", kind, "--run-id", run, "--step", checkpoint.id, "--input", "CANCEL=invalid"], { env, encoding: "utf8" });
          assert.notEqual(rejected.status, 0, `${run}: form enum validation stays active`);
          if (kind === "feature" && ["implement", "quality_review"].includes(checkpoint.id)) {
            const previous = process.env.DAGU_URL;
            process.env.DAGU_URL = `http://127.0.0.1:${port}`;
            try {
              assert.equal(await qualityDecision({ toolName: "bash", toolCallId: "cancel", input: {
                command: `dagu human-task complete feature --run-id ${run} --step ${checkpoint.id} --input CANCEL=yes`,
              } }, { cwd: primary, sessionManager: { getSessionDir: () => root } }), undefined);
            } finally {
              if (previous === undefined) delete process.env.DAGU_URL; else process.env.DAGU_URL = previous;
            }
          }
          dagu("human-task", "complete", kind, "--run-id", run, "--step", checkpoint.id, "--input", "CANCEL=yes");
          const terminal = kind === "feature" && ["await_ci", "await_merge"].includes(checkpoint.id) ? "aborted" : "failed";
          const result = await until(async () => { const runState = await details(kind, run); return runState?.statusLabel === terminal && runState.onExit?.statusLabel === "succeeded" ? runState : undefined; });
          assert.equal(result.nodes.find(node => node.step.name === `${checkpoint.id}_cancellation`)?.statusLabel, terminal, run);
          for (const node of result.nodes) if (node.step.name !== checkpoint.id && node.step.name !== `${checkpoint.id}_cancellation` && !["await_ci", "await_merge"].includes(node.step.name)) assert.equal(node.doneCount, 0, `${run}: ${node.step.name} suppressed`);
          assert.equal(JSON.parse(readFileSync(join(out, "cancellation.json"), "utf8")).checkpoint, checkpoint.id);
          assert.equal(readFileSync(effects, "utf8"), "", `${run}: external-effect ledger`);
          assert.equal(git("ls-remote", remote), remoteBefore);
          assert.equal(git("-C", primary, "rev-parse", "HEAD"), base);
          if (retained) {
            assert.deepEqual([git("-C", worktree, "rev-parse", "HEAD"), git("-C", worktree, "diff", "--binary"), git("-C", worktree, "diff", "--cached", "--binary"), readFileSync(join(worktree, "untracked.bin")).toString("hex")], before);
            assert.match(readFileSync(join(out, "cleanup-diagnostic"), "utf8"), /not MERGED/);
          } else if (kind === "discovery") assert.equal(existsSync(join(out, "snapshot")), false);
          else assert.equal(existsSync(worktree), false, `${run}: disposable worktree removed`);
          console.log(`PASS ${run}: ${terminal}; onExit succeeded; successors/effects suppressed; resources ${retained ? "retained" : "removed"}`);
        }
      }
    }
  } catch (error) { failed = true; console.error(`Evidence retained at ${root}`); throw error; }
  finally {
    service.kill("SIGTERM");
    await new Promise<void>(resolve => {
      if (service.exitCode !== null) resolve();
      else service.once("exit", () => resolve());
    });
    if (!failed) rmSync(root, { recursive: true, force: true });
    else writeFileSync(join(root, "service.log"), logs);
  }
});
