import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parse } from "yaml";
import { liveDagu, liveDaguVersion } from "./fixtures/live-dagu.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const template = parse(readFileSync(join(packageRoot, "skills/issue-execution/feature.yaml"), "utf8"));
const gateScript: string = template.steps.find((step: { id: string }) => step.id === "gate").run;
const npmCli = realpathSync(execFileSync("which", ["npm"], { encoding: "utf8" }).trim());

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function until(description: string, probe: () => boolean) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (probe()) return;
    await delay(25);
  }
  throw new Error(`Timed out: ${description}`);
}

type Running = { child: ChildProcess; done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; log: () => string };
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a4s-heavy-slot-")));
  const home = join(root, "home");
  const primary = join(root, "primary");
  const clone = join(root, "clone");
  const bin = join(root, "bin");
  mkdirSync(primary);
  mkdirSync(bin);
  git(primary, "init", "-b", "main");
  git(primary, "config", "user.name", "Slot Test");
  git(primary, "config", "user.email", "slot@example.test");
  writeFileSync(join(primary, "base.txt"), "base\n");
  git(primary, "add", ".");
  git(primary, "-c", "commit.gpgsign=false", "commit", "-m", "base");
  git(root, "clone", "--no-local", primary, clone);
  assert.notEqual(git(primary, "rev-parse", "--git-common-dir"), git(clone, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  for (const repo of [primary, clone]) {
    const state = join(repo, ".git/dagu-feature/runs", repo === primary ? "holder" : "waiter");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "candidate.json"), JSON.stringify({ sha: git(repo, "rev-parse", "HEAD") }));
  }
  for (const name of ["dagu-gate.cjs", "dagu-feature-protect.ts"]) {
    symlinkSync(join(packageRoot, "bin", name), join(bin, name.replace(/\.(?:cjs|ts)$/, "")));
  }
  const body = join(root, "body.py");
  writeFileSync(body, `import json, os, pathlib, sys, time
root = pathlib.Path(${JSON.stringify(root)})
run = os.environ['RUN']
def event(kind):
    with open(root / 'events', 'a') as out:
        out.write(json.dumps({'run': run, 'kind': kind, 'at': time.time_ns(), 'held': os.environ.get('A4S_HEAVY_SLOT_HELD')}) + '\\n')
event('start')
release = root / ('release-' + run)
while not release.exists(): time.sleep(.02)
event('end')
sys.exit(int(release.read_text()))
`);
  const processes: Running[] = [];
  const env = (run: string): NodeJS.ProcessEnv => {
    const result: NodeJS.ProcessEnv = { ...process.env, DAGU_HOME: home, PATH: `${bin}:${process.env.PATH}`, RUN: run };
    delete result.A4S_HEAVY_SLOT_HELD;
    delete result.A4S_GATE_JOURNAL;
    delete result.NODE_OPTIONS;
    return result;
  };
  const start = (command: string, args: string[], cwd: string, extra: NodeJS.ProcessEnv = {}): Running => {
    let log = "";
    const child = spawn(command, args, { cwd, env: { ...env("script"), ...extra }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.on("data", data => { log += data; });
    child.stderr!.on("data", data => { log += data; });
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const running = { child, done, log: () => log };
    processes.push(running);
    return running;
  };
  const gate = (repo: string, run: string, command = `exec python3 ${JSON.stringify(body)}`) => start("bash", ["-c", gateScript], repo, {
    ...env(run), PRIMARY: repo, WORKTREE: repo, BRANCH: "main", GATE: command, ISSUE: "606",
  });
  const events = (): Array<{ run: string; kind: string; at: number; held: string }> => existsSync(join(root, "events"))
    ? readFileSync(join(root, "events"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const release = (run: string, code = 0) => writeFileSync(join(root, `release-${run}`), String(code));
  const scripts = join(root, "scripts");
  mkdirSync(scripts);
  for (const relative of ["package.json", "packages/issue-lifecycle/package.json", "packages/issue-lifecycle/bin/heavy-slot.py"]) {
    mkdirSync(dirname(join(scripts, relative)), { recursive: true });
    copyFileSync(join(sourceRoot, relative), join(scripts, relative));
  }
  // Exercise actual production npm entry scripts with bounded test bodies, not full suites.
  // Nested npm dispatch and tsx are replaced only after the real wrapper has acquired.
  for (const name of ["npm", "tsx"]) writeFileSync(join(bin, name), `#!/bin/sh\nexec python3 ${JSON.stringify(body)}\n`, { mode: 0o755 });
  return { root, home, primary, clone, bin, body, scripts, env, start, gate, events, release,
    async close() {
      for (const running of processes) {
        if (running.child.pid) {
          try { process.kill(-running.child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        }
        await running.done;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const outcome of ["success", "failure", "cancellation", "SIGKILL", "surviving descendant"] as const) {
  test(`cross-clone gates release the station slot after ${outcome}`, { timeout: 30_000 }, async () => {
    const f = fixture();
    try {
      const holder = f.gate(f.primary, "holder");
      await until("holder starts", () => f.events().some(row => row.run === "holder"));
      const waiter = f.gate(f.clone, "waiter");
      await until("waiter names holder", () => waiter.log().includes("gate: waiting") && waiter.log().includes('"run": "holder"'));
      assert.equal(f.events().some(row => row.run === "waiter"), false);
      const killedAt = Date.now() * 1_000_000;
      if (outcome === "cancellation" || outcome === "SIGKILL") process.kill(-holder.child.pid!, outcome === "cancellation" ? "SIGTERM" : "SIGKILL");
      else if (outcome === "surviving descendant") {
        holder.child.kill("SIGKILL");
        await holder.done;
        await delay(200);
        assert.equal(f.events().some(row => row.run === "waiter"), false);
        f.release("holder");
      } else f.release("holder", outcome === "failure" ? 17 : 0);
      const result = await holder.done;
      if (outcome === "success" || outcome === "failure") assert.equal(result.code, outcome === "failure" ? 17 : 0, holder.log());
      else assert.equal(result.signal, outcome === "cancellation" ? "SIGTERM" : "SIGKILL");
      await until("waiter enters", () => f.events().some(row => row.run === "waiter"));
      const rows = f.events();
      assert.ok(rows.find(row => row.run === "waiter")!.at >= (rows.find(row => row.run === "holder" && row.kind === "end")?.at ?? killedAt));
      assert.ok(rows.every(row => row.held === "1"));
      f.release("waiter");
      assert.equal((await waiter.done).code, 0, waiter.log());
    } finally { await f.close(); }
  });
}

for (const workspace of [false, true]) {
  test(`${workspace ? "issue-lifecycle" : "root"} npm test acquires the gate slot in both directions`, { timeout: 30_000 }, async () => {
    const f = fixture();
    try {
      const holder = f.gate(f.primary, "holder");
      await until("gate starts", () => f.events().length > 0);
      const script = f.start(process.execPath, [npmCli, "test"], workspace ? join(f.scripts, "packages/issue-lifecycle") : f.scripts);
      await until("npm waits on gate", () => script.log().includes("gate: waiting") && script.log().includes('"run": "holder"'));
      assert.equal(f.events().some(row => row.run === "script"), false);
      f.release("holder");
      assert.equal((await holder.done).code, 0, holder.log());
      await until("script enters", () => f.events().some(row => row.run === "script"));
      const waiter = f.gate(f.clone, "waiter");
      await until("gate waits on npm", () => waiter.log().includes("gate: waiting") && waiter.log().includes('"role": "npm-test"'));
      f.release("script");
      assert.equal((await script.done).code, 0, script.log());
      await until("gate enters after npm", () => f.events().some(row => row.run === "waiter"));
      f.release("waiter");
      assert.equal((await waiter.done).code, 0, waiter.log());
    } finally { await f.close(); }
  });

  test(`gate internal ${workspace ? "issue-lifecycle" : "root"} npm test re-enters without deadlock`, { timeout: 30_000 }, async () => {
    const f = fixture();
    try {
      f.release("holder");
      const cwd = workspace ? join(f.scripts, "packages/issue-lifecycle") : f.scripts;
      // Use a subshell so gate post-checks still inspect the candidate repository.
      const holder = f.gate(f.primary, "holder", `(cd ${JSON.stringify(cwd)} && ${JSON.stringify(process.execPath)} ${JSON.stringify(npmCli)} test)`);
      assert.equal((await holder.done).code, 0, holder.log());
      assert.match(holder.log(), /slot: reenter/);
      assert.doesNotMatch(holder.log(), /gate: waiting/);
      assert.ok(f.events().every(row => row.held === "1"));
    } finally { await f.close(); }
  });
}

test("targeted commands do not acquire the station slot", { timeout: 30_000 }, async () => {
  const f = fixture();
  try {
    f.gate(f.primary, "holder");
    await until("holder starts", () => f.events().length > 0);
    f.release("script");
    const targeted = f.start("tsx", ["--test", "test/one.test.ts"], f.scripts);
    assert.equal((await targeted.done).code, 0, targeted.log());
    assert.doesNotMatch(targeted.log(), /gate: waiting|gate: acquired/);
  } finally { await f.close(); }
});

test("real Dagu preserves eight-slot and foreign queue capacity while cross-clone gates wait", { ...liveDagu, timeout: 60_000 }, async t => {
  const f = fixture();
  try {
    assert.equal(liveDaguVersion, "2.20.1");
    mkdirSync(f.home, { recursive: true });
    const config = "queues:\n  enabled: true\n  config:\n    - name: a4s\n      max_concurrency: 8\n    - name: foreign\n      max_concurrency: 3\n";
    writeFileSync(join(f.home, "config.yaml"), config);
    const dag = join(f.root, "gates.yaml");
    const vars = { PATH: f.env("holder").PATH, DAGU_HOME: f.home, PRIMARY: "${REPO}", WORKTREE: "${REPO}", BRANCH: "main", RUN: "${ID}", GATE: `exec python3 ${JSON.stringify(f.body)}`, ISSUE: "606" };
    writeFileSync(dag, `queue: a4s\nshell: bash\nparams:\n  - REPO: ''\n  - ID: ''\nenv:\n${Object.entries(vars).map(([key, value]) => `  - ${key}: ${JSON.stringify(value)}\n`).join("")}steps:\n  - id: gate\n    run: |\n${gateScript.split("\n").map(line => `      ${line}\n`).join("")}    outputs:\n      - name: tested_sha\n`);
    const holder = f.start("dagu", ["start", "--run-id", "holder", dag, "--", `REPO=${f.primary}`, "ID=holder"], f.root);
    await until("native holder starts", () => f.events().some(row => row.run === "holder"));
    const waiter = f.start("dagu", ["start", "--run-id", "waiter", dag, "--", `REPO=${f.clone}`, "ID=waiter"], f.root);
    await until("native waiter diagnostic", () => {
      const logs = join(f.home, "logs");
      if (!existsSync(logs)) return false;
      return readdirSync(logs, { recursive: true }).map(String).some(relative => {
        const file = join(logs, relative);
        const descriptor = openSync(file, "r");
        try {
          if (!fstatSync(descriptor).isFile()) return false;
          const text = readFileSync(descriptor, "utf8");
          return text.includes("gate: waiting") && text.includes('"run": "holder"');
        } finally {
          closeSync(descriptor);
        }
      });
    });
    const controlFile = join(f.root, "control.yaml");
    writeFileSync(controlFile, "queue: a4s\nsteps:\n  - id: control\n    run: echo independent-control\n");
    const control = f.start("dagu", ["start", "--run-id", "control", controlFile], f.root);
    assert.equal((await control.done).code, 0, control.log());
    assert.equal(f.events().some(row => row.run === "waiter"), false);
    f.release("holder");
    assert.equal((await holder.done).code, 0, holder.log());
    await until("native waiter enters", () => f.events().some(row => row.run === "waiter"));
    f.release("waiter");
    assert.equal((await waiter.done).code, 0, waiter.log());
    assert.equal(readFileSync(join(f.home, "config.yaml"), "utf8"), config);
    t.diagnostic(`Dagu ${liveDaguVersion}; independent clone windows=${JSON.stringify(f.events())}; queues a4s=8, foreign=3 unchanged; control progressed`);
  } finally { await f.close(); }
});
