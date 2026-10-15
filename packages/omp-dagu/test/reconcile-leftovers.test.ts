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
  ];
  return fields.filter(Boolean).join(" ");
}

function runScript(script: string, repo: Repository, feature: HistoryRun[], poc: HistoryRun[]) {
  writeFileSync(repo.featureHistory, `${JSON.stringify(feature)}\n`);
  writeFileSync(repo.pocHistory, `${JSON.stringify(poc)}\n`);
  return spawnSync("bash", ["-c", script], {
    cwd: repo.root,
    encoding: "utf8",
    env: {
      HOME: process.env.HOME,
      PATH: `${repo.bin}:${process.env.PATH ?? ""}`,
      ISSUE: "",
      PR_NUMBER: "",
      PRIMARY: "",
      WORKTREE: "",
      BRANCH: "",
      BASE_BRANCH: "",
      REQUIRED_CHECK: "",
      OMP_SESSION_ID: "",
      FEATURE_HISTORY: repo.featureHistory,
      POC_HISTORY: repo.pocHistory,
    },
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
