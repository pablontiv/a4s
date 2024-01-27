import { renderedFeature, renderedPoc } from "../fixtures/rendered-feature.ts";
import { copyRepositorySeed, normalizedFixtureSnapshot, SEED_COMMIT_DATE, settleCopiedRepository } from "../fixtures/repository-seed.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { stubHistory, withResourceGuard } from "../resource-fixtures.ts";
import { a4sBin } from "../fixtures/a4s.ts";

const featureDefinitions = [
  ["template", fileURLToPath(new URL("../../skills/issue-execution/feature.yaml", import.meta.url))],
  ["rendered DAG", fileURLToPath(new URL(renderedFeature, import.meta.url))],
] as const;
const pocDefinitions = [
  ["template", fileURLToPath(new URL("../../skills/issue-execution/poc.yaml", import.meta.url))],
  ["rendered DAG", fileURLToPath(new URL(renderedPoc, import.meta.url))],
] as const;

function extractScript(definition: string, marker: string, after = 0): string {
  const lines = readFileSync(definition, "utf8").split("\n");
  const markerIndex = lines.indexOf(marker, after);
  assert.notEqual(markerIndex, -1, `missing ${marker} in ${definition}`);
  const anchor = lines.indexOf("    run: &feature_cleanup |");
  const runIndex = anchor >= 0 && (marker === "  exit:" || marker === "  - id: close_gate")
    ? anchor : lines.indexOf("    run: |", markerIndex);
  assert.notEqual(runIndex, -1, `missing run block after ${marker}`);
  let end = runIndex + 1;
  while (end < lines.length && (lines[end]!.startsWith("      ") || lines[end] === "")) end++;
  return withResourceGuard((marker === "  - id: close_gate" ? "CLEANUP_CLOSE=true\n" : "") +
    lines.slice(runIndex + 1, end).map((line) => line.slice(6)).join("\n"), definition);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
function hasRef(cwd: string, ref: string): boolean {
  return spawnSync("git", ["-C", cwd, "show-ref", "--verify", "--quiet", ref]).status === 0;
}

type Repo = { root: string; outside: string; primary: string; remote: string; worktree: string; branch: string };

function buildCleanupSeed(root: string, branch: string, worktreeName: string): void {
  const outside = join(root, "dagu-run-root");
  const primary = join(root, "primary");
  const remote = join(root, "remote.git");
  const worktree = join(primary, ".workspace", "worktrees", worktreeName);
  mkdirSync(outside);
  execFileSync("git", ["init", "--bare", "-b", "main", remote]);
  execFileSync("git", ["init", "-b", "main", primary]);
  git(primary, "config", "user.name", "Lifecycle Test");
  git(primary, "config", "user.email", "lifecycle@example.com");
  git(primary, "remote", "add", "origin", remote);
  writeFileSync(join(primary, "value.txt"), "base\n");
  git(primary, "add", ".");
  execFileSync("git", ["-C", primary, "-c", "commit.gpgsign=false", "commit", "-m", "base"], {
    env: { ...process.env, GIT_AUTHOR_DATE: SEED_COMMIT_DATE, GIT_COMMITTER_DATE: SEED_COMMIT_DATE },
  });
  git(primary, "push", "-u", "origin", "main");
  writeFileSync(join(primary, ".git", "info", "exclude"), "/.workspace/worktrees/\n");
  mkdirSync(join(primary, ".workspace", "worktrees"), { recursive: true });
  git(primary, "worktree", "add", "-b", branch, worktree, "origin/main");
  stubHistory(root);
  register({ root, outside, primary, remote, worktree, branch });
}

function materializeCleanup(branch: string, worktreeName: string, fresh: boolean): Repo {
  const root = fresh
    ? realpathSync(mkdtempSync(join(tmpdir(), "omp-dagu-cleanup-")))
    : copyRepositorySeed(`cleanup:${branch}:${worktreeName}`, "omp-dagu-cleanup-", seed => buildCleanupSeed(seed, branch, worktreeName));
  if (fresh) buildCleanupSeed(root, branch, worktreeName);
  const primary = join(root, "primary");
  const repo: Repo = {
    root,
    outside: join(root, "dagu-run-root"),
    primary,
    remote: join(root, "remote.git"),
    worktree: join(primary, ".workspace", "worktrees", worktreeName),
    branch,
  };
  if (!fresh) settleCopiedRepository([repo.primary, repo.worktree]);
  return repo;
}

function repository(branch = "dagu/issue-209", worktreeName = "issue-209"): Repo {
  return materializeCleanup(branch, worktreeName, false);
}

function state(repo: Repo): string {
  return git(repo.primary, "rev-parse", "--path-format=absolute", "--git-path", "dagu-feature/runs/test-run");
}

function owner(repo: Repo): string {
  const hash = execFileSync("git", ["hash-object", "--stdin"], { input: repo.branch, encoding: "utf8" }).trim();
  return git(repo.primary, "rev-parse", "--path-format=absolute", "--git-path", `dagu-feature/resources/${hash}.json`);
}

function register(repo: Repo): void {
  mkdirSync(state(repo), { recursive: true });
  mkdirSync(join(owner(repo), ".."), { recursive: true });
  const resource = JSON.stringify({ run: "test-run", primary: realpathSync(repo.primary), branch: repo.branch, worktree: realpathSync(repo.worktree) });
  writeFileSync(join(state(repo), "resource.json"), resource);
  writeFileSync(owner(repo), resource);
}

function featureCommit(repo: Repo): string {
  writeFileSync(join(repo.worktree, "value.txt"), "feature\n");
  git(repo.worktree, "add", "value.txt");
  git(repo.worktree, "commit", "-m", "feature");
  writeFileSync(join(state(repo), "candidate.json"), JSON.stringify({ sha: git(repo.worktree, "rev-parse", "HEAD") }) + "\n");
  writeFileSync(join(state(repo), "tested-sha"), git(repo.worktree, "rev-parse", "HEAD") + "\n");
  return git(repo.worktree, "rev-parse", "HEAD");
}

function squashMerge(repo: Repo, deleteRemote: boolean): string {
  const tested = featureCommit(repo);
  git(repo.worktree, "push", "origin", `HEAD:${repo.branch}`);
  writeFileSync(join(repo.primary, "value.txt"), "feature\n");
  git(repo.primary, "add", "value.txt");
  git(repo.primary, "commit", "-m", "squash feature");
  git(repo.primary, "push", "origin", "main");
  if (deleteRemote) git(repo.primary, "push", "origin", "--delete", repo.branch);
  return tested;
}

function stubGh(repo: Repo, tested: string, overrides: Record<string, unknown> = {}): void {
  const bin = join(repo.root, "bin");
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, "gh");
  const pr = JSON.stringify({ number: 209, state: "MERGED", headRefOid: tested, mergeCommit: { oid: git(repo.primary, "rev-parse", "HEAD") }, ...overrides });
  writeFileSync(executable, `#!/bin/sh
case "$*" in
  api*|"repo view"*) ;;
  *) if ! git -C "$PWD" rev-parse --git-dir >/dev/null 2>&1 && [ "$1 $2" != "pr view" ] && [ "$1 $2" != "pr checks" ]; then
    printf 'fatal: not a git repository\n' >&2
    exit 2
  fi ;;
esac
case "$*" in
  *"pr view"*) printf '%s\\n' ${JSON.stringify(pr)} ;;
  *"pr checks"*) printf 'SUCCESS\\n' ;;
  "repo view ${repo.remote} --json nameWithOwner --jq .nameWithOwner") printf 'fixture/repo\\n' ;;
  "api repos/fixture/repo/pulls/209") printf '{"changed_files":1}\\n' ;;
  "api --paginate --slurp repos/fixture/repo/pulls/209/files?per_page=100") printf '[[{"filename":"value.txt"}]]\\n' ;;
  *) printf 'unexpected gh arguments: %s\\n' "$*" >&2; exit 3 ;;
esac
`);
  chmodSync(executable, 0o755);
}

function stubGitNoop(repo: Repo, operation: "worktree" | "branch" | "remote"): void {
  const executable = join(repo.root, "bin", "git");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const registeredWorktree = git(repo.worktree, "rev-parse", "--show-toplevel");
  const cases = operation === "worktree"
    ? `*"worktree remove"*|*"update-ref -d"*) exit 0 ;;
  *"worktree list"*) ${JSON.stringify(realGit)} "$@"; printf 'worktree %s\\n' ${JSON.stringify(registeredWorktree)}; exit 0 ;;`
    : operation === "branch"
      ? '*"update-ref -d"*|*"branch -D"*) exit 0 ;;'
      : '*"push --force-with-lease="*) exit 0 ;;';
  writeFileSync(executable, `#!/bin/sh
case " $* " in
  ${cases}
esac
exec ${JSON.stringify(realGit)} "$@"
`);
  chmodSync(executable, 0o755);
}

function run(script: string, repo: Repo, extra: Record<string, string> = {}) {
  return spawnSync("bash", ["-c", script], {
    cwd: repo.outside,
    encoding: "utf8",
    env: {
      HOME: process.env.HOME,
      A4S_BIN: a4sBin,
      // Pipes can look like remote-shell stdin; preserve the fixture's stub PATH.
      SHLVL: "1",
      PATH: `${join(repo.root, "bin")}:${process.env.PATH ?? ""}`,
      ISSUE: "209",
      PR_NUMBER: "",
      PRIMARY: repo.primary,
      WORKTREE: repo.worktree,
      BRANCH: repo.branch,
      BASE_BRANCH: "main",
      GATE: "npm test",
      REQUIRED_CHECK: "validate",
      OMP_SESSION_ID: "",
      POC_BASIS: "",
      RUN: "test-run",
      ...extra,
    },
  });
}

for (const [name, definition] of featureDefinitions) {
  const closeGate = extractScript(definition, "  - id: close_gate");
  const exit = extractScript(definition, "  exit:");
  test(`${name} exit retains an uncaptured base head without integration proof`, () => {
    for (const dirty of [false, true]) {
      const repo = repository();
      try {
        if (dirty) writeFileSync(join(repo.worktree, "value.txt"), "uncaptured work\n");
        const head = git(repo.worktree, "rev-parse", "HEAD");
        const result = run(exit, repo);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stderr, /no captured candidate/);
        assert.equal(existsSync(repo.worktree), true);
        assert.equal(git(repo.worktree, "rev-parse", "HEAD"), head);
        assert.equal(readFileSync(join(repo.worktree, "value.txt"), "utf8"), dirty ? "uncaptured work\n" : "base\n");
        assert.equal(readFileSync(join(state(repo), "cleanup-head"), "utf8"), head + "\n");
        assert.equal(readFileSync(join(state(repo), "cleanup-phase"), "utf8"), "identify\n");
        assert.equal(existsSync(join(state(repo), "cleanup-proof.json")), false);
      } finally { rmSync(repo.root, { recursive: true, force: true }); }
    }
  });

  test(`${name} close_gate succeeds after failed-attempt cleanup, capture, rebase and squash merge`, () => {
    const repo = repository();
    try {
      const base = git(repo.worktree, "rev-parse", "HEAD");
      const identity = JSON.stringify({
        primary: repo.primary, worktree: repo.worktree, branch: repo.branch, run: "test-run", session: "",
      }) + "\n";
      writeFileSync(join(state(repo), "identity"), identity);
      writeFileSync(git(repo.worktree, "rev-parse", "--path-format=absolute", "--git-path", "dagu-feature-owner"), identity);
      writeFileSync(join(state(repo), "base"), base + "\n");
      writeFileSync(join(state(repo), "initial-head"), base + "\n");
      writeFileSync(join(repo.worktree, "value.txt"), "retried implementation\n");
      const failedExit = run(exit, repo);
      assert.equal(failedExit.status, 0, failedExit.stderr);
      assert.match(failedExit.stderr, /no captured candidate/);
      assert.equal(readFileSync(join(state(repo), "cleanup-phase"), "utf8"), "identify\n");
      assert.equal(existsSync(join(state(repo), "cleanup-proof.json")), false);

      const capture = run(extractScript(definition, "  - id: capture"), repo, {
        SUMMARY: "Retried implementation", MESSAGE: "fix: retry implementation", IMPLEMENTER: "CleanupTest",
      });
      assert.equal(capture.status, 0, capture.stdout + capture.stderr);
      const captured = git(repo.worktree, "rev-parse", "HEAD");
      assert.notEqual(captured, base);
      stubGh(repo, captured, { state: "OPEN" });
      const capturedExit = run(exit, repo);
      assert.equal(capturedExit.status, 0, capturedExit.stderr);
      assert.match(capturedExit.stderr, /PR is not MERGED/);
      assert.equal(readFileSync(join(state(repo), "cleanup-head"), "utf8"), captured + "\n");
      assert.equal(existsSync(join(state(repo), "cleanup-proof.json")), false);

      writeFileSync(join(repo.primary, "upstream.txt"), "base advanced\n");
      git(repo.primary, "add", "upstream.txt");
      git(repo.primary, "commit", "-m", "advance base");
      git(repo.primary, "push", "origin", "main");
      const rebase = run(extractScript(definition, "  - id: rebase"), repo);
      assert.equal(rebase.status, 0, rebase.stdout + rebase.stderr);
      const rebased = git(repo.worktree, "rev-parse", "HEAD");
      assert.notEqual(rebased, captured);
      writeFileSync(join(state(repo), "tested-sha"), rebased + "\n");
      git(repo.worktree, "push", "origin", `HEAD:${repo.branch}`);
      git(repo.primary, "merge", "--squash", repo.branch);
      git(repo.primary, "commit", "-m", "squash retried implementation");
      git(repo.primary, "push", "origin", "main");
      const squash = git(repo.primary, "rev-parse", "HEAD");
      assert.notEqual(squash, rebased);
      stubGh(repo, rebased);

      const closed = run(closeGate, repo);
      assert.equal(closed.status, 0, closed.stdout + closed.stderr);
      assert.match(closed.stdout, /proof=squash/);
      assert.equal(readFileSync(join(state(repo), "cleanup-head"), "utf8"), rebased + "\n");
      assert.equal(readFileSync(join(state(repo), "cleanup-phase"), "utf8"), "complete\n");
      assert.deepEqual(JSON.parse(readFileSync(join(state(repo), "cleanup-proof.json"), "utf8")), {
        candidate: rebased, base: squash, squash, proof: "squash",
      });
      assert.equal(existsSync(repo.worktree), false);
      assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), false);
      assert.equal(git(repo.primary, "ls-remote", "origin", `refs/heads/${repo.branch}`), "");
      assert.equal(git(repo.primary, "rev-parse", "HEAD"), git(repo.primary, "rev-parse", "origin/main"));
      assert.equal(existsSync(join(state(repo), "cleanup-diagnostic")), false);
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });

  test(`${name} exit invalidates legacy integration proof and close mode when the captured head advances`, () => {
    const repo = repository();
    try {
      const oldHead = git(repo.worktree, "rev-parse", "HEAD");
      const tested = squashMerge(repo, false);
      writeFileSync(join(state(repo), "cleanup-head"), oldHead + "\n");
      writeFileSync(join(state(repo), "cleanup-phase"), "integrated\n");
      writeFileSync(join(state(repo), "cleanup-proof.json"), JSON.stringify({ candidate: oldHead, proof: "ancestor" }));
      writeFileSync(join(state(repo), "cleanup-close"), "true\n");
      stubGh(repo, tested, { state: "OPEN" });
      const retained = run(exit, repo);
      assert.equal(retained.status, 0, retained.stderr);
      assert.match(retained.stderr, /PR is not MERGED/);
      assert.equal(readFileSync(join(state(repo), "cleanup-head"), "utf8"), tested + "\n");
      assert.equal(readFileSync(join(state(repo), "cleanup-phase"), "utf8"), "identify\n");
      assert.equal(existsSync(join(state(repo), "cleanup-proof.json")), false);
      assert.equal(existsSync(join(state(repo), "cleanup-close")), false);
      assert.equal(existsSync(repo.worktree), true);
      stubGh(repo, tested);
      const closed = run(closeGate, repo);
      assert.equal(closed.status, 0, closed.stdout + closed.stderr);
      assert.match(closed.stdout, /proof=squash/);
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });

  test(`${name} exit discards stale integration proof after an uncaptured head change`, () => {
    const repo = repository();
    try {
      const oldHead = git(repo.worktree, "rev-parse", "HEAD");
      const head = featureCommit(repo);
      rmSync(join(state(repo), "candidate.json"));
      writeFileSync(join(repo.worktree, "value.txt"), "uncaptured correction\n");
      writeFileSync(join(state(repo), "cleanup-head"), oldHead + "\n");
      writeFileSync(join(state(repo), "cleanup-phase"), "integrated\n");
      writeFileSync(join(state(repo), "cleanup-proof.json"), JSON.stringify({ candidate: oldHead, proof: "ancestor" }));
      writeFileSync(join(state(repo), "cleanup-close"), "true\n");
      const retained = run(exit, repo);
      assert.equal(retained.status, 0, retained.stderr);
      assert.match(retained.stderr, /no captured candidate/);
      assert.equal(readFileSync(join(state(repo), "cleanup-head"), "utf8"), head + "\n");
      assert.equal(readFileSync(join(state(repo), "cleanup-phase"), "utf8"), "identify\n");
      assert.equal(existsSync(join(state(repo), "cleanup-proof.json")), false);
      assert.equal(existsSync(join(state(repo), "cleanup-close")), false);
      assert.equal(existsSync(repo.worktree), true);
      assert.equal(readFileSync(join(repo.worktree, "value.txt"), "utf8"), "uncaptured correction\n");
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });

  const modes = name === "template" ? [["close", closeGate], ["exit", exit]] as const : [["exit", exit]] as const;
  for (const [mode, cleanup] of modes) {
    test(`${name} ${mode} verified squash cleanup converges and preserves a neighbouring run`, () => {
      const repo = repository();
      try {
        const tested = squashMerge(repo, false);
        stubGh(repo, tested);
        const neighbour = join(repo.primary, ".workspace", "worktrees", "issue-2090");
        git(repo.primary, "worktree", "add", "-b", "dagu/issue-2090", neighbour, "origin/main");
        writeFileSync(join(neighbour, "private.txt"), "neighbour changes\n");
        const neighbourState = join(repo.primary, ".git", "dagu-feature", "runs", "test-run-neighbour");
        mkdirSync(neighbourState, { recursive: true });
        writeFileSync(join(neighbourState, "resource.json"), "neighbour metadata\n");
        const neighbourHead = git(neighbour, "rev-parse", "HEAD");
        for (let attempt = 0; attempt < 3; attempt++) {
          const result = run(cleanup, repo);
          assert.equal(result.status, 0, result.stderr);
          assert.match(result.stdout, /proof=squash/);
          assert.equal(existsSync(repo.worktree), false);
          assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), false);
          assert.equal(readFileSync(join(state(repo), "cleanup-phase"), "utf8"), "complete\n");
          assert.deepEqual(JSON.parse(readFileSync(join(state(repo), "cleanup-proof.json"), "utf8")), {
            candidate: tested, base: git(repo.primary, "rev-parse", "origin/main"),
            squash: git(repo.primary, "rev-parse", "origin/main"), proof: "squash",
          });
          assert.equal(git(neighbour, "rev-parse", "HEAD"), neighbourHead);
          assert.equal(readFileSync(join(neighbour, "private.txt"), "utf8"), "neighbour changes\n");
          assert.equal(readFileSync(join(neighbourState, "resource.json"), "utf8"), "neighbour metadata\n");
        }
      } finally { rmSync(repo.root, { recursive: true, force: true }); }
    });

    for (const scenario of ["dirty", "published", "unintegrated", "head-mismatch", "squash-mismatch", "ambiguous", "owner", "candidate"] as const) {
      test(`${name} ${mode} preserves ${scenario} resources with durable diagnostics`, () => {
        const repo = repository();
        try {
          const tested = ["published", "unintegrated"].includes(scenario)
            ? featureCommit(repo) : squashMerge(repo, false);
          if (scenario === "published") git(repo.worktree, "push", "origin", `HEAD:${repo.branch}`);
          if (scenario === "dirty") writeFileSync(join(repo.worktree, "private.txt"), "local edits\n");
          if (scenario === "owner") writeFileSync(owner(repo), JSON.stringify({ run: "another-run" }));
          if (scenario === "candidate") writeFileSync(join(state(repo), "tested-sha"), "f".repeat(40));
          stubGh(repo, tested, scenario === "head-mismatch" ? { headRefOid: "e".repeat(40) }
            : scenario === "squash-mismatch" ? { mergeCommit: { oid: tested } }
            : scenario === "ambiguous" ? { mergeCommit: null }
            : ["published", "unintegrated"].includes(scenario) ? { state: "OPEN" } : {});
          const result = run(cleanup, repo);
          assert.equal(result.status, mode === "close" ? 1 : 0, result.stderr);
          assert.equal(existsSync(repo.worktree), true);
          assert.equal(git(repo.worktree, "rev-parse", "HEAD"), tested);
          assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), true);
          const diagnostic = readFileSync(join(state(repo), "cleanup-diagnostic"), "utf8");
          assert.match(diagnostic, {
            dirty: /dirty worktree/, published: /publication alone/, unintegrated: /not MERGED/,
            "head-mismatch": /PR head SHA differs/, "squash-mismatch": /not confirmed/,
            ambiguous: /not confirmed/, owner: /owner or identity changed/, candidate: /tested candidate SHA differs/,
          }[scenario]);
          assert.match(result.stderr, /run=test-run.*preserved:/);
          if (scenario === "dirty") assert.equal(readFileSync(join(repo.worktree, "private.txt"), "utf8"), "local edits\n");
        } finally { rmSync(repo.root, { recursive: true, force: true }); }
      });
    }

    test(`${name} ${mode} resumes after interruption between worktree and branch removal`, () => {
      const repo = repository();
      try {
        const tested = squashMerge(repo, false);
        stubGh(repo, tested);
        const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
        const wrapper = join(repo.root, "bin", "git");
        writeFileSync(wrapper, `#!/bin/sh\ncase " $* " in *"update-ref -d"*) exit 1 ;; esac\nexec ${JSON.stringify(realGit)} "$@"\n`);
        chmodSync(wrapper, 0o755);
        const interrupted = run(cleanup, repo);
        assert.equal(interrupted.status, mode === "close" ? 1 : 0);
        assert.match(interrupted.stderr, /local branch removal failed/);
        assert.equal(existsSync(repo.worktree), false);
        assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), true);
        assert.equal(readFileSync(join(state(repo), "cleanup-phase"), "utf8"), "worktree-removed\n");
        rmSync(wrapper);
        const resumed = run(cleanup, repo);
        assert.equal(resumed.status, 0, resumed.stderr);
        assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), false);
        assert.equal(readFileSync(join(state(repo), "cleanup-phase"), "utf8"), "complete\n");
      } finally { rmSync(repo.root, { recursive: true, force: true }); }
    });

    for (const change of ["SHA", "owner"] as const) {
    test(`${name} ${mode} preserves a branch whose ${change} changed after interrupted cleanup`, () => {
      const repo = repository();
      try {
        const tested = squashMerge(repo, false);
        stubGh(repo, tested);
        writeFileSync(join(state(repo), "cleanup-head"), tested + "\n");
        git(repo.primary, "worktree", "remove", repo.worktree);
        writeFileSync(join(state(repo), "cleanup-phase"), "worktree-removed\n");
        if (change === "SHA") git(repo.primary, "update-ref", `refs/heads/${repo.branch}`, git(repo.primary, "rev-parse", "main"));
        else writeFileSync(owner(repo), JSON.stringify({ run: "neighbour-run" }));
        const result = run(cleanup, repo);
        assert.equal(result.status, mode === "close" ? 1 : 0, result.stderr);
        assert.match(result.stderr, change === "SHA" ? /branch SHA changed/ : /owner or identity changed/);
        assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), true);
        assert.equal(readFileSync(join(state(repo), "cleanup-phase"), "utf8"), "worktree-removed\n");
      } finally { rmSync(repo.root, { recursive: true, force: true }); }
    });
    }
  }

  if (name === "template") {
  test(`${name} close_gate cleans squash-merged worktree and absent remote branch outside a repository`, () => {
    const repo = repository();
    try {
      const tested = squashMerge(repo, true);
      stubGh(repo, tested);
      const other = join(repo.primary, ".workspace", "worktrees", "issue-210");
      git(repo.primary, "worktree", "add", "-b", "dagu/issue-210", other, "origin/main");
      const otherHead = git(other, "rev-parse", "HEAD");
      const result = run(closeGate, repo);
      assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.equal(existsSync(repo.worktree), false);
      assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), false);
      assert.equal(hasRef(repo.primary, `refs/remotes/origin/${repo.branch}`), false);
      assert.equal(git(repo.primary, "rev-parse", "HEAD"), git(repo.primary, "rev-parse", "origin/main"));
      assert.match(result.stdout, /cleanup worktree=.* branch=dagu\/issue-209 remote=absent/);
      const repeated = run(closeGate, repo);
      assert.equal(repeated.status, 0, repeated.stderr);
      const exit = extractScript(definition, "  exit:");
      assert.equal(run(exit, repo).status, 0);
      assert.equal(git(other, "rev-parse", "HEAD"), otherHead);
      assert.equal(hasRef(repo.primary, "refs/heads/dagu/issue-210"), true);
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });

  test(`${name} close_gate canonicalizes a symlinked worktree path`, () => {
    const repo = repository();
    try {
      const primaryLink = join(repo.root, "primary-link");
      symlinkSync(repo.primary, primaryLink, "dir");
      const linkedRepo = {
        ...repo,
        worktree: join(primaryLink, ".workspace", "worktrees", "issue-209"),
      };
      const tested = squashMerge(linkedRepo, true);
      stubGh(linkedRepo, tested);
      const result = run(closeGate, linkedRepo);
      assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.equal(existsSync(repo.worktree), false);
      assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), false);
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });

  test(`${name} close_gate detects a retained worktree through a symlinked path`, () => {
    const repo = repository();
    try {
      const primaryLink = join(repo.root, "primary-link");
      symlinkSync(repo.primary, primaryLink, "dir");
      const linkedRepo = {
        ...repo,
        worktree: join(primaryLink, ".workspace", "worktrees", "issue-209"),
      };
      const tested = squashMerge(linkedRepo, true);
      stubGh(linkedRepo, tested);
      stubGitNoop(linkedRepo, "worktree");
      const result = run(closeGate, linkedRepo);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /close_gate: worktree .* remains, expected removed/);
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });

  test(`${name} close_gate fails and preserves a dirty worktree`, () => {
    const repo = repository();
    try {
      const tested = squashMerge(repo, true);
      writeFileSync(join(repo.worktree, "dirty.txt"), "dirty\n");
      stubGh(repo, tested);
      const result = run(closeGate, repo);
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(repo.worktree), true);
      assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), true);
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });

  test(`${name} close_gate deletes a remaining remote branch`, () => {
    const repo = repository();
    try {
      const tested = squashMerge(repo, false);
      stubGh(repo, tested);
      const result = run(closeGate, repo);
      assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.equal(git(repo.primary, "ls-remote", "origin", `refs/heads/${repo.branch}`), "");
      assert.match(result.stdout, /remote=deleted/);
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });

  for (const operation of ["worktree", "branch", "remote"] as const) {
    test(`${name} close_gate fails when ${operation} cleanup reports success but leaves state`, () => {
      const repo = repository();
      try {
        const tested = squashMerge(repo, operation !== "remote");
        stubGh(repo, tested);
        stubGitNoop(repo, operation);
        const result = run(closeGate, repo);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, new RegExp(`close_gate: .*${operation === "branch" ? "local branch" : operation}.*remains, expected removed`));
        assert.equal(readFileSync(join(state(repo), "cleanup-phase"), "utf8"),
          { worktree: "removing-worktree\n", branch: "worktree-removed\n", remote: "branch-removed\n" }[operation]);
        rmSync(join(repo.root, "bin", "git"));
        const resumed = run(exit, repo);
        assert.equal(resumed.status, 0, resumed.stderr);
        assert.equal(readFileSync(join(state(repo), "cleanup-phase"), "utf8"), "complete\n");
        assert.equal(git(repo.primary, "ls-remote", "origin", `refs/heads/${repo.branch}`), "");
      } finally { rmSync(repo.root, { recursive: true, force: true }); }
    });
  }
  }
}

for (const [name, definition] of pocDefinitions) {
  const exit = extractScript(definition, "  exit:");
  test(`${name} PoC cleanup fails and retains a dirty worktree and branch`, () => {
    const repo = repository("poc/test-run", "poc-test-run");
    try {
      writeFileSync(join(repo.worktree, "dirty.txt"), "dirty\n");
      const result = run(exit, repo);
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(repo.worktree), true);
      assert.equal(hasRef(repo.primary, "refs/heads/poc/test-run"), true);
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });

  test(`${name} PoC cleanup fails when branch deletion leaves the branch`, () => {
    const repo = repository("poc/test-run", "poc-test-run");
    try {
      mkdirSync(join(repo.root, "bin"), { recursive: true });
      stubGitNoop(repo, "branch");
      const result = run(exit, repo);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /cleanup failed: branch poc\/test-run remains/);
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });

  test(`${name} PoC cleanup canonicalizes a symlinked primary path`, () => {
    const repo = repository("poc/test-run", "poc-test-run");
    try {
      const primaryLink = join(repo.root, "primary-link");
      symlinkSync(repo.primary, primaryLink, "dir");
      const linkedRepo = {
        ...repo,
        primary: primaryLink,
        worktree: join(primaryLink, ".workspace", "worktrees", "poc-test-run"),
      };
      const result = run(exit, linkedRepo);
      assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.equal(existsSync(repo.worktree), false);
      assert.equal(hasRef(repo.primary, "refs/heads/poc/test-run"), false);
      const repeated = run(exit, linkedRepo);
      assert.equal(repeated.status, 0, repeated.stderr);
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });
}

for (const [name, definition] of [...featureDefinitions, ...pocDefinitions]) {
  const isPoc = definition.endsWith("/poc.yaml");
  test(`${name} ${isPoc ? "PoC" : "feature"} authorized cleanup protects the primary and its canonical aliases`, () => {
    const repo = isPoc ? repository("poc/test-run", "poc-test-run") : repository();
    try {
      const alias = join(repo.root, "primary-alias");
      symlinkSync(repo.primary, alias, "dir");
      const snapshot = () => JSON.stringify([
        git(repo.primary, "worktree", "list", "--porcelain"),
        git(repo.primary, "show-ref"),
        git(repo.primary, "rev-parse", "HEAD"),
        git(repo.primary, "branch", "--show-current"),
        readFileSync(join(repo.primary, "value.txt"), "utf8"),
      ]);
      const before = snapshot();
      for (const marker of isPoc ? ["  exit:"] : ["  - id: close_gate", "  exit:"]) {
        for (const target of [repo.primary, alias]) {
          const result = run(extractScript(definition, marker), repo, { WORKTREE: target });
          assert.equal(result.status, 1);
          assert.match(result.stderr, /protected primary or unmanaged target/);
          assert.equal(snapshot(), before);
          assert.equal(existsSync(repo.primary), true);
        }
      }
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });
}

for (const kind of ["feature", "poc"]) {
  test(`${kind} cancelled exit retains unpublished commits and staged, unstaged and untracked recovery`, () => {
    const repo = kind === "feature" ? repository() : repository("poc/test-run", "poc-test-run");
    const definition = fileURLToPath(new URL(`../../skills/issue-execution/${kind}.yaml`, import.meta.url));
    try {
      const evidence = kind === "feature" ? state(repo) : join(repo.primary, ".git", "poc", "runs", "test-run");
      mkdirSync(evidence, { recursive: true });
      writeFileSync(join(evidence, "base.sha"), git(repo.primary, "rev-parse", "HEAD"));
      writeFileSync(join(evidence, "cancellation.json"), '{"outcome":"cancelled"}\n');
      const candidate = featureCommit(repo);
      const record = JSON.stringify({ sha: candidate, worktree: repo.worktree, branch: repo.branch, run: "test-run", outcome: "pending" }) + "\n";
      writeFileSync(join(evidence, "candidate.json"), record);
      writeFileSync(join(repo.worktree, "value.txt"), "staged\n");
      git(repo.worktree, "add", "value.txt");
      writeFileSync(join(repo.worktree, "value.txt"), "unstaged\n");
      writeFileSync(join(repo.worktree, "private.bin"), Buffer.from([0, 255, 9]));
      stubGh(repo, candidate, { state: "OPEN" });
      const before = [git(repo.worktree, "diff", "--binary"), git(repo.worktree, "diff", "--cached", "--binary")];
      const result = run(extractScript(definition, "  exit:"), repo);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /preserved|retained/);
      assert.equal(git(repo.worktree, "rev-parse", "HEAD"), candidate);
      assert.deepEqual([git(repo.worktree, "diff", "--binary"), git(repo.worktree, "diff", "--cached", "--binary")], before);
      assert.deepEqual(readFileSync(join(repo.worktree, "private.bin")), Buffer.from([0, 255, 9]));
      assert.ok(hasRef(repo.primary, `refs/heads/${repo.branch}`));
      assert.ok(existsSync(join(evidence, "cancellation.json")));
      assert.equal(readFileSync(join(evidence, "candidate.json"), "utf8"), record);
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });
}

for (const [branch, worktreeName] of [["dagu/issue-209", "issue-209"], ["poc/test-run", "poc-test-run"]] as const) {
  test(`seeded cleanup repository matches a fresh ${worktreeName} fixture and stays isolated`, () => {
    const fresh = materializeCleanup(branch, worktreeName, true);
    const copy = repository(branch, worktreeName);
    const other = repository(branch, worktreeName);
    const again = repository(branch, worktreeName);
    const view = (repo: Repo) => normalizedFixtureSnapshot({
      root: repo.root,
      primary: repo.primary,
      worktree: repo.worktree,
      remote: repo.remote,
      ownership: [join(state(repo), "resource.json"), owner(repo)],
    });
    try {
      const baseline = view(fresh);
      assert.equal(view(copy), baseline);
      assert.equal(view(other), baseline);
      assert.equal(view(again), baseline);
      assert.equal(git(copy.primary, "config", "--get", "remote.origin.url"), copy.remote);
      assert.equal(readlinkSync(join(copy.root, "bin", "a4s")), readlinkSync(join(fresh.root, "bin", "a4s")));
      assert.notEqual(copy.root, other.root);
      writeFileSync(join(copy.worktree, "value.txt"), "mutated\n");
      git(copy.worktree, "add", "value.txt");
      git(copy.worktree, "commit", "-m", "mutate");
      git(copy.primary, "config", "user.name", "Mutated Observer");
      git(copy.worktree, "push", "origin", "HEAD:refs/heads/mutated-copy");
      writeFileSync(owner(copy), "{\"run\":\"mutated\"}\n");
      assert.equal(view(other), baseline);
      assert.equal(view(again), baseline);
      assert.notEqual(view(copy), baseline);
      assert.equal(readFileSync(join(other.worktree, "value.txt"), "utf8"), "base\n");
      assert.equal(git(other.primary, "ls-remote", "origin", "refs/heads/mutated-copy"), "");
    } finally {
      for (const repo of [fresh, copy, other, again]) rmSync(repo.root, { recursive: true, force: true });
    }
  });
}
