import { renderedFeature, renderedPoc } from "../fixtures/rendered-feature.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Transitions } from "../../src/status/progress.ts";
import type { RunDetails } from "../../src/status/progress.ts";

import { liveDagu, liveDaguVersion } from "../fixtures/live-dagu.ts";
import { testRunId } from "../fixtures/run-id.ts";
const feature = readFileSync(new URL(renderedFeature, import.meta.url), "utf8");
const poc = readFileSync(new URL(renderedPoc, import.meta.url), "utf8");
function step(source: string, id: string): string {
  const start = source.indexOf(`  - id: ${id}\n`);
  assert.ok(start >= 0, id);
  const end = source.indexOf("\n  - id:", start + 1);
  const block = source.slice(start, end < 0 ? source.length : end).split("\nhandler_on:")[0]! + "\n";
  if (!block.includes("    run: *cancellation_gate")) return block;
  const cancellation = source.match(/^    run: &cancellation_gate \|\n(?:^      .*\n|^\n)*/m);
  assert.ok(cancellation, "materialized cancellation gate");
  return block.replace("    run: *cancellation_gate\n", cancellation[0].replace("&cancellation_gate ", ""));
}
async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

test("Dagu isolated primary checkpoints release the queue and rewind the same run through real gates", {
  ...liveDagu,
  timeout: 360_000,
}, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-dagu-primary-")));
  const home = join(root, "dagu-home");
  const bin = join(root, "bin");
  mkdirSync(join(home, "dags"), { recursive: true });
  mkdirSync(bin);
  const servicePort = await port();
  const env = { ...process.env, DAGU_PARAMS_JSON: "{}", DAGU_HOME: home, DAGU_COORDINATOR_ENABLED: "false", DAGU_HOST: "127.0.0.1", DAGU_PORT: String(servicePort), PATH: `${bin}:${process.env.PATH}` };
  const command = (executable: string, args: string[], cwd = root) => execFileSync(executable, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const dagu = (...args: string[]) => command("dagu", args);
  const git = (cwd: string, ...args: string[]) => command("git", ["-C", cwd, ...args]);
  writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${servicePort}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\nqueues:\n  enabled: true\n  config:\n    - name: primary228\n      max_active_runs: 1\n`);
  let serviceLog = "";
  const service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(servicePort)], { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  service.stdout.on("data", data => { serviceLog += data; });
  service.stderr.on("data", data => { serviceLog += data; });
  const api = `http://127.0.0.1:${servicePort}/api/v1`;
  async function until<T>(description: string, probe: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const value = await probe();
      if (value !== undefined) return value;
      await delay(150);
    }
    throw new Error(`Timed out: ${description}\n${serviceLog}`);
  }
  type Detail = Omit<RunDetails, "nodes"> & { nodes: Array<{ statusLabel: string; stderr?: string; step: { name: string; humanTask?: { prompt?: string } } }> };
  async function detail(name: string, id: string): Promise<Detail | undefined> {
    try {
      const response = await fetch(`${api}/dag-runs/${name}/${id}`);
      if (!response.ok) return undefined;
      return (await response.json() as { dagRunDetails: Detail }).dagRunDetails;
    } catch { return undefined; }
  }
  async function state(name: string, id: string, status: string): Promise<Detail> {
    return until(`${name}/${id} ${status}`, async () => {
      const run = await detail(name, id);
      if (run?.statusLabel === "failed" || run?.statusLabel === "aborted") {
        const logs = run.nodes.filter(node => node.statusLabel === "failed")
          .map(node => `${node.step.name}: ${node.stderr ? readFileSync(node.stderr, "utf8") : "no stderr"}`).join("\n");
        throw new Error(`${name}/${id} ${run.statusLabel}\n${logs}\n${JSON.stringify(run)}`);
      }
      return run?.statusLabel === status ? run : undefined;
    });
  }
  try {
    await until("isolated server ready", async () => {
      try { return (await fetch(`${api}/dag-runs`)).ok ? true : undefined; } catch { return undefined; }
    });
    console.log(`LIVE dagu=${liveDaguVersion} DAGU_HOME=${home} port=${servicePort}`);
    const sentinel = join(home, "dags", "sentinel.yaml");
    writeFileSync(sentinel, "queue: primary228\ntype: graph\nsteps:\n  - id: sentinel\n    run: echo queue-slot-released\n");
    for (const [phase, blocked] of [
      ["start", "dirty"], ["start", "branch"], ["start", "clean"],
      ["close", "dirty"], ["close", "branch"], ["close", "clean"],
      ["base", "dirty"], ["base", "branch"], ["base", "clean"],
    ] as const) {
      const caseRoot = join(root, `${phase}-${blocked}`);
      const primary = join(caseRoot, "primary");
      const remote = join(caseRoot, "remote.git");
      mkdirSync(caseRoot);
      command("git", ["init", "--bare", "-b", "main", remote]);
      command("git", ["init", "-b", "main", primary]);
      git(primary, "config", "user.name", "Primary availability test");
      git(primary, "config", "user.email", "primary@example.invalid");
      git(primary, "remote", "add", "origin", remote);
      writeFileSync(join(primary, ".gitignore"), "/.workspace/\n");
      writeFileSync(join(primary, "tracked.txt"), "seed\n");
      git(primary, "add", ".");
      git(primary, "commit", "-m", "seed");
      git(primary, "push", "origin", "main");
      const id = testRunId(`${phase}-${blocked}`);
      const worktree = join(primary, ".workspace", "worktrees", phase === "base" ? `poc-${id}` : "issue-228");
      const branch = phase === "base" ? `poc/${id}` : "dagu/issue-228";
      const sha = git(primary, "rev-parse", "HEAD");
      if (phase === "close") git(primary, "worktree", "add", "-b", branch, worktree, "origin/main");
      const gh = join(bin, "gh");
      writeFileSync(gh, `#!/bin/sh
case "$*" in
  *"--json number,state,headRefOid,mergeCommit"*) printf '%s\\n' '${JSON.stringify({ number: 228, state: "MERGED", headRefOid: sha, mergeCommit: { oid: sha } })}' ;;
  *"--required"*) echo SUCCESS ;;
  "repo view ${remote} --json nameWithOwner --jq .nameWithOwner") echo example/repo ;;
  "api repos/example/repo/pulls/228") echo '{"changed_files":1}' ;;
  "api --paginate --slurp repos/example/repo/pulls/228/files?per_page=100") echo '[[{"filename":"tracked.txt"}]]' ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`);
      chmodSync(gh, 0o755);
      if (blocked === "dirty") writeFileSync(join(primary, "tracked.txt"), "operator changes\n");
      else if (blocked === "branch") git(primary, "switch", "-c", "operator");
      const name = phase === "base" ? "poc" : "feature";
      if (phase === "close") {
        const state = git(primary, "rev-parse", "--path-format=absolute", "--git-path", `dagu-feature/runs/${id}`);
        const resource = JSON.stringify({ run: id, primary, branch, worktree });
        mkdirSync(state, { recursive: true });
        writeFileSync(join(state, "resource.json"), resource);
        writeFileSync(join(state, "tested-sha"), sha + "\n");
        const hash = execFileSync("git", ["hash-object", "--stdin"], { input: branch, encoding: "utf8" }).trim();
        const resources = git(primary, "rev-parse", "--path-format=absolute", "--git-path", "dagu-feature/resources");
        mkdirSync(resources, { recursive: true });
        writeFileSync(join(resources, `${hash}.json`), resource);
      }
      const checkpoint = `${phase}_primary_unavailable`;
      const detector = `detect_${phase}_primary`;
      const gate = phase === "base" ? "base" : `${phase}_gate`;
      const source = phase === "base" ? poc : feature;
      const predecessor = phase === "start" ? `  - id: triage\n    run: |\n      echo 'POC=no' >> "$DAGU_OUTPUT_FILE"\n    outputs:\n      - name: POC\n  - id: triage_decision\n    depends: triage\n    run: echo triage-stub\n` : `  - id: ${phase === "base" ? "record" : "await_merge"}\n    run: |\n      mkdir -p "$(git -C "$PRIMARY" rev-parse --path-format=absolute --git-path poc/runs/$RUN)"\n`;
      const closeAuthorization = phase === "close" ? "  - id: await_merge_cancellation\n    depends: await_merge\n    run: echo retained-merge-checkpoint\n  - id: authorize_ci\n    depends: await_merge_cancellation\n    run: echo authorized-candidate\n" : "";
      const definition = join(home, "dags", `${name}.yaml`);
      const guard = source.slice(source.indexOf("  - DAGU_RESOURCE_GUARD: |"), source.indexOf("steps:\n"));
      writeFileSync(definition, `labels: [workspace=primary228, dagu-feature-bundle=0.2.0]\nqueue: primary228\ntype: graph\nshell: bash\nparams:\n  - BASE_BRANCH: main\n  - ISSUE: "228"\n  - PR_NUMBER: ""\n  - OMP_SESSION_ID: primary228-owner\nenv:\n  - PRIMARY: ${JSON.stringify(primary)}\n  - BRANCH: ${branch}\n  - GATE: "true"\n  - REQUIRED_CHECK: validate\n  - WORKTREE: ${worktree}\n  - RUN: \${context.run.id}\n  - DAGU_FEATURE_BUNDLE: test\n${guard}steps:\n${predecessor}${closeAuthorization}${step(source, detector)}${step(source, checkpoint)}${step(source, `${checkpoint}_cancellation`)}${step(source, gate)}${phase === "base" ? step(source, "worktree") : ""}  - id: after_gate\n    depends: ${phase === "base" ? "worktree" : gate}\n    run: echo SAME_RUN=\${context.run.id}\n`);
      console.log(`$ DAGU_HOME=${home} dagu validate ${definition}\n${dagu("validate", definition)}`);
      console.log(`$ DAGU_HOME=${home} dagu enqueue --run-id ${id} ${definition}\n${dagu("enqueue", "--run-id", id, definition)}`);
      if (blocked === "clean") {
        const clean = await state(name, id, "succeeded");
        assert.equal(clean.nodes.find(node => node.step.name === checkpoint)?.statusLabel, "skipped");
        assert.equal(clean.nodes.find(node => node.step.name === gate)?.statusLabel, "succeeded");
        assert.equal(existsSync(worktree), phase !== "close");
        console.log(`${name}/${id}: succeeded directly; checkpoint skipped; ${gate} succeeded`);
        continue;
      }
      const waiting = await state(name, id, "waiting");
      const node = waiting.nodes.find(node => node.step.name === checkpoint)!;
      const reason = blocked === "dirty" ? "primary dirty:  M tracked.txt" : "primary on operator, expected main";
      assert.ok(node.step.humanTask?.prompt?.includes(reason), JSON.stringify(node));
      const detectNode = waiting.nodes.find(node => node.step.name === detector)!;
      assert.ok(detectNode.stderr);
      assert.ok(readFileSync(detectNode.stderr!, "utf8").includes(reason));
      const wake = new Transitions("primary228-owner").observe(waiting).wakeMessage!;
      assert.ok(wake.includes(reason), wake);
      console.log(`Waiting ${name}/${id} ${checkpoint}; ${wake}`);
      dagu("enqueue", "--run-id", `sentinel-${id}`, sentinel);
      await state("sentinel", `sentinel-${id}`, "succeeded");
      assert.equal((await detail(name, id))?.statusLabel, "waiting");
      console.log(`sentinel-${id}: succeeded while ${id} Waiting`);
      let iteration = 0;
      if (blocked === "branch") {
        dagu("human-task", "push-back", name, "--run-id", id, "--step", checkpoint, "--expected-iteration", "0");
        await until("premature push-back rechecks", async () => {
          const status = dagu("status", "--run-id", id, name);
          return /push-back iteration: 1/.test(status) && /Waiting/.test(status) ? true : undefined;
        });
        iteration = 1;
        git(primary, "switch", "main");
      } else git(primary, "restore", "tracked.txt");
      assert.equal((await detail(name, id))?.statusLabel, "waiting", "cleaning alone preserves Waiting");
      const resume = ["human-task", "push-back", name, "--run-id", id, "--step", checkpoint, "--expected-iteration", String(iteration)];
      console.log(`$ DAGU_HOME=${home} dagu ${resume.join(" ")}\n${dagu(...resume)}`);
      const done = await state(name, id, "succeeded");
      assert.equal(done.dagRunId, id);
      assert.equal(done.nodes.find(node => node.step.name === checkpoint)?.statusLabel, "skipped");
      assert.equal(done.nodes.find(node => node.step.name === gate)?.statusLabel, "succeeded");
      if (phase === "close") assert.equal(existsSync(worktree), false);
      else assert.equal(existsSync(worktree), true);
      console.log(`${name}/${id}: succeeded; checkpoint skipped; ${gate} succeeded; worktree ${phase === "close" ? "removed" : "created"}`);
    }
  } finally {
    service.kill("SIGTERM");
    await new Promise<void>(resolve => { if (service.exitCode !== null) resolve(); else service.once("exit", () => resolve()); });
    rmSync(root, { recursive: true, force: true });
  }
});
