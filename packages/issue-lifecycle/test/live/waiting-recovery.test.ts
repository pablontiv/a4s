import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parse, stringify } from "yaml";
import { liveDagu, liveDaguVersion } from "../fixtures/live-dagu.ts";
import { waitingSnapshot } from "../fixtures/waiting-snapshot.ts";
import { testRunId } from "../fixtures/run-id.ts";
import { compiledArtifact, compiledA4sBin } from "../fixtures/admission.ts";
import { stationEnvironment } from "../fixtures/service-environment.ts";
import { inspectArtifact } from "../../../launcher/src/artifact-cache.ts";
import { artifactToken } from "../../../launcher/src/release.ts";
import { CONFIG_PATH, exampleConfig, serializeConfig } from "../../../launcher/src/config.ts";
import { USED_CONTRACTS } from "../../src/artifact-receipt.ts";

type Step = { id: string; action?: string; depends?: string | string[]; preconditions?: unknown[]; with?: { push_back?: unknown }; [key: string]: unknown };
type Template = { steps: Step[]; env?: Record<string, string>[]; handler_on: { exit: unknown } };
type Details = { statusLabel: string; onExit?: { statusLabel: string }; nodes: Array<{ step: { name: string }; statusLabel: string; doneCount: number }> };
const variants = ["feature", "historical-feature", "poc", "discovery", "planning", "dagu-feature-bootstrap"];
const definitions = variants.map(variant => readFileSync(new URL(`../../skills/issue-execution/${variant === "historical-feature" ? "feature" : variant}.yaml`, import.meta.url), "utf8"));
const fingerprint = createHash("sha256").update(definitions.join("\n")).update(readFileSync(new URL("../../src/cancellation.ts", import.meta.url))).update(readFileSync(new URL("../../src/bootstrap-receipt.ts", import.meta.url))).update(readFileSync(new URL("../../src/run-artifact.ts", import.meta.url))).update(readFileSync(new URL("../../src/artifact-receipt.ts", import.meta.url))).update(readFileSync(new URL("./waiting-recovery.test.ts", import.meta.url))).digest("hex");

test("receipt-bound cancellation covers every maintained wait, native absence, pending requests and unsupported snapshots", { ...liveDagu, timeout: 900_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a4s-cancel-"))), home = join(root, "home"), bin = join(root, "bin");
  mkdirSync(join(home, "dags"), { recursive: true }); mkdirSync(bin);
  const evidence = process.env.A4S_CANCEL_EVIDENCE || join(root, "evidence"); mkdirSync(evidence, { recursive: true });
  const effects = join(root, "effects"), pr = join(root, "pr.json");
  writeFileSync(effects, ""); writeFileSync(pr, '{"state":"OPEN","autoMerge":false}\n');
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${effects}'\nexit 1\n`, { mode: 0o755 });
  const socket = createServer(), listening = Promise.withResolvers<void>();
  socket.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
  const address = socket.address(); assert.ok(address && typeof address !== "string"); const port = address.port;
  const closed = Promise.withResolvers<void>(); socket.close(() => closed.resolve()); await closed.promise;
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DAGU_")));
  const env = stationEnvironment({ ...inherited, DAGU_HOME: home, DAGU_PORT: String(port), DAGU_AUTH_MODE: "none", DAGU_COORDINATOR_ENABLED: "false", PATH: `${bin}:${process.env.PATH}`, OMP_SESSION_ID: "cancellation-test", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" });
  const tuple = compiledArtifact(home), cached = await inspectArtifact(home, tuple), launcher = compiledA4sBin();
  Object.assign(env, { A4S_BIN: cached.executable, A4S_ARTIFACT: artifactToken(tuple) });
  delete env.PRIMARY; delete env.RUN;
  const station = { DAGU_URL: env.DAGU_URL, DAGU_HOME: env.DAGU_HOME, PATH: env.PATH, A4S_SERVICE_ENV: env.A4S_SERVICE_ENV, A4S_BIN: cached.executable, A4S_ARTIFACT: artifactToken(tuple) };
  const commandLog: unknown[] = [];
  const command = (exe: string, args: string[], cwd?: string, extra: NodeJS.ProcessEnv = {}) => {
    const started = Date.now();
    try { const stdout = execFileSync(exe, args, { env: { ...env, ...extra }, ...(cwd ? { cwd } : {}), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); commandLog.push({ exe, args, cwd, stdout, exitCode: 0, elapsedMs: Date.now() - started }); return stdout.trim(); }
    catch (error) { const failure = error as Error & { status?: number; stdout?: Buffer; stderr?: Buffer }; commandLog.push({ exe, args, cwd, exitCode: failure.status, stdout: failure.stdout?.toString(), stderr: failure.stderr?.toString() }); throw error; }
  };
  const git = (...args: string[]) => command("git", args), dagu = (...args: string[]) => command("dagu", args);
  writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\nqueues:\n  enabled: true\n  config:\n    - name: cancellation\n      max_concurrency: 1\n`);
  const service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "", failed = true, completed = 0, index = 0;
  service.stdout.on("data", chunk => { logs += chunk; }); service.stderr.on("data", chunk => { logs += chunk; });
  const baseURL = `http://127.0.0.1:${port}/api/v1`;
  async function until<T>(probe: () => Promise<T | undefined>): Promise<T> { const deadline = Date.now() + 40_000; while (Date.now() < deadline) { const value = await probe(); if (value !== undefined) return value; await delay(100); } throw new Error(`Dagu timeout\n${logs}`); }
  async function details(dag: string, run: string): Promise<Details | undefined> { const response = await fetch(`${baseURL}/dag-runs/${dag}/${run}`); if (!response.ok) return; const body = await response.json(); return body.dagRunDetails; }
  const snapshot = (primary: string) => ({ head: git("-C", primary, "rev-parse", "HEAD"), branch: git("-C", primary, "branch", "--show-current"), index: readFileSync(git("-C", primary, "rev-parse", "--path-format=absolute", "--git-path", "index")).toString("hex"), staged: git("-C", primary, "diff", "--cached", "--binary"), unstaged: git("-C", primary, "diff", "--binary"), untracked: readFileSync(join(primary, "untracked.bin")).toString("hex") });
  function fixture(run: string, kind: string) {
    const primary = join(root, run), remote = `${primary}.git`, worktree = join(root, `${run}-candidate`), branch = `candidate/${run}`;
    git("init", "--bare", "-b", "main", remote); git("init", "-b", "main", primary); git("-C", primary, "config", "user.name", "Cancellation Test"); git("-C", primary, "config", "user.email", "cancel@example.invalid");
    const config = serializeConfig(exampleConfig({ lane: "cancellation", gate: "true", rebaseResolver: "" }));
    mkdirSync(dirname(join(primary, CONFIG_PATH)), { recursive: true }); writeFileSync(join(primary, CONFIG_PATH), config); writeFileSync(join(primary, ".gitignore"), "/.workspace/\n"); writeFileSync(join(primary, "value"), "base\n");
    git("-C", primary, "add", "."); git("-C", primary, "add", "-f", CONFIG_PATH); git("-C", primary, "commit", "-m", "seed"); git("-C", primary, "remote", "add", "origin", remote); git("-C", primary, "push", "-u", "origin", "main");
    const base = git("-C", primary, "rev-parse", "HEAD"); git("-C", primary, "worktree", "add", "-b", branch, worktree, base);
    writeFileSync(join(worktree, "value"), "unpublished\n"); git("-C", worktree, "add", "value"); git("-C", worktree, "commit", "-m", "unpublished candidate");
    for (const path of [primary, worktree]) { writeFileSync(join(path, "value"), "staged\n"); git("-C", path, "add", "value"); writeFileSync(join(path, "value"), "unstaged\n"); writeFileSync(join(path, "untracked.bin"), Buffer.from([0, 255, 17])); }
    const state = join(primary, ".git", "dagu-feature", "runs", run), out = kind === "poc" ? join(primary, ".git", "poc", "runs", run) : kind === "feature" ? state : join(home, "data", kind, run);
    mkdirSync(state, { recursive: true }); mkdirSync(out, { recursive: true }); writeFileSync(join(out, "base.sha"), base);
    writeFileSync(join(state, "resource.json"), JSON.stringify({ run, primary, branch, worktree }));
    if (kind === "discovery") { git("-C", primary, "worktree", "add", "--detach", join(out, "snapshot"), base); writeFileSync(join(out, "snapshot-resource.json"), JSON.stringify({ run, primary, snapshot: join(out, "snapshot"), sha: base })); }
    const before = { primary: snapshot(primary), candidate: snapshot(worktree), refs: git("ls-remote", remote), pr: readFileSync(pr, "utf8") };
    function receipt(dag: string, spec: string) {
      const now = new Date().toISOString();
      const value = { schemaVersion: 2, receiptCreatedAt: now, artifact: tuple, artifactSupport: cached.identity.support, contracts: USED_CONTRACTS, sourceVersion: { version: tuple.version, commit: tuple.commit, origin: "verified-cache" }, deploymentFingerprint: createHash("sha256").update(spec).digest("hex"),
        initial: { admittedAt: now, deployment: { config: { schemaVersion: cached.identity.support.config.write, commit: base, digest: createHash("sha256").update(config).digest("hex") } }, runtimeAndModels: { daguHome: home, station: { DAGU_URL: env.DAGU_URL, DAGU_HOME: home, PATH: env.PATH } }, execution: { primary, dagSnapshot: spec, parameters: [`PRIMARY=${primary}`, "OMP_SESSION_ID=cancellation-test"], ompSession: "cancellation-test" }, eventsAndExternalState: {} }, runReceipt: { dag, run, attempt: 1, observations: [] } };
      writeFileSync(join(state, "receipt.json"), `${JSON.stringify(value)}\n`);
    }
    function preserved() { assert.deepEqual(snapshot(primary), before.primary, "primary files/index/branch/HEAD preserved"); assert.deepEqual(snapshot(worktree), before.candidate, "unpublished candidate plus staged/unstaged/untracked preserved"); assert.equal(git("ls-remote", remote), before.refs); assert.equal(readFileSync(pr, "utf8"), before.pr); assert.equal(readFileSync(effects, "utf8"), ""); }
    return { primary, remote, worktree, branch, state, out, receipt, preserved, before };
  }
  async function shard(key: string, body: () => Promise<unknown>) {
    const shardIndex = index++, path = join(evidence, `${fingerprint}-${key}.json`);
    if (process.env.A4S_CANCEL_CASE && process.env.A4S_CANCEL_CASE !== key) return;
    if (existsSync(path)) { console.log(`RESUME ${key}`); return; }
    const started = Date.now(); console.log(`SHARD_START ${shardIndex} ${key}`);
    const result = await body(); const record = { index: shardIndex, range: [shardIndex, shardIndex + 1], key, fingerprint, runtime: liveDaguVersion, elapsedMs: Date.now() - started, completedAt: new Date().toISOString(), result };
    writeFileSync(path, JSON.stringify(record, null, 2)); console.log(`SHARD_DONE ${key} ${record.elapsedMs}ms`); completed++;
  }
  const limited = () => !!process.env.A4S_CANCEL_LIMIT && completed >= Number(process.env.A4S_CANCEL_LIMIT);
  try {
    await until(async () => { try { return (await fetch(`${baseURL}/health`)).ok ? true : undefined; } catch { return; } });
    outer: for (let variantIndex = 0; variantIndex < variants.length; variantIndex++) {
      const variant = variants[variantIndex]!, kind = variant === "historical-feature" ? "feature" : variant, source: Template = parse(variant === "historical-feature" ? waitingSnapshot(definitions[variantIndex]!) : definitions[variantIndex]!);
      for (const checkpoint of source.steps.filter(step => step.action === "human.task" && (variant !== "historical-feature" || ["triage", "implement"].includes(step.id)))) {
        await shard(`${variant}-${checkpoint.id}`, async () => {
          const run = testRunId(`${kind}-${checkpoint.id}`), f = fixture(run, kind);
          const selected = new Set([checkpoint.id, `${checkpoint.id}_cancellation`]);
          if (checkpoint.id === "await_ci") selected.add("await_merge");
          const dependencies = (step: Step) => step.depends === undefined ? [] : Array.isArray(step.depends) ? step.depends : [step.depends];
          // Keep the maintained effecting suffix: cancellation must prevent all of it.
          for (let changed = true; changed;) { changed = false; for (const step of source.steps) if (!selected.has(step.id) && dependencies(step).some(id => selected.has(id))) { selected.add(step.id); changed = true; } }
          const steps = source.steps.filter(step => selected.has(step.id)).map(step => ({ ...step, depends: dependencies(step).filter(id => selected.has(id)) }));
          for (const step of steps) { if (step.id === checkpoint.id || step.id === `${checkpoint.id}_cancellation` || ["await_ci", "await_merge"].includes(step.id)) delete step.preconditions; if (step.with) delete step.with.push_back; }
          if (kind === "dagu-feature-bootstrap") {
            steps.find(step => step.id === checkpoint.id)!.depends.push("bind_bootstrap_receipt");
            steps.unshift({ id: "bind_bootstrap_receipt", depends: [], run: '"$A4S_BIN" bootstrap-receipt' } as typeof steps[number]);
          }
          const replace = (value: unknown): unknown => typeof value === "string" ? value.replaceAll("${steps.snapshot.outputs.OUT_DIR}", f.out).replaceAll("${steps.init.outputs.OUT_DIR}", f.out).replaceAll("${steps.snapshot.outputs.SNAPSHOT}", join(f.out, "snapshot")) : Array.isArray(value) ? value.map(replace) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child)])) : value;
          const environment = Object.assign({}, ...(source.env ?? []), { ...station, PRIMARY: f.primary, WORKTREE: f.worktree, BRANCH: f.branch, RUN: run, ISSUE: "272", BASE_BRANCH: "main", PR_NUMBER: "", OMP_SESSION_ID: "cancellation-test", VALIDATION: "procedure", REQUIRED_CHECK: "test", OUT_DIR: f.out });
          const spec = stringify(replace({ type: "graph", shell: "bash", max_active_steps: 1, env: Object.entries(environment).filter(([, value]) => value !== undefined).map(([key, value]) => ({ [key]: value })), params: [{ ISSUE: "272" }], steps, handler_on: { exit: source.handler_on.exit } }), { defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN", lineWidth: 0 });
          const definition = join(home, "dags", `${kind}.yaml`); writeFileSync(definition, spec); if (kind !== "dagu-feature-bootstrap") f.receipt(kind, spec);
          dagu("validate", definition); dagu("enqueue", "--run-id", run, definition);
          await until(async () => { const value = await details(kind, run); return value?.statusLabel === "waiting" && value.nodes.some(node => node.step.name === checkpoint.id && node.statusLabel === "waiting") && (checkpoint.id !== "await_ci" || value.nodes.some(node => node.step.name === "await_merge" && node.statusLabel === "waiting")) ? value : undefined; });
          command(launcher, ["cancel", "--run", run], f.worktree);
          const terminal = kind === "planning" || kind === "dagu-feature-bootstrap" || kind === "feature" && ["await_ci", "await_merge"].includes(checkpoint.id) ? "aborted" : "failed";
          const result = await until(async () => { const value = await details(kind, run); return value?.statusLabel === terminal && value.onExit?.statusLabel === "succeeded" ? value : undefined; });
          for (const node of result.nodes) if (![checkpoint.id, `${checkpoint.id}_cancellation`, "await_ci", "await_merge", "bind_bootstrap_receipt"].includes(node.step.name)) assert.equal(node.doneCount, 0, `${node.step.name}: no new effects`);
          if (checkpoint.id === "await_ci") assert.equal(result.nodes.find(node => node.step.name === "await_merge")?.statusLabel, "waiting", "preserve the actual sibling label inside an aborted run");
          const record = JSON.parse(readFileSync(join(f.state, "cancellation.json"), "utf8")); assert.equal(record.outcome, "cancelled"); assert.equal(record.nativeExpected, terminal); assert.equal(record.nativeObserved, terminal); assert.equal(record.checkpoint, checkpoint.id); assert.equal(record.requester, "cancellation-test"); assert.equal(record.cleanup.admissionReleased, true); assert.equal(record.cleanup.receiptRetained, true); assert.ok(record.retained.some((item: { location: string }) => item.location === f.worktree));
          if (kind === "discovery") { assert.equal(existsSync(join(f.out, "snapshot")), false); assert.deepEqual(record.cleanup.disposed, [join(f.out, "snapshot")]); }
          f.preserved(); for (const status of [1, 5, 7]) { const active = await (await fetch(`${baseURL}/dag-runs?status=${status}`)).json(); assert.ok(!active.dagRuns.some((item: { dagRunId: string }) => item.dagRunId === run)); }
          return { run, before: f.before, native: result, cancellation: record };
        });
        if (limited()) break outer;
      }
    }
    if (!limited()) {
      for (const mode of ["queued", "running", "unsupported"] as const) {
        await shard(mode, async () => {
          const run = testRunId(`cancel-${mode}`), f = fixture(run, "feature"), dag = "feature";
          const steps = mode === "unsupported" ? [{ id: "historical", action: "human.task", with: { prompt: "Historical snapshot without cancellation", form: { type: "object", properties: { RESULT: { type: "string" } } } } }] : [{ id: "hold", run: `while ! test -f '${join(root, run + "-release")}'; do sleep 0.1; done` }, { id: "effect", depends: "hold", run: `printf effect >> '${effects}'` }];
          const nativeExitMarker = join(root, `${run}-native-exit`);
          const spec = stringify({ type: "graph", queue: "cancellation", shell: "bash", env: [{ ...station, PRIMARY: f.primary, RUN: run }], steps, handler_on: { exit: { run: `printf exit > '${nativeExitMarker}'\n"$A4S_BIN" cancellation finalize` } } });
          const definition = join(home, "dags", "feature.yaml"); writeFileSync(definition, spec); f.receipt(dag, spec);
          const blockerRun = testRunId("cancel-blocker"), blocker = join(home, "dags", "cancel-blocker.yaml");
          if (mode === "queued") {
            writeFileSync(blocker, stringify({ queue: "cancellation", shell: "bash", steps: [{ id: "hold", run: `while ! test -f '${join(root, blockerRun + "-release")}'; do sleep 0.1; done` }] }));
            dagu("enqueue", "--run-id", blockerRun, blocker);
            await until(async () => (await details("cancel-blocker", blockerRun))?.statusLabel === "running" ? true : undefined);
          }
          dagu("enqueue", "--run-id", run, definition);
          const before = await until(async () => { const value = await details(dag, run); return value?.statusLabel === (mode === "unsupported" ? "waiting" : mode === "queued" ? "queued" : "running") ? value : undefined; });
          if (mode === "unsupported") {
            assert.throws(() => command(launcher, ["cancel", "--run", run], f.primary), /does not declare/);
            assert.equal(existsSync(join(f.state, "cancellation.json")), false); assert.deepEqual(await details(dag, run), before);
          } else if (mode === "queued") {
            command(launcher, ["cancel", "--run", run], f.worktree);
            const response = await fetch(`${baseURL}/dag-runs/${dag}/${run}`); assert.equal(response.status, 404); assert.equal((await response.json()).code, "not_found");
            assert.throws(() => dagu("status", "--run-id", run, dag), /dag-run ID not found/);
            const record = JSON.parse(readFileSync(join(f.state, "cancellation.json"), "utf8"));
            assert.equal(record.outcome, "cancelled"); assert.equal(record.nativeObserved, "not_found"); assert.equal(record.nativeExpected, "not_found"); assert.equal(record.cleanup.admissionReleased, true); assert.equal(record.cleanup.receiptRetained, true);
            assert.equal(existsSync(nativeExitMarker), false, "dequeue does not run native onExit; the app finalizer supplies cleanup");
            assert.equal(JSON.parse(readFileSync(join(f.state, "cancellation-native.json"), "utf8")).cleanupInputs.resource.run, run);
            for (const status of [1, 5, 7]) { const active = await (await fetch(`${baseURL}/dag-runs?status=${status}`)).json(); assert.ok(!active.dagRuns.some((item: { dagRunId: string }) => item.dagRunId === run)); }
            command(launcher, ["cancel", "--run", run], f.primary);
            assert.equal(JSON.parse(readFileSync(join(f.state, "cancellation.json"), "utf8")).cleanup.completedAt, record.cleanup.completedAt, "idempotent finalization");
            assert.throws(() => command(launcher, ["run", "--primary", f.primary, "--run", run, "--artifact", artifactToken(tuple), "--", "native", "retry", dag, "--run-id", run], f.primary), /Logical run is cancelled/);
          } else {
            command(launcher, ["cancel", "--run", run], f.primary); const record = JSON.parse(readFileSync(join(f.state, "cancellation.json"), "utf8"));
            assert.equal(record.outcome, "pending"); assert.equal(record.cleanup, undefined); assert.equal((await details(dag, run))?.statusLabel, "running"); assert.equal((await details(dag, run))?.nodes.find(node => node.step.name === "effect")?.doneCount, 0);
            assert.equal(existsSync(nativeExitMarker), false, "running requests must not invoke onExit");
          }
          f.preserved();
          if (mode === "unsupported") { dagu("human-task", "complete", dag, "--run-id", run, "--step", "historical", "--input", "RESULT=done"); }
          else { dagu("stop", "--run-id", mode === "queued" ? blockerRun : run, mode === "queued" ? "cancel-blocker" : dag); }
          await until(async () => { const value = await details(mode === "queued" ? "cancel-blocker" : dag, mode === "queued" ? blockerRun : run); return ["aborted", "succeeded"].includes(value?.statusLabel || "") && (mode === "queued" || value?.onExit?.statusLabel === "succeeded") ? true : undefined; });
          return { run, native: before, cancellation: existsSync(join(f.state, "cancellation.json")) ? JSON.parse(readFileSync(join(f.state, "cancellation.json"), "utf8")) : null };
        });
      }
    }
    failed = false;
  } finally {
    if (service.exitCode === null) { const exited = once(service, "exit"); service.kill("SIGTERM"); await exited; }
    writeFileSync(join(evidence, "commands.json"), JSON.stringify(commandLog, null, 2)); writeFileSync(join(evidence, "service.log"), logs);
    writeFileSync(join(evidence, "execution.json"), JSON.stringify({ root, home, baseURL, runtime: liveDaguVersion, fingerprint, completed, failed, serviceExit: service.exitCode }, null, 2));
    if (!failed) rmSync(root, { recursive: true, force: true }); else console.error(`Evidence retained at ${root}`);
  }
});
