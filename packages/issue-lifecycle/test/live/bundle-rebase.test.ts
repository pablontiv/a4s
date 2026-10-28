import { renderedFeature } from "../fixtures/rendered-feature.ts";
import { liveDagu, liveDaguVersion } from "../fixtures/live-dagu.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { testRunId } from "../fixtures/run-id.ts";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readConfigFile } from "../../src/config.ts";
import { a4sBin } from "../fixtures/a4s.ts";
import { roleAdmission } from "../role-job-fixtures.ts";

const resolver = fileURLToPath(new URL("../../bin/dagu-bundle-rebase.mjs", import.meta.url));
const template = fileURLToPath(new URL("../../skills/issue-execution/feature.yaml", import.meta.url));
const rendered = fileURLToPath(new URL(renderedFeature, import.meta.url));
const manifest = "packages/issue-lifecycle/package.json";
const changelog = "packages/issue-lifecycle/CHANGELOG.md";
const bundle = "packages/issue-lifecycle/test/bundle.test.ts";
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const text = (cwd: string, file: string) => readFileSync(join(cwd, file), "utf8");
const json = (cwd: string, file: string) => JSON.parse(text(cwd, file));
function put(cwd: string, file: string, value: string): void {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), value);
}
function release(cwd: string, version: string, entry: string, functional?: string, legacy = true): void {
  put(cwd, manifest, JSON.stringify({ name: "@a4s/issue-lifecycle", version, description: functional ?? "base", private: true }, null, 2) + "\n");
  put(cwd, "package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "fixture" }, "packages/issue-lifecycle": { version, license: "UNLICENSED" }, "node_modules/other": { version: "1.0.0" } } }, null, 2) + "\n");
  put(cwd, bundle, legacy ? `assert.equal(BUNDLE_VERSION, "${version}");\n` : "assert.equal(BUNDLE_VERSION, manifest.version);\n");
  const prior = existsSync(join(cwd, changelog)) ? text(cwd, changelog).slice("# Changelog\n\n".length) : "";
  put(cwd, changelog, `# Changelog\n\n## ${version}\n\n- ${entry}\n\n${prior}`);
}
function step(source: string, id: string): string {
  const start = source.indexOf(`  - id: ${id}\n`);
  assert.ok(start >= 0);
  const end = source.indexOf("\n  - id:", start + 1);
  let result = source.slice(start, end < 0 ? source.length : end).split("\nhandler_on:")[0]! + "\n";
  if (result.includes("    run: *cancellation_gate")) {
    result = result.replace("    run: *cancellation_gate", source.match(/    run: &cancellation_gate \|[\s\S]*?(?=\n  - id:)/)![0]!.replace(" &cancellation_gate", ""));
  }
  result = result.replace("    run: &cancellation_gate", "    run:");
  if (result.includes("    action: human.task")) result += step(source, `${id}_cancellation`);
  return result;
}
function script(file: string, id: string): string {
  const block = step(readFileSync(file, "utf8"), id);
  return block.slice(block.indexOf("    run: |\n") + "    run: |\n".length).split("\n").map(line => line.slice(6)).join("\n");
}
type Fixture = {
  root: string; primary: string; worktree: string; branch: string; state: string; before: string;
  env: NodeJS.ProcessEnv & { GATE: string };
};
function fixture(upstream = "0.3.18", proposed = "0.3.18", mode = "clean", legacy = true): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-bundle-rebase-")));
  const primary = join(root, "primary");
  const remote = join(root, "remote.git");
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "pipe" });
  execFileSync("git", ["init", "-b", "main", primary], { stdio: "pipe" });
  git(primary, "config", "user.name", "Bundle Test");
  git(primary, "config", "user.email", "bundle@example.invalid");
  git(primary, "remote", "add", "origin", remote);
  put(primary, ".git/info/exclude", "/.workspace/\n");
  release(primary, "0.3.17", "Published history", undefined, legacy);
  put(primary, "src/shared.ts", "base\n");
  git(primary, "add", "."); git(primary, "commit", "-m", "base"); git(primary, "push", "origin", "main");
  const base = git(primary, "rev-parse", "HEAD");
  const branch = "dagu/issue-339";
  const worktree = join(primary, ".workspace/worktrees/issue-339");
  git(primary, "worktree", "add", "-b", branch, worktree, base);
  release(worktree, proposed, "Candidate B", mode === "manifest" ? "candidate description" : undefined, legacy);
  if (mode === "mixed") put(worktree, "src/shared.ts", "candidate\n");
  if (mode === "history") put(worktree, changelog, text(worktree, changelog).replace("Published history", "Edited history"));
  if (mode === "compatible") {
    const lock = json(worktree, "package-lock.json");
    lock.packages["node_modules/other"].version = "2.0.0";
    put(worktree, "package-lock.json", JSON.stringify(lock, null, 2) + "\n");
    put(worktree, bundle, "assert.equal(BUNDLE_VERSION, manifest.version);\n");
  }
  if (mode === "mismatch") {
    const lock = json(worktree, "package-lock.json");
    lock.packages["packages/issue-lifecycle"].version = "0.3.99";
    put(worktree, "package-lock.json", JSON.stringify(lock, null, 2) + "\n");
  }
  if (mode === "lock") {
    const lock = json(worktree, "package-lock.json"); lock.packages["node_modules/other"].version = "2.0.0";
    put(worktree, "package-lock.json", JSON.stringify(lock, null, 2) + "\n");
  }
  git(worktree, "add", "."); git(worktree, "commit", "-m", "feat: candidate B");
  const before = git(worktree, "rev-parse", "HEAD");
  release(primary, upstream, "Candidate A", ["manifest", "compatible"].includes(mode) ? "upstream description" : undefined, legacy);
  if (mode === "mixed") put(primary, "src/shared.ts", "upstream\n");
  if (mode === "lock") {
    const lock = json(primary, "package-lock.json"); lock.packages["node_modules/other"].version = "3.0.0";
    put(primary, "package-lock.json", JSON.stringify(lock, null, 2) + "\n");
  }
  git(primary, "add", "."); git(primary, "commit", "-m", "feat: candidate A"); git(primary, "push", "origin", "main");
  const id = testRunId("bundle-rebase");
  const state = join(primary, ".git/dagu-feature/runs", id);
  mkdirSync(state, { recursive: true });
  const identity = JSON.stringify({ primary, worktree, branch, run: id, session: "" });
  put(state, "identity", identity + "\n");
  writeFileSync(git(worktree, "rev-parse", "--path-format=absolute", "--git-path", "dagu-feature-owner"), identity + "\n");
  put(state, "base", base + "\n");
  put(state, "candidate.json", JSON.stringify({ sha: before, base, tree: git(worktree, "rev-parse", "HEAD^{tree}"), iteration: 0, message: "feat: candidate B", summary: "Candidate B", implementer: "ImplementTest" }) + "\n");
  put(state, "diff.patch", git(worktree, "diff", "--binary", base, before) + "\n");
  put(state, "gate.json", JSON.stringify({ sha: before, gate: "old gate" }) + "\n");
  const env = { HOME: process.env.HOME, A4S_BIN: a4sBin, PATH: process.env.PATH, DAGU_HOME: join(root, "dagu-home"), PRIMARY: primary, WORKTREE: worktree, BRANCH: branch, BASE_BRANCH: "main", RUN: id, OMP_SESSION_ID: "", REBASE_RESOLVER: `node ${JSON.stringify(resolver)}`, GATE: "true" };
  put(state, "receipt.json", JSON.stringify(roleAdmission(primary, env.DAGU_HOME, id, readFileSync(template, "utf8"))));
  return { root, primary, worktree, branch, state, before, env };
}
function run(repo: Fixture, file = template, id = "rebase") {
  return spawnSync("bash", ["-c", script(file, id)], { cwd: repo.root, env: repo.env, encoding: "utf8" });
}
function normalized(repo: Fixture, version: string): string {
  const sha = git(repo.worktree, "rev-parse", "HEAD");
  assert.equal(json(repo.worktree, manifest).version, version);
  assert.equal(json(repo.worktree, "package-lock.json").packages["packages/issue-lifecycle"].version, version);
  assert.match(text(repo.worktree, changelog), new RegExp(`^# Changelog\\n\\n## ${version.replaceAll(".", "\\.")}\\n`));
  assert.match(text(repo.worktree, changelog), /Candidate A/); assert.match(text(repo.worktree, changelog), /Candidate B/); assert.match(text(repo.worktree, changelog), /Published history/);
  assert.equal(git(repo.worktree, "rev-list", "--count", "origin/main..HEAD"), "1");
  assert.equal(git(repo.worktree, "status", "--porcelain"), "");
  assert.equal(json(repo.state, "candidate.json").sha, sha);
  assert.equal(text(repo.state, "base").trim(), git(repo.worktree, "rev-parse", "origin/main"));
  assert.equal(text(repo.state, "diff.patch"), execFileSync("git", ["-C", repo.worktree, "diff", "--binary", "--full-index", "origin/main", sha], { encoding: "utf8" }));
  assert.equal(json(join(repo.state, "historical", repo.before), "gate.json").sha, repo.before);
  return sha;
}

for (const file of [template, rendered]) {
  test(`${file === template ? "template" : "render"} normalizes consecutive releases and preserves identity on repetition and advancing base`, () => {
    const repo = fixture();
    try {
      const result = run(repo, file); assert.equal(result.status, 0, result.stderr);
      const sha = normalized(repo, "0.3.19");
      assert.equal(text(repo.worktree, bundle), 'assert.equal(BUNDLE_VERSION, "0.3.19");\n');
      assert.ok(!existsSync(join(repo.state, "gate.json")));
      assert.equal(run(repo, file).status, 0); assert.equal(git(repo.worktree, "rev-parse", "HEAD"), sha);
      release(repo.primary, "0.3.20", "Candidate C");
      git(repo.primary, "add", "."); git(repo.primary, "commit", "-m", "next release"); git(repo.primary, "push", "origin", "main");
      const advanced = run(repo, file); assert.equal(advanced.status, 0, advanced.stderr);
      normalized(repo, "0.3.21");
      assert.ok(existsSync(join(repo.state, "historical", sha, "candidate.json")));
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });
}
for (const [upstream, proposed, expected] of [["0.3.18", "0.4.0", "0.4.0"], ["0.4.0", "0.4.0", "0.4.1"], ["0.3.18", "1.0.0", "1.0.0"], ["1.0.0", "1.0.0", "1.0.1"]]) {
  test(`preserves compatible release intent ${upstream} / ${proposed}`, () => {
    const repo = fixture(upstream, proposed, "clean", false);
    try { const result = run(repo); assert.equal(result.status, 0, result.stderr); normalized(repo, expected!); assert.equal(text(repo.worktree, bundle), "assert.equal(BUNDLE_VERSION, manifest.version);\n"); }
    finally { rmSync(repo.root, { recursive: true, force: true }); }
  });
}
test("merges independent non-version metadata and the manifest-authority identity cutover", () => {
  const repo = fixture("0.3.18", "0.3.18", "compatible");
  try {
    const result = run(repo);
    assert.equal(result.status, 0, result.stderr);
    normalized(repo, "0.3.19");
    assert.equal(json(repo.worktree, manifest).description, "upstream description");
    assert.equal(json(repo.worktree, "package-lock.json").packages["node_modules/other"].version, "2.0.0");
    assert.equal(text(repo.worktree, bundle), "assert.equal(BUNDLE_VERSION, manifest.version);\n");
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});
for (const [mode, upstream, proposed, diagnostic] of [
  ["mixed", "0.3.18", "0.3.18", "remaining conflicts: src/shared.ts"],
  ["manifest", "0.3.18", "0.3.18", "ambiguous non-version changes"],
  ["lock", "0.3.18", "0.3.18", "ambiguous non-version changes"],
  ["mismatch", "0.3.18", "0.3.18", "workspace version mismatch"],
  ["history", "0.3.18", "0.3.18", "published changelog history changed"],
  ["clean", "0.4.0", "0.3.18", "patch intent conflicts"],
  ["clean", "0.4.0", "1.0.0", "incompatible explicit major/minor"],
]) {
  test(`retains recoverable conflicts: ${mode} ${upstream} / ${proposed}`, () => {
    const repo = fixture(upstream, proposed, mode);
    try {
      const result = run(repo); assert.equal(result.status, 0, result.stderr);
      assert.ok((result.stdout + result.stderr).includes(diagnostic!), result.stdout + result.stderr);
      assert.equal(text(repo.state, "conflict-action"), "rewind\n");
      assert.ok(text(repo.state, "conflict-files").trim());
      assert.equal(git(repo.worktree, "branch", "--show-current"), repo.branch);
      assert.equal(git(repo.worktree, "show", `${repo.before}:${changelog}`).includes("Candidate B"), true);
      assert.equal(git(repo.primary, "show", `main:${changelog}`).includes("Candidate A"), true);
      assert.equal(json(join(repo.state, "historical", repo.before), "candidate.json").sha, repo.before);
      if (mode === "mixed") {
        assert.equal(text(repo.state, "conflict-files"), "src/shared.ts\n");
        assert.equal(json(repo.worktree, manifest).version, "0.3.19");
        assert.match(text(repo.worktree, "src/shared.ts"), /<<<<<<< HEAD/);
      }
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });
}
test("repository resolution requires verified run identity", () => {
  const repo = fixture();
  try { put(repo.state, "identity", "{}\n"); assert.notEqual(run(repo).status, 0); assert.equal(git(repo.worktree, "rev-parse", "HEAD"), repo.before); }
  finally { rmSync(repo.root, { recursive: true, force: true }); }
});

test("isolated Dagu rebases colliding candidates before gate and publishes the normalized SHA", {
  ...liveDagu,
  timeout: 150_000,
}, async () => {
  const repo = fixture();
  const home = join(repo.root, "dagu-home"); mkdirSync(join(home, "dags"), { recursive: true });
  const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address(); assert.ok(address && typeof address !== "string"); const port = address.port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  put(home, "config.yaml", `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\nscheduler:\n  port: 0\n`);
  const bin = join(repo.root, "bin"); put(bin, "gh", "#!/bin/sh\nprintf 'fixture/repository\\n'\n"); chmodSync(join(bin, "gh"), 0o755);
  const env = { ...repo.env, PATH: `${bin}:${process.env.PATH}`, DAGU_HOME: home, DAGU_COORDINATOR_ENABLED: "false" };
  repo.env.GATE = `gh repo view >/dev/null && node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync("${manifest}")); if(p.version!=="0.3.19") process.exit(1)'`;
  const source = readFileSync(template, "utf8");
  const file = join(home, "dags/feature.yaml");
  const staged = join(repo.root, "staged/config.json");
  const adoptionEnv = {
    ...env, STAGE: staged, REPO: "fixture", BASE_BRANCH: "main",
    GATE: repo.env.GATE, REQUIRED_CHECK: "validate", TEST_PATHS: "(^|/)test/",
    REBASE_RESOLVER: repo.env.REBASE_RESOLVER, BUNDLE_NAME: "@a4s/issue-lifecycle",
    BUNDLE_VERSION: "0.3.18", DAGU_VERSION: "2.24.0", SOURCE_NWO: "fixture/repository",
    SOURCE_SHA: repo.before, DAG_RUN_ID: "fixture-bootstrap",
  };
  put(home, "dags/feature.yaml", `type: graph\nshell: bash\nenv:\n${Object.entries({ ...repo.env, VALIDATION: "", PATH: env.PATH }).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`).join("\n")}\nsteps:\n` +
    "  - id: triage\n    run: echo POC=no >> \"$DAGU_OUTPUT_FILE\"\n    outputs:\n      - name: POC\n" +
    "  - id: implement\n    depends: triage\n    run: echo fixture-candidate-ready\n" +
    step(source, "rebase").replace("    depends: rebase_escalation_decision", "    depends: implement") +
    step(source, "gate").replace("    depends: conflict_review_cancellation", "    depends: rebase") +
    step(source, "push").replace("    depends: validation_cancellation", "    depends: gate"));
  let serviceLog = "";
  const service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(port)], { cwd: repo.root, env, stdio: ["ignore", "pipe", "pipe"] });
  service.stdout.on("data", data => { serviceLog += data; }); service.stderr.on("data", data => { serviceLog += data; });
  const command = (...args: string[]) => execFileSync("dagu", args, { cwd: repo.root, env, encoding: "utf8" });
  const id = repo.env.RUN!; const api = `http://127.0.0.1:${port}/api/v1`;
  async function until<T>(description: string, probe: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) { const value = await probe(); if (value !== undefined) return value; await delay(150); }
    throw new Error(`${description}\n${serviceLog}`);
  }
  try {
    await until("Dagu ready", async () => { try { return (await fetch(`${api}/dag-runs`)).ok ? true : undefined; } catch { return undefined; } });
    execFileSync("bash", ["-c", script(join(dirname(template), "dagu-feature-bootstrap.yaml"), "write_config")], { cwd: repo.root, env: adoptionEnv });
    assert.equal(readConfigFile(staged).gate, repo.env.GATE);
    command("validate", rendered); command("validate", file);
    command("enqueue", "--run-id", id, "feature");
    const run = await until("normalized rebase/gate/push", async () => {
      const response = await fetch(`${api}/dag-runs/feature/${id}`); if (!response.ok) return undefined;
      const run = (await response.json() as { dagRunDetails: { statusLabel: string; nodes: Array<{ statusLabel: string; stdout?: string; stderr?: string }> } }).dagRunDetails;
      return ["succeeded", "failed", "aborted"].includes(run.statusLabel) ? run : undefined;
    });
    const logs = run.nodes.map(node => [node.stdout, node.stderr].filter(Boolean).map(path => readFileSync(path!, "utf8")).join("\n")).join("\n");
    assert.equal(run.statusLabel, "succeeded", logs + serviceLog);
    assert.ok(!run.nodes.some(node => node.statusLabel === "failed"), logs + serviceLog);
    const sha = normalized(repo, "0.3.19");
    assert.equal(json(repo.state, "gate.json").sha, sha);
    assert.equal(git(repo.primary, "ls-remote", "origin", `refs/heads/${repo.branch}`).split(/\s/)[0], sha);
    assert.match(logs, /bundle-rebase: 0\.3\.17 \/ 0\.3\.18 \/ 0\.3\.18 -> 0\.3\.19/);
    assert.ok(logs.includes(`tested_sha=${sha}`));
    const status = command("status", "--run-id", id, "feature");
    console.log(`LIVE bundle-rebase DAGU_HOME=${home} port=${port} run=${id}\n${liveDaguVersion}\nconfig=${staged}\ndagu validate ${rendered}\ndagu validate ${file}\ndagu enqueue --run-id ${id} feature\ndagu status --run-id ${id} feature\n${status}\noriginal_sha=${repo.before} normalized_sha=${sha}\n${logs}`);
  } finally {
    if (service.exitCode === null && service.signalCode === null) await new Promise<void>(resolve => { service.once("exit", () => resolve()); service.kill("SIGTERM"); });
    rmSync(repo.root, { recursive: true, force: true });
  }
});
