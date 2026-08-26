import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { engineCommand } from "../../src/executable.ts";
import { identity } from "../../src/identity.ts";
import { cachePath } from "../../../launcher/src/artifact-cache.ts";
import type { Receipt } from "../../src/admission.ts";
import { USED_CONTRACTS } from "../../src/artifact-receipt.ts";
import { gitBuildIdentity } from "../../../../scripts/release-identity.mjs";
import { roleRuntimeFixture } from "../fixtures/role-runtime.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const execute = promisify(execFile);
const sourceArgs = ["--import", "tsx", cli];
const helpCommands = ["gate", "pr-body", "codeql", "poc-scope", "protect", "role-jobs", "admit", "enqueue", "queue", "observe", "escalation", "stale-recovery", "prioritize", "reconcile", "planning"];
const support = identity.support;

function source(args: string[], env = process.env) {
  return spawnSync(process.execPath, [...sourceArgs, ...args], { cwd: root, env, encoding: "utf8" });
}

test("the source entry rejects unknown commands with usage and exposes explicit unbuilt identity", () => {
  for (const args of [[], ["not-a-command"]]) {
    const result = source(args);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Usage: a4s/);
  }
  const result = source(["version"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), identity);
  assert.deepEqual(identity.support, support);
  assert.deepEqual(Object.keys(identity).sort(), ["commit", "dispatch", "layout", "protocols", "registrationManifest", "registrationManifestHash", "requiredLauncherProtocol", "requiredLoaderProtocol", "support", "version"]);
});

test("source self-spawn commands select the existing entry and preserve helper arguments", () => {
  const computation = engineCommand("role-jobs", ["computation", "run", "--id", "example"]);
  assert.equal(computation.file, process.execPath);
  assert.deepEqual(computation.args, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../../bin/dagu-role-jobs.ts", import.meta.url)), "computation", "run", "--id", "example"]);
  assert.deepEqual(engineCommand("enqueue", ["--run-id", "one", "feature"]).args.slice(-5),
    [fileURLToPath(new URL("../../bin/dagu-feature-bundle.ts", import.meta.url)), "enqueue", "--run-id", "one", "feature"]);
  assert.deepEqual(engineCommand("queue", ["--lane", "example"]).args.slice(-3), ["readiness", "--lane", "example"]);
});

test("each source dispatch reaches its real command without ambient role-runtime fallback", () => {
  const env = { ...process.env, RUN: "" };
  for (const command of helpCommands) {
    const result = source([command, "--help"], env);
    assert.equal(result.status, command === "codeql" ? 0 : 1, `${command}: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /Unknown subcommand|ERR_MODULE_NOT_FOUND|Cannot find module/);
  }
  const detect = source(["role-jobs", "detect"], { ...env, PATH: "" });
  assert.equal(detect.status, 1, detect.stderr);
  assert.match(detect.stderr, /no executable omp on PATH/);
});

test("release archives and the compiled engine work from an extracted root", {
  timeout: 240000,
}, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "a4s-compiled-"));
  try {
    const releases = process.env.A4S_RELEASE_DIR || join(temporary, "release");
    if (!process.env.A4S_RELEASE_DIR) execFileSync(process.execPath, [join(root, "scripts/build-a4s.mjs"), "--outdir", releases], { cwd: root, stdio: "inherit" });
    const build = gitBuildIdentity(root);
    const archives = ["linux-x64", "darwin-arm64"].map(platform => `a4s-${build.version}-${platform}.tar.gz`);
    const expectedCommit = build.commit;
    for (const archive of archives) {
      const path = join(releases, archive);
      const checksum = readFileSync(`${path}.sha256`, "utf8");
      assert.match(checksum, new RegExp(`^[a-f0-9]{64}  ${archive.replaceAll(".", "\\.")}\\n$`));
      assert.equal(checksum, `${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${archive}\n`);
      const names = execFileSync("tar", ["-tzf", path], { encoding: "utf8" }).trim().split("\n");
      assert.deepEqual(names, [...names].sort());
      assert.deepEqual([...new Set(names.map(name => name.split("/")[0]))].sort(), ["a4s", "agents", "bin", "identity.json", "package.json", "role-runner.ts", "skills", "src"]);
      assert.deepEqual(names.filter(name => name.startsWith("bin/")), ["bin/", "bin/dagu-gate.cjs", "bin/gate-cache-run.cjs", "bin/gate-cache.cjs"]);
      for (const file of ["role-runner.ts", "agents/plan-reviewer.md", "agents/triage-reviewer.md", "src/status/reloadable.ts", "src/status/index.ts", "src/triage/reloadable.ts", "src/triage/native.ts",
        ...["feature", "poc", "discovery", "planning", "reconcile"].map(name => `skills/issue-execution/${name}.yaml`),
        ...["backlog-breakdown", "issue-execution", "refine", "repository-discovery", "sprint-planning", "sprint-retrospective", "sprint-review"].map(name => `skills/${name}/SKILL.md`),
        "skills/repository-discovery/CONTRACT.md", "skills/repository-discovery/METHOD.md"]) assert.ok(names.includes(file), `${archive}: missing ${file}`);
      assert.equal(names.filter(name => name.startsWith("skills/repository-discovery/lenses/") && name.endsWith(".md")).length, 5);
      assert.ok(!names.some(name => name.endsWith(".py") || name.includes("bootstrap")));
      const directory = join(temporary, archive);
      mkdirSync(directory);
      execFileSync("tar", ["-xzf", path, "-C", directory]);
      const artifactIdentity = JSON.parse(readFileSync(join(directory, "identity.json"), "utf8"));
      assert.deepEqual(artifactIdentity, { ...identity, version: build.version, commit: expectedCommit });
      assert.ok(!("digest" in artifactIdentity));
    }
    const repeated = join(temporary, "repeated");
    execFileSync(process.execPath, [join(root, "scripts/build-a4s.mjs"), "--target", "bun-linux-x64", "--outdir", repeated], { cwd: root, stdio: "inherit" });
    assert.equal(readFileSync(join(repeated, `${archives[0]}.sha256`), "utf8"), readFileSync(join(releases, `${archives[0]}.sha256`), "utf8"), "rebuilding the same commit must produce identical archive bytes");
    const extracted = join(temporary, archives[0]!);
    const executable = join(extracted, "a4s");
    const home = join(temporary, "dagu");
    mkdirSync(home);
    const noPython = join(temporary, "no-python");
    const pythonCalled = join(temporary, "python-called");
    mkdirSync(noPython);
    writeFileSync(join(noPython, "python3"), '#!/bin/sh\nprintf invoked > "$A4S_PYTHON_SENTINEL"\nexit 97\n', { mode: 0o755 });
    const env = { ...process.env, DAGU_HOME: home, RUN: "", A4S_HEAVY_SLOT_HELD: "",
      PATH: `${noPython}:${process.env.PATH}`, A4S_PYTHON_SENTINEL: pythonCalled };
    const run = (args: string[], override: NodeJS.ProcessEnv = env) => spawnSync(executable, args, { cwd: extracted, env: override, encoding: "utf8" });
    const version = run(["version"]);
    assert.equal(version.status, 0, version.stderr);
    assert.deepEqual(JSON.parse(version.stdout), { ...identity, version: build.version, commit: expectedCommit });
    for (const command of helpCommands) {
      // Node's source-only flock fallback may use Python; only the released engine is under this sentinel.
      const expected = source([command, "--help"], { ...env, PATH: process.env.PATH });
      const actual = run([command, "--help"]);
      assert.equal(actual.status, expected.status, `${command}: ${actual.stderr}`);
      assert.doesNotMatch(actual.stderr, /Unknown subcommand|Cannot find module|Module not found|python3/);
    }
    const body = join(temporary, "body.md");
    writeFileSync(body, "Closes #712\n\n## Summary\n- Deliver one executable.\n\n## Verification\n- Compiled smoke.\n\n## Risk\nNone\n");
    const checked = run(["pr-body", "validate", body]);
    assert.equal(checked.status, 0, checked.stderr);
    const blocked = run(["role-jobs", "detect"], { ...env, PATH: "" });
    assert.equal(blocked.status, 1, blocked.stderr);
    assert.match(blocked.stderr, /no executable omp on PATH/);
    roleRuntimeFixture(temporary);
    const detected = run(["role-jobs", "detect"], { ...env, PRIMARY: extracted, PATH: `${join(temporary, "bin")}:${noPython}` });
    assert.equal(detected.status, 0, detected.stderr);
    assert.deepEqual(JSON.parse(detected.stdout).agents, [
      { name: "triage-reviewer", source: join(extracted, "agents/triage-reviewer.md") }, { name: "task", source: `fixture:${extracted}` },
    ]);
    const capacity = run(["role-jobs", "capacity", "3"]);
    assert.equal(capacity.status, 0, capacity.stderr);
    assert.ok(existsSync(join(home, "role-jobs.sqlite")));
    const computation = join(temporary, "computation");
    for (const args of [
      ["sample", "--units", "1", "--elapsed-ms", "300", "--projected-units", "1", "--shard-units", "1"],
      ["open", "--id", "computation", "--run", "compiled712", "--session", "owner", "--total-units", "1", "--shard-units", "1", "--stall-multiple", "20"],
      ["run", "--delay-ms", "300", "--background"],
    ]) {
      const result = run(["role-jobs", "computation", ...args, "--dir", computation]);
      assert.equal(result.status, 0, `${args[0]}: ${result.stderr}`);
    }
    // Real timer/OS-process integration: the detached compiled worker must
    // finish a real shard, not execute its embedded source as a script.
    const supervised = await execute(executable, ["role-jobs", "computation", "supervise", "--dir", computation], { cwd: extracted, env });
    assert.equal(JSON.parse(supervised.stdout).state, "completed");
    assert.ok(existsSync(join(computation, "shards/1.json")));
    const exhausted = run(["reconcile", "bounded", "observe", "0", String(Date.now()), "1", process.execPath, "-e", "process.exit(99)"]);
    assert.equal(exhausted.status, 124, exhausted.stderr);
    assert.equal(exhausted.stdout, "");
    assert.equal(run(["reconcile", "bounded", "observe", "10", String(Date.now()), "1", process.execPath, "-e", "process.exit(0)"]).status, 0);
    // A fake clock cannot exercise the compiled child's real OS timeout.
    const bounded = run(["reconcile", "bounded", "observe", "3", String(Date.now()), "0.05", process.execPath, "-e", "setTimeout(()=>{},10000)"]);
    assert.equal(bounded.status, 124, bounded.stderr);
    assert.equal(bounded.stderr, "reconcile deadline exceeded\n");
    const gate = join(extracted, "bin/dagu-gate.cjs");
    const gatePath = run(["gate", "path"]);
    assert.equal(gatePath.status, 0, gatePath.stderr);
    assert.equal(gatePath.stdout.trim(), gate);
    const preload = spawnSync("node", ["--require", gate, "-e", 'console.log(JSON.stringify({node:process.versions.node,bun:process.versions.bun,loaded:!!require.cache[process.env.PRELOAD]}))'], {
      cwd: extracted, env: { ...env, PRELOAD: gate }, encoding: "utf8",
    });
    assert.equal(preload.status, 0, preload.stderr);
    assert.equal(JSON.parse(preload.stdout).loaded, true);
    assert.equal(JSON.parse(preload.stdout).bun, undefined);
    const plugin = JSON.parse(readFileSync(join(extracted, "package.json"), "utf8"));
    assert.deepEqual(plugin.omp.extensions, ["./src/status/reloadable.ts", "./src/triage/reloadable.ts"]);
    for (const entry of plugin.omp.extensions) {
      const imported = spawnSync("node", ["--input-type=module", "-e", `const extension = await import(${JSON.stringify(pathToFileURL(join(extracted, entry)).href)}); if (typeof extension.default !== "function") process.exit(1);`], { cwd: extracted, env, encoding: "utf8" });
      assert.equal(imported.status, 0, imported.stderr);
    }
    const primary = join(temporary, "primary");
    mkdirSync(primary);
    execFileSync("git", ["init", "-q", primary]);
    execFileSync("git", ["-C", primary, "-c", "user.name=Compiled smoke", "-c", "user.email=compiled@example.invalid", "commit", "--allow-empty", "-qm", "seed"]);
    const state = join(primary, ".git/dagu-feature/runs/compiled712");
    mkdirSync(state, { recursive: true });
    const archive = join(releases, archives[0]!);
    const artifact = { version: build.version, commit: expectedCommit, digest: createHash("sha256").update(readFileSync(archive)).digest("hex") };
    const cached = cachePath(home, artifact);
    mkdirSync(cached, { recursive: true });
    execFileSync("tar", ["-xzf", archive, "-C", cached]);
    copyFileSync(archive, join(cached, "verified-archive.tar.gz"));
    writeFileSync(join(cached, "artifact.json"), JSON.stringify({ ...artifact, verifiedAt: new Date().toISOString() }));
    const receipt: Receipt = { schemaVersion: 2, artifact, artifactSupport: support,
      contracts: USED_CONTRACTS,
      sourceVersion: { version: artifact.version, commit: artifact.commit, origin: "fixture/repo" }, deploymentFingerprint: "compiled-smoke",
      initial: { admittedAt: new Date().toISOString(), deployment: { config: { schemaVersion: 1, commit: expectedCommit, digest: "c".repeat(64) } },
        runtimeAndModels: { daguHome: home }, execution: { primary,
          head: execFileSync("git", ["-C", primary, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          ompSession: "owner", parameters: ["ISSUE=712"], dagSnapshot: 'steps:\n  - run: \'"$A4S_BIN" escalation check\'\n' }, eventsAndExternalState: {} },
      runReceipt: { dag: "feature", run: "compiled712", attempt: 1, observations: [] } };
    writeFileSync(join(state, "receipt.json"), JSON.stringify(receipt));
    // A Python holder is a test peer, not an engine dependency: it proves libc
    // flock interoperation with the pre-cutover lock files.
    const holder = spawn("python3", ["-c", 'import fcntl,sys; lock=open(sys.argv[1],"a"); fcntl.flock(lock,fcntl.LOCK_EX); print("locked",flush=True); sys.stdin.read()', join(state, "escalation.lock")], { stdio: ["pipe", "pipe", "inherit"] });
    try {
      await once(holder.stdout!, "data");
      let settled = false;
      const escalation = execute(executable, ["escalation", "check"], { cwd: extracted,
        env: { ...env, PRIMARY: primary, RUN: "compiled712", DAGU_OUTPUT_FILE: join(temporary, "outputs") } }).finally(() => { settled = true; });
      // This interprocess kernel-lock test deliberately uses the platform clock;
      // fake timers cannot advance a separate compiled process blocked in libc.
      await sleep(150);
      assert.equal(settled, false, "the compiled escalation must block on the existing flock");
      assert.equal(existsSync(join(state, "escalation.json")), false);
      holder.stdin!.end();
      const result = await escalation;
      assert.equal(JSON.parse(result.stdout).run, "compiled712");
      assert.match(readFileSync(join(temporary, "outputs"), "utf8"), /ESCALATE=no/);
    } finally { holder.kill(); }
    mkdirSync(join(home, "a4s"));
    const slotHolder = spawn("python3", ["-c", 'import fcntl,sys; lock=open(sys.argv[1],"a"); fcntl.flock(lock,fcntl.LOCK_EX); print("locked",flush=True); sys.stdin.read()', join(home, "a4s/heavy-slot.lock")], { stdio: ["pipe", "pipe", "inherit"] });
    try {
      await once(slotHolder.stdout!, "data");
      const slot = execute(executable, ["heavy-slot", process.execPath, "-e", 'if(process.env.A4S_HEAVY_SLOT_HELD!=="1")process.exit(2)'], { cwd: extracted, env });
      let resolve!: () => void;
      const waiting = new Promise<void>(ready => { resolve = ready; });
      slot.child.stderr!.on("data", chunk => { if (String(chunk).includes("gate: waiting lock=")) resolve(); });
      await Promise.race([waiting, slot.then(() => assert.fail("the compiled nonblocking flock must contend with Python"))]);
      slotHolder.stdin!.end();
      const result = await slot;
      assert.match(result.stderr, /gate: acquired lock=/);
    } finally { slotHolder.kill(); }
    assert.equal(existsSync(pythonCalled), false, "the released engine must not invoke Python");
    assert.equal(readdirSync(join(extracted, "src")).sort().join(","), "status,triage");
    assert.equal(basename(executable), "a4s");
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
