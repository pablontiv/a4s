import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const definitions = [
  ["template", fileURLToPath(new URL("../skills/dagu-feature/reconcile.yaml", import.meta.url))],
  ["rendered DAG", fileURLToPath(new URL("../../../.workspace/dagu/dags/reconcile.yaml", import.meta.url))],
] as const;

function extractScript(definition: string, marker: string): string {
  const lines = readFileSync(definition, "utf8").split("\n");
  const markerIndex = lines.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing ${marker} in ${definition}`);
  const runIndex = lines.indexOf("    run: |", markerIndex);
  assert.notEqual(runIndex, -1, `missing run block after ${marker}`);
  let end = runIndex + 1;
  while (end < lines.length && (lines[end]!.startsWith("      ") || lines[end] === "")) end++;
  return lines.slice(runIndex + 1, end).map((line) => line.slice(6)).join("\n");
}

type HistoryRun = {
  name: "feature" | "poc";
  dagRunId: string;
  status: string;
  startedAt: string;
  params: string;
};

type Repository = {
  root: string;
  primary: string;
  bin: string;
  featureHistory: string;
  pocHistory: string;
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function repository(): Repository {
  const root = mkdtempSync(join(tmpdir(), "omp-dagu-reconcile-"));
  const primary = join(root, "primary");
  const bin = join(root, "bin");
  mkdirSync(primary);
  mkdirSync(bin);
  execFileSync("git", ["init", "-b", "main", primary]);
  git(primary, "config", "user.name", "Reconcile Test");
  git(primary, "config", "user.email", "reconcile-test@example.com");
  writeFileSync(join(primary, "README.txt"), "base\n");
  git(primary, "add", "README.txt");
  git(primary, "commit", "-m", "base");

  const featureHistory = join(root, "feature.json");
  const pocHistory = join(root, "poc.json");
  const dagu = join(bin, "dagu");
  writeFileSync(
    dagu,
    `#!/bin/sh\ncase "$2" in\n  feature) cat "$FEATURE_HISTORY" ;;\n  poc) cat "$POC_HISTORY" ;;\n  *) printf 'unexpected dagu invocation: %s\\n' "$*" >&2; exit 2 ;;\nesac\n`,
  );
  chmodSync(dagu, 0o755);
  return { root, primary, bin, featureHistory, pocHistory };
}

function params(primary: string, values: { issue?: string; branch?: string; question?: string }): string {
  const fields = [
    values.issue === undefined ? "" : `ISSUE=${values.issue}`,
    values.question === undefined ? "" : `QUESTION=${values.question}`,
    `PRIMARY=${primary}`,
    values.branch === undefined ? "" : `BRANCH=${values.branch}`,
    "BASE_BRANCH=main",
    "PR_NUMBER=",
  ];
  return fields.filter(Boolean).join(" ");
}

function childEnv(repo: Repository): NodeJS.ProcessEnv {
  return {
    HOME: repo.root,
    PATH: `${repo.bin}:${process.env.PATH ?? ""}`,
    TMPDIR: tmpdir(),
    FEATURE_HISTORY: repo.featureHistory,
    POC_HISTORY: repo.pocHistory,
  };
}

function runScript(script: string, repo: Repository, feature: HistoryRun[], poc: HistoryRun[]) {
  writeFileSync(repo.featureHistory, `${JSON.stringify(feature)}\n`);
  writeFileSync(repo.pocHistory, `${JSON.stringify(poc)}\n`);
  return spawnSync("bash", ["-c", script], {
    cwd: repo.root,
    encoding: "utf8",
    env: childEnv(repo),
  });
}

function addWorktree(repo: Repository, name: string, branch: string): string {
  const worktree = join(repo.primary, ".workspace", "worktrees", name);
  mkdirSync(join(repo.primary, ".workspace", "worktrees"), { recursive: true });
  git(repo.primary, "worktree", "add", "-b", branch, worktree, "main");
  return git(worktree, "rev-parse", "--show-toplevel");
}

for (const [name, definition] of definitions) {
  const script = extractScript(definition, "  - id: leftovers");

  test(`${name} skips missing primaries and still reports a real leftover`, () => {
    const repo = repository();
    try {
      const missing = join(repo.root, "missing");
      git(repo.primary, "branch", "dagu/issue-999", "main");
      const feature: HistoryRun[] = [missing, repo.primary].map((primary) => ({
        name: "feature",
        dagRunId: `history-${primary === missing ? "missing" : "real"}`,
        status: "succeeded",
        startedAt: "2026-10-15T18:00:00Z",
        params: params(primary, { issue: "225", branch: "dagu/issue-225" }),
      }));
      const result = runScript(script, repo, feature, []);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, `SKIP_PRIMARY ${missing} missing\n`);
      assert.equal(result.stderr, "LEFTOVER primary worktree=none branch=dagu/issue-999 last_run=none last_status=none\n");
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} succeeds when history contains only a missing primary`, () => {
    const repo = repository();
    try {
      const missing = join(repo.root, "missing");
      const result = runScript(script, repo, [{
        name: "poc",
        dagRunId: "missing-poc",
        status: "failed",
        startedAt: "2026-10-15T18:00:00Z",
        params: params(missing, { issue: "225", branch: "dagu/issue-225", question: "Can a historical primary disappear?" }),
      }], []);
      assert.equal(result.status, 0);
      assert.equal(result.stdout, `SKIP_PRIMARY ${missing} missing\n`);
      assert.equal(result.stderr, "");
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} surfaces Git errors for an existing primary directory`, () => {
    const repo = repository();
    try {
      const invalid = join(repo.root, "not-a-repository");
      mkdirSync(invalid);
      const result = runScript(script, repo, [{
        name: "feature",
        dagRunId: "invalid-primary",
        status: "succeeded",
        startedAt: "2026-10-15T18:00:00Z",
        params: params(invalid, { issue: "225", branch: "dagu/issue-225" }),
      }], []);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /fatal: not a git repository/);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} runs tick despite leftovers and finishes Failed in real Dagu`, { timeout: 20_000 }, (t) => {
    const lookup = spawnSync("bash", ["-c", "command -v dagu"], { encoding: "utf8" });
    if (lookup.status !== 0) {
      t.skip("dagu is required for the local DAG integration proof");
      return;
    }
    const repo = repository();
    try {
      const realDagu = lookup.stdout.trim();
      const home = join(repo.root, "dagu");
      mkdirSync(join(home, "dags"), { recursive: true });
      const dag = join(home, "dags", "reconcile.yaml");
      writeFileSync(dag, readFileSync(definition, "utf8").replaceAll("__DAGU_FEATURE_VERSION__", "0.2.0"));
      git(repo.primary, "remote", "add", "origin", "https://github.com/example/test.git");
      git(repo.primary, "branch", "dagu/issue-999", "main");
      writeFileSync(repo.featureHistory, JSON.stringify([{
        name: "feature", dagRunId: "waiting-run", status: "waiting",
        startedAt: "2026-10-15T18:00:00Z",
        params: params(repo.primary, { issue: "225", branch: "dagu/issue-225" }),
      }]));
      writeFileSync(repo.pocHistory, "[]");
      writeFileSync(join(repo.bin, "dagu"), `#!/bin/sh
case "$1 $2" in
  "history feature") cat ${JSON.stringify(repo.featureHistory)} ;;
  "history poc") cat ${JSON.stringify(repo.pocHistory)} ;;
  "status feature") printf '├─await_merge [waiting]\\n' ;;
  *) exec ${JSON.stringify(realDagu)} "$@" ;;
esac
`);
      writeFileSync(join(repo.bin, "gh"), `#!/bin/sh
case "$1 $2" in
  "repo view") echo example/test ;;
  "pr view") echo OPEN/CLEAN/true ;;
  *) printf 'unexpected gh invocation: %s\\n' "$*" >&2; exit 2 ;;
esac
`);
      chmodSync(join(repo.bin, "gh"), 0o755);
      const env = { ...childEnv(repo), DAGU_HOME: home };
      const result = spawnSync(realDagu, ["start", "--run-id", "leftover-proof", dag], {
        cwd: repo.root, env, encoding: "utf8", timeout: 15_000,
      });
      const status = spawnSync(realDagu, ["status", "--run-id", "leftover-proof", dag], {
        cwd: repo.root, env, encoding: "utf8", timeout: 3_000,
      });
      const evidence = `${result.stdout}${result.stderr}\n${status.stdout}${status.stderr}`;
      t.diagnostic(status.stdout.split("\n").filter((line) =>
        /^(Failed|Result:)|[├└]─(discover|leftovers|tick)|LEFTOVER primary/.test(line),
      ).join("\n"));
      assert.equal(result.error, undefined, evidence);
      assert.notEqual(result.status, 0, evidence);
      assert.equal(status.status, 0, evidence);
      assert.match(evidence, /LEFTOVER primary .*branch=dagu\/issue-999/);
      assert.match(status.stdout, /leftovers .*?\[failed\]/i);
      assert.match(status.stdout, /tick .*?\[succeeded\]/i);
      assert.match(status.stdout, /Result:\s*Failed/i);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} accepts feature and poc resources owned by active runs from outside the repository`, () => {
    const repo = repository();
    try {
      addWorktree(repo, "issue-211", "dagu/issue-211");
      git(repo.primary, "branch", "poc/omp-dashboard-149", "main");
      const feature: HistoryRun[] = [{
        name: "feature",
        dagRunId: "a4s-issue-211",
        status: "waiting",
        startedAt: "2026-10-15T18:00:00Z",
        params: params(repo.primary, { issue: "211", branch: "dagu/issue-211" }),
      }];
      const poc: HistoryRun[] = [{
        name: "poc",
        dagRunId: "omp-dashboard-149",
        status: "waiting",
        startedAt: "2026-10-15T18:01:00Z",
        params: params(repo.primary, { issue: "149", question: "Can a realistic question contain spaces?" }),
      }];
      const result = runScript(script, repo, feature, poc);
      assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /LEFTOVER/);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  for (const status of ["queued", "running", "waiting", "succeeded", "failed", "aborted"]) {
    test(`${name} associates a ${status} PoC worktree with its run when optional params are missing`, () => {
      const repo = repository();
      try {
        const run = "poc-a4s-issue-228";
        const branch = `poc/${run}`;
        const worktree = addWorktree(repo, `poc-${run}`, branch);
        const result = runScript(script, repo, [], [{
          name: "poc",
          dagRunId: run,
          status,
          startedAt: "2026-10-15T18:01:00Z",
          params: params(repo.primary, { question: "Can a PoC question contain spaces?" }),
        }]);
        assert.equal(result.stdout, "");
        if (["queued", "running", "waiting"].includes(status)) {
          assert.equal(result.status, 0, result.stderr);
          assert.equal(result.stderr, "");
        } else {
          assert.equal(result.status, 1);
          assert.equal(result.stderr, `LEFTOVER primary worktree=${worktree} branch=${branch} last_run=${run} last_status=${status}\n`);
        }
      } finally {
        rmSync(repo.root, { recursive: true, force: true });
      }
    });
  }

  test(`${name} reports a succeeded feature worktree and branch once with its last run`, () => {
    const repo = repository();
    try {
      const worktree = addWorktree(repo, "issue-210", "dagu/issue-210");
      const feature: HistoryRun[] = [{
        name: "feature",
        dagRunId: "a4s-issue-210",
        status: "succeeded",
        startedAt: "2026-10-15T17:00:00Z",
        params: params(repo.primary, { issue: "210", branch: "dagu/issue-210" }),
      }];
      const result = runScript(script, repo, feature, []);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, `LEFTOVER primary worktree=${worktree} branch=dagu/issue-210 last_run=a4s-issue-210 last_status=succeeded\n`);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} reports an unowned dagu branch without a worktree`, () => {
    const repo = repository();
    try {
      git(repo.primary, "branch", "dagu/issue-999", "main");
      const feature: HistoryRun[] = [{
        name: "feature",
        dagRunId: "a4s-issue-211",
        status: "waiting",
        startedAt: "2026-10-15T18:00:00Z",
        params: params(repo.primary, { issue: "211", branch: "dagu/issue-211" }),
      }];
      const result = runScript(script, repo, feature, []);
      assert.equal(result.status, 1);
      assert.equal(result.stderr, "LEFTOVER primary worktree=none branch=dagu/issue-999 last_run=none last_status=none\n");
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} ignores a non-dagu local branch with no managed worktree`, () => {
    const repo = repository();
    try {
      git(repo.primary, "branch", "poc/omp-dashboard-149", "main");
      const feature: HistoryRun[] = [{
        name: "feature",
        dagRunId: "a4s-issue-211",
        status: "running",
        startedAt: "2026-10-15T18:00:00Z",
        params: params(repo.primary, { issue: "211", branch: "dagu/issue-211" }),
      }];
      const result = runScript(script, repo, feature, []);
      assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /LEFTOVER/);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });
}
