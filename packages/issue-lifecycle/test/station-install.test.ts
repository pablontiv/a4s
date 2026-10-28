import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fixture } from "./fixtures/station.ts";
import { exampleConfig, serializeConfig } from "../src/config.ts";

test("station installer accepts an unpinned runtime and reports its observed version", () => {
  const f = fixture();
  try {
    const bin = join(f.root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "dagu"), "#!/bin/sh\nif [ \"$1\" = version ]; then printf '2.24.0\\n'; fi\n");
    chmodSync(join(bin, "dagu"), 0o755);
    const original = "queues:\n  config:\n    - name: antojea-e2e\n      max_concurrency: 4\n";
    writeFileSync(join(f.home, "config.yaml"), original);
    const result = f.run([], { PATH: `${bin}:${process.env.PATH}` });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /dagu=2\.24\.0 launch-agent=/);
    assert.match(readFileSync(join(f.home, "config.yaml"), "utf8"), /name: antojea-e2e/);
  } finally { f.dispose(); }
});

test("station apply requires explicit admission and restart hooks before writing", () => {
  const f = fixture();
  try {
    const result = f.run(["--apply"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires admission-close, admission-open and restart-command/);
    assert.equal(existsSync(join(f.home, "config.yaml")), false);
  } finally { f.dispose(); }
});

test("station apply binds probes to a stamped render and its derived installed queue", () => {
  const f = fixture();
  try {
    const hooks = ["--apply", "--admission-close", "true", "--admission-open", "true", "--restart-command", "true"];
    const missing = f.run(hooks);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /requires --repo-dag/);
    const bin = join(f.root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "dagu"), "#!/bin/sh\nprintf '2.24.0\\n'\n", { mode: 0o755 });
    const render = join(f.root, "config.json");
    writeFileSync(render, serializeConfig(exampleConfig({ lane: "example", queueConcurrency: 6 })));
    const original = "queues:\n  enabled: true\n  config:\n    - name: example\n      max_concurrency: 3\n";
    writeFileSync(join(f.home, "config.yaml"), original);
    const drift = f.run([...hooks, "--repo-dag", render], { PATH: `${bin}:${process.env.PATH}` });
    assert.equal(drift.status, 1);
    assert.match(drift.stderr, /queue=example max_concurrency=6 compat=incompatible action=re-run-bootstrap/);
    assert.equal(readFileSync(join(f.home, "config.yaml"), "utf8"), original);
  } finally { f.dispose(); }
});

function executorsFixture() {
  const f = fixture();
  const source = join(f.root, "source");
  const bin = join(f.root, "bin");
  mkdirSync(source);
  mkdirSync(bin);
  const history = join(f.root, "history.json");
  const calls = join(f.root, "calls");
  writeFileSync(history, "[]");
  writeFileSync(join(bin, "dagu"), `#!/bin/sh\nif [ "$1" = version ]; then echo 2.24.0; else printf '%s\\n' "$*" >> '${calls}'; cat '${history}'; fi\n`, { mode: 0o755 });
  writeFileSync(join(bin, "npm"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n`, { mode: 0o755 });
  // Exercise the real TypeScript dispatcher with Node's native TS support;
  // production uses Bun. Only the interpreter name differs in this fixture.
  writeFileSync(join(bin, "bun"), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
  const env = { PATH: `${bin}:${process.env.PATH}`, RUN: "", PRIMARY: source };
  const git = (...args: string[]) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Station Test");
  for (const path of ["src/station-executors.ts", "src/receipt-version.ts", "src/type-guard.ts", "src/run-primary.ts", "src/primary.ts", "src/bundle.ts", "bin/dagu-station-executor.ts"]) {
    const destination = join(source, "packages/issue-lifecycle", path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), destination);
  }
  const pkg = join(source, "packages/issue-lifecycle");
  writeFileSync(join(source, ".gitignore"), "node_modules/\n");
  writeFileSync(join(source, "package.json"), '{"private":true,"type":"module"}\n');
  writeFileSync(join(pkg, "bin/dagu-role-jobs.ts"), `import { BUNDLE_VERSION } from "../src/bundle.ts";\nconsole.log(JSON.stringify({ version: BUNDLE_VERSION, args: process.argv.slice(2) }));\n`);
  function release(version: string) {
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@a4s/issue-lifecycle", version, type: "module" }));
    git("add", "."); git("commit", "-qm", `Release ${version}`);
    return git("rev-parse", "HEAD");
  }
  const old = release("0.8.1");
  const current = release("0.8.2");
  const executor = (version: string, commit: string) => join(f.home, "executors", `issue-lifecycle-${version}-${commit}`);
  const launcherDir = join(f.root, "launchers");
  let sequence = 0;
  let evidence = "";
  function run(action: string, extra: string[] = []) {
    evidence = join(f.root, `evidence-${sequence++}.json`);
    return f.run(["--executor-action", action, "--source", source, "--evidence", evidence, ...extra], env);
  }
  const install = () => run("install", ["--commit", current, "--launcher-dir", launcherDir]);
  const mutate = (action: string, path: string) => run(action, ["--executor", path, "--admission-close", "true", "--admission-open", "true"]);
  function reference(commit = old, version = "0.8.1", status = "waiting", runId = "historical") {
    const state = join(source, ".git/dagu-feature/runs", runId);
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "receipt.json"), JSON.stringify({ schemaVersion: 1, sourceVersion: { version, commit, origin: source }, runReceipt: { run: runId } }));
    writeFileSync(history, JSON.stringify([{ name: "feature", dagRunId: runId, status, params: `PRIMARY=${source}` }]));
  }
  function legacy() {
    const path = executor("0.8.1", old);
    mkdirSync(dirname(path), { recursive: true });
    git("worktree", "add", "--detach", path, old);
    return path;
  }
  function launch(runId = "") {
    return spawnSync(join(launcherDir, "dagu-role-jobs"), ["stage", "implement"], { env: { ...process.env, ...env, DAGU_HOME: f.home, RUN: runId }, encoding: "utf8" });
  }
  return { ...f, source, bin, env, git, old, current, history, calls, executor, launcherDir, run, install, mutate, reference, legacy, launch, evidence: () => evidence };
}

test("station installs an independent recorded bundle and preserves development registrations", () => {
  const f = executorsFixture();
  try {
    const development = join(f.root, "development");
    f.git("worktree", "add", "-b", "development", development);
    const before = f.git("worktree", "list", "--porcelain");
    const result = f.install();
    assert.equal(result.status, 0, result.stderr);
    const path = f.executor("0.8.2", f.current);
    assert.equal(statSync(join(path, ".git")).isDirectory(), true);
    assert.equal(existsSync(join(path, ".git/objects/info/alternates")), false);
    assert.equal(f.git("worktree", "list", "--porcelain"), before);
    const launched = f.launch();
    assert.equal(launched.status, 0, launched.stderr);
    assert.deepEqual(JSON.parse(launched.stdout), { version: "0.8.2", args: ["stage", "implement"] });
    const evidence = JSON.parse(readFileSync(f.evidence(), "utf8"));
    assert.equal(evidence.installed.commit, f.current);
    assert.equal(evidence.worktreesBefore, evidence.worktreesAfter);
    assert.match(readFileSync(f.calls, "utf8"), /ci --ignore-scripts --no-audit --no-fund/);
    const mtime = statSync(join(f.launcherDir, "dagu-role-jobs")).mtimeMs;
    assert.equal(f.install().status, 0);
    assert.equal(statSync(join(f.launcherDir, "dagu-role-jobs")).mtimeMs, mtime);
  } finally { f.dispose(); }
});

test("station rejects unsupported receipt versions before evidence, executor directories or admission hooks", () => {
  const f = executorsFixture();
  try {
    f.reference();
    const path = join(f.source, ".git/dagu-feature/runs/historical/receipt.json");
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...receipt, schemaVersion: 3 }));
    const marker = join(f.root, "closed");
    const result = f.run("migrate", ["--executor", f.executor("0.8.1", f.old),
      "--admission-close", `touch '${marker}'`, "--admission-open", "true"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unsupported admission receipt schemaVersion=3/);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(f.evidence()), false);
    assert.equal(existsSync(join(f.home, "executors")), false);
    assert.equal(existsSync(join(f.home, ".station-install.lock")), false);
  } finally { f.dispose(); }
});

test("station replaces launcher drift atomically without writing through symlinks", () => {
  const f = executorsFixture();
  try {
    assert.equal(f.install().status, 0);
    const launcher = join(f.launcherDir, "dagu-role-jobs");
    const desired = readFileSync(launcher, "utf8");
    const operator = join(f.root, "operator-launcher");
    for (const contents of ["operator-owned\n", undefined]) {
      rmSync(launcher);
      if (contents !== undefined) writeFileSync(operator, contents);
      else rmSync(operator);
      symlinkSync(operator, launcher);
      const repaired = f.install();
      assert.equal(repaired.status, 0, repaired.stderr);
      assert.equal(readFileSync(launcher, "utf8"), desired);
      assert.equal(statSync(launcher).mode & 0o777, 0o755);
      if (contents !== undefined) assert.equal(readFileSync(operator, "utf8"), contents);
      else assert.equal(existsSync(operator), false);
      assert.equal(f.launch().status, 0);
    }
  } finally { f.dispose(); }
});

test("station migrates a waiting run's exact bundle and launcher remains receipt-pinned", () => {
  const f = executorsFixture();
  try {
    const path = f.legacy();
    f.reference();
    assert.equal(f.install().status, 0);
    assert.equal(JSON.parse(f.launch("historical").stdout).version, "0.8.1");
    const result = f.mutate("migrate", path);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(statSync(join(path, ".git")).isDirectory(), true);
    assert.equal(f.git("worktree", "list", "--porcelain").includes(path), false);
    assert.equal(JSON.parse(f.launch("historical").stdout).version, "0.8.1");
    assert.equal(JSON.parse(f.launch().stdout).version, "0.8.2");
    const evidence = JSON.parse(readFileSync(f.evidence(), "utf8"));
    assert.equal(evidence.before[0].run, "historical");
    assert.equal(evidence.before[0].commit, f.old);
    assert.deepEqual(evidence.before[0].resolution, evidence.after[0].resolution);
    assert.equal(f.mutate("migrate", path).status, 0);
  } finally { f.dispose(); }
});

test("retention keeps waiting, not-started and active pins, removes only an unreferenced old executor", () => {
  const f = executorsFixture();
  try {
    const path = f.legacy();
    assert.equal(f.install().status, 0);
    for (const status of ["waiting", "not_started"]) {
      f.reference(f.old, "0.8.1", status);
      const kept = f.mutate("prune", path);
      assert.equal(kept.status, 1);
      assert.match(kept.stderr, /Referenced or active executor retained/);
      assert.equal(existsSync(path), true);
    }
    writeFileSync(f.history, "[]");
    assert.equal(f.mutate("prune", f.executor("0.8.2", f.current)).status, 1);
    const development = join(f.root, "development");
    f.git("worktree", "add", "-b", "development", development);
    const removed = f.mutate("prune", path);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(existsSync(path), false);
    assert.match(f.git("worktree", "list", "--porcelain"), /development/);
    assert.equal(f.launch().status, 0);
  } finally { f.dispose(); }
});

test("migration and retention fail closed for dirty, foreign, symlink and development checkouts", () => {
  const f = executorsFixture();
  try {
    const path = f.legacy();
    assert.equal(f.install().status, 0);
    writeFileSync(join(path, "operator.txt"), "preserve");
    assert.match(f.mutate("migrate", path).stderr, /Dirty executor retained/);
    assert.match(f.mutate("prune", path).stderr, /Dirty executor retained/);
    rmSync(join(path, "operator.txt"));
    f.git("-C", path, "switch", "-c", "operator");
    assert.match(f.mutate("prune", path).stderr, /Development checkout retained/);
    f.git("-C", path, "checkout", "--detach");
    assert.match(f.mutate("prune", f.source).stderr, /Not a direct managed executor/);
    const link = join(f.home, "executors", "omp-dagu-0.8.1");
    symlinkSync(path, link);
    assert.match(f.mutate("prune", link).stderr, /Not a direct managed executor/);
    const foreign = join(f.root, "foreign");
    execFileSync("git", ["clone", "--quiet", f.source, foreign]);
    assert.equal(f.run("prune", ["--executor", path, "--source", foreign, "--admission-close", "true", "--admission-open", "true"]).status, 1);
    assert.equal(existsSync(path), true);
  } finally { f.dispose(); }
});

test("missing references and truncated history block removal, and historical missing entrypoints are not substituted", () => {
  const f = executorsFixture();
  try {
    const path = f.legacy();
    assert.equal(f.install().status, 0);
    f.reference("a".repeat(40), "0.3.98");
    assert.match(f.mutate("prune", path).stderr, /Unresolved run references/);
    const missing = f.launch("historical");
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Missing pinned executor 0.3.98/);
    writeFileSync(f.history, JSON.stringify(Array.from({ length: 1000 }, () => ({}))));
    assert.match(f.mutate("prune", path).stderr, /Incomplete active history/);
    f.reference(f.old, "0.8.1");
    rmSync(join(path, "packages/issue-lifecycle/bin/dagu-role-jobs.ts"));
    const unsupported = f.launch("historical");
    assert.equal(unsupported.status, 1);
    assert.match(unsupported.stderr, /has no role-jobs entrypoint; retained/);
    assert.equal(existsSync(path), true);
  } finally { f.dispose(); }
});

test("migration holds running runs and preserves prior evidence receipts", () => {
  const f = executorsFixture();
  try {
    const path = f.legacy();
    f.reference(f.old, "0.8.1", "running");
    const held = f.mutate("migrate", path);
    assert.equal(held.status, 1);
    assert.match(held.stderr, /Station must be quiescent/);
    assert.equal(statSync(join(path, ".git")).isFile(), true);
    const evidence = JSON.parse(readFileSync(f.evidence(), "utf8"));
    assert.equal(evidence.admissionRemainsClosed, true);
    const receipt = f.evidence();
    const previous = readFileSync(receipt, "utf8");
    const duplicate = f.run("inventory", ["--evidence", receipt]);
    assert.equal(duplicate.status, 1);
    assert.equal(readFileSync(receipt, "utf8"), previous);
  } finally { f.dispose(); }
});

test("historical entrypoint absence survives independent migration and only unreferenced storage can be pruned", () => {
  const f = executorsFixture();
  try {
    assert.equal(f.install().status, 0);
    f.git("rm", "packages/issue-lifecycle/bin/dagu-role-jobs.ts");
    writeFileSync(join(f.source, "packages/issue-lifecycle/package.json"), JSON.stringify({ name: "@a4s/issue-lifecycle", version: "0.3.98", type: "module" }));
    f.git("add", "."); f.git("commit", "-qm", "Historical bundle without role-jobs");
    const commit = f.git("rev-parse", "HEAD");
    const path = f.executor("0.3.98", commit);
    f.git("worktree", "add", "--detach", path, commit);
    f.reference(commit, "0.3.98");
    assert.match(f.launch("historical").stderr, /has no role-jobs entrypoint/);
    const migrated = f.mutate("migrate", path);
    assert.equal(migrated.status, 0, migrated.stderr);
    assert.equal(statSync(join(path, ".git")).isDirectory(), true);
    const evidence = JSON.parse(readFileSync(f.evidence(), "utf8"));
    assert.deepEqual(evidence.before[0].resolution, evidence.after[0].resolution);
    assert.equal(evidence.after[0].resolution.entrypointDigest, undefined);
    assert.match(f.launch("historical").stderr, /has no role-jobs entrypoint/);
    assert.equal(f.mutate("prune", path).status, 1);
    writeFileSync(f.history, "[]");
    const removed = f.mutate("prune", path);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(existsSync(path), false);
    assert.equal(f.launch().status, 0);
  } finally { f.dispose(); }
});

test("failed staging preserves worktree-backed references and leaves admission closed", () => {
  const f = executorsFixture();
  try {
    const path = f.legacy();
    f.reference();
    const before = f.git("worktree", "list", "--porcelain");
    writeFileSync(join(f.bin, "npm"), "#!/bin/sh\nexit 42\n", { mode: 0o755 });
    const failed = f.mutate("migrate", path);
    assert.equal(failed.status, 1);
    assert.equal(f.git("worktree", "list", "--porcelain"), before);
    assert.equal(statSync(join(path, ".git")).isFile(), true);
    const evidence = JSON.parse(readFileSync(f.evidence(), "utf8"));
    assert.equal(evidence.before[0].commit, f.old);
    assert.equal(evidence.admissionRemainsClosed, true);
  } finally { f.dispose(); }
});
