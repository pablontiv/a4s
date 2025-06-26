import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Transitions } from "../src/status/progress.ts";
import type { RunDetails } from "../src/status/progress.ts";
import { BUNDLE_VERSION } from "../src/bundle.ts";
import { stubHistory, withResourceGuard } from "./resource-fixtures.ts";

const definitions = [
  ["template", fileURLToPath(new URL("../skills/dagu-feature/feature.yaml", import.meta.url))],
  ["rendered DAG", fileURLToPath(new URL("../../../.workspace/dagu/dags/feature.yaml", import.meta.url))],
] as const;

function extractScript(definition: string, marker: string): string {
  const lines = readFileSync(definition, "utf8").split("\n");
  const markerIndex = lines.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing ${marker} in ${definition}`);
  const runIndex = lines.indexOf("    run: |", markerIndex);
  assert.notEqual(runIndex, -1, `missing run block after ${marker}`);
  let end = runIndex + 1;
  while (end < lines.length && (lines[end]!.startsWith("      ") || lines[end] === "")) end++;
  return withResourceGuard(lines.slice(runIndex + 1, end).map((line) => line.slice(6)).join("\n"), definition);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function hasRef(cwd: string, ref: string): boolean {
  return spawnSync("git", ["-C", cwd, "show-ref", "--verify", "--quiet", ref]).status === 0;
}

type Repository = {
  root: string;
  primary: string;
  worktree: string;
  branch: string;
  state: string;
};

function repository(): Repository {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-dagu-feature-")));
  const primary = join(root, "primary");
  const remote = join(root, "remote.git");
  const worktree = join(primary, ".workspace", "worktrees", "issue-189");
  const branch = "dagu/issue-189";
  execFileSync("git", ["init", "--bare", "-b", "main", remote]);
  execFileSync("git", ["init", "-b", "main", primary]);
  git(primary, "config", "user.name", "Feature Test");
  git(primary, "config", "user.email", "feature-test@example.com");
  git(primary, "remote", "add", "origin", remote);
  writeFileSync(join(primary, ".git", "info", "exclude"), "/.workspace/\n");
  mkdirSync(join(primary, "packages", "first"), { recursive: true });
  mkdirSync(join(primary, "packages", "second"), { recursive: true });
  writeFileSync(join(primary, "packages", "first", "package.json"), '{"dependencies":{"shared":"1.0.0"}}\n');
  writeFileSync(join(primary, "packages", "second", "package.json"), "{}\n");
  writeFileSync(join(primary, "README.txt"), "base\n");
  git(primary, "add", ".");
  git(primary, "commit", "-m", "base");
  git(primary, "push", "-u", "origin", "main");
  writeFileSync(join(primary, ".git", "info", "exclude"), "/.workspace/worktrees/\n");
  stubHistory(root);
  git(primary, "worktree", "add", "-b", branch, worktree, "origin/main");
  const state = join(primary, ".git", "dagu-feature", "runs", "test-run");
  mkdirSync(state, { recursive: true });
  const identity = JSON.stringify({ primary, worktree, branch, run: "test-run", session: "" }) + "\n";
  writeFileSync(join(state, "identity"), identity);
  writeFileSync(git(worktree, "rev-parse", "--path-format=absolute", "--git-path", "dagu-feature-owner"), identity);
  writeFileSync(join(state, "base"), git(worktree, "rev-parse", "HEAD") + "\n");
  recordCandidate({ root, primary, worktree, branch, state });
  return { root, primary, worktree, branch, state };
}

function recordCandidate(repo: Repository): void {
  const sha = git(repo.worktree, "rev-parse", "HEAD");
  writeFileSync(join(repo.state, "candidate.json"), JSON.stringify({
    sha, base: readFileSync(join(repo.state, "base"), "utf8").trim(),
    tree: git(repo.worktree, "rev-parse", "HEAD^{tree}"), message: "base", iteration: -1,
  }) + "\n");
}

function commit(repo: Repository, path: string, content: string): void {
  const target = join(repo.worktree, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  git(repo.worktree, "add", path);
  git(repo.worktree, "commit", "-m", "feature change");
  recordCandidate(repo);
}

function stubGh(repo: Repository, stdout: string, status: number, stderr = ""): void {
  const bin = join(repo.root, "bin");
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, "gh");
  writeFileSync(
    executable,
    `#!/bin/sh\ncase " $* " in *" --repo "*) ;; *)\n  if [ "$PWD" != ${JSON.stringify(repo.primary)} ]; then\n    printf 'failed to run git: fatal: not a git repository\\n' >&2\n    exit 2\n  fi\nesac\nprintf '%b' ${JSON.stringify(stdout)}\nprintf '%b' ${JSON.stringify(stderr)} >&2\nexit ${status}\n`,
  );
  chmodSync(executable, 0o755);
}

function stubSuccessfulCloseGateGh(repo: Repository): void {
  const head = git(repo.worktree, "rev-parse", "HEAD");
  const bin = join(repo.root, "bin");
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, "gh");
  writeFileSync(
    executable,
    `#!/bin/sh
case "$*" in
  "pr view ${repo.branch} --repo ${repo.root}/remote.git --json number --jq .number") printf '190\\n' ;;
  "pr view 190 --repo ${repo.root}/remote.git --json state --jq .state") printf 'MERGED\\n' ;;
  "pr view 190 --repo ${repo.root}/remote.git --json headRefOid --jq .headRefOid") printf '${head}\\n' ;;
  "pr checks 190 --repo ${repo.root}/remote.git --required --json name,state --jq "*) printf 'SUCCESS\\n' ;;
  *) printf 'unexpected gh invocation: %s\\n' "$*" >&2; exit 1 ;;
esac
`,
  );
  chmodSync(executable, 0o755);
}

function featureScriptEnv(repo: Repository): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME,
    PATH: `${join(repo.root, "bin")}:${process.env.PATH ?? ""}`,
    ISSUE: "189",
    PR_NUMBER: "",
    PRIMARY: repo.primary,
    WORKTREE: repo.worktree,
    BRANCH: repo.branch,
    BASE_BRANCH: "main",
    GATE: "true",
    REQUIRED_CHECK: "validate",
    OMP_SESSION_ID: "",
    POC_BASIS: "",
    RUN: "test-run",
    SUMMARY: "Delivered files",
    MESSAGE: "feat: delivered change",
  };
}

function runFailingCloseGate(script: string, repo: Repository) {
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: featureScriptEnv(repo),
  });
}

function runScript(script: string, repo: Repository, env: NodeJS.ProcessEnv = {}): string {
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    cwd: repo.root,
    env: { ...featureScriptEnv(repo), ...env },
  });
  assert.equal(result.status, 0, `script failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
}

for (const [name, definition] of definitions) {
  const exitScript = extractScript(definition, "  exit:");
  const checkpointScript = extractScript(definition, "  - id: checkpoint_push");
  const closeGateScript = extractScript(definition, "  - id: close_gate");
  const autoMergeScript = extractScript(definition, "  - id: auto_merge");

  const captureScript = extractScript(definition, "  - id: capture");
  const gateScript = extractScript(definition, "  - id: gate");
  const pushScript = extractScript(definition, "  - id: push");

  for (const signing of [true, false]) {
    test(`${name} capture signs delivery commits with configured SSH signing (${signing})`, () => {
      const repo = repository();
      try {
        const home = join(repo.root, "home");
        mkdirSync(home);
        const key = join(home, "signing-key");
        execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], { env: { ...process.env, HOME: home } });
        const signers = join(home, "allowed-signers");
        writeFileSync(signers, `feature-test@example.com ${readFileSync(`${key}.pub`, "utf8")}`);
        git(repo.worktree, "config", "gpg.format", "ssh");
        git(repo.worktree, "config", "user.signingkey", `${key}.pub`);
        git(repo.worktree, "config", "gpg.ssh.allowedSignersFile", signers);
        git(repo.worktree, "config", "commit.gpgsign", String(signing));
        writeFileSync(join(repo.worktree, "README.txt"), "signed delivery\n");
        runScript(captureScript, repo, { HOME: home });
        assert.equal(git(repo.worktree, "log", "-1", "--format=%G?"), signing ? "G" : "N");
        if (signing) git(repo.worktree, "verify-commit", "HEAD");
        const candidate = JSON.parse(readFileSync(join(repo.state, "candidate.json"), "utf8"));
        assert.equal(candidate.sha, git(repo.worktree, "rev-parse", "HEAD"));
        runScript(gateScript, repo, { HOME: home });
        assert.equal(JSON.parse(readFileSync(join(repo.state, "gate.json"), "utf8")).sha, candidate.sha);
        const sha = git(repo.worktree, "rev-parse", "HEAD");
        const dates = git(repo.worktree, "show", "-s", "--format=%at:%ct", sha);
        const checksum = execFileSync("cksum", { input: "test-run:0", encoding: "utf8" }).split(" ")[0]!;
        const epoch = 1700000000 + Number(checksum) % 100000000;
        assert.equal(dates, `${epoch}:${epoch}`);
        runScript(captureScript, repo, { HOME: home });
        assert.equal(git(repo.worktree, "rev-parse", "HEAD"), sha);
        assert.equal(git(repo.worktree, "show", "-s", "--format=%at:%ct"), dates);
        assert.equal(git(repo.worktree, "rev-list", "--count", "origin/main..HEAD"), "1");
      } finally { rmSync(repo.root, { recursive: true, force: true }); }
    });
  }

  test(`${name} terminal cleanup retains an uncaptured delivery whose HEAD is on the base`, () => {
    const repo = repository();
    try {
      writeFileSync(join(repo.worktree, "delivery"), "keep this\n");
      symlinkSync(join(repo.root, "outside"), join(repo.worktree, "escape"));
      const before = git(repo.worktree, "rev-parse", "HEAD");
      const rejected = spawnSync("bash", ["-c", captureScript], { encoding: "utf8", env: featureScriptEnv(repo) });
      assert.notEqual(rejected.status, 0);
      assert.match(runScript(exitScript, repo), /Unpublished work kept/);
      assert.equal(git(repo.worktree, "rev-parse", "HEAD"), before);
      assert.equal(readFileSync(join(repo.worktree, "delivery"), "utf8"), "keep this\n");
      assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), true);
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });

  test(`${name} captures every file kind exactly and repeats with the same candidate`, () => {
    const repo = repository();
    try {
      const base = git(repo.worktree, "rev-parse", "HEAD");
      renameSync(join(repo.worktree, "README.txt"), join(repo.worktree, "renamed.txt"));
      rmSync(join(repo.worktree, "packages/first/package.json"));
      writeFileSync(join(repo.worktree, "packages/second/package.json"), '{"name":"changed"}\n');
      const binary = Buffer.from([0, 255, 1, 10, 0, 128]);
      writeFileSync(join(repo.worktree, "new binary\nfile"), binary);
      writeFileSync(join(repo.worktree, "executable"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(repo.worktree, "executable"), 0o755);
      symlinkSync("renamed.txt", join(repo.worktree, "internal-link"));
      runScript(captureScript, repo);
      const sha = git(repo.worktree, "rev-parse", "HEAD");
      const candidate = JSON.parse(readFileSync(join(repo.state, "candidate.json"), "utf8"));
      assert.equal(candidate.sha, sha);
      assert.equal(candidate.base, base);
      assert.equal(candidate.summary, "Delivered files");
      assert.equal(candidate.message, "feat: delivered change");
      assert.equal(git(repo.worktree, "rev-list", "--count", `${base}..HEAD`), "1");
      assert.equal(git(repo.worktree, "status", "--porcelain"), "");
      assert.deepEqual(execFileSync("git", ["-C", repo.worktree, "show", `${sha}:new binary\nfile`]), binary);
      assert.equal(git(repo.worktree, "show", `${sha}:packages/second/package.json`), '{"name":"changed"}');
      assert.equal(git(repo.worktree, "show", `${sha}:renamed.txt`), "base");
      assert.equal(git(repo.worktree, "show", `${sha}:internal-link`), "renamed.txt");
      assert.match(git(repo.worktree, "ls-tree", sha, "executable"), /^100755 /);
      const changes = git(repo.worktree, "diff", "--name-status", "-M", base, sha);
      assert.match(changes, /R100\s+README.txt\s+renamed.txt/);
      assert.match(changes, /D\s+packages\/first\/package.json/);
      assert.match(readFileSync(join(repo.state, "diff.patch"), "utf8"), /GIT binary patch/);
      runScript(checkpointScript, repo);
      const count = git(repo.worktree, "rev-list", "--count", "HEAD");
      const date = git(repo.worktree, "show", "-s", "--format=%at:%ct", sha);
      assert.match(runScript(captureScript, repo), new RegExp(`candidate_sha=${sha}`));
      assert.equal(git(repo.worktree, "rev-list", "--count", "HEAD"), count);
      assert.equal(git(repo.worktree, "show", "-s", "--format=%at:%ct", sha), date);
      runScript(gateScript, repo);
      runScript(pushScript, repo);
      assert.equal(git(repo.primary, "rev-parse", `origin/${repo.branch}`), sha);
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });

  for (const rejection of ["external worktree", "other run", "owner", "branch", "linked primary", "symlink", "dangling symlink", "directory symlink"] as const) {
    test(`${name} rejects ${rejection} while preserving deliveries, refs and both run states`, () => {
      const repo = repository();
      try {
        writeFileSync(join(repo.worktree, "delivery"), "keep this\n");
        git(repo.worktree, "add", "delivery");
        const other = join(repo.primary, ".workspace/worktrees/issue-190");
        git(repo.primary, "worktree", "add", "-b", "dagu/issue-190", other, "origin/main");
        writeFileSync(join(other, "other-delivery"), "keep other\n");
        const otherState = join(dirname(repo.state), "other-run");
        mkdirSync(otherState);
        writeFileSync(join(otherState, "identity"), "other owner\n");
        const env = featureScriptEnv(repo);
        if (rejection === "external worktree") env.WORKTREE = other;
        if (rejection === "other run") env.RUN = "other-run";
        if (rejection === "owner") env.OMP_SESSION_ID = "different-session";
        if (rejection === "branch") env.BRANCH = "dagu/issue-190";
        if (rejection === "linked primary") env.PRIMARY = repo.worktree;
        if (rejection === "symlink") symlinkSync(join(other, "other-delivery"), join(repo.worktree, "escape"));
        if (rejection === "dangling symlink") symlinkSync("../../../../outside/missing", join(repo.worktree, "escape"));
        if (rejection === "directory symlink") symlinkSync(other, join(repo.worktree, "escape"), "dir");
        const snapshot = () => ({
          refs: git(repo.primary, "show-ref"),
          delivery: readFileSync(join(repo.worktree, "delivery"), "utf8"),
          other: readFileSync(join(other, "other-delivery"), "utf8"),
          index: readFileSync(git(repo.worktree, "rev-parse", "--path-format=absolute", "--git-path", "index")).toString("base64"),
          states: readdirSync(dirname(repo.state), { recursive: true, withFileTypes: true })
            .filter(entry => entry.isFile()).map(entry => [join(entry.parentPath, entry.name), readFileSync(join(entry.parentPath, entry.name), "utf8")]),
        });
        const before = snapshot();
        const result = spawnSync("bash", ["-c", captureScript], { encoding: "utf8", env });
        assert.notEqual(result.status, 0, result.stdout);
        assert.deepEqual(snapshot(), before);
      } finally { rmSync(repo.root, { recursive: true, force: true }); }
    });
  }

  test(`${name} corrections replace one candidate and require current SHA evidence for publication`, () => {
    const repo = repository();
    try {
      writeFileSync(join(repo.worktree, "README.txt"), "first\n");
      runScript(captureScript, repo);
      const first = git(repo.worktree, "rev-parse", "HEAD");
      runScript(gateScript, repo);
      const evidence = readFileSync(join(repo.state, "gate.json"), "utf8");
      writeFileSync(join(repo.worktree, "README.txt"), "corrected\n");
      runScript(captureScript, repo);
      const second = git(repo.worktree, "rev-parse", "HEAD");
      assert.notEqual(first, second);
      assert.equal(git(repo.worktree, "rev-list", "--count", "origin/main..HEAD"), "1");
      assert.equal(readFileSync(join(repo.state, "historical", first, "gate.json"), "utf8"), evidence);
      writeFileSync(join(repo.state, "gate.json"), evidence);
      const refused = spawnSync("bash", ["-c", pushScript], { encoding: "utf8", env: featureScriptEnv(repo) });
      assert.notEqual(refused.status, 0);
      assert.equal(hasRef(repo.primary, `refs/remotes/origin/${repo.branch}`), false);
      runScript(gateScript, repo);
      runScript(pushScript, repo);
      assert.equal(git(repo.primary, "rev-parse", `origin/${repo.branch}`), second);
      const evidenceNow = readFileSync(join(repo.state, "gate.json"), "utf8");
      runScript(captureScript, repo);
      assert.equal(git(repo.worktree, "rev-parse", "HEAD"), second);
      assert.equal(readFileSync(join(repo.state, "gate.json"), "utf8"), evidenceNow);
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });

  for (const conflict of [false, true]) {
    test(`${name} ${conflict ? "conflict correction stays in the same run and branch" : "clean rebase renews candidate evidence"}`, () => {
      const repo = repository();
      try {
        writeFileSync(join(repo.worktree, "README.txt"), "feature\n");
        writeFileSync(join(repo.worktree, "other-feature-file"), "preserved delivery\n");
        runScript(captureScript, repo);
        const first = git(repo.worktree, "rev-parse", "HEAD");
        runScript(gateScript, repo);
        writeFileSync(join(repo.primary, conflict ? "README.txt" : "upstream"), "upstream\n");
        git(repo.primary, "add", ".");
        git(repo.primary, "commit", "-m", "upstream change");
        git(repo.primary, "push", "origin", "main");
        const base = git(repo.primary, "rev-parse", "HEAD");
        runScript(extractScript(definition, "  - id: rebase"), repo);
        assert.equal(readFileSync(join(repo.state, "base"), "utf8").trim(), base);
        assert.ok(existsSync(join(repo.state, "historical", first, "gate.json")));
        if (conflict) {
          assert.equal(readFileSync(join(repo.state, "conflict-action"), "utf8"), "rewind\n");
          assert.match(readFileSync(join(repo.worktree, "README.txt"), "utf8"), /<<<<<<< HEAD/);
          writeFileSync(join(repo.worktree, "README.txt"), "resolved delivery\n");
          runScript(captureScript, repo);
          assert.equal(git(repo.worktree, "show", "HEAD:README.txt"), "resolved delivery");
        }
        assert.equal(git(repo.worktree, "branch", "--show-current"), repo.branch);
        assert.equal(git(repo.worktree, "rev-list", "--count", `${base}..HEAD`), "1");
        assert.equal(git(repo.worktree, "status", "--porcelain"), "");
        assert.equal(git(repo.worktree, "show", "HEAD:other-feature-file"), "preserved delivery");
        const result = spawnSync("bash", ["-c", pushScript], { encoding: "utf8", env: featureScriptEnv(repo) });
        assert.notEqual(result.status, 0);
        runScript(gateScript, repo);
        runScript(pushScript, repo);
      } finally { rmSync(repo.root, { recursive: true, force: true }); }
    });
  }

  for (const [kind, gate, statusLine] of [
    ["tracked", "printf 'changed\\n' >> README.txt", " M README.txt"],
    ["untracked", "touch generated.txt", "?? generated.txt"],
  ] as const) {
    test(`${name} gate diagnoses ${kind} changes left by GATE`, () => {
      const repo = repository();
      try {
        const result = spawnSync("bash", ["-c", extractScript(definition, "  - id: gate")], {
          encoding: "utf8",
          env: { ...featureScriptEnv(repo), GATE: gate },
        });
        assert.equal(result.status, 1);
        assert.ok(result.stderr.includes(`gate: worktree ${repo.worktree} has changes after GATE:\n${statusLine}\n`), result.stderr);
        if (kind === "tracked") assert.match(result.stderr, /README\.txt \| 1 \+/);
      } finally {
        rmSync(repo.root, { recursive: true, force: true });
      }
    });
  }

  test(`${name} gate prints the tested SHA after a clean GATE`, () => {
    const repo = repository();
    try {
      const result = spawnSync("bash", ["-c", extractScript(definition, "  - id: gate")], {
        encoding: "utf8",
        env: { ...featureScriptEnv(repo), GATE: "true" },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `tested_sha=${git(repo.worktree, "rev-parse", "HEAD")}\n`);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} rebase retries a held index lock without changing the conflict action`, () => {
    const repo = repository();
    try {
      commit(repo, "feature.txt", "feature\n");
      writeFileSync(join(repo.primary, "upstream.txt"), "upstream\n");
      git(repo.primary, "add", ".");
      git(repo.primary, "commit", "-m", "upstream");
      git(repo.primary, "push", "origin", "main");
      writeFileSync(join(repo.state, "conflict-action"), "preserved\n");
      writeFileSync(git(repo.worktree, "rev-parse", "--git-path", "index.lock"), "");
      const result = spawnSync("bash", ["-c", extractScript(definition, "  - id: rebase")], {
        encoding: "utf8", env: featureScriptEnv(repo),
      });
      assert.equal(result.status, 75, result.stderr);
      assert.ok(result.stderr.includes(`rebase: index.lock held in ${repo.worktree}`));
      assert.equal(readFileSync(join(repo.state, "conflict-action"), "utf8"), "preserved\n");
      assert.match(readFileSync(definition, "utf8"), /- id: rebase\n    depends: dependency_review\n    retry_policy:\n      limit: 3\n      interval_sec: 5\n      exit_code: \[75\]/);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} rebase records a real conflict and rewinds`, () => {
    const repo = repository();
    try {
      commit(repo, "README.txt", "feature\n");
      writeFileSync(join(repo.primary, "README.txt"), "upstream\n");
      git(repo.primary, "add", ".");
      git(repo.primary, "commit", "-m", "upstream");
      git(repo.primary, "push", "origin", "main");
      const output = runScript(extractScript(definition, "  - id: rebase"), repo);
      assert.match(output, /conflict_files=README.txt/);
      assert.equal(readFileSync(join(repo.state, "conflict-action"), "utf8"), "rewind\n");
      assert.equal(git(repo.worktree, "status", "--porcelain"), "M README.txt");
      assert.match(readFileSync(join(repo.worktree, "README.txt"), "utf8"), /<<<<<<<[\s\S]*upstream[\s\S]*=======[\s\S]*feature[\s\S]*>>>>>>>/);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });
  test(`${name} start_gate creates and reuses a worktree through a symlinked primary`, () => {
    const repo = repository();
    try {
      git(repo.primary, "worktree", "remove", repo.worktree);
      git(repo.primary, "branch", "-D", repo.branch);
      writeFileSync(join(repo.primary, ".git", "info", "exclude"), "/.workspace/\n");
      const alias = join(repo.root, "primary-link");
      symlinkSync(repo.primary, alias, "dir");
      repo.primary = alias;
      repo.worktree = join(alias, ".workspace", "worktrees", "issue-189");
      const script = extractScript(definition, "  - id: start_gate");
      const env = { ...featureScriptEnv(repo), DAGU_FEATURE_BUNDLE: "test" };
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = spawnSync("bash", ["-c", script], { encoding: "utf8", env });
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.ok(existsSync(repo.worktree));
        assert.equal(git(repo.worktree, "branch", "--show-current"), repo.branch);
        assert.ok(result.stdout.includes("worktree="));
      }
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  for (const scenario of [
    { label: "CLEAN", mergeStateStatus: "CLEAN", merge: "immediate" },
    { label: "auto-merge enabled", mergeStateStatus: "CLEAN", autoMergeRequest: { enabledAt: "2026-10-16" } },
    ...["BEHIND", "BLOCKED", "UNSTABLE", "DIRTY", "UNKNOWN"].map((mergeStateStatus) => ({
      label: mergeStateStatus, mergeStateStatus, merge: "auto",
    })),
    { label: "MERGED same head", state: "MERGED", mergeCommit: { oid: "a".repeat(40) } },
    { label: "MERGED different head", state: "MERGED", mergeCommit: { oid: "a".repeat(40) }, wrongHead: true, failure: true },
    { label: "gh observation error", ghError: true, failure: true },
    { label: "gh merge error", mergeStateStatus: "CLEAN", merge: "immediate", mergeError: true, failure: true },
  ]) {
  test(`${name} auto_merge ${scenario.label} preserves the tested body and head`, () => {
    const repo = repository();
    try {
      const trailers = [
        "Dagu-Feature-Bundle: 0.2.0",
        `Dagu-Feature-Source: pablontiv/a4s@${"a".repeat(40)}`,
        "Dagu-Feature-Bootstrap: bootstrap-test",
      ].join("\n");
      const commitBody = `Tested body, not the PR description.\nA second line with "quotes" and $variables.\n\n${trailers}`;
      git(repo.worktree, "commit", "--allow-empty", "-m", "feat: tested change", "-m", commitBody);
      const sha = git(repo.worktree, "rev-parse", "HEAD");
      recordCandidate(repo);
      runScript(extractScript(definition, "  - id: gate"), repo);
      const bin = join(repo.root, "bin");
      mkdirSync(bin, { recursive: true });
      const executable = join(bin, "gh");
      const argsFile = join(repo.root, "merge-args");
      writeFileSync(executable, `#!/bin/sh
case "$*" in
  "pr view ${repo.branch} --json headRefOid --jq .headRefOid") printf '${sha}\\n' ;;
  "pr view ${repo.branch} --json state,mergeStateStatus,autoMergeRequest,mergeCommit,headRefOid")
    ${"ghError" in scenario ? "printf 'gh failure\\n' >&2; exit 17" : `printf '%s\\n' '${JSON.stringify({
      state: "state" in scenario ? scenario.state : "OPEN",
      mergeStateStatus: "mergeStateStatus" in scenario ? scenario.mergeStateStatus : "UNKNOWN",
      autoMergeRequest: "autoMergeRequest" in scenario ? scenario.autoMergeRequest : null,
      mergeCommit: "mergeCommit" in scenario ? scenario.mergeCommit : null,
      headRefOid: "wrongHead" in scenario ? "b".repeat(40) : sha,
    })}'`} ;;
  "pr view ${repo.branch} --json number --jq .number") printf '190\\n' ;;
  "pr view ${repo.branch} --json body --jq .body") printf 'Closes #189\\n' ;;
  "pr merge "*) printf '%s\\0' "$@" > "${argsFile}"; ${"mergeError" in scenario ? "exit 18" : ":"} ;;
  *) printf 'unexpected gh invocation: %s\\n' "$*" >&2; exit 1 ;;
esac
`);
      chmodSync(executable, 0o755);
      if ("failure" in scenario) {
        const result = spawnSync("bash", ["-c", autoMergeScript], {
          encoding: "utf8", env: featureScriptEnv(repo),
        });
        assert.notEqual(result.status, 0);
        if ("ghError" in scenario || "wrongHead" in scenario) assert.equal(existsSync(argsFile), false);
        return;
      }
      assert.match(runScript(autoMergeScript, repo), new RegExp(`pr=190\\nhead_sha=${sha}`));
      if (!("merge" in scenario)) {
        assert.equal(existsSync(argsFile), false);
        return;
      }
      const mergeBody = `Closes #189\n\n${commitBody}`;
      assert.deepEqual(readFileSync(argsFile, "utf8").split("\0"), [
        "pr", "merge", repo.branch, ...(scenario.merge === "auto" ? ["--auto"] : []),
        "--squash", "--match-head-commit", sha, "--body", mergeBody, "",
      ]);
      assert.ok(mergeBody.endsWith(trailers));
      const parsed = execFileSync("git", ["interpret-trailers", "--parse"], {
        input: mergeBody,
        encoding: "utf8",
      });
      assert.equal(parsed.trim(), trailers);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });
  }

  for (const converges of [true, false]) {
    test(`${name} auto_merge ${converges ? "waits for the pushed head" : "reports expected and last observed heads on expiry"}`, () => {
      const repo = repository();
      try {
        const sha = git(repo.worktree, "rev-parse", "HEAD");
        recordCandidate(repo);
        runScript(extractScript(definition, "  - id: gate"), repo);
        const oldSha = "b".repeat(40);
        const bin = join(repo.root, "bin");
        mkdirSync(bin, { recursive: true });
        const reads = join(repo.root, "head-reads");
        const sleeps = join(repo.root, "sleeps");
        const merged = join(repo.root, "merged");
        writeFileSync(join(bin, "gh"), `#!/bin/sh
case "$*" in
  "pr view ${repo.branch} --json headRefOid --jq .headRefOid")
    n=0; test ! -f "${reads}" || n=$(cat "${reads}")
    n=$((n + 1)); printf '%s' "$n" > "${reads}"
    if ${converges ? "true" : "false"} && test "$n" -ge 3; then
      printf '${sha}\\n'
    else
      printf '${oldSha}\\n'
    fi ;;
  "pr view ${repo.branch} --json state,mergeStateStatus,autoMergeRequest,mergeCommit,headRefOid")
    printf '%s\\n' '${JSON.stringify({ state: "OPEN", mergeStateStatus: "BLOCKED", autoMergeRequest: null, mergeCommit: null, headRefOid: sha })}' ;;
  "pr view ${repo.branch} --json number --jq .number") printf '190\\n' ;;
  "pr merge "*) printf '%s\\n' "$*" > "${merged}" ;;
  *) exit 1 ;;
esac
`);
        writeFileSync(join(bin, "sleep"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${sleeps}"\n`);
        chmodSync(join(bin, "gh"), 0o755);
        chmodSync(join(bin, "sleep"), 0o755);
        const result = spawnSync("bash", ["-c", autoMergeScript], {
          encoding: "utf8", env: featureScriptEnv(repo),
        });
        assert.equal(readFileSync(reads, "utf8"), converges ? "3" : "13");
        assert.deepEqual(readFileSync(sleeps, "utf8").trim().split("\n"), Array(converges ? 2 : 12).fill("5"));
        if (converges) {
          assert.equal(result.status, 0, result.stderr);
          assert.match(readFileSync(merged, "utf8"), new RegExp(`--auto --squash --match-head-commit ${sha}`));
        } else {
          assert.notEqual(result.status, 0);
          assert.match(result.stderr, new RegExp(`auto_merge: PR head did not converge after 60s: expected ${sha}, last observed ${oldSha}`));
        }
      } finally {
        rmSync(repo.root, { recursive: true, force: true });
      }
    });
  }

  test(`${name} close_gate reports a PRIMARY outside BASE_BRANCH`, () => {
    const repo = repository();
    try {
      stubSuccessfulCloseGateGh(repo);
      git(repo.primary, "checkout", "-b", "feature-x");
      const result = runFailingCloseGate(closeGateScript, repo);
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        new RegExp(`close_gate: PRIMARY ${repo.primary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} on branch feature-x, expected main`),
      );
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} close_gate reports PRIMARY local changes and porcelain status`, () => {
    const repo = repository();
    try {
      stubSuccessfulCloseGateGh(repo);
      writeFileSync(join(repo.primary, "README.txt"), "dirty\n");
      const result = runFailingCloseGate(closeGateScript, repo);
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        new RegExp(`close_gate: PRIMARY ${repo.primary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} has local changes, expected clean`),
      );
      assert.match(result.stderr, / M README\.txt/);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} exit keeps a never-pushed branch when no PR exists and prints recovery locations`, () => {
    const repo = repository();
    try {
      commit(repo, "README.txt", "unpublished\n");
      stubGh(repo, "", 1, "no pull requests found\n");
      const output = runScript(exitScript, repo);
      assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), true);
      assert.equal(existsSync(repo.worktree), true);
      assert.match(output, new RegExp(`branch ${repo.branch.replace("/", "\\/")}`));
      assert.match(output, new RegExp(`worktree ${repo.worktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.match(output, /Terminal failure outside recovery checkpoints/);
      assert.match(output, /available for operator recovery/);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} exit cleans a squash-merged head when invoked outside the repository`, () => {
    const repo = repository();
    try {
      commit(repo, "README.txt", "squash merged\n");
      const head = git(repo.worktree, "rev-parse", "HEAD");
      git(repo.worktree, "push", "origin", `HEAD:${repo.branch}`);
      writeFileSync(join(repo.primary, "README.txt"), "squash merged\n");
      git(repo.primary, "add", "README.txt");
      git(repo.primary, "commit", "-m", "squash feature change");
      git(repo.primary, "push", "origin", "main");
      git(repo.worktree, "push", "origin", "--delete", repo.branch);
      stubGh(repo, `${JSON.stringify({ state: "MERGED", headRefOid: head })}\n`, 0);
      runScript(exitScript, repo);
      assert.equal(existsSync(repo.worktree), false);
      assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), false);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} exit keeps local commits newer than a merged PR head`, () => {
    const repo = repository();
    try {
      commit(repo, "README.txt", "published head\n");
      const mergedHead = git(repo.worktree, "rev-parse", "HEAD");
      git(repo.worktree, "push", "origin", `HEAD:${repo.branch}`);
      commit(repo, "README.txt", "new local head\n");
      git(repo.worktree, "push", "origin", "--delete", repo.branch);
      stubGh(repo, `${JSON.stringify({ state: "MERGED", headRefOid: mergedHead })}\n`, 0);
      const output = runScript(exitScript, repo);
      assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), true);
      assert.equal(existsSync(repo.worktree), true);
      assert.match(output, /Unpublished work kept/);
      assert.match(output, /Terminal failure outside recovery checkpoints/);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} exit keeps unpublished work and succeeds when gh fails`, () => {
    const repo = repository();
    try {
      commit(repo, "README.txt", "unpublished\n");
      stubGh(repo, "", 2, "GitHub unavailable\n");
      const output = runScript(exitScript, repo);
      assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), true);
      assert.equal(existsSync(repo.worktree), true);
      assert.match(output, /Unpublished work kept/);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} exit cleans a published head`, () => {
    const repo = repository();
    try {
      commit(repo, "README.txt", "published\n");
      git(repo.worktree, "push", "origin", `HEAD:${repo.branch}`);
      runScript(exitScript, repo);
      assert.equal(existsSync(repo.worktree), false);
      assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), false);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} exit cleans a head merged into the base branch`, () => {
    const repo = repository();
    try {
      commit(repo, "README.txt", "merged\n");
      git(repo.primary, "merge", "--ff-only", repo.branch);
      git(repo.primary, "push", "origin", "main");
      runScript(exitScript, repo);
      assert.equal(existsSync(repo.worktree), false);
      assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), false);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} checkpoint reviews an existing dependency added to a second package`, () => {
    const repo = repository();
    try {
      commit(repo, "packages/second/package.json", '{"dependencies":{"shared":"1.0.0"}}\n');
      runScript(checkpointScript, repo);
      assert.equal(readFileSync(join(repo.state, "dependency-action"), "utf8"), "rewind\n");
      assert.equal(readFileSync(join(repo.state, "dependencies"), "utf8"), "dependency\tpackages/second/package.json\tshared\n");
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} checkpoint completes when dependency relationships are unchanged`, () => {
    const repo = repository();
    try {
      commit(repo, "README.txt", "dependency relationships unchanged\n");
      runScript(checkpointScript, repo);
      assert.equal(readFileSync(join(repo.state, "dependency-action"), "utf8"), "complete\n");
      assert.equal(readFileSync(join(repo.state, "dependencies"), "utf8"), "");
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });
  for (const [step, downstream] of [["start_gate", "implement"], ["gate", "push"], ["push", "pr"]]) {
    test(`${name} ${step} routes failure through its recovery checkpoint`, () => {
      const source = readFileSync(definition, "utf8");
      assert.match(extractStep(source, step!), /continue_on:\n      failure: true/);
      const recovery = extractStep(source, `recover_${step}`);
      assert.ok(recovery.includes(`condition: "\${${step}.exit_code}"`));
      assert.ok(recovery.includes(`rewind_to: ${step === "gate" ? "implement" : step}`));
      assert.match(recovery, /continue_on: skipped/);
      assert.ok(extractStep(source, downstream!).includes(`depends: recover_${step}`));
    });
  }
}

for (const [name, definition] of [
  ...definitions,
  ["PoC template", fileURLToPath(new URL("../skills/dagu-feature/poc.yaml", import.meta.url))],
  ["PoC rendered DAG", fileURLToPath(new URL("../../../.workspace/dagu/dags/poc.yaml", import.meta.url))],
] as const) {
  const phases = name.startsWith("PoC") ? ["base"] : ["start", "close"];
  for (const phase of phases) {
    const detector = `detect_${phase}_primary`;
    const checkpoint = `${phase}_primary_unavailable`;
    test(`${name} ${phase} detects concrete causes, rechecks ready and wires the checkpoint`, () => {
      const repo = repository();
      try {
        const source = readFileSync(definition, "utf8");
        const block = source.split(`  - id: ${checkpoint}\n`)[1]!.split("\n  - id:")[0]!;
        assert.ok(block.includes(`depends: ${detector}`));
        assert.ok(block.includes("continue_on: skipped"));
        assert.ok(block.includes('expected: "re:^primary "'));
        assert.ok(block.includes("action: human.task"));
        assert.ok(block.includes(`rewind_to: ${detector}`));
        assert.ok(block.includes(`\${steps.${detector}.outputs.reason}`));
        const script = extractScript(definition, `  - id: ${detector}`);
        const output = join(repo.root, "outputs");
        const detect = () => {
          writeFileSync(output, "");
          const result = spawnSync("bash", ["-c", script], {
            encoding: "utf8", env: { ...featureScriptEnv(repo), DAGU_OUTPUT_FILE: output },
          });
          assert.equal(result.status, 0, result.stderr);
          return { cause: readFileSync(output, "utf8").trim(), stderr: result.stderr };
        };
        assert.equal(detect().cause, "reason=ready");
        writeFileSync(join(repo.primary, "README.txt"), "operator changes\n");
        const dirty = detect();
        assert.match(dirty.cause, /^reason=primary dirty: .*README.txt$/);
        assert.match(dirty.stderr, /primary dirty: .*README.txt/);
        git(repo.primary, "restore", "README.txt");
        git(repo.primary, "switch", "-c", "operator");
        const branch = detect();
        assert.equal(branch.cause, "reason=primary on operator, expected main");
        assert.match(branch.stderr, /primary on operator, expected main/);
        git(repo.primary, "switch", "main");
        assert.equal(detect().cause, "reason=ready");
      } finally {
        rmSync(repo.root, { recursive: true, force: true });
      }
    });
  }
}

for (const [name, definition] of [
  ...definitions,
  ["PoC template", fileURLToPath(new URL("../skills/dagu-feature/poc.yaml", import.meta.url))],
  ["PoC rendered DAG", fileURLToPath(new URL("../../../.workspace/dagu/dags/poc.yaml", import.meta.url))],
] as const) {
  const gate = name.startsWith("PoC") ? "base" : "start_gate";
  for (const failure of ["fetch", "ff-only"] as const) {
    test(`${name} ${gate} diagnoses ${failure} and preserves operator commits`, () => {
      const repo = repository();
      try {
        const managed = join(repo.primary, ".workspace", "worktrees", "issue-189");
        writeFileSync(join(repo.primary, ".git", "info", "exclude"), "/.workspace/\n");
        if (failure === "fetch") git(repo.primary, "remote", "set-url", "origin", join(repo.root, "unavailable.git"));
        else {
          commit(repo, "remote.txt", "remote commit\n");
          git(repo.worktree, "push", "origin", "HEAD:main");
          writeFileSync(join(repo.primary, "operator.txt"), "operator commit\n");
          git(repo.primary, "add", "operator.txt");
          git(repo.primary, "commit", "-m", "operator commit");
        }
        const head = git(repo.primary, "rev-parse", "HEAD");
        const result = spawnSync("bash", ["-c", extractScript(definition, `  - id: ${gate}`)], {
          encoding: "utf8",
          env: { ...featureScriptEnv(repo), WORKTREE: managed, DAGU_FEATURE_BUNDLE: "test" },
        });
        assert.equal(result.status, 1);
        assert.ok(result.stderr.includes(`${gate}: ${failure}`), result.stderr);
        assert.match(result.stderr, /restore origin access|reconcile primary/);
        assert.equal(git(repo.primary, "rev-parse", "HEAD"), head);
      } finally {
        rmSync(repo.root, { recursive: true, force: true });
      }
    });
  }
}

function extractStep(source: string, id: string): string {
  const start = source.indexOf(`  - id: ${id}\n`);
  assert.ok(start >= 0, `missing step ${id}`);
  const end = source.indexOf("\n  - id:", start + 1);
  return source.slice(start, end < 0 ? source.length : end).split("\nhandler_on:")[0]! + "\n";
}

const daguAvailable = spawnSync("dagu", ["version"], { encoding: "utf8" });
for (const [name, definition] of definitions) {
  test(`${name} real Dagu reenqueue adopts retained worktree from terminal owner`, {
    skip: daguAvailable.status !== 0 || !/2\.20\.1/.test(daguAvailable.stdout) ? "Dagu 2.20.1 binary required for live integration" : false,
    timeout: 115_000,
  }, async (t) => {
    const repo = repository();
    git(repo.primary, "worktree", "remove", repo.worktree);
    git(repo.primary, "branch", "-D", repo.branch);
    rmSync(join(repo.root, "bin", "dagu"));
    stubGh(repo, "OPEN\n", 0);
    const home = join(repo.root, "dagu-home");
    mkdirSync(join(home, "dags"), { recursive: true });
    const listener = createServer();
    await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>(resolve => listener.close(() => resolve()));
    writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\nscheduler:\n  port: 0\n`);
    const env: NodeJS.ProcessEnv = { ...process.env, ...featureScriptEnv(repo), DAGU_HOME: home, DAGU_COORDINATOR_ENABLED: "false", OMP_SESSION_ID: "retained-owner" };
    let serviceLog = "";
    const service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(port)], {
      cwd: repo.root, env, stdio: ["ignore", "pipe", "pipe"],
    });
    service.stdout.on("data", data => { serviceLog += data; });
    service.stderr.on("data", data => { serviceLog += data; });
    const api = `http://127.0.0.1:${port}/api/v1`;
    const dagu = (...args: string[]) => execFileSync("dagu", args, { env, cwd: repo.root, encoding: "utf8" }).trim();
    type Detail = { statusLabel: string; nodes: Array<{ step: { name: string }; statusLabel: string; stdout?: string; stderr?: string }>; onExit?: { statusLabel: string; stdout?: string; stderr?: string } };
    async function until<T>(description: string, probe: () => Promise<T | undefined>): Promise<T> {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const value = await probe();
        if (value !== undefined) return value;
        await delay(150);
      }
      throw new Error(`Timed out: ${description}\n${serviceLog}`);
    }
    async function state(id: string, status: string): Promise<Detail> {
      return until(`${id} ${status}`, async () => {
        const response = await fetch(`${api}/dag-runs/feature/${id}`);
        if (!response.ok) return undefined;
        const run = (await response.json() as { dagRunDetails: Detail }).dagRunDetails;
        if (run.statusLabel === status && (status !== "failed" || run.onExit?.statusLabel === "succeeded")) return run;
        if (run.nodes.some(node => node.step.name === "recover_start_gate" && node.statusLabel === "waiting")) {
          throw new Error(run.nodes.map(node => `${node.step.name}: ${node.stderr && existsSync(node.stderr) ? readFileSync(node.stderr, "utf8") : node.statusLabel}`).join("\n"));
        }
        return undefined;
      });
    }
    try {
      await until("isolated Dagu ready", async () => {
        try { return (await fetch(`${api}/dag-runs`)).ok ? true : undefined; } catch { return undefined; }
      });
      const source = readFileSync(definition, "utf8");
      const file = join(home, "dags", "feature.yaml");
      writeFileSync(file, [
        "type: graph\nshell: bash\nmax_active_steps: 1\n",
        `params:\n  - ISSUE: "189"\n  - PRIMARY: ${repo.primary}\n  - BRANCH: ${repo.branch}\n  - BASE_BRANCH: main\n  - PR_NUMBER: ""\n  - GATE: "true"\n  - REQUIRED_CHECK: validate\n  - OMP_SESSION_ID: retained-owner\n`,
        `env:\n  - PATH: ${env.PATH}\n  - WORKTREE: ${repo.worktree}\n  - RUN: \${context.run.id}\n  - DAGU_FEATURE_BUNDLE: test\n`,
        source.slice(source.indexOf("  - DAGU_RESOURCE_GUARD: |"), source.indexOf("steps:\n")),
        "steps:\n", extractStep(source, "admit"),
        "  - id: triage\n    depends: admit\n    run: echo POC=no >> \"$DAGU_OUTPUT_FILE\"\n    outputs:\n      - name: POC\n",
        "  - id: triage_decision\n    depends: triage\n    run: echo reviewed\n",
        ...["detect_start_primary", "start_primary_unavailable", "start_gate", "recover_start_gate", "implement", "capture"].map(id => extractStep(source, id)),
        "handler_on:\n", source.slice(source.indexOf("  exit:\n")),
      ].join(""));
      dagu("validate", file);
      const first = "retained-189", second = `${first}-v2`;
      dagu("enqueue", "--run-id", first, file);
      await state(first, "waiting");
      writeFileSync(join(repo.worktree, "retained.txt"), "retained candidate\n");
      git(repo.worktree, "add", ".");
      git(repo.worktree, "commit", "-m", "precommitted candidate");
      const head = git(repo.worktree, "rev-parse", "HEAD");
      dagu("human-task", "complete", "feature", "--run-id", first, "--step", "implement",
        "--input", "MESSAGE=fix: retained candidate", "--input", "SUMMARY=Retained candidate");
      const failed = await state(first, "failed");
      const capture = failed.nodes.find(node => node.step.name === "capture")!;
      assert.equal(capture.statusLabel, "failed");
      assert.match(readFileSync(capture.stderr!, "utf8"), /HEAD differs from Dagu candidate/);
      const owner = git(repo.worktree, "rev-parse", "--path-format=absolute", "--git-path", "dagu-feature-owner");
      assert.equal(JSON.parse(readFileSync(owner, "utf8")).run, first);
      dagu("enqueue", "--run-id", second, file);
      const adopted = await state(second, "waiting");
      for (const id of ["admit", "start_gate"]) assert.equal(adopted.nodes.find(node => node.step.name === id)?.statusLabel, "succeeded");
      assert.equal(adopted.nodes.find(node => node.step.name === "implement")?.statusLabel, "waiting");
      const stateDir = join(repo.primary, ".git", "dagu-feature", "runs", second);
      assert.equal(readFileSync(join(stateDir, "previous-owner"), "utf8").trim(), first);
      assert.equal(readFileSync(join(repo.primary, ".git", "dagu-feature", "owners", "issue-189"), "utf8"), `${second}\t${repo.branch}\n`);
      assert.equal(JSON.parse(readFileSync(owner, "utf8")).run, second);
      assert.equal(readFileSync(owner, "utf8"), readFileSync(join(stateDir, "identity"), "utf8"));
      assert.equal(git(repo.worktree, "rev-parse", "HEAD"), head);
      assert.equal(readFileSync(join(repo.worktree, "retained.txt"), "utf8"), "retained candidate\n");
      const retry = spawnSync("bash", ["-c", extractScript(definition, "  - id: start_gate")], {
        env: { ...env, RUN: second, DAGU_FEATURE_BUNDLE: "test" }, encoding: "utf8",
      });
      assert.equal(retry.status, 0, retry.stderr);
      const valid = readFileSync(owner, "utf8");
      writeFileSync(owner, JSON.stringify({ ...JSON.parse(valid), session: "different-session" }));
      const mismatch = spawnSync("bash", ["-c", extractScript(definition, "  - id: start_gate")], {
        env: { ...env, RUN: second, DAGU_FEATURE_BUNDLE: "test" }, encoding: "utf8",
      });
      assert.equal(mismatch.status, 1);
      assert.match(mismatch.stderr, /ownership identity mismatch.*requesting_run=retained-189-v2.*observed=.*expected=/);
      writeFileSync(owner, valid);
      const active = spawnSync("bash", ["-c", extractScript(definition, "  - id: admit")], {
        env: { ...env, RUN: `${second}-other` }, encoding: "utf8",
      });
      assert.equal(active.status, 1);
      assert.match(active.stderr, /belongs to active run retained-189-v2/);
      assert.equal(git(repo.worktree, "rev-parse", "HEAD"), head);
      const evidence = [...failed.nodes, ...adopted.nodes].filter(node => ["admit", "start_gate", "capture"].includes(node.step.name))
        .map(node => ({ step: node.step.name, status: node.statusLabel,
          stdout: node.stdout && readFileSync(node.stdout, "utf8"), stderr: node.stderr && readFileSync(node.stderr, "utf8") }));
      t.diagnostic(`Dagu ${daguAvailable.stdout.trim()}; runs=${first}:failed/capture,${second}:waiting/implement; HEAD=${head}; owner=${valid.trim()}; logs=${JSON.stringify(evidence)}; onExit=${failed.onExit?.stdout ? readFileSync(failed.onExit.stdout, "utf8") : JSON.stringify(failed.onExit)}`);
    } finally {
      service.kill("SIGTERM");
      await new Promise<void>(resolve => service.once("exit", () => resolve()));
      rmSync(repo.root, { recursive: true, force: true });
    }
  });
}
test("real Dagu retries rebase after a six-second index lock", {
  skip: daguAvailable.status !== 0 || !/2\.20\.1/.test(daguAvailable.stdout),
  timeout: 150_000,
}, async () => {
  const repo = repository();
  rmSync(join(repo.root, "bin", "dagu"));
  const home = join(repo.root, "dagu-home");
  mkdirSync(join(home, "dags"), { recursive: true });
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\n`);
  const env = { ...process.env, ...featureScriptEnv(repo), DAGU_HOME: home, DAGU_COORDINATOR_ENABLED: "false" };
  let serviceLog = "";
  const service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: repo.root, env, stdio: ["ignore", "pipe", "pipe"],
  });
  service.stdout.on("data", data => { serviceLog += data; });
  service.stderr.on("data", data => { serviceLog += data; });
  const id = `lock-retry-${randomUUID()}`;
  async function until<T>(description: string, probe: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const value = await probe();
      if (value !== undefined) return value;
      await delay(150);
    }
    throw new Error(`Timed out: ${description}\n${serviceLog}`);
  }
  let unlock: NodeJS.Timeout | undefined;
  try {
    commit(repo, "feature.txt", "feature\n");
    writeFileSync(join(repo.primary, "upstream.txt"), "upstream\n");
    git(repo.primary, "add", ".");
    git(repo.primary, "commit", "-m", "upstream");
    git(repo.primary, "push", "origin", "main");
    const lock = git(repo.worktree, "rev-parse", "--git-path", "index.lock");
    writeFileSync(lock, "");
    const source = readFileSync(definitions[0][1], "utf8");
    const step = extractStep(source, "rebase").replace("    depends: dependency_review\n", "");
    const file = join(home, "dags", "lock-retry.yaml");
    const dagEnv = Object.entries(featureScriptEnv(repo)).map(([key, value]) => `  ${key}: ${JSON.stringify(value ?? "")}`).join("\n");
    writeFileSync(file, `name: lock-retry\nenv:\n${dagEnv}\nsteps:\n${step}`);
    const api = `http://127.0.0.1:${port}/api/v1`;
    await until("isolated Dagu ready", async () => {
      try { return (await fetch(`${api}/dag-runs`)).ok ? true : undefined; } catch { return undefined; }
    });
    execFileSync("dagu", ["enqueue", "--run-id", id, file], { env });
    // Real Dagu retry scheduling crosses a process boundary and requires platform time.
    unlock = setTimeout(() => rmSync(lock, { force: true }), 6000);
    let succeeded = false;
    let evidence = "";
    for (let i = 0; i < 400; i++) {
      const response = await fetch(`${api}/dag-runs/lock-retry/${id}`);
      if (response.ok) {
        const run = (await response.json() as { dagRunDetails: {
          statusLabel: string;
          nodes: Array<{ statusLabel: string; stderr?: string }>;
        } }).dagRunDetails;
        assert.notEqual(run.statusLabel, "failed", JSON.stringify(run));
        if (run.statusLabel === "succeeded") {
          assert.equal(run.nodes[0]!.statusLabel, "succeeded");
          evidence = readFileSync(run.nodes[0]!.stderr!, "utf8");
          succeeded = true;
          break;
        }
      }
      await delay(150);
    }
    assert.ok(succeeded, "isolated retry run did not succeed");
    assert.ok(evidence.includes(`rebase: index.lock held in ${repo.worktree}`), evidence);
    assert.equal(readFileSync(join(repo.state, "conflict-action"), "utf8"), "complete\n");
  } finally {
    clearTimeout(unlock);
    if (service.exitCode === null && service.signalCode === null) {
      await new Promise<void>(resolve => {
        service.once("exit", () => resolve());
        service.kill("SIGTERM");
      });
    }
    rmSync(repo.root, { recursive: true, force: true });
  }
});

type LiveDetail = Omit<RunDetails, "nodes"> & {
  nodes: Array<{ step: { name: string }; statusLabel: string; stdout?: string; stderr?: string }>;
  onExit?: { statusLabel: string };
};

type RecoveryFixture = {
  suffix: string;
  root: string;
  home: string;
  port: number;
  env: NodeJS.ProcessEnv;
  until: <T>(description: string, probe: () => Promise<T | undefined>) => Promise<T>;
  state: (id: string, expected: string) => Promise<LiveDetail>;
  close: () => Promise<void>;
};

async function recoveryFixture(): Promise<RecoveryFixture> {
  const suffix = randomUUID();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-dagu-triage-close-")));
  const home = join(root, "dagu-home");
  mkdirSync(join(home, "dags"), { recursive: true });
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const env = { ...process.env, DAGU_HOME: home, DAGU_COORDINATOR_ENABLED: "false" };
  writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\nscheduler:\n  port: 0\n`);
  let serviceLog = "";
  const service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: root, env, stdio: ["ignore", "pipe", "pipe"],
  });
  service.stdout.on("data", data => { serviceLog += data; });
  service.stderr.on("data", data => { serviceLog += data; });
  const api = `http://127.0.0.1:${port}/api/v1`;
  async function until<T>(description: string, probe: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const value = await probe();
      if (value !== undefined) return value;
      await delay(150);
    }
    throw new Error(`Timed out: ${description}\n${serviceLog}`);
  }
  async function state(id: string, expected: string): Promise<LiveDetail> {
    return until(`${id} ${expected}`, async () => {
      const response = await fetch(`${api}/dag-runs/feature/${id}`);
      if (!response.ok) return undefined;
      const run = (await response.json() as { dagRunDetails: LiveDetail }).dagRunDetails;
      assert.equal(run.name, "feature");
      assert.equal(run.dagRunId, id);
      if (["failed", "aborted"].includes(run.statusLabel)) {
        const logs = run.nodes.filter(node => node.stderr).map(node => `${node.step.name}: ${readFileSync(node.stderr!, "utf8")}`).join("\n");
        const log = (run as LiveDetail & { log?: string }).log;
        throw new Error(`${JSON.stringify(run)}\n${logs}\n${log && existsSync(log) ? readFileSync(log, "utf8") : ""}\n${serviceLog}`);
      }
      return run.statusLabel === expected ? run : undefined;
    });
  }
  async function close(): Promise<void> {
    if (service.exitCode === null && service.signalCode === null) {
      await new Promise<void>(resolve => {
        service.once("exit", () => resolve());
        service.kill("SIGTERM");
      });
    }
    rmSync(root, { recursive: true, force: true });
  }
  try {
    await until("isolated Dagu ready", async () => {
      try { return (await fetch(`${api}/dag-runs`)).ok ? true : undefined; } catch { return undefined; }
    });
    return { suffix, root, home, port, env, until, state, close };
  } catch (error) {
    await close();
    throw error;
  }
}

type RecoveryMode = "healthy" | "gate" | "start_gate" | "push";
type RecoveryResult = {
  dag: string;
  id: string;
  checkpoints: Array<{ step: string; iteration: number }>;
  iteration: number;
  candidateSHA: string;
  socket: string;
  repositoryRoot: string;
};

async function runRecovery(fixture: RecoveryFixture, definition: string, mode: RecoveryMode): Promise<RecoveryResult> {
  const { suffix, root, home, env, until, state } = fixture;
  const id = `recovery-${mode}-${suffix}`;
  const repo = repository();
  repo.state = join(repo.primary, ".git", "dagu-feature", "runs", id);
  const checkpoints: Array<{ step: string; iteration: number }> = [];
  try {
    git(repo.primary, "worktree", "remove", repo.worktree);
    git(repo.primary, "branch", "-D", repo.branch);
    repo.worktree = join(repo.primary, ".workspace", "worktrees", "issue-189");
    writeFileSync(join(repo.primary, ".git", "info", "exclude"), "/.workspace/\n");
    const remote = git(repo.primary, "remote", "get-url", "origin");
    if (mode === "start_gate") git(repo.primary, "remote", "set-url", "origin", join(repo.root, "unavailable.git"));
    const bin = join(repo.root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${repo.root}/gh.log'\nprintf '{"number":189,"url":"https://example.test/pr/189"}\\n'\n`);
    chmodSync(join(bin, "gh"), 0o755);
    if (mode === "push") {
      const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" push "*)\nif ! test -f '${repo.root}/allow-push'; then echo 'push: simulated remote access failure' >&2; exit 1; fi\n;;\nesac\nexec '${realGit}' "$@"\n`);
      chmodSync(join(bin, "git"), 0o755);
    }
    const source = readFileSync(definition, "utf8");
    const script = [
      "type: graph\nshell: bash\nmax_active_steps: 1\n",
      `params:\n  - ISSUE: "189"\n  - PRIMARY: ${repo.primary}\n  - BRANCH: ${repo.branch}\n  - BASE_BRANCH: main\n  - PR_NUMBER: ""\n  - GATE: test -f required.txt\n  - REQUIRED_CHECK: validate\n  - OMP_SESSION_ID: recovery-owner\n`,
      `env:\n  - PATH: ${bin}:${process.env.PATH}\n  - WORKTREE: ${repo.worktree}\n  - RUN: \${context.run.id}\n  - DAGU_FEATURE_BUNDLE: test\n`,
      source.slice(source.indexOf("  - DAGU_RESOURCE_GUARD: |"), source.indexOf("steps:\n")),
      "steps:\n",
      `  - id: triage\n    run: |\n      mkdir -p "$(git -C "$PRIMARY" rev-parse --path-format=absolute --git-path "dagu-feature/runs/$RUN")"\n      echo POC=no >> "$DAGU_OUTPUT_FILE"\n    outputs:\n      - name: POC\n`,
      "  - id: triage_decision\n    depends: triage\n    run: echo reviewed\n",
      ...["detect_start_primary", "start_primary_unavailable", "start_gate", "recover_start_gate", "implement",
        "capture", "checkpoint_push", "dependency_review", "rebase", "conflict_review", "gate", "recover_gate", "push", "recover_push", "pr"]
        .map(step => extractStep(source, step)),
      "  - id: await_merge\n    depends: pr\n    action: human.task\n    with:\n      prompt: Isolated merge boundary\n",
      source.slice(source.indexOf("handler_on:\n"), source.indexOf("  exit:\n")),
    ].join("");
    rmSync(join(repo.root, "bin", "dagu"));
    const dag = join(home, "dags", "feature.yaml");
    writeFileSync(dag, script);
    const dagu = (...args: string[]) => execFileSync("dagu", args, {
      cwd: root, env: { ...env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const iteration = () => Number(dagu("status", "feature", "--run-id", id).match(/push-back iteration: (\d+)/)?.[1] ?? 0);
    async function waiting(step: string): Promise<LiveDetail> {
      const run = await until(`${id} waiting ${step}`, async () => {
        const run = await state(id, "waiting");
        return run.nodes.some(node => node.step.name === step && node.statusLabel === "waiting") ? run : undefined;
      });
      checkpoints.push({ step, iteration: iteration() });
      return run;
    }
    function transition(step: string, pushBack = false): void {
      const observed = iteration();
      dagu("human-task", pushBack ? "push-back" : "complete", "feature", "--run-id", id, "--step", step,
        ...(pushBack ? ["--expected-iteration", String(observed)] : []),
        ...(!pushBack && step === "implement" ? ["--input", "SUMMARY=Recovery candidate", "--input", "MESSAGE=fix: recover candidate"] : []));
    }
    const candidate = () => JSON.parse(readFileSync(join(repo.state, "candidate.json"), "utf8")) as { sha: string };
    dagu("validate", dag);
    dagu("enqueue", "--run-id", id, dag);
    if (mode === "start_gate") {
      const run = await waiting("recover_start_gate");
      assert.equal(run.nodes.find(node => node.step.name === "start_gate")?.statusLabel, "failed");
      assert.match(new Transitions("recovery-owner").observe(run).wakeMessage ?? "", /step=recover_start_gate.*cause=start_gate failed/);
      git(repo.primary, "remote", "set-url", "origin", remote);
      transition("recover_start_gate", true);
    }
    await waiting("implement");
    const delivery = mode === "gate" ? "candidate.txt" : "required.txt";
    writeFileSync(join(repo.worktree, delivery), `candidate ${id}\n`);
    const before = iteration();
    assert.equal(before, mode === "start_gate" ? 1 : 0);
    transition("implement");
    let previousCandidate: string | undefined;
    if (mode === "gate") {
      const failed = await waiting("recover_gate");
      assert.equal(failed.nodes.find(node => node.step.name === "gate")?.statusLabel, "failed");
      const notice = new Transitions("recovery-owner").observe(failed).wakeMessage;
      assert.match(notice ?? "", /step=recover_gate.*cause=gate failed/);
      previousCandidate = candidate().sha;
      transition("recover_gate", true);
      await waiting("implement");
      assert.equal(iteration(), before + 1);
      assert.equal(git(repo.worktree, "rev-parse", "HEAD"), previousCandidate);
      writeFileSync(join(repo.worktree, "required.txt"), "fixed\n");
      transition("implement");
    } else if (mode === "push") {
      const failed = await waiting("recover_push");
      assert.equal(failed.nodes.find(node => node.step.name === "push")?.statusLabel, "failed");
      assert.match(new Transitions("recovery-owner").observe(failed).wakeMessage ?? "", /step=recover_push.*cause=push failed/);
      previousCandidate = candidate().sha;
      writeFileSync(join(repo.root, "allow-push"), "");
      transition("recover_push", true);
    }
    const done = await waiting("await_merge");
    for (const step of ["start_gate", "gate", "push"]) {
      assert.equal(done.nodes.find(node => node.step.name === step)?.statusLabel, "succeeded");
      assert.equal(done.nodes.find(node => node.step.name === `recover_${step}`)?.statusLabel, "skipped");
    }
    const candidateSHA = candidate().sha;
    assert.equal(git(repo.worktree, "rev-parse", "HEAD"), candidateSHA);
    assert.equal(git(repo.primary, "rev-parse", `origin/${repo.branch}`), candidateSHA);
    assert.equal(JSON.parse(readFileSync(join(repo.state, "gate.json"), "utf8")).sha, candidateSHA);
    assert.equal(git(repo.worktree, "show", `${candidateSHA}:${delivery}`), `candidate ${id}`);
    if (mode === "gate") {
      assert.notEqual(candidateSHA, previousCandidate);
      assert.equal(JSON.parse(readFileSync(join(repo.state, "historical", previousCandidate!, "candidate.json"), "utf8")).sha, previousCandidate);
    } else if (mode === "push") assert.equal(candidateSHA, previousCandidate);
    const finalIteration = iteration();
    assert.equal(finalIteration, mode === "healthy" ? 0 : 1);
    assert.equal(git(repo.worktree, "branch", "--show-current"), repo.branch);
    assert.equal(git(repo.worktree, "status", "--porcelain"), "");
    assert.match(readFileSync(join(repo.root, "gh.log"), "utf8"), /pr view/);
    return {
      dag: done.name, id: done.dagRunId, checkpoints, iteration: finalIteration, candidateSHA,
      socket: `/tmp/@dagu_feature_${createHash("md5").update(`feature${id}`).digest("hex").slice(0, 6)}.sock`,
      repositoryRoot: repo.root,
    };
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}

for (const [name, definition] of definitions) {
  test(`${name} real Dagu closes implementation runs and succeeds after enqueuing a PoC`, {
    skip: daguAvailable.status !== 0 || !/2\.20\.1/.test(daguAvailable.stdout) ? "Dagu 2.20.1 binary required for live integration" : false,
    timeout: 360_000,
  }, async (t) => {
    assert.match(daguAvailable.stdout, /2\.20\.1/);
    const fixture = await recoveryFixture();
    const { root, home, env, state } = fixture;
    try {
      for (const mode of ["healthy", "gate", "start_gate", "push"] as const) {
        await t.test(`integrated recovery ${mode}`, async () => {
          await runRecovery(fixture, definition, mode);
        });
      }
      for (const mode of ["poc", "implementation-ready", "implementation-blocked"] as const) {
        await t.test(mode, async () => {
          const repo = repository();
          try {
            if (mode === "poc") {
              // The only GitHub effect on this path is the triage comment.
              const gh = join(repo.root, "bin", "gh");
              mkdirSync(dirname(gh), { recursive: true });
              writeFileSync(gh, '#!/bin/sh\ncase "$*" in\n  "issue comment 189 --body-file "*) exit 0 ;;\n  *) echo "unexpected gh $*" >&2; exit 1 ;;\nesac\n');
              chmodSync(gh, 0o755);
            } else stubSuccessfulCloseGateGh(repo);
            git(repo.primary, "worktree", "remove", repo.worktree);
            git(repo.primary, "branch", "-D", repo.branch);
            repo.worktree = join(repo.primary, ".workspace", "worktrees", "issue-189");
            writeFileSync(join(repo.primary, ".git", "info", "exclude"), "/.workspace/\n");
            const pocDefinition = join(repo.primary, ".workspace", "dagu", "dags", "poc.yaml");
            mkdirSync(dirname(pocDefinition), { recursive: true });
            writeFileSync(pocDefinition, "steps:\n  - id: experiment\n    run: echo isolated-poc\n");
            const source = readFileSync(definition, "utf8");
            const triage = `  - id: triage\n    run: |\n      printf 'POC=${mode === "poc" ? "yes" : "no"}\\nQUESTION=runtime behavior\\nBASIS=regression test\\nREVIEW=fixture\\n' >> "$DAGU_OUTPUT_FILE"\n    outputs:\n      - name: POC\n      - name: QUESTION\n      - name: BASIS\n      - name: REVIEW\n`;
            // Reviewer verification and implementation/merge are outside this routing test.
            // Keep the production start/close gates, conditional checkpoints and exit handler.
            const decision = mode === "poc" ? extractStep(source, "triage_decision")
              : "  - id: triage_decision\n    depends: triage\n    run: echo reviewed-implementation\n";
            const implementation = `  - id: implement\n    depends: start_gate\n    run: ${mode === "implementation-blocked" ? 'printf "operator changes\\n" > "$PRIMARY/README.txt"' : "echo implementation"}\n  - id: await_merge\n    depends: implement\n    run: echo merged\n`;
            const script = [
              "type: graph\nshell: bash\nmax_active_steps: 1\n",
              `params:\n  - ISSUE: "189"\n  - PRIMARY: ${repo.primary}\n  - BRANCH: ${repo.branch}\n  - BASE_BRANCH: main\n  - PR_NUMBER: ""\n  - GATE: "true"\n  - REQUIRED_CHECK: validate\n  - OMP_SESSION_ID: close-owner\n`,
              `env:\n  - PATH: ${join(repo.root, "bin")}:${process.env.PATH}\n  - WORKTREE: ${repo.worktree}\n  - RUN: \${context.run.id}\n  - DAGU_FEATURE_BUNDLE: test\n`,
              source.slice(source.indexOf("  - DAGU_RESOURCE_GUARD: |"), source.indexOf("steps:\n")),
              "steps:\n", triage, decision,
              ...["detect_start_primary", "start_primary_unavailable", "start_gate"].map(id => extractStep(source, id)),
              implementation,
              ...["detect_close_primary", "close_primary_unavailable", "close_gate"].map(id => extractStep(source, id)),
              "handler_on:\n", source.slice(source.indexOf("  exit:\n")),
            ].join("");
            const dag = join(home, "dags", "feature.yaml");
            writeFileSync(dag, script);
            rmSync(join(repo.root, "bin", "dagu"));
            const runEnv = { ...env, PATH: `${join(repo.root, "bin")}:${process.env.PATH}` };
            const dagu = (...args: string[]) => execFileSync("dagu", args, {
              cwd: root, env: runEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
            }).trim();
            const id = `${mode}-${randomUUID()}`;
            dagu("enqueue", "--run-id", id, dag);
            if (mode === "implementation-blocked") {
              const waiting = await state(id, "waiting");
              assert.equal(waiting.nodes.find(node => node.step.name === "close_primary_unavailable")?.statusLabel, "waiting");
              assert.equal(waiting.nodes.find(node => node.step.name === "close_gate")?.statusLabel, "not_started");
              assert.equal(existsSync(repo.worktree), true);
              git(repo.primary, "restore", "README.txt");
              dagu("human-task", "push-back", "feature", "--run-id", id, "--step", "close_primary_unavailable", "--expected-iteration", "0");
            }
            const done = await state(id, "succeeded");
            const status = (step: string) => done.nodes.find(node => node.step.name === step)?.statusLabel;
            assert.equal(status("triage_decision"), "succeeded");
            assert.equal(status("await_merge"), mode === "poc" ? "skipped" : "succeeded");
            assert.equal(status("detect_close_primary"), mode === "poc" ? "skipped" : "succeeded");
            assert.equal(status("close_primary_unavailable"), "skipped");
            assert.equal(status("close_gate"), mode === "poc" ? "skipped" : "succeeded");
            assert.equal(done.onExit?.statusLabel, "succeeded", JSON.stringify(done));
            assert.equal(existsSync(repo.worktree), false);
            assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), false);
            const transitions = new Transitions("close-owner");
            transitions.observe({ ...done, statusLabel: "running" }, { baseline: true });
            assert.deepEqual(transitions.observe(done), {
              notification: { message: "dagu · feature #189 succeeded", type: "info" },
              wakeMessage: `[DAGU STATE] run=${id} status=succeeded issue=189 bundle=unstamped extension=${BUNDLE_VERSION} compat=unstamped`,
            });
            if (mode === "poc") {
              assert.match(dagu("history", "poc", "--run-id", `poc-${id}`), new RegExp(`poc-${id}`));
            }
          } finally {
            rmSync(repo.root, { recursive: true, force: true });
          }
        });
      }
    } finally {
      await fixture.close();
    }
  });
}

test("concurrent recovery fixtures keep distinct run identities", {
  skip: daguAvailable.status !== 0 || !/2\.20\.1/.test(daguAvailable.stdout) ? "Dagu 2.20.1 binary required for live integration" : false,
  timeout: 360_000,
}, async (t) => {
  const active = new Set<RecoveryFixture>();
  try {
    const started = await Promise.allSettled(definitions.map(async () => {
      const fixture = await recoveryFixture();
      active.add(fixture);
      return fixture;
    }));
    for (const result of started) {
      if (result.status === "rejected") throw result.reason;
    }
    const [first, second] = [...active];
    assert.ok(first && second);
    assert.notEqual(first.home, second.home);
    assert.notEqual(first.port, second.port);
    assert.notEqual(first.suffix, second.suffix);
    let lastId = "";
    for (const mode of ["healthy", "gate", "start_gate", "push"] as const) {
      const runs: PromiseSettledResult<RecoveryResult>[] = await Promise.allSettled([
        runRecovery(first, definitions[0][1], mode),
        runRecovery(second, definitions[1][1], mode),
      ]);
      const [left, right] = runs.map(result => {
        if (result.status === "rejected") throw result.reason;
        return result.value;
      });
      assert.ok(left && right);
      assert.equal(left.dag, "feature");
      assert.equal(right.dag, "feature");
      assert.notEqual(`${left.dag}/${left.id}`, `${right.dag}/${right.id}`);
      assert.notEqual(left.socket, right.socket);
      assert.notEqual(left.candidateSHA, right.candidateSHA);
      const expected = mode === "healthy"
        ? [{ step: "implement", iteration: 0 }, { step: "await_merge", iteration: 0 }]
        : mode === "start_gate"
          ? [{ step: "recover_start_gate", iteration: 0 }, { step: "implement", iteration: 1 }, { step: "await_merge", iteration: 1 }]
          : [
            { step: "implement", iteration: 0 }, { step: `recover_${mode}`, iteration: 0 },
            ...(mode === "gate" ? [{ step: "implement", iteration: 1 }] : []),
            { step: "await_merge", iteration: 1 },
          ];
      const outcomes: Array<[RecoveryFixture, RecoveryResult]> = [[first, left], [second, right]];
      for (const [fixture, result] of outcomes) {
        assert.equal(result.id, `recovery-${mode}-${fixture.suffix}`);
        assert.deepEqual(result.checkpoints, expected);
        assert.equal(result.iteration, mode === "healthy" ? 0 : 1);
        assert.equal(existsSync(result.repositoryRoot), false);
        t.diagnostic(JSON.stringify({ home: fixture.home, port: fixture.port, ...result }));
      }
      lastId = right.id;
    }
    await first.close();
    active.delete(first);
    assert.equal(existsSync(first.root), false);
    assert.equal(existsSync(second.home), true);
    const surviving = await second.state(lastId, "waiting");
    assert.equal(surviving.nodes.find(node => node.step.name === "await_merge")?.statusLabel, "waiting");
    execFileSync("dagu", ["human-task", "complete", "feature", "--run-id", lastId, "--step", "await_merge"], {
      cwd: second.root, env: second.env, stdio: ["ignore", "pipe", "pipe"],
    });
    await second.state(lastId, "succeeded");
    await second.close();
    active.delete(second);
    assert.equal(existsSync(second.root), false);
  } finally {
    await Promise.all([...active].map(fixture => fixture.close()));
  }
});
