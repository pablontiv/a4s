import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse, stringify } from "yaml";
import { admissionFixture } from "../fixtures/admission.ts";
import { liveDagu, liveDaguVersion } from "../fixtures/live-dagu.ts";

const skill = fileURLToPath(new URL("../../skills/dagu-feature", import.meta.url));
const cli = fileURLToPath(new URL("../../bin/dagu-feature-bundle.ts", import.meta.url));
const ordinary: Record<string, string> = { feature: "admission", poc: "admission", discovery: "snapshot", planning: "init" };

test("real Dagu guards all lifecycle entry points against queue bypass before ordinary steps and handlers", { ...liveDagu, timeout: 180_000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dagu-queue-live-")));
  const home = join(root, "home"), bin = join(root, "bin"), primary = join(root, "primary"), stage = join(root, "stage");
  for (const directory of [join(home, "dags"), bin, primary, stage]) mkdirSync(directory, { recursive: true });
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  socket.close();
  await once(socket, "close");
  const env = { ...process.env, DAGU_HOME: home, DAGU_COORDINATOR_ENABLED: "false", DAGU_PORT: String(port), PATH: `${bin}:${process.env.PATH}`, PRIMARY: primary };
  const git = (...args: string[]) => execFileSync("git", ["-C", primary, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Queue Test"); git("config", "user.email", "queue@example.test");
  writeFileSync(join(primary, "file"), "queue fixture\n"); git("add", "file"); git("commit", "-qm", "queue fixture");
  execFileSync("git", ["clone", "--bare", primary, join(root, "origin.git")], { stdio: "pipe" });
  git("remote", "add", "origin", join(root, "origin.git")); git("fetch", "origin");
  writeFileSync(join(bin, "dagu-feature-bundle"), `#!/bin/bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`);
  chmodSync(join(bin, "dagu-feature-bundle"), 0o755);
  const calls = join(root, "github-calls");
  writeFileSync(join(bin, "gh"), `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\ncase "$*" in\n  'repo view --json nameWithOwner,defaultBranchRef') printf '%s\\n' '{"nameWithOwner":"owner/queue","defaultBranchRef":{"name":"main"}}' ;;\n  'repo view --json nameWithOwner --jq .nameWithOwner') echo owner/queue ;;\n  *) exit 99 ;;\nesac\n`);
  chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\nscheduler:\n  port: 0\nqueues:\n  enabled: true\n  config:\n    - name: a4s\n      max_concurrency: 4\n    - name: a4s-v1\n      max_concurrency: 4\n`);
  const bootstrap = parse(readFileSync(join(skill, "dagu-feature-bootstrap.yaml"), "utf8"));
  const render = bootstrap.steps.find((step: { id: string }) => step.id === "render").run;
  const rendered = spawnSync("bash", ["-c", render], { encoding: "utf8", env: { ...env, DAG_RUN_ID: "bootstrap-queue", SKILL_DIR: skill, STAGE: join(stage, "feature.yaml"), REPO: "a4s", BASE_BRANCH: "main", GATE: "true", REQUIRED_CHECK: "validate", TEST_PATHS: "test", REBASE_RESOLVER: "", BUNDLE_NAME: "@a4s/omp-dagu", BUNDLE_VERSION: "0.3.120", DAGU_VERSION: liveDaguVersion, SOURCE_NWO: "owner/queue", SOURCE_SHA: "a".repeat(40) } });
  assert.equal(rendered.status, 0, rendered.stdout + rendered.stderr);
  for (const lifecycle of Object.keys(ordinary)) {
    const definition = parse(readFileSync(join(stage, `${lifecycle}.yaml`), "utf8"));
    // Keep the distributed gate, ordinary first operation and real failure/exit handlers.
    // A native hold bounds acceptance before subsequent lifecycle work is authorized.
    definition.steps = [definition.steps.find((step: { id: string }) => step.id === "queue_gate"), definition.steps.find((step: { id: string }) => step.id === ordinary[lifecycle]), { id: "hold", depends: ordinary[lifecycle], action: "human.task", with: { prompt: "queue acceptance hold" } }];
    definition.env = [{ PRIMARY: primary }, { PATH: env.PATH }, { DAGU_HOME: home }, { RUN: "${context.run.id}" }, { DAGU_FEATURE_BUNDLE: "queue-fixture" }];
    writeFileSync(join(home, "dags", `${lifecycle}.yaml`), stringify(definition));
  }
  let logs = "";
  const service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
  service.stdout.on("data", value => { logs += value; }); service.stderr.on("data", value => { logs += value; });
  const api = `http://127.0.0.1:${port}/api/v1`;
  const dagu = (...args: string[]) => {
    const result = spawnSync("dagu", args, { env, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  async function until<T>(description: string, probe: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const value = await probe();
      if (value !== undefined) return value;
      await delay(50);
    }
    throw new Error(`isolated Dagu observation timed out: ${description}\n${logs}`);
  }
  interface NativeRun { statusLabel: string; nodes: { step: { id: string }; statusLabel: string }[]; log: string; onExit?: { statusLabel: string }; onFailure?: { statusLabel: string } }
  async function settled(dag: string, run: string): Promise<NativeRun> {
    return until(`${dag}/${run}`, async () => {
      const response = await fetch(`${api}/dag-runs/${dag}/${run}`);
      if (!response.ok) return undefined;
      const details = (await response.json() as { dagRunDetails: NativeRun }).dagRunDetails;
      return ["waiting", "failed", "succeeded", "aborted"].includes(details.statusLabel) ? details : undefined;
    });
  }
  function parameters(dag: string): string[] {
    if (dag === "feature" || dag === "poc") return ["ISSUE=335"];
    if (dag === "discovery") return [`PRIMARY=${primary}`, "LENSES=0"];
    return [`PRIMARY=${primary}`, `UNITS_FROM=${join(root, "units")}`, "OMP_SESSION_ID=queue-owner"];
  }
  try {
    await until("health", async () => { try { return (await fetch(`${api}/health`)).ok ? true : undefined; } catch { return undefined; } });
    for (const lifecycle of Object.keys(ordinary)) {
      const path = join(home, "dags", `${lifecycle}.yaml`);
      const original = readFileSync(path, "utf8");
      for (const [mode, queue] of [["enqueue", "a4s"], ["cross-lane", "a4s-v1"], ["undeclared", "other-repository"], ["unavailable", "a4s"], ["ambiguous", "a4s"], ["direct", "a4s"], ["rest", "a4s"]]) {
        const definition = parse(original);
        const gate = definition.steps.find((step: { id: string }) => step.id === "queue_gate");
        if (mode === "unavailable") gate.run = `DAG_RUN_LOG_FILE= ${gate.run}`;
        if (mode === "ambiguous") gate.run = `python3 - <<'PY'\nimport os, pathlib, re\ne = os.environ\nrun = pathlib.Path(e['DAG_RUN_LOG_FILE']).parent.name\nm = re.fullmatch(r'dag-run_(\\d{4})(\\d{2})(\\d{2})_\\d{6}Z_(.+)', run)\na = pathlib.Path(e['DAG_RUN_STEP_STDOUT_FILE']).parent.name.rsplit('_', 1)[1]\np = pathlib.Path(e['DAGU_HOME']) / 'data/dag-runs' / e['DAG_NAME'] / 'dag-runs' / m[1] / m[2] / m[3] / run\n(p / ('a_ambiguous_' + a)).mkdir()\nPY\n${gate.run}`;
        writeFileSync(path, stringify(definition));
        const run = `${lifecycle}-${mode}`;
        const beforeCalls = existsSync(calls) ? readFileSync(calls, "utf8") : "";
        const beforeWorktrees = git("worktree", "list", "--porcelain");
        const beforeResources = existsSync(join(primary, ".git/dagu-feature/resources"));
        if (mode === "rest") {
          const response = await fetch(`${api}/dags/${lifecycle}/enqueue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dagRunId: run, params: parameters(lifecycle).join(" "), queue: "a4s-v1" }) });
          assert.equal(response.status, 200, await response.text());
        } else {
          dagu(mode === "direct" ? "start" : "enqueue", "--run-id", run, ...(mode === "cross-lane" || mode === "undeclared" ? ["--queue", queue!] : []), lifecycle!, "--", ...parameters(lifecycle!));
        }
        const details = await settled(lifecycle!, run);
        const rejected = ["cross-lane", "undeclared", "unavailable", "ambiguous"].includes(mode!);
        assert.equal(details.nodes.find(node => node.step.id === "queue_gate")?.statusLabel, rejected ? "failed" : "succeeded", JSON.stringify(details));
        assert.equal(details.nodes.find(node => node.step.id === ordinary[lifecycle!])?.statusLabel, rejected ? "aborted" : "succeeded", JSON.stringify(details));
        assert.equal(details.nodes.find(node => node.step.id === "hold")?.statusLabel, rejected ? "aborted" : "waiting", JSON.stringify(details));
        const runFiles = (readdirSync(join(home, "logs", lifecycle!), { recursive: true }) as string[]).filter(path => path.includes(`Z_${run}/`) && basename(path).startsWith("queue_gate.") && path.endsWith(".out"));
        assert.equal(runFiles.length, 1, JSON.stringify(runFiles));
        const out = readFileSync(join(home, "logs", lifecycle!, runFiles[0]!), "utf8");
        const log = out + readFileSync(join(home, "logs", lifecycle!, runFiles[0]!.replace(/\.out$/, ".err")), "utf8");
        const attempts = (readdirSync(join(home, "data/dag-runs", lifecycle!), { recursive: true }) as string[]).filter(path => path.includes(`Z_${run}/`) && path.endsWith("/dag.json"));
        assert.equal(attempts.length, 1);
        assert.equal(JSON.parse(readFileSync(join(home, "data/dag-runs", lifecycle!, attempts[0]!), "utf8")).queue, queue);
        assert.match(log, rejected ? /QUEUE_REJECTED/ : /QUEUE_ACCEPTED/);
        assert.ok(log.includes(`queue=${mode === "unavailable" || mode === "ambiguous" ? "unknown" : queue} expected=a4s`), log);
        if (mode === "unavailable") assert.match(log, /missing DAG_RUN_LOG_FILE/);
        if (mode === "ambiguous") assert.match(log, /observed=2/);
        if (rejected) {
          assert.equal(existsSync(calls) ? readFileSync(calls, "utf8") : "", beforeCalls);
          assert.equal(git("worktree", "list", "--porcelain"), beforeWorktrees);
          assert.equal(existsSync(join(primary, ".git/dagu-feature/resources")), beforeResources);
          for (const [event, field] of [["exit", "onExit"], ["failure", "onFailure"]] as const) {
            if (definition.handler_on?.[event]) assert.equal(details[field]?.statusLabel, "skipped", JSON.stringify(details));
          }
        }
        // Every rejected bypass preserves all previously accepted native waits.
        if (mode !== "enqueue") {
          const preserved = await settled(lifecycle!, `${lifecycle}-enqueue`);
          assert.equal(preserved.statusLabel, "waiting");
        }
        t.diagnostic(`${lifecycle}/${run}: actual=${queue} gate=${rejected ? "rejected" : "accepted"} ordinary=${rejected ? "aborted" : "succeeded"} hold=${rejected ? "aborted" : "waiting"}`);
      }
    }
  } finally {
    service.kill("SIGTERM");
    if (service.exitCode === null) await once(service, "exit");
    execFileSync("chmod", ["-R", "u+w", root]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("native same-lane parent enqueues admitted children on their single declared queue", { ...liveDagu, timeout: 90_000 }, async t => {
  const f = admissionFixture();
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "dagu-feature-bundle"), `#!/bin/bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(f.cli)} "$@"\n`, { mode: 0o755 });
  // Commit bounded source templates only inside the disposable admission checkout.
  // This retains provenance validation and each real queue gate without dispatching role jobs.
  for (const lifecycle of Object.keys(ordinary)) {
    const path = join(f.packageDir, "skills/dagu-feature", `${lifecycle}.yaml`);
    const source = readFileSync(path, "utf8");
    const gate = source.slice(source.indexOf("  - id: queue_gate\n"), source.indexOf("\n\n", source.indexOf("  - id: queue_gate\n")));
    writeFileSync(path, source.slice(0, source.indexOf("steps:\n")) + `steps:\n${gate}\n  - id: hold\n    depends: queue_gate\n    action: human.task\n    with:\n      prompt: Same-lane promotion acceptance hold.\n`);
  }
  execFileSync("git", ["-C", f.packageDir, "add", "skills"]);
  execFileSync("git", ["-C", f.packageDir, "commit", "-qm", "bounded native queue acceptance"]);
  for (const lifecycle of Object.keys(ordinary)) f.render(`${lifecycle}.yaml`, join(f.home, "dags", `${lifecycle}.yaml`));
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  socket.close(); await once(socket, "close");
  writeFileSync(join(f.home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\nqueues:\n  enabled: true\n  config:\n    - name: fixture\n      max_concurrency: 4\n`);
  const env = { ...process.env, DAGU_HOME: f.home, DAGU_PORT: String(port), DAGU_COORDINATOR_ENABLED: "false", PATH: `${bin}:${process.env.PATH}` };
  const commands = Object.keys(ordinary).map(lifecycle => {
    const params = lifecycle === "feature" || lifecycle === "poc" ? ["ISSUE=335"]
      : [`PRIMARY=${f.packageDir}`, ...(lifecycle === "discovery" ? ["LENSES=0"] : [`UNITS_FROM=${join(f.root, "units")}`, "OMP_SESSION_ID=queue-owner"])];
    return `dagu-feature-bundle enqueue --run-id promoted-${lifecycle} ${JSON.stringify(join(f.home, "dags", `${lifecycle}.yaml`))} -- ${params.map(value => JSON.stringify(value)).join(" ")}`;
  });
  writeFileSync(join(f.home, "dags", "parent.yaml"), stringify({ queue: "fixture", shell: "bash", steps: [{ id: "promote", run: "set -euo pipefail\n" + commands.join("\n") }] }));
  let logs = "";
  const service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(port)], { env, cwd: f.packageDir, stdio: ["ignore", "pipe", "pipe"] });
  service.stdout.on("data", value => { logs += value; }); service.stderr.on("data", value => { logs += value; });
  const api = `http://127.0.0.1:${port}/api/v1`;
  async function until<T>(description: string, probe: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const result = await probe();
      if (result !== undefined) return result;
      await delay(50);
    }
    throw new Error(`same-lane promotion timeout: ${description}\n${logs}`);
  }
  try {
    await until("health", async () => { try { return (await fetch(`${api}/health`)).ok ? true : undefined; } catch { return undefined; } });
    const queued = spawnSync("dagu", ["enqueue", "--run-id", "same-lane-parent", "parent"], { env, cwd: f.packageDir, encoding: "utf8" });
    assert.equal(queued.status, 0, queued.stdout + queued.stderr);
    for (const lifecycle of Object.keys(ordinary)) {
      const details = await until(lifecycle, async () => {
        const response = await fetch(`${api}/dag-runs/${lifecycle}/promoted-${lifecycle}`);
        if (!response.ok) return undefined;
        const details = (await response.json() as { dagRunDetails: { statusLabel: string; nodes: { step: { id: string }; statusLabel: string; stdout?: string; stderr?: string }[] } }).dagRunDetails;
        assert.notEqual(details.statusLabel, "failed", JSON.stringify(details));
        return details.statusLabel === "waiting" ? details : undefined;
      });
      const gate = details.nodes.find(node => node.step.id === "queue_gate")!;
      assert.equal(gate.statusLabel, "succeeded");
      assert.match(readFileSync(gate.stdout!, "utf8"), /QUEUE_ACCEPTED.*queue=fixture expected=fixture/);
      const receipt = JSON.parse(readFileSync(f.receipt(`promoted-${lifecycle}`), "utf8"));
      assert.equal(receipt.initial.execution.dagSnapshot.match(/^queue:.*$/m)[0], 'queue: "fixture"');
      t.diagnostic(`parent -> ${lifecycle}: admission receipt sealed; executing queue=fixture; gate=succeeded; hold=waiting`);
    }
  } finally {
    service.kill("SIGTERM");
    if (service.exitCode === null) await once(service, "exit");
    execFileSync("chmod", ["-R", "u+w", f.root]);
    f.dispose();
  }
});
