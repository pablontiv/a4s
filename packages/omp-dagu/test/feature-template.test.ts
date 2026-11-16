import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { extractScript, featureCloseScript, runBash } from "./shell.ts";

const definitions = [
  ["template", fileURLToPath(new URL("../skills/dagu-feature/feature.yaml", import.meta.url))],
  ["rendered DAG", fileURLToPath(new URL("../../../.workspace/dagu/dags/feature.yaml", import.meta.url))],
] as const;


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
  const root = mkdtempSync(join(tmpdir(), "omp-dagu-feature-"));
  const primary = join(root, "primary");
  const remote = join(root, "remote.git");
  const worktree = join(root, "worktree");
  const branch = "dagu/issue-189";
  execFileSync("git", ["init", "--bare", "-b", "main", remote]);
  execFileSync("git", ["init", "-b", "main", primary]);
  git(primary, "config", "user.name", "Feature Test");
  git(primary, "config", "user.email", "feature-test@example.com");
  git(primary, "remote", "add", "origin", remote);
  mkdirSync(join(primary, "packages", "first"), { recursive: true });
  mkdirSync(join(primary, "packages", "second"), { recursive: true });
  writeFileSync(join(primary, "packages", "first", "package.json"), '{"dependencies":{"shared":"1.0.0"}}\n');
  writeFileSync(join(primary, "packages", "second", "package.json"), "{}\n");
  writeFileSync(join(primary, "README.txt"), "base\n");
  git(primary, "add", ".");
  git(primary, "commit", "-m", "base");
  git(primary, "push", "-u", "origin", "main");
  git(primary, "worktree", "add", "-b", branch, worktree, "origin/main");
  const state = join(primary, ".git", "dagu-feature", "runs", "test-run");
  mkdirSync(state, { recursive: true });
  return { root, primary, worktree, branch, state };
}

function commit(repo: Repository, path: string, content: string): void {
  const target = join(repo.worktree, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  git(repo.worktree, "add", path);
  git(repo.worktree, "commit", "-m", "feature change");
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
    GATE: "npm test",
    REQUIRED_CHECK: "validate",
    OMP_SESSION_ID: "",
    POC_BASIS: "",
    RUN: "test-run",
    CLOSED: "false",
    DAGU_OUTPUT_FILE: join(repo.root, "dagu-output"),
  };
}

function runFailingCloseGate(script: string, repo: Repository) {
  return runBash(script, {
    encoding: "utf8",
    env: featureScriptEnv(repo),
  });
}

function runScript(script: string, repo: Repository): string {
  const result = runBash(script, {
    encoding: "utf8",
    cwd: repo.root,
    env: featureScriptEnv(repo),
  });
  assert.equal(result.status, 0, `script failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
}

for (const [name, definition] of definitions) {
  const exitScript = extractScript(definition, "  - id: report_exit");
  const checkpointScript = extractScript(definition, "  - id: checkpoint_push");
  const closeGateScript = featureCloseScript(definition);

  for (const existing of [false, true]) {
    test(`${name} repeated POC=yes reuses ${existing ? "an existing" : "a newly queued"} child before commenting`, () => {
      const repo = repository();
      try {
        const bin = join(repo.root, "bin"), calls = join(repo.root, "calls"), child = join(repo.root, "child");
        mkdirSync(bin);
        writeFileSync(calls, "");
        if (existing) writeFileSync(child, "failed\n");
        writeFileSync(join(bin, "dagu"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$1" >> "$CALLS"
if [[ "$1" == status ]]; then
  [[ "$*" == "status --run-id poc-test-run poc" ]]
  test -f "$CHILD"
else
  [[ "$1" == enqueue && "$*" == *'--run-id poc-test-run '* ]]
  test ! -f "$CHILD"
  printf 'queued\\n' > "$CHILD"
fi
`, { mode: 0o755 });
        writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash
set -euo pipefail
test -f "$CHILD"
printf 'comment\\n' >> "$CALLS"
`, { mode: 0o755 });
        for (let iteration = 0; iteration < 2; iteration++) {
          const result = runBash(extractScript(definition, "  - id: triage_decision"), {
            encoding: "utf8",
            env: { ...featureScriptEnv(repo), POC: "yes", QUESTION: "Runtime behavior", BASIS: "Unexercised runtime", REVIEW: "", CALLS: calls, CHILD: child },
          });
          assert.equal(result.status, 0, result.stdout + result.stderr);
        }
        assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"),
          existing ? ["status", "comment", "status", "comment"] : ["status", "enqueue", "comment", "status", "comment"]);
        assert.equal(readFileSync(child, "utf8"), existing ? "failed\n" : "queued\n");
      } finally { rmSync(repo.root, { recursive: true, force: true }); }
    });
  }

  test(`${name} a failed POC enqueue publishes no triage comment`, () => {
    const repo = repository();
    try {
      const bin = join(repo.root, "bin"), published = join(repo.root, "published");
      mkdirSync(bin);
      writeFileSync(join(bin, "dagu"), '#!/usr/bin/env bash\nif [[ "$1" == status ]]; then exit 1; fi\nexit 42\n', { mode: 0o755 });
      writeFileSync(join(bin, "gh"), '#!/usr/bin/env bash\ntouch "$PUBLISHED"\n', { mode: 0o755 });
      const result = runBash(extractScript(definition, "  - id: triage_decision"), {
        encoding: "utf8",
        env: { ...featureScriptEnv(repo), POC: "yes", QUESTION: "Runtime behavior", BASIS: "Unexercised runtime", REVIEW: "", PUBLISHED: published },
      });
      assert.equal(result.status, 42, result.stdout + result.stderr);
      assert.equal(existsSync(published), false);
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });

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

  test(`${name} exit keeps a never-pushed branch without successful close state`, () => {
    const repo = repository();
    try {
      commit(repo, "README.txt", "unpublished\n");
      stubGh(repo, "", 1, "no pull requests found\n");
      const output = runScript(exitScript, repo);
      assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), true);
      assert.equal(existsSync(repo.worktree), true);
      assert.match(output, new RegExp(`branch ${repo.branch.replace("/", "\\/")}`));
      assert.match(output, new RegExp(`worktree ${repo.worktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.match(output, /Recovery: inspect run test-run and retry its failed step/);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} exit keeps a squash-merged head until close_gate succeeds`, () => {
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
      const output = runScript(exitScript, repo);
      assert.equal(existsSync(repo.worktree), true);
      assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), true);
      assert.match(output, /Work kept/);
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
      assert.match(output, /Work kept/);
      assert.match(output, /Recovery: inspect run test-run and retry its failed step/);
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
      assert.match(output, /Work kept/);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} exit keeps a published head until close_gate succeeds`, () => {
    const repo = repository();
    try {
      commit(repo, "README.txt", "published\n");
      git(repo.worktree, "push", "origin", `HEAD:${repo.branch}`);
      const output = runScript(exitScript, repo);
      assert.equal(existsSync(repo.worktree), true);
      assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), true);
      assert.match(output, /Work kept/);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} exit keeps a head merged into the base branch until close_gate succeeds`, () => {
    const repo = repository();
    try {
      commit(repo, "README.txt", "merged\n");
      git(repo.primary, "merge", "--ff-only", repo.branch);
      git(repo.primary, "push", "origin", "main");
      const output = runScript(exitScript, repo);
      assert.equal(existsSync(repo.worktree), true);
      assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), true);
      assert.match(output, /Work kept/);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} checkpoint reviews an existing dependency added to a second package`, () => {
    const repo = repository();
    try {
      commit(repo, "packages/second/package.json", '{"dependencies":{"shared":"1.0.0"}}\n');
      runScript(checkpointScript, repo);
      assert.equal(readFileSync(join(repo.root, "dagu-output"), "utf8"), "action=rewind\n");
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
      assert.equal(readFileSync(join(repo.root, "dagu-output"), "utf8"), "action=complete\n");
      assert.equal(readFileSync(join(repo.state, "dependencies"), "utf8"), "");
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });
}
