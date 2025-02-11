import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import { Transitions } from "../../src/status/progress.ts";
import type { RunDetails } from "../../src/status/progress.ts";
import { readConfigFile } from "../../src/config.ts";
import { BUNDLE_VERSION } from "../../src/bundle.ts";
import { materializeDag } from "../../src/materialize.ts";
import { stubHistory, withResourceGuard } from "../resource-fixtures.ts";
import { liveDagu, liveDaguVersion } from "../fixtures/live-dagu.ts";
import { roleAdmission, roleExecution } from "../role-job-fixtures.ts";
import { jobId, type JobBinding } from "../../src/role-jobs.ts";
import { roleAssignment, runRoleJob } from "../../src/role-dispatch.ts";
import { copyRepositorySeed, normalizedFixtureSnapshot, SEED_COMMIT_DATE, settleCopiedRepository } from "../fixtures/repository-seed.ts";
import { testRunId } from "../fixtures/run-id.ts";
import { renderedFeature, renderedPoc } from "../fixtures/rendered-feature.ts";
import { readAdminEvents, STALE_PROCESS_ERROR } from "../../src/stale-recovery.ts";
import { compiledA4sBin, compiledArtifact } from "../fixtures/admission.ts";

const a4sBin = compiledA4sBin();

const definitions = [
  ["template", fileURLToPath(new URL("../../skills/issue-execution/feature.yaml", import.meta.url))],
  ["rendered fixture", renderedFeature],
] as const;
const deliveryForm = `      form:
        type: object
        properties:
          SUMMARY:
            type: string
          MESSAGE:
            type: string
          IMPLEMENTER:
            type: string
        required: [SUMMARY, MESSAGE, IMPLEMENTER]
`;

function extractScript(definition: string, marker: string): string {
  const lines = readFileSync(definition, "utf8").split("\n");
  const markerIndex = lines.indexOf(marker);
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

type Repository = {
  root: string;
  primary: string;
  worktree: string;
  branch: string;
  state: string;
};

const FEATURE_SEED_RUN = "test-run";

function buildFeatureSeed(root: string): void {
  const primary = join(root, "primary");
  const remote = join(root, "remote.git");
  const worktree = join(primary, ".workspace", "worktrees", "issue-189");
  const branch = "dagu/issue-189";
  const run = FEATURE_SEED_RUN;
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
  execFileSync("git", ["-C", primary, "-c", "commit.gpgsign=false", "commit", "-m", "base"], {
    env: { ...process.env, GIT_AUTHOR_DATE: SEED_COMMIT_DATE, GIT_COMMITTER_DATE: SEED_COMMIT_DATE },
  });
  git(primary, "push", "-u", "origin", "main");
  writeFileSync(join(primary, ".git", "info", "exclude"), "/.workspace/worktrees/\n");
  stubHistory(root);
  git(primary, "worktree", "add", "-b", branch, worktree, "origin/main");
  const state = join(primary, ".git", "dagu-feature", "runs", run);
  mkdirSync(state, { recursive: true });
  const identity = JSON.stringify({ primary, worktree, branch, run, session: "" }) + "\n";
  writeFileSync(join(state, "identity"), identity);
  writeFileSync(git(worktree, "rev-parse", "--path-format=absolute", "--git-path", "dagu-feature-owner"), identity);
  writeFileSync(join(state, "base"), git(worktree, "rev-parse", "HEAD") + "\n");
  recordCandidate({ root, primary, worktree, branch, state });
  const resource = JSON.stringify({ run, primary, branch, worktree });
  writeFileSync(join(state, "resource.json"), resource);
  const hash = execFileSync("git", ["hash-object", "--stdin"], { input: branch, encoding: "utf8" }).trim();
  const resources = join(primary, ".git", "dagu-feature", "resources");
  mkdirSync(resources, { recursive: true });
  writeFileSync(join(resources, `${hash}.json`), resource);
  writeFileSync(join(state, "tested-sha"), git(worktree, "rev-parse", "HEAD") + "\n");
}

function retargetFeatureRun(root: string, from: string, to: string): void {
  if (from === to) return;
  const primary = join(root, "primary");
  const runs = join(primary, ".git", "dagu-feature", "runs");
  renameSync(join(runs, from), join(runs, to));
  const needle = `"run":${JSON.stringify(from)}`;
  const next = `"run":${JSON.stringify(to)}`;
  const resources = join(primary, ".git", "dagu-feature", "resources");
  const files = [
    join(runs, to, "identity"),
    join(runs, to, "resource.json"),
    join(primary, ".git", "worktrees", "issue-189", "dagu-feature-owner"),
    ...readdirSync(resources).map(name => join(resources, name)),
  ];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    assert.equal(text.includes(needle), true, file);
    writeFileSync(file, text.replaceAll(needle, next));
  }
}

function materializeFeature(run: string, fresh: boolean): Repository {
  const root = fresh
    ? realpathSync(mkdtempSync(join(tmpdir(), "omp-dagu-feature-")))
    : copyRepositorySeed("feature", "omp-dagu-feature-", buildFeatureSeed);
  if (fresh) buildFeatureSeed(root);
  retargetFeatureRun(root, FEATURE_SEED_RUN, run);
  const repo: Repository = {
    root,
    primary: join(root, "primary"),
    worktree: join(root, "primary", ".workspace", "worktrees", "issue-189"),
    branch: "dagu/issue-189",
    state: join(root, "primary", ".git", "dagu-feature", "runs", run),
  };
  if (!fresh) settleCopiedRepository([repo.primary, repo.worktree]);
  writeFileSync(join(repo.state, "receipt.json"), JSON.stringify(roleAdmission(repo.primary, join(root, "dagu-home"), run, readFileSync(definitions[0][1], "utf8"))));
  stubGh(repo, "[]\n", 0);
  return repo;
}

function repository(run = "test-run"): Repository {
  return materializeFeature(run, false);
}

function recordCandidate(repo: Repository): void {
  const sha = git(repo.worktree, "rev-parse", "HEAD");
  writeFileSync(join(repo.state, "candidate.json"), JSON.stringify({
    sha, base: readFileSync(join(repo.state, "base"), "utf8").trim(),
    tree: git(repo.worktree, "rev-parse", "HEAD^{tree}"), message: "base", iteration: -1, implementer: "ImplementTest",
  }) + "\n");
  writeFileSync(join(repo.state, "codeql-observation.json"), JSON.stringify({ sha, class: "PASS" }));
}

function writePocBasis(repo: Repository, pocRun: string, mutate: (worktree: string) => void): { base: string; digest: string; patch: string } {
  const base = git(repo.primary, "rev-parse", "HEAD");
  const worktree = join(repo.primary, ".workspace", "worktrees", `poc-${pocRun}`);
  git(repo.primary, "worktree", "add", "-b", `poc/${pocRun}`, worktree, base);
  mutate(worktree);
  const state = git(repo.primary, "rev-parse", "--path-format=absolute", "--git-path", `poc/runs/${pocRun}`);
  mkdirSync(state, { recursive: true });
  const patch = join(state, "full.patch");
  execFileSync("bash", ["-c", `
    set -euo pipefail
    git -C "$WORKTREE" diff --binary "$BASE" > "$PATCH"
    while IFS= read -r -d '' path; do
      (cd "$WORKTREE"; git diff --no-index --binary -- /dev/null "$path") >> "$PATCH" || test "$?" -eq 1
    done < <(git -C "$WORKTREE" ls-files --others --exclude-standard -z)
    shasum -a 256 "$PATCH" | awk '{print $1}' > "$PATCH.sha256"
  `], { env: { ...process.env, WORKTREE: worktree, BASE: base, PATCH: patch } });
  const digest = readFileSync(`${patch}.sha256`, "utf8").trim();
  writeFileSync(join(state, "comment.url"), "https://example.test/comments/9\n");
  writeFileSync(join(state, "promotion.url"), "https://example.test/comments/9\n");
  writeFileSync(join(state, "base.sha"), `${base}\n`);
  git(repo.primary, "worktree", "remove", "--force", worktree);
  git(repo.primary, "branch", "-D", `poc/${pocRun}`);
  return { base, digest, patch };
}

function resetFeatureWorktree(repo: Repository): void {
  if (existsSync(repo.worktree)) git(repo.primary, "worktree", "remove", "--force", repo.worktree);
  if (hasRef(repo.primary, `refs/heads/${repo.branch}`)) git(repo.primary, "branch", "-D", repo.branch);
  rmSync(join(repo.state, "base"), { force: true });
  rmSync(join(repo.state, "candidate.json"), { force: true });
  rmSync(join(repo.state, "initial-head"), { force: true });
}

function commit(repo: Repository, path: string, content: string): void {
  const target = join(repo.worktree, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  git(repo.worktree, "add", path);
  git(repo.worktree, "commit", "-m", "feature change");
  recordCandidate(repo);
  writeFileSync(join(repo.state, "tested-sha"), git(repo.worktree, "rev-parse", "HEAD") + "\n");
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
  "pr view ${repo.branch} --repo ${repo.root}/remote.git --json number,state,headRefOid,mergeCommit") printf '%s\\n' '${JSON.stringify({ number: 190, state: "MERGED", headRefOid: head, mergeCommit: { oid: head } })}' ;;
  "pr checks 190 --repo ${repo.root}/remote.git --required --json name,state --jq "*) printf 'SUCCESS\\n' ;;
  *) printf 'unexpected gh invocation: %s\\n' "$*" >&2; exit 1 ;;
esac
`,
  );
  chmodSync(executable, 0o755);
}

test("maintained close completes without inspecting changed files or re-sealing the checkout", () => {
  const repo = repository();
  try {
    commit(repo, "packages/issue-lifecycle/skills/issue-execution/feature.yaml", "merged template\n");
    git(repo.primary, "merge", "--ff-only", repo.branch);
    git(repo.primary, "push", "origin", "main");
    stubSuccessfulCloseGateGh(repo);
    const log = join(repo.root, "bootstrap.args");
    const executable = join(repo.root, "bin", "dagu");
    writeFileSync(executable, `#!/bin/sh\ncase "$1" in\nhistory) printf '[]\\n';;\nenqueue) printf '%s\\n' "$@" > ${JSON.stringify(log)};;\n*) exit 1;;\nesac\n`);
    chmodSync(executable, 0o755);
    const result = spawnSync("bash", ["-c", extractScript(definitions[0][1], "  - id: close_gate")], {
      encoding: "utf8", env: featureScriptEnv(repo),
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(join(repo.state, "cleanup-phase"), "utf8"), "complete\n");
    assert.equal(existsSync(log), false);
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

function featureScriptEnv(repo: Repository): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME,
    // Node's socket-backed stdin must not turn isolated Bash children into remote-login shells.
    SHLVL: "1",
    A4S_BIN: a4sBin,
    DAGU_HOME: join(repo.root, "dagu-home"),
    DAGU_OUTPUT_FILE: join(repo.root, "step-output"),
    PATH: `${join(repo.root, "bin")}:${process.env.PATH ?? ""}`,
    DAGU_PARAMS_JSON: "{}",
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
    RUN: repo.state.slice(repo.state.lastIndexOf("/") + 1),
    SUMMARY: "Delivered files",
    MESSAGE: "feat: delivered change",
    IMPLEMENTER: "ImplementTest",
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

test("feature script helpers isolate inherited Dagu step outputs", () => {
  const repo = repository();
  const inherited = join(repo.root, "implement-output");
  const previous = process.env.DAGU_OUTPUT_FILE;
  writeFileSync(inherited, "IMPLEMENTER=stage-owned\n");
  process.env.DAGU_OUTPUT_FILE = inherited;
  try {
    const script = 'printf "X=1\\n" >> "${DAGU_OUTPUT_FILE:-/dev/null}"';
    runScript(script, repo);
    const result = runFailingCloseGate(script, repo);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(inherited, "utf8"), "IMPLEMENTER=stage-owned\n");
    assert.equal(readFileSync(featureScriptEnv(repo).DAGU_OUTPUT_FILE!, "utf8"), "X=1\nX=1\n");
  } finally {
    if (previous === undefined) delete process.env.DAGU_OUTPUT_FILE;
    else process.env.DAGU_OUTPUT_FILE = previous;
    rmSync(repo.root, { recursive: true, force: true });
  }
});

for (const [name, definition] of definitions) {
  for (const step of ["start_gate", "capture", "push", "pr", "auto_merge"]) {
    test(`${name} ${step} rejection writes rule expected observed to stderr`, () => {
      const repo = repository();
      try {
        runScript(extractScript(definition, "  - id: gate"), repo);
        if (["push", "pr", "auto_merge"].includes(step)) {
          const candidate = JSON.parse(readFileSync(join(repo.state, "candidate.json"), "utf8"));
          writeFileSync(join(repo.state, "candidate.json"), JSON.stringify({ ...candidate, sha: "b".repeat(40) }));
        }
        const result = spawnSync("bash", ["-c", extractScript(definition, `  - id: ${step}`)], {
          encoding: "utf8", env: { ...featureScriptEnv(repo), DAGU_FEATURE_BUNDLE: "test", CODE_SCANNING: "off",
            ...(step === "start_gate" ? { GATE: "" } : step === "capture" ? { MESSAGE: "" } : {}) },
        });
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stderr, new RegExp(`^rule=${step}\\.\\S+ expected=.+ observed=.+$`, "m"));
      } finally { rmSync(repo.root, { recursive: true, force: true }); }
    });
  }
  for (const existing of [false, true]) {
    test(`${name} repeated yes-triage reuses ${existing ? "a pre-existing" : "a newly enqueued"} PoC before publication`, () => {
      const root = mkdtempSync(join(tmpdir(), "triage-reuse-"));
      try {
        const primary = join(root, "primary");
        const state = join(primary, ".git", "dagu-feature", "runs", "repeat-triage");
        const bin = join(root, "bin");
        const calls = join(root, "calls");
        const child = join(root, "child");
        mkdirSync(state, { recursive: true });
        mkdirSync(bin);
        git(root, "init", primary);
        writeFileSync(join(state, "dependencies"), "reviewed dependencies\n");
        writeFileSync(calls, "");
        if (existing) writeFileSync(child, "failed\n");
        const stub = (command: string, script: string) =>
          writeFileSync(join(bin, command), `#!/usr/bin/env bash\nset -euo pipefail\n${script}\n`, { mode: 0o755 });
        stub("dagu", `[[ "$*" == 'status --run-id poc-repeat-triage poc' ]]
printf 'status\\n' >> "$CALLS"
test -f "$CHILD"`);
        stub("a4s", `[[ "$1" == enqueue && "$4" == --run-id && "$5" == poc-repeat-triage ]]
[[ ! -f "$CHILD" ]]
printf 'enqueue\\n' >> "$CALLS"
printf 'queued\\n' > "$CHILD"`);
        stub("gh", `[[ "$PWD" == "$PRIMARY" ]]
[[ "$*" == "issue comment 295 --body-file $STATE/triage.md" ]]
[[ -f "$CHILD" ]]
printf 'comment\\n' >> "$CALLS"
cp "$STATE/triage.md" "$PUBLISHED"`);
        const env = {
          ...process.env, PRIMARY: primary, STATE: state, RUN: "repeat-triage", ISSUE: "295",
          PATH: `${bin}:${process.env.PATH}`, A4S_BIN: join(bin, "a4s"), POC: "yes",
          DAGU_OUTPUT_FILE: join(root, "step-output"),
          TEST_PATH: `${bin}:${process.env.PATH}`,
          QUESTION: "Can this runtime work?", BASIS: "Unexercised runtime", REVIEW: "review",
          OMP_SESSION_ID: "parent", REQUIRED_TARGETS: "[]", AUTHORIZED_TARGETS: "[]",
          SCOPE_BASIS: "authorized", SCOPE_REQUEST: "request", CALLS: calls, CHILD: child,
          PUBLISHED: join(root, "published"),
        };
        const run = (step: string) => {
          const result = spawnSync("bash", ["-c", `export PATH="$TEST_PATH"\n${extractScript(definition, `  - id: ${step}`)}`], { env, encoding: "utf8" });
          assert.equal(result.status, 0, result.stdout + result.stderr);
        };
        for (let iteration = 0; iteration < 2; iteration++) {
          run("triage_decision");
          assert.equal(readFileSync(calls, "utf8").split("comment\n").length - 1, iteration);
          run("poc_admit");
        }
        assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"),
          existing ? ["status", "comment", "status", "comment"] : ["status", "enqueue", "comment", "status", "comment"]);
        assert.equal(readFileSync(child, "utf8"), existing ? "failed\n" : "queued\n");
        assert.match(readFileSync(env.PUBLISHED, "utf8"), /<!-- poc-triage:yes run:repeat-triage -->/);
        assert.equal(readFileSync(join(state, "reviewed-dependencies"), "utf8"), "reviewed dependencies\n");
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
  test(`${name} failed PoC enqueue leaves no yes-triage comment`, () => {
    const root = mkdtempSync(join(tmpdir(), "triage-enqueue-failure-"));
    try {
      const state = join(root, ".git", "dagu-feature", "runs", "failed-triage");
      const bin = join(root, "bin");
      mkdirSync(state, { recursive: true });
      mkdirSync(bin);
      git(root, "init");
      for (const [command, script] of [
        ["dagu", "exit 1"], ["a4s", "exit 42"], ["gh", 'touch "$PUBLISHED"'],
      ]) writeFileSync(join(bin, command!), `#!/usr/bin/env bash\n${script}\n`, { mode: 0o755 });
      const env = {
        ...process.env, PRIMARY: root, RUN: "failed-triage", ISSUE: "295",
        PATH: `${bin}:${process.env.PATH}`, A4S_BIN: join(bin, "a4s"), POC: "yes",
        DAGU_OUTPUT_FILE: join(root, "step-output"),
        TEST_PATH: `${bin}:${process.env.PATH}`,
        QUESTION: "Runtime question", BASIS: "Unexercised runtime", REVIEW: "review",
        OMP_SESSION_ID: "parent", REQUIRED_TARGETS: "[]", AUTHORIZED_TARGETS: "[]",
        SCOPE_BASIS: "authorized", SCOPE_REQUEST: "request", PUBLISHED: join(root, "published"),
      };
      const decision = spawnSync("bash", ["-c", `export PATH="$TEST_PATH"\n${extractScript(definition, "  - id: triage_decision")}`], { env, encoding: "utf8" });
      assert.equal(decision.status, 0, decision.stdout + decision.stderr);
      assert.equal(existsSync(env.PUBLISHED), false);
      const admission = spawnSync("bash", ["-c", `export PATH="$TEST_PATH"\n${extractScript(definition, "  - id: poc_admit")}`], { env, encoding: "utf8" });
      assert.equal(admission.status, 42, admission.stdout + admission.stderr);
      assert.equal(existsSync(env.PUBLISHED), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test(`${name} PR publication creates and refreshes concise run-populated bodies`, () => {
    const repo = repository();
    try {
      const sha = git(repo.worktree, "rev-parse", "HEAD");
      git(repo.worktree, "push", "origin", repo.branch);
      const candidate = JSON.parse(readFileSync(join(repo.state, "candidate.json"), "utf8"));
      writeFileSync(join(repo.state, "candidate.json"), JSON.stringify({ ...candidate, summary: "Change PR publication\nPreserve candidate identity" }));
      writeFileSync(join(repo.state, "gate.json"), JSON.stringify({ sha, gate: "true", result: "PASS" }));
      writeFileSync(join(repo.state, "validation.json"), JSON.stringify({ sha, approved: "yes", procedure: "Run smoke in <worktree>" }));
      const calls = join(repo.root, "publication-calls");
      const published = join(repo.root, "published.md");
      const gh = join(repo.root, "bin", "gh");
      writeFileSync(gh, `#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  "pr view")
    case "$*" in
      *"--json state"*) echo OPEN ;;
      *"--json headRefName"*) echo "$BRANCH" ;;
      *"--json headRefOid"*) echo '${sha}' ;;
      *"--json number") test "$EXISTING_PR" = yes ;;
      *) echo '{"number":571}' ;;
    esac ;;
  "pr create"|"pr edit")
    printf '%s\\n' "$*" >> '${calls}'
    while (($#)); do
      if [[ "$1" == --body-file ]]; then cp "$2" '${published}'; exit 0; fi
      shift
    done
    exit 1 ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
      const script = extractScript(definition, "  - id: pr");
      for (const [EXISTING_PR, PR_NUMBER, command] of [["no", "", "pr create"], ["yes", "", "pr edit"], ["yes", "571", "pr edit"]]) {
        runScript(script, repo, { EXISTING_PR, PR_NUMBER });
        assert.match(readFileSync(calls, "utf8").trim().split("\n").at(-1)!, new RegExp(`^${command} `));
        const body = readFileSync(published, "utf8");
        assert.equal(body, "Closes #189\n\n## Summary\n- Change PR publication\n- Preserve candidate identity\n\n## Verification\n- true — PASS\n- Operator validation: Run smoke in <worktree> — approved\n\n## Risk\nNone\n");
      }
      const before = readFileSync(calls, "utf8");
      for (const PR_NUMBER of ["", "571"]) {
        writeFileSync(join(repo.state, "candidate.json"), JSON.stringify({ ...candidate, summary: "Exposes /Users/example/private/repository" }));
        const rejected = spawnSync("bash", ["-c", script], {
          encoding: "utf8", env: { ...featureScriptEnv(repo), EXISTING_PR: "yes", PR_NUMBER },
        });
        assert.equal(rejected.status, 1, rejected.stderr);
        assert.match(rejected.stderr, /host absolute path/);
        assert.equal(readFileSync(calls, "utf8"), before);
      }
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });
}


for (const live of [false, true]) {
  test(`retained candidate merge-base capture and version-anchor rebase${live ? " installed Dagu smoke" : ""}`, live ? liveDagu : {}, () => {
    const repo = repository(live ? testRunId("retained-smoke") : "test-run");
    const definition = definitions[0][1];
    const manifest = "packages/issue-lifecycle/package.json";
    const changelog = "packages/issue-lifecycle/CHANGELOG.md";
    const putRelease = (cwd: string, version: string, entry: string) => {
      mkdirSync(dirname(join(cwd, manifest)), { recursive: true });
      writeFileSync(join(cwd, manifest), JSON.stringify({ name: "@a4s/issue-lifecycle", version }) + "\n");
      writeFileSync(join(cwd, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "packages/issue-lifecycle": { version } } }) + "\n");
      mkdirSync(join(cwd, "packages/issue-lifecycle/test"), { recursive: true });
      writeFileSync(join(cwd, "packages/issue-lifecycle/test/bundle.test.ts"), `assert.equal(BUNDLE_VERSION, "${version}");\n`);
      writeFileSync(join(cwd, changelog), `# Changelog\n\n## ${version}\n\n- ${entry}\n\n${version === "0.1.1" ? "" : "## 0.1.1\n\n- Base\n\n"}## 0.1.0\n\n- Published\n`);
    };
    try {
      putRelease(repo.primary, "0.1.1", "Base");
      git(repo.primary, "add", "."); git(repo.primary, "commit", "-m", "release base");
      git(repo.primary, "push", "origin", "main");
      git(repo.worktree, "reset", "--hard", "origin/main");
      const base = git(repo.worktree, "rev-parse", "HEAD");
      putRelease(repo.worktree, "0.1.2", "Retained");
      writeFileSync(join(repo.worktree, "retained.txt"), "operator content\n");
      git(repo.worktree, "add", "."); git(repo.worktree, "commit", "-m", "operator candidate");
      const retained = git(repo.worktree, "rev-parse", "HEAD");
      putRelease(repo.primary, "0.1.2", "Upstream");
      git(repo.primary, "add", "."); git(repo.primary, "commit", "-m", "upstream release");
      git(repo.primary, "push", "origin", "main");
      rmSync(join(repo.state, "base")); rmSync(join(repo.state, "candidate.json"));
      writeFileSync(join(repo.worktree, "dirty.txt"), "uncaptured content\n");
      const resolver = fileURLToPath(new URL("../../bin/dagu-bundle-rebase.mjs", import.meta.url));
      const env: NodeJS.ProcessEnv = { ...featureScriptEnv(repo), DAGU_FEATURE_BUNDLE: "test", REBASE_RESOLVER: `test "$(git rev-parse REBASE_HEAD)" = "$DAGU_REBASE_CANDIDATE"; node ${JSON.stringify(resolver)}` };
      const scripts = ["start_gate", "capture", "rebase", "gate"].map(id => {
        let script = extractScript(definition, `  - id: ${id}`);
        if (id === "start_gate") script += `\ntest "$(cat "$STATE/base")" = "${base}"\ntest "$(git -C "$WORKTREE" rev-parse HEAD)" = "${retained}"\n`;
        if (id === "capture") script += `\ntest "$(git rev-list --count '${base}..HEAD')" = 1\n`;
        return script;
      });
      if (live) {
        rmSync(join(repo.root, "bin", "dagu"));
        const home = join(repo.root, "isolated-dagu-home");
        mkdirSync(home);
        const file = join(repo.root, "retained-smoke.yaml");
        writeFileSync(file, "name: retained-smoke\ntype: graph\nshell: bash\nenv:\n" + Object.entries(env).filter(([, value]) => value !== undefined).map(([key, value]) => `  - ${key}: ${JSON.stringify(value)}\n`).join("") + "steps:\n" + scripts.map((script, index) =>
          `  - id: phase${index}\n${index ? `    depends: phase${index - 1}\n` : ""}    run: |\n${script.split("\n").map(line => "      " + line).join("\n")}\n${index === 3 ? "    outputs:\n      - name: tested_sha\n" : ""}`).join(""));
        execFileSync("dagu", ["start", "--run-id", env.RUN!, file], { cwd: repo.root, env: { ...process.env, ...env, DAGU_HOME: home }, stdio: "pipe" });
      } else {
        for (const script of scripts) runScript(script, repo, env);
      }
      assert.equal(git(repo.worktree, "rev-list", "--count", "origin/main..HEAD"), "1");
      assert.equal(readFileSync(join(repo.worktree, "retained.txt"), "utf8"), "operator content\n");
      assert.equal(readFileSync(join(repo.worktree, "dirty.txt"), "utf8"), "uncaptured content\n");
      assert.equal(JSON.parse(readFileSync(join(repo.worktree, manifest), "utf8")).version, "0.1.3");
      assert.match(readFileSync(join(repo.worktree, changelog), "utf8"), /Retained[\s\S]*Upstream/);
      assert.equal(readFileSync(join(repo.state, "tested-sha"), "utf8").trim(), git(repo.worktree, "rev-parse", "HEAD"));
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });
}

for (const retained of [false, true]) {
  test(`conflict rewind resolves and captures delivery with ${retained ? "retained commits" : "moved remote base"}`, () => {
    const repo = repository();
    const definition = definitions[0][1];
    try {
      rmSync(join(repo.state, "base"));
      rmSync(join(repo.state, "candidate.json"));
      if (retained) {
        writeFileSync(join(repo.worktree, "README.txt"), "retained feature\n");
        writeFileSync(join(repo.worktree, "retained.txt"), "retained delivery\n");
        git(repo.worktree, "add", ".");
        git(repo.worktree, "commit", "-m", "retained feature");
      }
      runScript(extractScript(definition, "  - id: start_gate"), repo, { DAGU_FEATURE_BUNDLE: "test" });
      const initial = git(repo.worktree, "rev-parse", "HEAD");
      writeFileSync(join(repo.worktree, "README.txt"), "feature\n");
      writeFileSync(join(repo.worktree, "delivery.txt"), "nonconflicting delivery\n");
      runScript(extractScript(definition, "  - id: capture"), repo);
      const candidate = git(repo.worktree, "rev-parse", "HEAD");
      writeFileSync(join(repo.primary, "README.txt"), "upstream\n");
      git(repo.primary, "add", ".");
      git(repo.primary, "commit", "-m", "move remote base");
      git(repo.primary, "push", "origin", "main");
      const base = git(repo.primary, "rev-parse", "HEAD");
      runScript(extractScript(definition, "  - id: rebase"), repo);
      assert.equal(readFileSync(join(repo.state, "conflict-action"), "utf8"), "rewind\n");
      assert.notEqual(base, initial);
      assert.equal(git(repo.worktree, "rev-parse", "HEAD"), base);
      assert.equal(readFileSync(join(repo.state, "initial-head"), "utf8").trim(), base);
      assert.equal(JSON.parse(readFileSync(join(repo.state, "historical", candidate, "candidate.json"), "utf8")).sha, candidate);
      assert.match(readFileSync(join(repo.worktree, "README.txt"), "utf8"), /<<<<<<< HEAD/);
      assert.equal(readFileSync(join(repo.worktree, "delivery.txt"), "utf8"), "nonconflicting delivery\n");
      writeFileSync(join(repo.worktree, "README.txt"), "resolved delivery\n");
      runScript(extractScript(definition, "  - id: capture"), repo);
      assert.equal(git(repo.worktree, "rev-parse", "HEAD^"), base);
      assert.equal(git(repo.worktree, "rev-list", "--count", `${base}..HEAD`), "1");
      assert.equal(git(repo.worktree, "show", "HEAD:README.txt"), "resolved delivery");
      assert.equal(git(repo.worktree, "show", "HEAD:delivery.txt"), "nonconflicting delivery");
      if (retained) assert.equal(git(repo.worktree, "show", "HEAD:retained.txt"), "retained delivery");
      assert.equal(git(repo.worktree, "branch", "--show-current"), repo.branch);
      assert.equal(git(repo.worktree, "status", "--porcelain"), "");
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });
}

test("template captures native implementation and publishes the gated candidate", async () => {
  const repo = repository();
  try {
    const definition = definitions[0][1];
    const source = readFileSync(definition, "utf8");
    const run = "test-run"; const home = join(repo.root, "dagu-home"); mkdirSync(home, { recursive: true });
    const startedAt = "2026-10-22T05:00:00Z";
    const binding: JobBinding = { repo: repo.primary, worktree: repo.worktree, lane: "feature", dag: "feature",
      run, stage: "implement", role: "implement", sha: git(repo.worktree, "rev-parse", "HEAD"), iteration: 0, attempt: `0:${startedAt}` };
    const directory = join(repo.state, "role-jobs", jobId(binding));
    const result = await runRoleJob({ home, capacity: 1, binding, directory, readyAt: startedAt,
      assignment: roleAssignment(binding, "189", "Acceptance", repo.state), authorize: async () => {}, execute: roleExecution });
    const receipt = roleAdmission(repo.primary, home, run, source);
    receipt.runReceipt.observations.push({ at: startedAt, dag: "feature", run, attempt: 1,
      category: "runtimeAndModels", kind: "role-job", data: { id: result.id, state: "completed", result: join(directory, "result.json") } });
    writeFileSync(join(repo.state, "receipt.json"), JSON.stringify(receipt));
    const identity = JSON.stringify({ primary: repo.primary, worktree: repo.worktree, branch: repo.branch, run, session: "parent-id" }) + "\n";
    writeFileSync(join(repo.state, "identity"), identity);
    writeFileSync(git(repo.worktree, "rev-parse", "--path-format=absolute", "--git-path", "dagu-feature-owner"), identity);
    writeFileSync(join(repo.worktree, "README.txt"), "native delivery\n");
    // Dagu outputs flatten newlines; capture must take the multi-line text from the verified receipt.
    const resultFile = join(directory, "result.json");
    const output = { summary: "Deliver native change\n\nRan: npm test", message: "feat: deliver native change\n\nBody line" };
    writeFileSync(resultFile, JSON.stringify({ ...JSON.parse(readFileSync(resultFile, "utf8")), output }));
    runScript(extractScript(definition, "  - id: capture"), repo, { IMPLEMENTER: result.id, OMP_SESSION_ID: "parent-id",
      SUMMARY: "Deliver native change  Ran: npm test", MESSAGE: "feat: deliver native change  Body line" });
    runScript(extractScript(definition, "  - id: gate"), repo);
    runScript(extractScript(definition, "  - id: push"), repo);
    const candidate = JSON.parse(readFileSync(join(repo.state, "candidate.json"), "utf8"));
    assert.equal(git(repo.primary, "ls-remote", "origin", `refs/heads/${repo.branch}`).split(/\s/)[0], candidate.sha);
    assert.equal(candidate.implementation.inputSha, binding.sha);
    assert.notEqual(candidate.sha, binding.sha);
    assert.equal(candidate.summary, output.summary);
    assert.equal(candidate.message, output.message);
    assert.equal(git(repo.worktree, "log", "-1", "--format=%B", candidate.sha), output.message);
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

test("template isolated PoC parent succeeds after exactly one child enqueue across the complete implementation graph", { ...liveDagu, timeout: 60_000 }, () => {
  const run = testRunId("poc-parent");
  const repo = repository(run);
  git(repo.primary, "worktree", "remove", repo.worktree);
  try {
    const home = join(repo.root, "dagu-home");
    mkdirSync(join(home, "dags"), { recursive: true });
    const bin = join(repo.root, "bin");
    const calls = join(repo.root, "external-calls");
    writeFileSync(calls, "");
    writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash\nprintf '%s\\n' "gh $*" >> ${JSON.stringify(calls)}\n`);
    writeFileSync(join(bin, "a4s-routing"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" != enqueue ]]; then exec ${JSON.stringify(a4sBin)} "$@"; fi
arguments="$*"
while [[ $# -gt 0 && "$1" != -- ]]; do shift; done
[[ "$1" == -- ]]
shift
for parameter in "$@"; do export "$parameter"; done
${JSON.stringify(a4sBin)} poc-scope require
printf '%s\\n' "a4s $arguments" >> ${JSON.stringify(calls)}
`);
    for (const command of ["gh", "a4s-routing"]) chmodSync(join(bin, command), 0o755);
    const source = readFileSync(definitions[0][1], "utf8");
    const dag = join(home, "dags", "feature.yaml");
    const variables = {
      A4S_BIN: join(bin, "a4s-routing"),
      PRIMARY: repo.primary, WORKTREE: repo.worktree, BRANCH: repo.branch,
      RUN: run, ISSUE: "189", BASE_BRANCH: "main", PR_NUMBER: "", VALIDATION: "",
      OMP_SESSION_ID: "parent-id", PATH: `${bin}:${process.env.PATH}`, GATE: "true",
      REQUIRED_CHECK: "validate", DAGU_FEATURE_BUNDLE: "test",
      ESCALATION_POC_INCONCLUSIVE: "2",
    };
    writeFileSync(dag, `name: feature\ntype: graph\nshell: bash\nmax_active_steps: 1\nenv:\n${Object.entries(variables).map(([key, value]) => `  - ${key}: ${JSON.stringify(value)}`).join("\n")}\n`
      + source.slice(source.indexOf("  - DAGU_RESOURCE_GUARD: |"), source.indexOf("steps:\n"))
      + `steps:\n  - id: triage\n    run: |\n      printf '%s\\n' 'POC=yes' 'QUESTION=runtime behavior' 'BASIS=regression test' 'REVIEW=' 'REQUIRED_TARGETS=["linux-arm64"]' 'AUTHORIZED_TARGETS=["linux-arm64"]' 'SCOPE_BASIS=regression test authorized linux-arm64' >> "$DAGU_OUTPUT_FILE"\n    outputs:\n      - name: POC\n      - name: QUESTION\n      - name: BASIS\n      - name: REVIEW\n      - name: REQUIRED_TARGETS\n      - name: AUTHORIZED_TARGETS\n      - name: SCOPE_BASIS\n`
      + source.slice(source.indexOf("  - id: triage_decision\n")));
    const env = { ...process.env, DAGU_HOME: home, DAGU_COORDINATOR_ENABLED: "false" };
    const result = spawnSync("dagu", ["start", "--run-id", run, dag], {
      encoding: "utf8", timeout: 45_000, env,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const step of ["implement", "push", "pr", "code_scanning", "auto_merge", "await_ci", "await_merge", "close_gate"]) {
      assert.match(result.stdout + result.stderr, new RegExp(`${step}\\s+.*skipped`));
    }
    const status = spawnSync("dagu", ["status", dag, "--run-id", run], { encoding: "utf8", env });
    assert.equal(status.status, 0, status.stdout + status.stderr);
    assert.match(status.stdout, /Succeeded/);
    const scope = join(repo.primary, ".git", "poc", "scope", "189");
    const requests = readdirSync(scope);
    assert.equal(requests.length, 1);
    const request = JSON.parse(readFileSync(join(scope, requests[0]!, "request.json"), "utf8"));
    assert.equal(request.decisionRequired, false);
    assert.deepEqual(request.input, { issue: "189", question: "runtime behavior", requiredTargets: ["linux-arm64"],
      authorizedTargets: ["linux-arm64"], basis: "regression test authorized linux-arm64" });
    assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), [
      `a4s enqueue --parent ${join(repo.primary, ".git", "dagu-feature", "runs", run, "receipt.json")} --run-id poc-${run} ${repo.primary}/.workspace/dagu/dags/poc.yaml -- ISSUE=189 QUESTION=runtime behavior OMP_SESSION_ID=parent-id REQUIRED_TARGETS=["linux-arm64"] AUTHORIZED_TARGETS=["linux-arm64"] SCOPE_BASIS=regression test authorized linux-arm64 SCOPE_REQUEST=${request.id}`,
      `gh issue comment 189 --body-file ${join(repo.primary, ".git", "dagu-feature", "runs", run, "triage.md")}`,
    ]);
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

for (const [name, definition] of definitions) {
  const exitScript = extractScript(definition, "  exit:");
  const checkpointScript = extractScript(definition, "  - id: checkpoint_push");
  const closeGateScript = extractScript(definitions[0][1], "  - id: close_gate");

  const captureScript = extractScript(definition, "  - id: capture");
  const gateScript = extractScript(definition, "  - id: gate");

  for (const kind of ["workspace", "workspace-repository", "nested-repository", "nested-git-file"] as const) {
    test(`${name} capture rejects disposable ${kind} before staging`, () => {
      const repo = repository();
      try {
        // The seed ignores .workspace globally; expose it to exercise ordinary untracked discovery.
        writeFileSync(join(repo.primary, ".git", "info", "exclude"), "");
        const path = kind.startsWith("workspace") ? ".workspace/issue-evidence" : "nested evidence";
        const directory = join(repo.worktree, path);
        mkdirSync(directory, { recursive: true });
        if (kind.endsWith("repository")) git(directory, "init");
        else if (kind === "nested-git-file") writeFileSync(join(directory, ".git"), "gitdir: missing\n");
        else writeFileSync(join(directory, "archive.tar"), "disposable\n");
        const beforeHead = git(repo.worktree, "rev-parse", "HEAD");
        const beforeIndex = git(repo.worktree, "ls-files", "--stage");
        const result = spawnSync("bash", ["-c", captureScript], { encoding: "utf8", env: featureScriptEnv(repo) });
        assert.notEqual(result.status, 0);
        assert.ok(result.stderr.includes(path.replaceAll(" ", "\\ ")), result.stderr);
        assert.ok(result.stderr.includes(`${repo.state}/computations/`), result.stderr);
        assert.match(result.stderr, /rule=capture.(untracked_workspace|nested_git) expected=.+ observed=.+/);
        assert.equal(git(repo.worktree, "rev-parse", "HEAD"), beforeHead);
        assert.equal(git(repo.worktree, "ls-files", "--stage"), beforeIndex);
      } finally { rmSync(repo.root, { recursive: true, force: true }); }
    });
  }

  for (const signing of [true, false]) {
    test(`${name} capture signs delivery commits with configured SSH signing (${signing})`, () => {
      const repo = repository();
      try {
        const home = join(repo.root, "home");
        mkdirSync(home);
        const key = join(home, "signing-key");
        execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], { env: { ...process.env, DAGU_PARAMS_JSON: "{}", HOME: home } });
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
      assert.match(runScript(exitScript, repo), /dirty worktree; files retained/);
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
      const source = readFileSync(definition, "utf8");
      assert.match(extractStep(source, "rebase"), /^    depends: rebase_escalation_decision$/m);
      assert.match(extractStep(source, "rebase"), /    retry_policy:\n      limit: 3\n      interval_sec: 5\n      exit_code: \[75\]/);
      assert.match(extractStep(source, "dependency_review_cancellation"), /^    depends: dependency_review$/m);
      const path = ["dependency_review_cancellation", "rebase_budget", "rebase_escalation",
        "rebase_escalation_cancellation", "rebase_escalation_decision"];
      for (let index = 1; index < path.length; index++) {
        assert.match(extractStep(source, path[index]!), new RegExp(`^    depends: ${path[index - 1]}$`, "m"));
      }
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
        assert.equal(existsSync(join(repo.state, "poc-basis.json")), false);
      }
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} start_gate carries a promoted PoC candidate and capture records an empty feature delta`, () => {
    const repo = repository("feature-carry");
    try {
      const basis = writePocBasis(repo, "carry", worktree => {
        writeFileSync(join(worktree, "README.txt"), "poc candidate\n");
        mkdirSync(join(worktree, "notes"), { recursive: true });
        writeFileSync(join(worktree, "notes", "generated file.txt"), "artifact\n");
        writeFileSync(join(worktree, "blob.bin"), Buffer.from([0, 1, 2, 255]));
      });
      writeFileSync(join(repo.primary, "upstream.txt"), "moved\n");
      git(repo.primary, "add", "upstream.txt");
      git(repo.primary, "commit", "-m", "move origin");
      git(repo.primary, "push", "origin", "main");
      resetFeatureWorktree(repo);
      const script = extractScript(definition, "  - id: start_gate");
      const env = { POC_BASIS: "https://example.test/comments/9", DAGU_FEATURE_BUNDLE: "test" };
      const output = runScript(script, repo, env);
      assert.equal(git(repo.worktree, "rev-parse", "HEAD"), basis.base);
      assert.notEqual(basis.base, git(repo.primary, "rev-parse", "origin/main"));
      assert.equal(readFileSync(join(repo.worktree, "README.txt"), "utf8"), "poc candidate\n");
      assert.equal(readFileSync(join(repo.worktree, "notes", "generated file.txt"), "utf8"), "artifact\n");
      assert.deepEqual(readFileSync(join(repo.worktree, "blob.bin")), Buffer.from([0, 1, 2, 255]));
      const recorded = JSON.parse(readFileSync(join(repo.state, "poc-basis.json"), "utf8")) as { digest: string; applied: boolean; pocRun: string; base: string };
      assert.equal(recorded.digest, basis.digest);
      assert.equal(recorded.applied, true);
      assert.equal(recorded.pocRun, "carry");
      assert.equal(recorded.base, basis.base);
      assert.match(output, new RegExp(`poc_basis=applied digest=${basis.digest}`));
      const again = runScript(script, repo, env);
      assert.match(again, new RegExp(`poc_basis=applied digest=${basis.digest}`));
      assert.equal(readFileSync(join(repo.worktree, "README.txt"), "utf8"), "poc candidate\n");
      const assignment = roleAssignment({
        repo: repo.primary, worktree: repo.worktree, lane: "feature", dag: "feature", run: "feature-carry",
        stage: "implement", role: "implement", sha: basis.base, iteration: 0, attempt: "0:test",
      }, "189", "Acceptance", repo.state);
      assert.match(assignment, /promoted PoC candidate is already applied/);
      assert.match(assignment, /poc-basis\.json/);
      const capture = extractScript(definition, "  - id: capture");
      const captured = runScript(capture, repo);
      assert.match(captured, new RegExp(`poc_basis=applied digest=${basis.digest} feature_delta=empty`));
      const candidate = JSON.parse(readFileSync(join(repo.state, "candidate.json"), "utf8")) as { pocBasis: { digest: string; featureDelta: string } };
      assert.equal(candidate.pocBasis.digest, basis.digest);
      assert.equal(candidate.pocBasis.featureDelta, "empty");
      assert.equal(git(repo.worktree, "show", "HEAD:README.txt"), "poc candidate");
      assert.equal(git(repo.worktree, "show", "HEAD:notes/generated file.txt"), "artifact");
      writeFileSync(join(repo.worktree, "more.txt"), "more\n");
      const extended = runScript(capture, repo);
      assert.match(extended, new RegExp(`poc_basis=applied digest=${basis.digest} feature_delta=changed`));
      assert.equal(git(repo.worktree, "show", "HEAD:README.txt"), "poc candidate");
      assert.equal(git(repo.worktree, "show", "HEAD:more.txt"), "more");
      assert.deepEqual(execFileSync("git", ["-C", repo.worktree, "show", "HEAD:blob.bin"]), Buffer.from([0, 1, 2, 255]));
      runScript(extractScript(definition, "  - id: rebase"), repo);
      assert.equal(git(repo.worktree, "rev-parse", "HEAD^"), git(repo.primary, "rev-parse", "origin/main"));
      assert.equal(git(repo.worktree, "show", "HEAD:README.txt"), "poc candidate");
      assert.equal(git(repo.worktree, "show", "HEAD:upstream.txt"), "moved");
      assert.equal(git(repo.worktree, "show", "HEAD:more.txt"), "more");
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} capture shows an empty PoC basis when the feature diff is empty`, () => {
    const repo = repository("feature-empty");
    try {
      const basis = writePocBasis(repo, "empty", () => {});
      assert.equal(readFileSync(basis.patch, "utf8"), "");
      resetFeatureWorktree(repo);
      const output = runScript(extractScript(definition, "  - id: start_gate"), repo, {
        POC_BASIS: "https://example.test/comments/9", DAGU_FEATURE_BUNDLE: "test",
      });
      assert.match(output, new RegExp(`poc_basis=applied digest=${basis.digest}`));
      assert.equal(git(repo.worktree, "status", "--porcelain", "--untracked-files=all"), "");
      assert.equal(git(repo.worktree, "rev-parse", "HEAD"), basis.base);
      const captured = runScript(extractScript(definition, "  - id: capture"), repo);
      assert.match(captured, new RegExp(`poc_basis=applied digest=${basis.digest} feature_delta=empty`));
      assert.equal(readFileSync(join(repo.state, "diff.patch"), "utf8"), "");
      const candidate = JSON.parse(readFileSync(join(repo.state, "candidate.json"), "utf8")) as { pocBasis: { applied: boolean; featureDelta: string; digest: string } };
      assert.equal(candidate.pocBasis.applied, true);
      assert.equal(candidate.pocBasis.featureDelta, "empty");
      assert.equal(candidate.pocBasis.digest, basis.digest);
      assert.equal(JSON.parse(readFileSync(join(repo.state, "poc-basis.json"), "utf8")).featureDelta, "empty");
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} start_gate rejects a promoted basis whose patch digest, ancestry, or apply target does not match`, () => {
    const mismatch = repository("feature-mismatch");
    try {
      const basis = writePocBasis(mismatch, "mismatch", worktree => writeFileSync(join(worktree, "README.txt"), "poc candidate\n"));
      writeFileSync(basis.patch, `${readFileSync(basis.patch, "utf8")}\n`);
      resetFeatureWorktree(mismatch);
      const script = extractScript(definition, "  - id: start_gate");
      const env = { POC_BASIS: "https://example.test/comments/9", DAGU_FEATURE_BUNDLE: "test" };
      const rejected = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...featureScriptEnv(mismatch), ...env } });
      assert.notEqual(rejected.status, 0, rejected.stdout);
      assert.match(rejected.stderr, /rule=start_gate.poc_patch_digest expected=\S+ observed=\S+/);
      assert.equal(existsSync(mismatch.worktree), false);
    } finally {
      rmSync(mismatch.root, { recursive: true, force: true });
    }

    const diverged = repository("feature-diverged");
    try {
      git(diverged.primary, "checkout", "-b", "side");
      writeFileSync(join(diverged.primary, "side.txt"), "side\n");
      git(diverged.primary, "add", "side.txt");
      git(diverged.primary, "commit", "-m", "side");
      const side = git(diverged.primary, "rev-parse", "HEAD");
      git(diverged.primary, "checkout", "main");
      const state = git(diverged.primary, "rev-parse", "--path-format=absolute", "--git-path", "poc/runs/diverged");
      mkdirSync(state, { recursive: true });
      writeFileSync(join(state, "full.patch"), "");
      writeFileSync(join(state, "full.patch.sha256"), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n");
      writeFileSync(join(state, "comment.url"), "https://example.test/comments/9\n");
      writeFileSync(join(state, "promotion.url"), "https://example.test/comments/9\n");
      writeFileSync(join(state, "base.sha"), `${side}\n`);
      resetFeatureWorktree(diverged);
      const rejected = spawnSync("bash", ["-c", extractScript(definition, "  - id: start_gate")], {
        encoding: "utf8",
        env: { ...featureScriptEnv(diverged), POC_BASIS: "https://example.test/comments/9", DAGU_FEATURE_BUNDLE: "test" },
      });
      assert.notEqual(rejected.status, 0, rejected.stdout);
      assert.match(rejected.stderr, new RegExp(`rule=start_gate.poc_base_ancestry .* observed=${side}`));
      assert.equal(existsSync(diverged.worktree), false);
    } finally {
      rmSync(diverged.root, { recursive: true, force: true });
    }

    const preserved = repository("feature-preserved");
    try {
      const base = git(preserved.primary, "rev-parse", "HEAD");
      const state = git(preserved.primary, "rev-parse", "--path-format=absolute", "--git-path", "poc/runs/preserved");
      mkdirSync(state, { recursive: true });
      const patch = [
        "diff --git a/README.txt b/README.txt",
        "index 1111111..2222222 100644",
        "--- a/README.txt",
        "+++ b/README.txt",
        "@@ -1 +1 @@",
        "-missing context",
        "+poc candidate",
        "",
      ].join("\n");
      writeFileSync(join(state, "full.patch"), patch);
      writeFileSync(join(state, "full.patch.sha256"), `${createHash("sha256").update(patch).digest("hex")}\n`);
      writeFileSync(join(state, "comment.url"), "https://example.test/comments/9\n");
      writeFileSync(join(state, "promotion.url"), "https://example.test/comments/9\n");
      writeFileSync(join(state, "base.sha"), `${base}\n`);
      const rejected = spawnSync("bash", ["-c", extractScript(definition, "  - id: start_gate")], {
        encoding: "utf8",
        env: { ...featureScriptEnv(preserved), POC_BASIS: "https://example.test/comments/9", DAGU_FEATURE_BUNDLE: "test" },
      });
      assert.notEqual(rejected.status, 0, rejected.stdout);
      assert.match(rejected.stderr, /rule=start_gate.poc_patch_applicable expected=.+ observed=.+/);
      assert.equal(readFileSync(join(preserved.worktree, "README.txt"), "utf8"), "base\n");
      assert.equal(git(preserved.worktree, "status", "--porcelain", "--untracked-files=all"), "");
      assert.equal(existsSync(join(preserved.state, "poc-basis.json")), false);
      writeFileSync(join(preserved.worktree, "README.txt"), "local edit\n");
      const valid = writePocBasis(preserved, "preserved", worktree => writeFileSync(join(worktree, "README.txt"), "poc candidate\n"));
      assert.equal(valid.base, base);
      const dirty = spawnSync("bash", ["-c", extractScript(definition, "  - id: start_gate")], {
        encoding: "utf8",
        env: { ...featureScriptEnv(preserved), POC_BASIS: "https://example.test/comments/9", DAGU_FEATURE_BUNDLE: "test" },
      });
      assert.notEqual(dirty.status, 0, dirty.stdout);
      assert.match(dirty.stderr, /rule=start_gate.existing_poc_basis expected=.+ observed=.+/);
      assert.equal(readFileSync(join(preserved.worktree, "README.txt"), "utf8"), "local edit\n");
    } finally {
      rmSync(preserved.root, { recursive: true, force: true });
    }
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
      assert.match(output, /Recovery: preserve/);
      assert.match(output, /suffixed run ID/);
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
      stubGh(repo, `${JSON.stringify({ state: "MERGED", headRefOid: head, mergeCommit: { oid: git(repo.primary, "rev-parse", "HEAD") } })}\n`, 0);
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
      assert.match(output, /PR head SHA differs/);
      assert.match(output, /Recovery: preserve/);
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
      assert.match(output, /PR integration query failed/);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} checkpoint recovery retains the exact failed-gate candidate after exit`, () => {
    const repo = repository();
    try {
      stubGh(repo, "[]\n", 0);
      commit(repo, "README.txt", "recoverable candidate\n");
      const head = git(repo.worktree, "rev-parse", "HEAD");
      runScript(checkpointScript, repo);
      const failed = spawnSync("bash", ["-c", gateScript], {
        encoding: "utf8", env: { ...featureScriptEnv(repo), GATE: "false" },
      });
      assert.notEqual(failed.status, 0);
      runScript(exitScript, repo);
      assert.equal(existsSync(repo.worktree), true);
      assert.equal(git(repo.worktree, "rev-parse", "HEAD"), head);
      const recovery = join(repo.root, "recovery");
      execFileSync("git", ["clone", join(repo.root, "remote.git"), recovery], { stdio: "pipe" });
      git(recovery, "fetch", "origin", "refs/dagu/checkpoints/issue-189");
      assert.equal(git(recovery, "rev-parse", "FETCH_HEAD"), head);
      git(recovery, "cat-file", "-e", `${head}^{commit}`);
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });

  test(`${name} close_gate removes its recorded checkpoint after the integrated candidate advances`, () => {
    const repo = repository();
    try {
      commit(repo, "README.txt", "checkpoint candidate\n");
      runScript(checkpointScript, repo);
      commit(repo, "README.txt", "integrated correction\n");
      git(repo.primary, "merge", "--ff-only", repo.branch);
      git(repo.primary, "push", "origin", "main");
      stubSuccessfulCloseGateGh(repo);
      runScript(closeGateScript, repo);
      assert.equal(git(repo.primary, "ls-remote", "origin", "refs/dagu/checkpoints/issue-189"), "");
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });

  test(`${name} exit preserves a merely published head with integration diagnostics`, () => {
    const repo = repository();
    try {
      commit(repo, "README.txt", "published\n");
      git(repo.worktree, "push", "origin", `HEAD:${repo.branch}`);
      stubGh(repo, JSON.stringify({ state: "OPEN" }), 0);
      const output = runScript(exitScript, repo);
      assert.equal(existsSync(repo.worktree), true);
      assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), true);
      assert.match(output, /publication alone is not integration/);
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
}

for (const [name, definition] of definitions) {
  const checkpointScript = extractScript(definition, "  - id: checkpoint_push");
  const captureScript = extractScript(definition, "  - id: capture");
  const gateScript = extractScript(definition, "  - id: gate");
  const pushScript = extractScript(definition, "  - id: push");
  const autoMergeScript = extractScript(definition, "  - id: auto_merge");
  for (const mergeStateStatus of ["CLEAN", "BLOCKED"]) {
    test(`${name} armed correction disarms before publishing then requests the admitted ${mergeStateStatus} SHA`, () => {
      const repo = repository();
      try {
        const remote = join(repo.root, "remote.git");
        const headRef = `refs/heads/${repo.branch}`;
        const old = git(repo.worktree, "rev-parse", "HEAD");
        git(repo.worktree, "push", "origin", `HEAD:${headRef}`);
        commit(repo, "README.txt", "corrected candidate\n");
        const sha = git(repo.worktree, "rev-parse", "HEAD");
        const armed = join(repo.root, "armed");
        const events = join(repo.root, "events");
        const observed = join(repo.root, "observed");
        writeFileSync(armed, "old request\n");
        writeFileSync(events, "");
        const observation = {
          number: 190, state: "OPEN", headRefName: repo.branch, baseRefName: "main",
          headRefOid: old, autoMergeRequest: { enabledAt: "old" }, mergeCommit: null, mergeStateStatus,
        };
        writeFileSync(observed, JSON.stringify(observation));
        writeFileSync(join(repo.root, "bin", "gh"), `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "pr list "*) jq -s . ${JSON.stringify(observed)} ;;
  "pr view 190 --repo "*) cat ${JSON.stringify(observed)} ;;
  "pr merge 190 --repo "*" --disable-auto")
    [[ "$(git --git-dir=${JSON.stringify(remote)} rev-parse ${JSON.stringify(headRef)})" == "${old}" ]]
    printf 'disarm\\n' >> ${JSON.stringify(events)}
    rm ${JSON.stringify(armed)}
    jq '.autoMergeRequest = null' ${JSON.stringify(observed)} > ${JSON.stringify(`${observed}.next`)}
    mv ${JSON.stringify(`${observed}.next`)} ${JSON.stringify(observed)} ;;
  "pr view 190 --json headRefOid --jq .headRefOid") git --git-dir=${JSON.stringify(remote)} rev-parse ${JSON.stringify(headRef)} ;;
  "pr view 190 --json state,mergeStateStatus,autoMergeRequest,mergeCommit,headRefOid")
    jq --arg sha "${sha}" '.headRefOid = $sha' ${JSON.stringify(observed)} ;;
  "pr view 190 --json number --jq .number") printf '190\\n' ;;
  "pr merge 190 "*)
    [[ ! -e ${JSON.stringify(armed)} ]]
    [[ "$(git --git-dir=${JSON.stringify(remote)} rev-parse ${JSON.stringify(headRef)})" == "${sha}" ]]
    [[ "$*" == *"--match-head-commit ${sha}"* ]]
    printf 'request ${sha}\\n' >> ${JSON.stringify(events)} ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 });
        writeFileSync(join(remote, "hooks", "pre-receive"), `#!/usr/bin/env bash
set -euo pipefail
while read -r old new ref; do
  if [[ "$ref" == "${headRef}" ]]; then
    [[ ! -e ${JSON.stringify(armed)} ]]
    [[ "$new" == "${sha}" ]]
    printf 'publish %s\\n' "$new" >> ${JSON.stringify(events)}
  fi
done
`, { mode: 0o755 });
        runScript(checkpointScript, repo);
        assert.equal(git(remote, "rev-parse", headRef), old);
        assert.equal(existsSync(armed), true);
        assert.equal(readFileSync(events, "utf8"), "");
        runScript(gateScript, repo);
        const refused = spawnSync("bash", ["-c", pushScript], {
          encoding: "utf8", env: { ...featureScriptEnv(repo), VALIDATION: "operator smoke", APPROVED: "yes", TESTED_SHA: old },
        });
        assert.notEqual(refused.status, 0);
        assert.equal(readFileSync(events, "utf8"), "");
        const approved = spawnSync("bash", ["-c", pushScript], {
          encoding: "utf8", env: { ...featureScriptEnv(repo), VALIDATION: "operator smoke", APPROVED: "yes", TESTED_SHA: sha },
        });
        assert.equal(approved.status, 0, approved.stdout + approved.stderr);
        assert.equal(readFileSync(join(repo.state, "published-sha"), "utf8"), `${sha}\n`);
        assert.equal(JSON.parse(readFileSync(join(repo.state, "validation.json"), "utf8")).sha, sha);
        runScript(autoMergeScript, repo);
        assert.deepEqual(readFileSync(events, "utf8").trim().split("\n"), ["disarm", `publish ${sha}`, `request ${sha}`]);
      } finally { rmSync(repo.root, { recursive: true, force: true }); }
    });
  }
  for (const failure of ["wrong identity", "disable rejected", "request remains armed"]) {
    test(`${name} push preserves the remote candidate when ${failure}`, () => {
      const repo = repository();
      try {
        const remote = join(repo.root, "remote.git");
        const old = git(repo.worktree, "rev-parse", "HEAD");
        git(repo.worktree, "push", "origin", `HEAD:refs/heads/${repo.branch}`);
        commit(repo, "README.txt", "corrected candidate\n");
        runScript(gateScript, repo);
        const events = join(repo.root, "events");
        writeFileSync(events, "");
        const pr = { number: 190, state: "OPEN", headRefName: failure === "wrong identity" ? "another-branch" : repo.branch,
          baseRefName: "main", headRefOid: old, autoMergeRequest: { enabledAt: "old" }, mergeCommit: null };
        writeFileSync(join(repo.root, "bin", "gh"), `#!/usr/bin/env bash
case "$*" in
  "pr list "*) printf '%s\\n' '${JSON.stringify([pr])}' ;;
  "pr view 190 --repo "*) printf '%s\\n' '${JSON.stringify(pr)}' ;;
  "pr merge 190 --repo "*" --disable-auto") printf 'disable\\n' >> ${JSON.stringify(events)}; exit ${failure === "disable rejected" ? 1 : 0} ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 });
        const result = spawnSync("bash", ["-c", pushScript], { encoding: "utf8", env: featureScriptEnv(repo) });
        assert.notEqual(result.status, 0);
        assert.equal(git(remote, "rev-parse", `refs/heads/${repo.branch}`), old);
        assert.equal(existsSync(join(repo.state, "published-sha")), false);
        assert.equal(readFileSync(events, "utf8"), failure === "wrong identity" ? "" : "disable\n");
      } finally { rmSync(repo.root, { recursive: true, force: true }); }
    });
  }

  for (const checkpoint of ["checkpoint_push", "push"]) {
    for (const deleted of [false, true]) {
      for (const retained of ["none", "dirty", "newer", "identity", "wrong-branch"]) {
        test(`${name} already MERGED at ${checkpoint}, remote ${deleted ? "deleted" : "present"}, ${retained} local work follows integrated cleanup`, () => {
          const repo = repository();
          try {
            commit(repo, "README.txt", "integrated candidate\n");
            const sha = git(repo.worktree, "rev-parse", "HEAD");
            runScript(checkpointScript, repo);
            git(repo.worktree, "push", "origin", `HEAD:refs/heads/${repo.branch}`);
            git(repo.primary, "merge", "--squash", repo.branch);
            git(repo.primary, "commit", "-m", "squash delivery");
            const squash = git(repo.primary, "rev-parse", "HEAD");
            git(repo.primary, "push", "origin", "main");
            if (deleted) git(repo.primary, "push", "origin", `:refs/heads/${repo.branch}`);
            if (retained === "dirty") writeFileSync(join(repo.worktree, "untracked"), "recover me\n");
            if (retained === "newer") commit(repo, "newer", "recover this commit\n");
            if (retained === "identity") {
              const resource = JSON.parse(readFileSync(join(repo.state, "resource.json"), "utf8"));
              writeFileSync(join(repo.state, "resource.json"), JSON.stringify({ ...resource, run: "another-owner" }));
            }
            if (retained === "wrong-branch") git(repo.worktree, "checkout", "-b", "recoverable-work");
            const local = git(repo.worktree, "rev-parse", "HEAD");
            const pr = { number: 190, state: "MERGED", headRefName: repo.branch, baseRefName: "main",
              headRefOid: sha, autoMergeRequest: null, mergeCommit: { oid: squash } };
            const gh = join(repo.root, "bin", "gh");
            writeFileSync(gh, `#!/usr/bin/env bash
case "$*" in
  "pr list "*) printf '%s\\n' '${JSON.stringify([pr])}' ;;
  "pr view 190 --repo "*) printf '%s\\n' '${JSON.stringify(pr)}' ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 });
            const hookEvents = join(repo.root, "publications");
            writeFileSync(hookEvents, "");
            writeFileSync(join(repo.root, "remote.git", "hooks", "pre-receive"), `#!/usr/bin/env bash
while read -r old new ref; do
  [[ "$new" == 0000000000000000000000000000000000000000 ]] || exit 1
  printf '%s\\n' "$ref" >> ${JSON.stringify(hookEvents)}
done
`, { mode: 0o755 });
            const output = join(repo.root, "outputs");
            assert.match(runScript(extractScript(definition, `  - id: ${checkpoint}`), repo, { DAGU_OUTPUT_FILE: output }),
              /already MERGED.*no publication/);
            assert.equal(readFileSync(output, "utf8"), "INTEGRATED=yes\n");
            const evidence = JSON.parse(readFileSync(join(repo.state, "integrated.json"), "utf8"));
            assert.equal(evidence.headRefOid, sha);
            assert.equal(evidence.candidate, local);
            assert.equal(evidence.checkpoint, checkpoint);
            runScript(extractScript(definition, "  exit:"), repo);
            if (retained === "none") {
              assert.equal(existsSync(repo.worktree), false);
              assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), false);
              assert.equal(hasRef(join(repo.root, "remote.git"), `refs/heads/${repo.branch}`), false);
              assert.equal(hasRef(join(repo.root, "remote.git"), "refs/dagu/checkpoints/issue-189"), false);
              assert.equal(readFileSync(join(repo.state, "cleanup-phase"), "utf8"), "complete\n");
              const proof = JSON.parse(readFileSync(join(repo.state, "cleanup-proof.json"), "utf8"));
              assert.equal(proof.candidate, sha);
              assert.equal(proof.proof, "squash");
              assert.equal(proof.squash, squash);
              assert.equal(existsSync(join(repo.state, "cleanup-diagnostic")), false);
            } else {
              assert.equal(existsSync(repo.worktree), true);
              assert.equal(git(repo.worktree, "rev-parse", "HEAD"), local);
              const diagnostic = readFileSync(join(repo.state, "cleanup-diagnostic"), "utf8");
              const reason = retained === "dirty" ? /dirty worktree/ : retained === "newer" ? /PR head SHA differs/
                : retained === "identity" ? /resource owner or identity changed/ : /resource proof or cleanup operation failed/;
              assert.match(diagnostic, reason);
              assert.ok(diagnostic.includes(repo.worktree));
              assert.ok(diagnostic.includes(repo.branch));
              assert.equal(readFileSync(hookEvents, "utf8"), "");
            }
          } finally { rmSync(repo.root, { recursive: true, force: true }); }
        });
      }
    }
  }
  for (const checkpoint of ["checkpoint_push", "push"]) {
    test(`${name} native graph succeeds after already MERGED at ${checkpoint} with a deleted remote branch`, { ...liveDagu, timeout: 60_000 }, async () => {
      const fixture = await recoveryFixture();
      const run = testRunId(`integrated-${checkpoint}`);
      const repo = repository(run);
      try {
        commit(repo, "README.txt", "already integrated\n");
        const sha = git(repo.worktree, "rev-parse", "HEAD");
        git(repo.worktree, "push", "origin", `HEAD:refs/heads/${repo.branch}`);
        git(repo.primary, "merge", "--ff-only", repo.branch);
        git(repo.primary, "push", "origin", "main", `:refs/heads/${repo.branch}`);
        const pr = { number: 190, state: "MERGED", headRefName: repo.branch, baseRefName: "main",
          headRefOid: sha, autoMergeRequest: null, mergeCommit: { oid: sha } };
        writeFileSync(join(repo.root, "bin", "gh"), `#!/usr/bin/env bash
case "$*" in
  "pr list "*) printf '%s\\n' '${JSON.stringify([pr])}' ;;
  "pr view 190 --repo "*) printf '%s\\n' '${JSON.stringify(pr)}' ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 });
        writeFileSync(join(repo.root, "remote.git", "hooks", "pre-receive"), '#!/usr/bin/env bash\nwhile read -r old new ref; do [[ "$new" == 0000000000000000000000000000000000000000 ]] || exit 1; done\n', { mode: 0o755 });
        rmSync(join(repo.root, "bin", "dagu"));
        const home = fixture.home;
        const source = parse(readFileSync(definition, "utf8")) as {
          env: Array<Record<string, string>>; steps: Array<{ id: string; depends?: string | string[]; [key: string]: unknown }>;
          handler_on: { exit: unknown }; [key: string]: unknown;
        };
        const start = source.steps.findIndex(step => step.id === checkpoint);
        const steps = source.steps.map((step, index) => index >= start ? step : {
          id: step.id, ...(index ? { depends: source.steps[index - 1]!.id } : {}),
          run: step.id === "triage" ? 'echo POC=no >> "$DAGU_OUTPUT_FILE"'
            : step.id === "checkpoint_push" ? 'echo INTEGRATED=no >> "$DAGU_OUTPUT_FILE"' : "true",
          ...(step.id === "triage" ? { outputs: [{ name: "POC" }] }
            : step.id === "checkpoint_push" ? { outputs: [{ name: "INTEGRATED" }] } : {}),
        });
        const env: NodeJS.ProcessEnv = { ...fixture.env, ...featureScriptEnv(repo), DAGU_HOME: home, DAGU_PORT: String(fixture.port) };
        // Native Dagu, not the direct-shell helper, owns each step's output sink.
        delete env.DAGU_OUTPUT_FILE;
        const file = join(home, "dags", "feature.yaml");
        writeFileSync(file, stringify({
          name: "feature", type: "graph", shell: "bash", max_active_steps: 1,
          params: [{ ISSUE: "189" }, { PR_NUMBER: "" }, { OMP_SESSION_ID: "integration-test-owner" }],
          env: [...Object.entries({ ...featureScriptEnv(repo), DAGU_HOME: home })
            .filter((entry): entry is [string, string] => entry[0] !== "DAGU_OUTPUT_FILE" && entry[1] !== undefined)
            .map(([key, value]) => ({ [key]: value })),
          { DAGU_RESOURCE_GUARD: source.env.find(entry => "DAGU_RESOURCE_GUARD" in entry)!.DAGU_RESOURCE_GUARD },
          { VALIDATION: "operator validates the gated candidate" }, { DAGU_PORT: String(fixture.port) }],
          steps, handler_on: { exit: source.handler_on.exit },
        }, { defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN" }));
        const result = spawnSync("dagu", ["start", "--run-id", run, file], { encoding: "utf8", env, timeout: 45_000 });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        for (const step of ["pr", "code_scanning", "auto_merge", "await_ci", "await_merge", "close_gate"]) {
          assert.match(result.stdout + result.stderr, new RegExp(`${step}\\s+.*skipped`));
        }
        const status = spawnSync("dagu", ["status", file, "--run-id", run], { encoding: "utf8", env });
        assert.equal(status.status, 0, status.stdout + status.stderr);
        assert.match(status.stdout, /Succeeded/);
        const diagnostic = join(repo.state, "cleanup-diagnostic");
        assert.equal(existsSync(repo.worktree), false,
          `${existsSync(diagnostic) ? readFileSync(diagnostic, "utf8") : ""}\n${result.stdout}${result.stderr}`);
        assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), false);
        assert.equal(hasRef(join(repo.root, "remote.git"), `refs/heads/${repo.branch}`), false);
        assert.equal(readFileSync(join(repo.state, "cleanup-phase"), "utf8"), "complete\n");
      } finally { await fixture.close(); rmSync(repo.root, { recursive: true, force: true }); }
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

  test(`${name} checkpoint leases preserve the PR head and push publishes only a fresh gated SHA`, () => {
    const repo = repository();
    try {
      stubGh(repo, "[]\n", 0);
      const remote = join(repo.root, "remote.git");
      const ref = "refs/dagu/checkpoints/issue-189";
      git(repo.worktree, "push", "origin", `HEAD:refs/heads/${repo.branch}`);
      const original = git(remote, "rev-parse", `refs/heads/${repo.branch}`);
      commit(repo, "README.txt", "candidate\n");
      const candidate = git(repo.worktree, "rev-parse", "HEAD");
      runScript(checkpointScript, repo);
      assert.equal(git(remote, "rev-parse", ref), candidate);
      assert.equal(readFileSync(join(repo.state, "checkpoint-sha"), "utf8"), `${candidate}\n`);
      assert.equal(git(remote, "rev-parse", `refs/heads/${repo.branch}`), original);
      const push = extractScript(definition, "  - id: push");
      const attempt = () => spawnSync("bash", ["-c", push], { encoding: "utf8", env: featureScriptEnv(repo) });
      assert.match(attempt().stderr, /rule=push.gated_candidate expected=gate.json observed=missing/);
      const gateScript = extractScript(definition, "  - id: gate");
      const gateOptions = { encoding: "utf8", env: { ...featureScriptEnv(repo), GATE: "true" } } as const;
      assert.equal(spawnSync("bash", ["-c", gateScript], gateOptions).status, 0);
      commit(repo, "README.txt", "changed after gate\n");
      const stale = attempt();
      assert.equal(stale.status, 1);
      assert.match(stale.stderr, /rule=push.gated_head expected=\S+ observed=\S+/);
      assert.equal(git(remote, "rev-parse", `refs/heads/${repo.branch}`), original);
      git(remote, "update-ref", ref, original);
      const rejected = spawnSync("bash", ["-c", checkpointScript], { encoding: "utf8", env: featureScriptEnv(repo) });
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /stale info/);
      assert.equal(git(remote, "rev-parse", ref), original);
      assert.equal(readFileSync(join(repo.state, "checkpoint-sha"), "utf8"), `${candidate}\n`);
      git(remote, "update-ref", ref, candidate);
      runScript(checkpointScript, repo);
      assert.equal(spawnSync("bash", ["-c", gateScript], gateOptions).status, 0);
      runScript(push, repo);
      assert.equal(git(remote, "rev-parse", `refs/heads/${repo.branch}`), git(repo.worktree, "rev-parse", "HEAD"));
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });
  for (const scenario of [
    { label: "CLEAN", mergeStateStatus: "CLEAN", merge: "immediate" },
    { label: "auto-merge enabled CLEAN", mergeStateStatus: "CLEAN", autoMergeRequest: { enabledAt: "2026-10-16" }, merge: "immediate" },
    { label: "auto-merge enabled BLOCKED", mergeStateStatus: "BLOCKED", autoMergeRequest: { enabledAt: "2026-10-16" }, merge: "auto" },
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
  "pr merge ${repo.branch} --disable-auto") printf 'disarmed\\n' > "${argsFile}.disarmed" ;;
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
      assert.equal(existsSync(`${argsFile}.disarmed`), "autoMergeRequest" in scenario);
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
          assert.match(result.stderr, new RegExp(`rule=auto_merge.head_convergence expected=${sha} observed=${oldSha}`));
        }
      } finally {
        rmSync(repo.root, { recursive: true, force: true });
      }
    });
  }
}

for (const [name, definition] of [
  ...definitions,
  ["PoC template", fileURLToPath(new URL("../../skills/issue-execution/poc.yaml", import.meta.url))],
  ["PoC rendered DAG", fileURLToPath(new URL(renderedPoc, import.meta.url))],
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
  ["PoC template", fileURLToPath(new URL("../../skills/issue-execution/poc.yaml", import.meta.url))],
  ["PoC rendered DAG", fileURLToPath(new URL(renderedPoc, import.meta.url))],
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
        if (gate === "start_gate") {
          assert.match(result.stderr, new RegExp(`rule=start_gate.${failure === "ff-only" ? "fast_forward" : "fetch"} expected=.+ observed=.+`));
        } else {
          const diagnostic = gate === "base" && failure === "ff-only" ? "cause=primary_ahead" : `${gate}: ${failure}`;
          assert.ok(result.stderr.includes(diagnostic), result.stderr);
          assert.match(result.stderr, /restore origin access|reconcile primary/);
        }
        assert.equal(git(repo.primary, "rev-parse", "HEAD"), head);
      } finally {
        rmSync(repo.root, { recursive: true, force: true });
      }
    });
  }
}

function stubLifecycleFetch(repo: Repository, failures: number, stderr: string, firstFailure = 1) {
  const executable = join(repo.root, "bin", "git");
  const calls = join(repo.root, "fetch-calls");
  writeFileSync(calls, "");
  writeFileSync(executable, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${3:-}" == fetch ]]; then
  printf '%s\\n' "$*" >> "$FETCH_CALLS"
  attempt=$(wc -l < "$FETCH_CALLS")
  if (( attempt >= FETCH_FIRST_FAILURE && attempt < FETCH_FIRST_FAILURE + FETCH_FAILURES )); then
    printf '%s\\n' "$FETCH_STDERR" >&2
    exit 37
  fi
fi
exec "$REAL_GIT" "$@"
`);
  chmodSync(executable, 0o755);
  return {
    calls: () => readFileSync(calls, "utf8").trim().split("\n"),
    env: {
      REAL_GIT: execFileSync("which", ["git"], { encoding: "utf8" }).trim(),
      FETCH_CALLS: calls, FETCH_FIRST_FAILURE: String(firstFailure),
      FETCH_FAILURES: String(failures), FETCH_STDERR: stderr,
    },
  };
}

const refLockError = "error: cannot lock ref 'refs/remotes/origin/main': is at 2222222 but expected 1111111";

test("lifecycle fetches use one identical bounded helper in feature and PoC", () => {
  const helpers: string[] = [];
  for (const [definition, fetches] of [
    [definitions[0][1], 5],
    [fileURLToPath(new URL("../../skills/issue-execution/poc.yaml", import.meta.url)), 1],
  ] as const) {
    const source = readFileSync(definition, "utf8");
    const helper = source.match(/^      lifecycle_fetch\(\) \([\s\S]*?^      \)/m);
    assert.ok(helper, definition);
    helpers.push(helper[0]);
    const rawFetches = source.split("\n").filter(line => /\bgit\b.*\bfetch\b/.test(line));
    assert.equal(rawFetches.length, 1, `bare fetch outside helper in ${definition}`);
    assert.ok(helper[0].includes(rawFetches[0]!));
    assert.equal(source.split("\n").filter(line => /^\s+lifecycle_fetch /.test(line)).length, fetches);
  }
  assert.equal(helpers[0], helpers[1]);
});

for (const [name, definition] of [
  ...definitions,
  ["PoC template", fileURLToPath(new URL("../../skills/issue-execution/poc.yaml", import.meta.url))],
  ["PoC rendered DAG", renderedPoc],
] as const) {
  const gate = name.startsWith("PoC") ? "base" : "start_gate";
  for (const failure of ["transient ref lock", "persistent ref lock", "non-lock failure"] as const) {
    test(`${name} ${gate} lifecycle fetch handles ${failure}`, () => {
      const repo = repository();
      try {
        writeFileSync(join(repo.primary, ".git", "info", "exclude"), "/.workspace/\n");
        if (gate === "base") mkdirSync(join(repo.primary, ".git", "poc", "runs", "test-run"), { recursive: true });
        const stderr = failure === "non-lock failure" ? "fatal: Authentication failed for origin" : refLockError;
        const fetch = stubLifecycleFetch(repo, failure === "transient ref lock" ? 1 : 3, stderr);
        const result = spawnSync("bash", ["-c", extractScript(definition, `  - id: ${gate}`)], {
          encoding: "utf8",
          env: {
            ...process.env, ...featureScriptEnv(repo), ...fetch.env, DAGU_FEATURE_BUNDLE: "test",
            DAGU_OUTPUT_FILE: join(repo.root, "outputs"),
          },
        });
        const expectedAttempts = failure === "transient ref lock" ? 2 : failure === "persistent ref lock" ? 3 : 1;
        assert.equal(result.status, failure === "transient ref lock" ? 0 : 1, result.stderr);
        assert.deepEqual(fetch.calls(), Array(expectedAttempts).fill(`-C ${repo.primary} fetch origin`), result.stderr);
        assert.ok(result.stderr.includes(stderr), result.stderr);
        if (failure !== "transient ref lock") {
          assert.ok(result.stderr.includes(`${gate}: fetch origin failed; restore origin access and recover this run`), result.stderr);
          assert.ok(existsSync(repo.worktree), "fetch failure must retain the candidate");
        } else if (gate === "base") {
          const base = join(repo.primary, ".git", "poc", "runs", "test-run", "base.sha");
          assert.equal(readFileSync(base, "utf8").trim(), git(repo.primary, "rev-parse", "HEAD"));
        }
      } finally {
        rmSync(repo.root, { recursive: true, force: true });
      }
    });
  }
}

for (const [name, definition] of definitions) {
  for (const [phase, firstFailure] of [
    ["admit", 1], ["rebase", 1], ["close_gate", 1], ["close_gate", 2],
  ] as const) {
    test(`${name} ${phase} lifecycle fetch retries ref lock at refresh ${firstFailure}`, () => {
      const repo = repository();
      try {
        writeFileSync(join(repo.primary, ".git", "info", "exclude"), "/.workspace/\n");
        if (phase === "rebase") commit(repo, "feature.txt", "candidate\n");
        if (phase === "close_gate") stubSuccessfulCloseGateGh(repo);
        const fetch = stubLifecycleFetch(repo, 1, refLockError, firstFailure);
        const result = spawnSync("bash", ["-c", extractScript(definition, `  - id: ${phase}`)], {
          encoding: "utf8", env: { ...process.env, ...featureScriptEnv(repo), ...fetch.env },
        });
        assert.equal(result.status, 0, result.stderr);
        const cwd = phase === "rebase" ? repo.worktree : repo.primary;
        const args = phase === "close_gate" ? "--prune origin" : "origin";
        assert.deepEqual(fetch.calls(), Array(phase === "close_gate" ? 3 : 2).fill(`-C ${cwd} fetch ${args}`));
        assert.ok(result.stderr.includes(refLockError), result.stderr);
        if (phase === "close_gate") {
          assert.equal(existsSync(repo.worktree), false);
          assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), false);
          assert.equal(git(repo.primary, "rev-parse", "HEAD"), git(repo.primary, "rev-parse", "origin/main"));
          assert.equal(readFileSync(join(repo.state, "cleanup-phase"), "utf8").trim(), "complete");
        } else if (phase === "rebase") {
          assert.equal(readFileSync(join(repo.state, "conflict-action"), "utf8").trim(), "complete");
        }
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
  let result = source.slice(start, end < 0 ? source.length : end).split("\nhandler_on:")[0]! + "\n";
  if (result.includes("    run: *cancellation_gate")) {
    result = result.replace("    run: *cancellation_gate", source.match(/    run: &cancellation_gate \|[\s\S]*?(?=\n  - id:)/)![0]!.replace(" &cancellation_gate", ""));
  }
  result = result.replace("    run: &cancellation_gate", "    run:");
  if (result.includes("    action: human.task") && source.includes(`  - id: ${id}_cancellation\n`)) {
    result += extractStep(source, `${id}_cancellation`);
  }
  return result;
}

for (const [name, definition] of definitions) {
  test(`${name} real Dagu reenqueue adopts retained worktree from terminal owner`, {
    ...liveDagu,
    timeout: 115_000,
  }, async (t) => {
    const repo = repository();
    git(repo.primary, "worktree", "remove", repo.worktree);
    git(repo.primary, "branch", "-D", repo.branch);
    rmSync(join(repo.primary, ".git", "dagu-feature", "resources"), { recursive: true });
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
    const env: NodeJS.ProcessEnv = { ...process.env, ...featureScriptEnv(repo), DAGU_HOME: home, DAGU_PORT: String(port), DAGU_COORDINATOR_ENABLED: "false", OMP_SESSION_ID: "retained-owner" };
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
        `params:\n  - ISSUE: "189"\n  - PR_NUMBER: ""\n  - OMP_SESSION_ID: retained-owner\n`,
        `env:\n  - A4S_BIN: ${JSON.stringify(a4sBin)}\n  - PRIMARY: ${JSON.stringify(repo.primary)}\n  - BASE_BRANCH: main\n  - BRANCH: dagu/issue-\${ISSUE}\n  - GATE: "true"\n  - REQUIRED_CHECK: validate\n  - PATH: ${env.PATH}\n  - WORKTREE: ${repo.worktree}\n  - RUN: \${context.run.id}\n  - DAGU_FEATURE_BUNDLE: test\n`,
        source.slice(source.indexOf("  - DAGU_RESOURCE_GUARD: |"), source.indexOf("steps:\n")),
        "steps:\n", extractStep(source, "admission"), extractStep(source, "admit"),
        "  - id: triage\n    depends: admit\n    run: echo POC=no >> \"$DAGU_OUTPUT_FILE\"\n    outputs:\n      - name: POC\n",
        "  - id: triage_decision\n    depends: triage\n    run: echo reviewed\n",
        ...["detect_start_primary", "start_primary_unavailable", "start_gate", "recover_start_gate"].map(id => extractStep(source, id)),
        "  - id: implement\n    depends: recover_start_gate\n    action: human.task\n    with:\n      prompt: Synthetic delivery actor for candidate-retention acceptance.\n" + deliveryForm,
        extractStep(source, "capture"),
        "handler_on:\n  exit:\n    run: |\n" + extractScript(definition, "  exit:").split("\n").map(line => "      " + line).join("\n") + "\n",
      ].join(""));
      dagu("validate", file);
      const first = testRunId("retained-189"), second = `${first}-v2`;
      dagu("enqueue", "--run-id", first, file);
      await state(first, "waiting");
      writeFileSync(join(repo.worktree, "retained.txt"), "retained candidate\n");
      git(repo.worktree, "add", ".");
      git(repo.worktree, "commit", "-m", "precommitted candidate");
      const head = git(repo.worktree, "rev-parse", "HEAD");
      dagu("human-task", "complete", "feature", "--run-id", first, "--step", "implement",
        "--input", "MESSAGE=fix: retained candidate", "--input", "SUMMARY=Retained candidate", "--input", "IMPLEMENTER=ImplementTest");
      const failed = await state(first, "failed");
      const capture = failed.nodes.find(node => node.step.name === "capture")!;
      assert.equal(capture.statusLabel, "failed");
      assert.match(readFileSync(capture.stderr!, "utf8"), /rule=capture.candidate_head expected=.+ observed=.+/);
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
      assert.match(mismatch.stderr, /rule=start_gate.ownership expected=.+ observed=.+/);
      writeFileSync(owner, valid);
      const active = spawnSync("bash", ["-c", extractScript(definition, "  - id: admit")], {
        env: { ...env, RUN: `${second}-other` }, encoding: "utf8",
      });
      assert.equal(active.status, 1);
      assert.ok(active.stderr.includes(`belongs to active run ${second}`));
      assert.equal(git(repo.worktree, "rev-parse", "HEAD"), head);
      const evidence = [...failed.nodes, ...adopted.nodes].filter(node => ["admit", "start_gate", "capture"].includes(node.step.name))
        .map(node => ({ step: node.step.name, status: node.statusLabel,
          stdout: node.stdout && readFileSync(node.stdout, "utf8"), stderr: node.stderr && readFileSync(node.stderr, "utf8") }));
      t.diagnostic(`Dagu ${liveDaguVersion}; runs=${first}:failed/capture,${second}:waiting/implement; HEAD=${head}; owner=${valid.trim()}; logs=${JSON.stringify(evidence)}; onExit=${failed.onExit?.stdout ? readFileSync(failed.onExit.stdout, "utf8") : JSON.stringify(failed.onExit)}`);
    } finally {
      service.kill("SIGTERM");
      await new Promise<void>(resolve => service.once("exit", () => resolve()));
      rmSync(repo.root, { recursive: true, force: true });
    }
  });
}
test("native terminal replacement captures retained and nonempty correction", {
  ...liveDagu,
  timeout: 115_000,
}, async (t) => {
  const repo = repository();
  const definition = definitions[0][1];
  git(repo.primary, "worktree", "remove", repo.worktree);
  git(repo.primary, "branch", "-D", repo.branch);
  rmSync(join(repo.primary, ".git", "dagu-feature", "resources"), { recursive: true });
  rmSync(join(repo.root, "bin", "dagu"));
  stubGh(repo, "OPEN\n", 0);
  const manifest = "packages/issue-lifecycle/package.json";
  const changelog = "packages/issue-lifecycle/CHANGELOG.md";
  const putRelease = (cwd: string, version: string, entry: string) => {
    mkdirSync(dirname(join(cwd, manifest)), { recursive: true });
    writeFileSync(join(cwd, manifest), JSON.stringify({ name: "@a4s/issue-lifecycle", version }) + "\n");
    writeFileSync(join(cwd, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "packages/issue-lifecycle": { version } } }) + "\n");
    mkdirSync(join(cwd, "packages/issue-lifecycle/test"), { recursive: true });
    writeFileSync(join(cwd, "packages/issue-lifecycle/test/bundle.test.ts"), `assert.equal(BUNDLE_VERSION, "${version}");\n`);
    writeFileSync(join(cwd, changelog), `# Changelog\n\n## ${version}\n\n- ${entry}\n\n${version === "0.1.1" ? "" : "## 0.1.1\n\n- Base\n\n"}## 0.1.0\n\n- Published\n`);
  };
  putRelease(repo.primary, "0.1.1", "Base");
  git(repo.primary, "add", ".");
  git(repo.primary, "commit", "-m", "release base");
  git(repo.primary, "push", "origin", "main");
  const originalBase = git(repo.primary, "rev-parse", "HEAD");
  const home = join(repo.root, "dagu-home");
  mkdirSync(join(home, "dags"), { recursive: true });
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\nscheduler:\n  port: 0\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, ...featureScriptEnv(repo), DAGU_HOME: home, DAGU_PORT: String(port), DAGU_COORDINATOR_ENABLED: "false", OMP_SESSION_ID: "retained-owner" };
  let serviceLog = "";
  const service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: repo.root, env, stdio: ["ignore", "pipe", "pipe"],
  });
  service.stdout.on("data", data => { serviceLog += data; });
  service.stderr.on("data", data => { serviceLog += data; });
  const api = `http://127.0.0.1:${port}/api/v1`;
  const dagu = (...args: string[]) => execFileSync("dagu", args, { env, cwd: repo.root, encoding: "utf8" }).trim();
  type Detail = { statusLabel: string; nodes: Array<{ step: { name: string }; statusLabel: string; stdout?: string; stderr?: string }>; onExit?: { statusLabel: string } };
  async function until<T>(description: string, probe: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const value = await probe();
      if (value !== undefined) return value;
      await delay(150);
    }
    throw new Error(`Timed out: ${description}\n${serviceLog}`);
  }
  async function state(id: string, status: string, step?: string): Promise<Detail> {
    return until(`${id} ${status} ${step ?? ""}`, async () => {
      const response = await fetch(`${api}/dag-runs/feature/${id}`);
      if (!response.ok) return undefined;
      const run = (await response.json() as { dagRunDetails: Detail }).dagRunDetails;
      if (run.statusLabel === status &&
          (!step || run.nodes.some(node => node.step.name === step && node.statusLabel === status)) &&
          (!["failed", "succeeded"].includes(status) || run.onExit?.statusLabel === "succeeded")) return run;
      if (run.statusLabel === "failed" && status !== "failed") {
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
    const resolver = fileURLToPath(new URL("../../bin/dagu-bundle-rebase.mjs", import.meta.url));
    const evidence = join(repo.root, "resolver-refs");
    const resolverCommand = `printf '%s\\n' "$DAGU_REBASE_BASE $DAGU_REBASE_CANDIDATE $DAGU_REBASE_UPSTREAM $(git rev-parse REBASE_HEAD)" > ${JSON.stringify(evidence)}; node ${JSON.stringify(resolver)}`;
    // Synthetic triage/implement actors and deliberate post-capture failure isolate native handoff.
    const file = join(home, "dags", "feature.yaml");
    writeFileSync(file, [
      "type: graph\nshell: bash\nmax_active_steps: 1\n",
      `params:\n  - ISSUE: "189"\n  - PR_NUMBER: ""\n  - OMP_SESSION_ID: retained-owner\n  - RETAIN: "no"\n`,
      `env:\n  - A4S_BIN: ${JSON.stringify(a4sBin)}\n  - PRIMARY: ${JSON.stringify(repo.primary)}\n  - BASE_BRANCH: main\n  - BRANCH: dagu/issue-\${ISSUE}\n  - GATE: "true"\n  - REQUIRED_CHECK: validate\n  - PATH: ${env.PATH}\n  - WORKTREE: ${repo.worktree}\n  - RUN: \${context.run.id}\n  - DAGU_FEATURE_BUNDLE: test\n  - REBASE_RESOLVER: ${JSON.stringify(resolverCommand)}\n`,
      source.slice(source.indexOf("  - DAGU_RESOURCE_GUARD: |"), source.indexOf("steps:\n")),
      "steps:\n", extractStep(source, "admission"), extractStep(source, "admit"),
      "  - id: triage\n    depends: admit\n    run: echo POC=no >> \"$DAGU_OUTPUT_FILE\"\n    outputs:\n      - name: POC\n",
      "  - id: triage_decision\n    depends: triage\n    run: echo reviewed\n",
      ...["detect_start_primary", "start_primary_unavailable", "start_gate", "recover_start_gate"].map(id => extractStep(source, id)),
      "  - id: implement\n    depends: recover_start_gate\n    action: human.task\n    with:\n      prompt: Synthetic delivery actor for recovery/rebase acceptance.\n" + deliveryForm,
      extractStep(source, "capture"),
      "  - id: retain_candidate\n    depends: capture\n    run: test \"$RETAIN\" = no\n",
      "  - id: dependency_review\n    depends: retain_candidate\n    action: human.task\n    with:\n      prompt: Synthetic dependency reviewer releases captured candidate for rebase.\n",
      extractStep(source, "rebase").replace(/depends: (?:dependency_review(?:_cancellation)?|rebase_escalation_decision)/, "depends: dependency_review"),
      "handler_on:\n  exit:\n    run: |\n" + extractScript(definition, "  exit:").split("\n").map(line => "      " + line).join("\n") + "\n",
    ].join(""));
    dagu("validate", file);
    const first = testRunId("replacement-189"), second = `${first}-v2`;
    dagu("enqueue", "--run-id", first, file, "--", "RETAIN=yes");
    await state(first, "waiting", "implement");
    putRelease(repo.worktree, "0.1.2", "Retained");
    writeFileSync(join(repo.worktree, "README.txt"), '{"items":null}\n');
    writeFileSync(join(repo.worktree, "retained.txt"), "independent retained delivery\n");
    dagu("human-task", "complete", "feature", "--run-id", first, "--step", "implement",
      "--input", "MESSAGE=fix: retained delivery", "--input", "SUMMARY=Retained delivery", "--input", "IMPLEMENTER=ImplementSynthetic");
    const failed = await state(first, "failed");
    assert.equal(failed.nodes.find(node => node.step.name === "capture")?.statusLabel, "succeeded");
    assert.equal(failed.nodes.find(node => node.step.name === "retain_candidate")?.statusLabel, "failed");
    const retained = git(repo.worktree, "rev-parse", "HEAD");
    const firstState = join(repo.primary, ".git", "dagu-feature", "runs", first);
    assert.equal(JSON.parse(readFileSync(join(firstState, "candidate.json"), "utf8")).sha, retained);
    putRelease(repo.primary, "0.1.2", "Upstream");
    writeFileSync(join(repo.primary, "upstream.txt"), "advanced upstream\n");
    git(repo.primary, "add", ".");
    git(repo.primary, "commit", "-m", "advance upstream");
    git(repo.primary, "push", "origin", "main");
    const upstream = git(repo.primary, "rev-parse", "HEAD");
    dagu("enqueue", "--run-id", second, file);
    await state(second, "waiting", "implement");
    const stateDir = join(repo.primary, ".git", "dagu-feature", "runs", second);
    const owner = git(repo.worktree, "rev-parse", "--path-format=absolute", "--git-path", "dagu-feature-owner");
    const identity = readFileSync(join(stateDir, "identity"), "utf8");
    assert.equal(readFileSync(join(stateDir, "previous-owner"), "utf8").trim(), first);
    assert.equal(JSON.parse(identity).run, second);
    assert.equal(readFileSync(owner, "utf8"), identity);
    assert.equal(readFileSync(join(repo.primary, ".git", "dagu-feature", "owners", "issue-189"), "utf8"), `${second}\t${repo.branch}\n`);
    assert.equal(git(repo.worktree, "rev-parse", "HEAD"), retained);
    writeFileSync(join(repo.worktree, "README.txt"), '{"items":[]}\n');
    dagu("human-task", "complete", "feature", "--run-id", second, "--step", "implement",
      "--input", "MESSAGE=fix: corrected delivery", "--input", "SUMMARY=Retained and corrected delivery", "--input", "IMPLEMENTER=ImplementSyntheticCorrection");
    await state(second, "waiting", "dependency_review");
    const captured = JSON.parse(readFileSync(join(stateDir, "candidate.json"), "utf8"));
    assert.equal(captured.base, originalBase);
    assert.equal(git(repo.worktree, "rev-parse", "HEAD^"), originalBase);
    assert.equal(git(repo.worktree, "rev-list", "--count", `${originalBase}..HEAD`), "1");
    assert.equal(git(repo.worktree, "show", "HEAD:README.txt"), '{"items":[]}');
    assert.equal(git(repo.worktree, "show", "HEAD:retained.txt"), "independent retained delivery");
    assert.match(readFileSync(join(stateDir, "diff.patch"), "utf8"), /retained\.txt/);
    dagu("human-task", "complete", "feature", "--run-id", second, "--step", "dependency_review");
    const succeeded = await state(second, "succeeded");
    assert.equal(succeeded.nodes.find(node => node.step.name === "rebase")?.statusLabel, "succeeded");
    assert.equal(readFileSync(evidence, "utf8").trim(), `${originalBase} ${captured.sha} ${upstream} ${captured.sha}`);
    const final = JSON.parse(readFileSync(join(stateDir, "candidate.json"), "utf8"));
    assert.equal(final.base, upstream);
    assert.equal(final.sha, git(repo.worktree, "rev-parse", "HEAD"));
    assert.equal(final.tree, git(repo.worktree, "rev-parse", "HEAD^{tree}"));
    assert.equal(git(repo.worktree, "rev-list", "--count", "origin/main..HEAD"), "1");
    assert.equal(git(repo.worktree, "show", "HEAD:README.txt"), '{"items":[]}');
    assert.equal(git(repo.worktree, "show", "HEAD:retained.txt"), "independent retained delivery");
    assert.equal(git(repo.worktree, "show", "HEAD:upstream.txt"), "advanced upstream");
    assert.equal(JSON.parse(readFileSync(join(repo.worktree, manifest), "utf8")).version, "0.1.3");
    assert.equal(readFileSync(join(stateDir, "base"), "utf8").trim(), upstream);
    assert.equal(readFileSync(join(stateDir, "diff.patch"), "utf8"), execFileSync("git", ["-C", repo.worktree, "diff", "--binary", "--full-index", upstream, final.sha], { encoding: "utf8" }));
    assert.equal(JSON.parse(readFileSync(join(stateDir, "historical", captured.sha, "candidate.json"), "utf8")).base, originalBase);
    assert.equal(readFileSync(owner, "utf8"), identity);
    assert.equal(git(repo.worktree, "status", "--porcelain"), "");
    t.diagnostic(`Official Dagu ${liveDaguVersion}; private home/loopback; synthetic triage/implement/dependency actors; ${first}:failed/retain_candidate -> ${second}:succeeded/rebase; original=${originalBase}, retained=${retained}, captured=${captured.sha}, rebased=${final.sha}; owners preserved.`);
  } finally {
    service.kill("SIGTERM");
    await new Promise<void>(resolve => service.once("exit", () => resolve()));
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("real Dagu retries rebase after a six-second index lock", {
  ...liveDagu,
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
  const id = testRunId("lock-retry");
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
    const step = extractStep(source, "rebase").replace(/    depends: rebase_escalation_decision\n/, "");
    const file = join(home, "dags", "lock-retry.yaml");
    const dagEnv = Object.entries(featureScriptEnv(repo)).map(([key, value]) => `  ${key}: ${JSON.stringify(value ?? "")}`).join("\n");
    writeFileSync(file, `name: lock-retry\nenv:\n${dagEnv}\nsteps:\n  - id: triage\n    run: echo POC=no >> "$DAGU_OUTPUT_FILE"\n    outputs:\n      - name: POC\n${step.replace("    retry_policy:", "    depends: triage\n    retry_policy:")}`);
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
          nodes: Array<{ step: { name: string }; statusLabel: string; stderr?: string }>;
        } }).dagRunDetails;
        assert.notEqual(run.statusLabel, "failed", JSON.stringify(run));
        if (run.statusLabel === "succeeded") {
          const rebase = run.nodes.find(node => node.step.name === "rebase")!;
          assert.equal(rebase.statusLabel, "succeeded");
          evidence = readFileSync(rebase.stderr!, "utf8");
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

for (const [name, definition] of definitions) {
  test(`${name} wait handler automatically rewinds recover_gate by observed iteration only`, async () => {
    const repo = repository();
    try {
      const bin = join(repo.root, "bin");
      const calls = join(repo.root, "transitions");
      const done = join(repo.root, "transition-done");
      writeFileSync(join(bin, "dagu"), `#!/bin/sh
if [ "$1" = status ]; then
  printf 'Waiting - feature\\n'
  if [ -n "$OBSERVED_ITERATION" ]; then printf 'push-back iteration: %s\\n' "$OBSERVED_ITERATION"; fi
else
  printf '%s\\n' "$*" >> "$TRANSITIONS"
  touch "$TRANSITION_DONE"
fi
`);
      chmodSync(join(bin, "dagu"), 0o755);
      const script = extractScript(definition, "  wait:");
      const env = { ...featureScriptEnv(repo), PATH: `${bin}:${process.env.PATH}`,
        TRANSITIONS: calls, TRANSITION_DONE: done };
      for (const iteration of ["0", "7", ""]) {
        rmSync(calls, { force: true });
        rmSync(done, { force: true });
        const result = spawnSync("bash", ["-c", script], { env: { ...env,
          DAG_WAITING_STEPS: "recover_gate,recover_start_gate,recover_push,validation,escalation",
          OBSERVED_ITERATION: iteration }, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        const deadline = Date.now() + 5_000;
        while (!existsSync(done) && Date.now() < deadline) await delay(20);
        assert.ok(existsSync(done), `wait handler did not dispatch recover_gate: ${readFileSync(join(repo.state, "gate-transition.log"), "utf8")}`);
        assert.equal(readFileSync(calls, "utf8"),
          `human-task push-back feature --run-id test-run --step recover_gate --expected-iteration ${iteration || "0"}\n`);
      }
      rmSync(calls);
      const result = spawnSync("bash", ["-c", script], { env: { ...env,
        DAG_WAITING_STEPS: "recover_start_gate,recover_push,validation,escalation,not_recover_gate",
        OBSERVED_ITERATION: "9" }, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(calls), false, "non-automated waits must not transition");
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });
}

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

async function recoveryFixture(extraConfig = ""): Promise<RecoveryFixture> {
  const suffix = testRunId("recovery");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-dagu-triage-close-")));
  const home = join(root, "dagu-home");
  mkdirSync(join(home, "dags"), { recursive: true });
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const env: NodeJS.ProcessEnv = { ...process.env, A4S_BIN: a4sBin, DAGU_PARAMS_JSON: "{}", DAGU_HOME: home, DAGU_PORT: String(port), DAGU_COORDINATOR_ENABLED: "false" };
  // Fixture CLI retries are user requests; its scheduler supplies dispatch context.
  delete env.DAGU_QUEUE_DISPATCH_RETRY;
  delete env.DAG_PUSHBACK_ITERATION;
  // Native steps must never inherit the enclosing role job's output file.
  delete env.DAGU_OUTPUT_FILE;
  writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\nscheduler:\n  port: 0\n${extraConfig}`);
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

for (const [name, definition] of definitions) {
  test(`${name} real Dagu automatically returns failed gates to implement and stops at escalation`, {
    ...liveDagu, timeout: 120_000,
  }, async () => {
    const fixture = await recoveryFixture();
    const id = testRunId("automatic-gate-budget");
    const repo = repository(id);
    try {
      const source = parse(readFileSync(definition, "utf8"));
      const ids = ["implement_budget", "escalation", "escalation_cancellation", "escalation_decision"];
      const budgetSteps = ids.map(id => structuredClone(source.steps.find((step: { id: string }) => step.id === id)));
      budgetSteps[0].depends = "triage";
      const recoverGate = structuredClone(source.steps.find((step: { id: string }) => step.id === "recover_gate"));
      const gateOutput = join(repo.root, "gate-output.log");
      const implementations = join(repo.root, "implementations");
      const dag = join(fixture.home, "dags", "feature.yaml");
      writeFileSync(gateOutput, "FAIL persistent candidate defect\n");
      const script = stringify({
        name: "feature", type: "graph", shell: "bash", max_active_steps: 1,
        env: { A4S_BIN: a4sBin, PRIMARY: repo.primary, WORKTREE: repo.worktree,
          BRANCH: repo.branch, ISSUE: "189", RUN: "${context.run.id}", OMP_SESSION_ID: "recovery-owner",
          DAGU_PORT: String(fixture.port), ESCALATION_PUSHBACKS: "2", ESCALATION_FINDINGS: "2", ESCALATION_SECONDS: "3600" },
        steps: [
          { id: "triage", run: 'echo POC=no >> "$DAGU_OUTPUT_FILE"', outputs: [{ name: "POC" }] },
          ...budgetSteps,
          { id: "implement", depends: "escalation_decision",
            run: `printf '%s\\n' "\${DAG_PUSHBACK_ITERATION:-0}" >> ${JSON.stringify(implementations)}` },
          { id: "gate", depends: "implement", continue_on: { failure: true },
            run: `"$A4S_BIN" escalation finding gate ${JSON.stringify(gateOutput)}\nexit 1` },
          recoverGate,
        ],
        handler_on: { wait: source.handler_on.wait },
      });
      writeFileSync(dag, script);
      writeFileSync(join(repo.state, "receipt.json"), JSON.stringify(roleAdmission(repo.primary, fixture.home, id, script)));
      execFileSync("dagu", ["enqueue", "--run-id", id, dag], { env: fixture.env, stdio: "pipe" });
      const stopped = await fixture.until(`${id} escalation after automatic gate returns`, async () => {
        const response = await fetch(`http://127.0.0.1:${fixture.port}/api/v1/dag-runs/feature/${id}`);
        if (!response.ok) return undefined;
        const run = (await response.json() as { dagRunDetails: LiveDetail }).dagRunDetails;
        assert.ok(!["failed", "aborted"].includes(run.statusLabel), JSON.stringify(run));
        return run.statusLabel === "waiting" && run.nodes.some(node =>
          node.step.name === "escalation" && node.statusLabel === "waiting") ? run : undefined;
      });
      assert.deepEqual(readFileSync(implementations, "utf8").trim().split("\n"), ["0", "1"]);
      const budget = JSON.parse(readFileSync(join(repo.state, "escalation.json"), "utf8"));
      assert.equal(budget.iteration, 2);
      assert.match(budget.trigger.reasons.join(" "), /push-back.*repeated finding fingerprint/);
      assert.notEqual(stopped.nodes.find(node => node.step.name === "implement")?.statusLabel, "running");
      assert.equal(existsSync(join(repo.state, "gate-transition.log")), true);
      // The same production handler does nothing at the owner decision boundary.
      const log = readFileSync(join(repo.state, "gate-transition.log"), "utf8");
      await delay(250);
      assert.equal(readFileSync(implementations, "utf8"), "0\n1\n");
      assert.equal(readFileSync(join(repo.state, "gate-transition.log"), "utf8"), log);
    } finally {
      await fixture.close();
      rmSync(repo.root, { recursive: true, force: true });
    }
  });
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
    rmSync(join(repo.primary, ".git", "dagu-feature", "resources"), { recursive: true });
    repo.worktree = join(repo.primary, ".workspace", "worktrees", "issue-189");
    writeFileSync(join(repo.primary, ".git", "info", "exclude"), "/.workspace/\n");
    const remote = git(repo.primary, "remote", "get-url", "origin");
    if (mode === "start_gate") git(repo.primary, "remote", "set-url", "origin", join(repo.root, "unavailable.git"));
    const bin = join(repo.root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gh"), `#!/bin/sh
printf '%s\\n' "$*" >> '${repo.root}/gh.log'
case "$*" in
  "pr list "*) printf '[]\\n' ;;
  *"--jq .state"*) printf 'OPEN\\n' ;;
  *"--jq .headRefName"*) printf '%s\\n' '${repo.branch}' ;;
  *"--jq .headRefOid"*) git -C '${repo.worktree}' rev-parse HEAD ;;
  *) printf '{"number":189,"url":"https://example.test/pr/189"}\\n' ;;
esac
`);
    chmodSync(join(bin, "gh"), 0o755);
    if (mode === "push") {
      const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" push "*refs/heads/*)\nif ! test -f '${repo.root}/allow-push'; then echo 'push: simulated remote access failure' >&2; exit 1; fi\n;;\nesac\nexec '${realGit}' "$@"\n`);
      chmodSync(join(bin, "git"), 0o755);
    }
    const source = readFileSync(definition, "utf8");
    const script = [
      "type: graph\nshell: bash\nmax_active_steps: 1\n",
      `params:\n  - ISSUE: "189"\n  - PR_NUMBER: ""\n  - OMP_SESSION_ID: recovery-owner\n`,
      `env:\n  - A4S_BIN: ${JSON.stringify(a4sBin)}\n  - PRIMARY: ${JSON.stringify(repo.primary)}\n  - BASE_BRANCH: main\n  - VALIDATION: ""\n  - BRANCH: dagu/issue-\${ISSUE}\n  - GATE: test -f required.txt\n  - REQUIRED_CHECK: validate\n  - PATH: ${bin}:${process.env.PATH}\n  - WORKTREE: ${repo.worktree}\n  - RUN: \${context.run.id}\n  - DAGU_FEATURE_BUNDLE: test\n  - DAGU_PORT: "${fixture.port}"\n`,
      source.slice(source.indexOf("  - DAGU_RESOURCE_GUARD: |"), source.indexOf("steps:\n")),
      "steps:\n",
      `  - id: triage\n    run: |\n      mkdir -p "$(git -C "$PRIMARY" rev-parse --path-format=absolute --git-path "dagu-feature/runs/$RUN")"\n      echo POC=no >> "$DAGU_OUTPUT_FILE"\n    outputs:\n      - name: POC\n`,
      "  - id: triage_decision\n    depends: triage\n    run: echo reviewed\n",
      ...["detect_start_primary", "start_primary_unavailable", "start_gate", "recover_start_gate", "implement",
        "capture", "checkpoint_push", "dependency_review", "rebase", "conflict_review", "gate", "recover_gate",
        "validation", "push", "recover_push", "pr"]
        .map(step => step === "implement"
          ? "  - id: implement\n    depends: recover_start_gate\n    action: human.task\n    with:\n      prompt: Synthetic delivery actor for native recovery acceptance.\n" + deliveryForm
          : extractStep(source, step)
            .replace("depends: rebase_escalation_decision", "depends: dependency_review_cancellation")
            .replaceAll("rewind_to: implement_budget", "rewind_to: implement")),
      "  - id: await_merge\n    depends: pr\n    action: human.task\n    with:\n      prompt: Isolated merge boundary\n",
      source.slice(source.indexOf("handler_on:\n"), source.indexOf("  exit:\n")),
    ].join("");
    rmSync(join(repo.root, "bin", "dagu"));
    const dag = join(home, "dags", "feature.yaml");
    writeFileSync(dag, script);
    mkdirSync(repo.state, { recursive: true });
    writeFileSync(join(repo.state, "receipt.json"), JSON.stringify(roleAdmission(repo.primary, home, id, script)));
    const dagu = (...args: string[]) => execFileSync("dagu", args, {
      cwd: root, env: { ...env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const iteration = () => Number(dagu("status", "feature", "--run-id", id).match(/push-back iteration: (\d+)/)?.[1] ?? 0);
    async function waiting(step: string, expectedIteration?: number): Promise<LiveDetail> {
      const run = await until(`${id} waiting ${step}`, async () => {
        const run = await state(id, "waiting");
        if (step === "implement" && run.nodes.some(node => node.step.name === "recover_start_gate" && node.statusLabel === "waiting")) {
          throw new Error(run.nodes.filter(node => node.stderr).map(node => `${node.step.name}: ${readFileSync(node.stderr!, "utf8")}`).join("\n"));
        }
        if (expectedIteration !== undefined && iteration() !== expectedIteration) return undefined;
        return run.nodes.some(node => node.step.name === step && node.statusLabel === "waiting") ? run : undefined;
      });
      checkpoints.push({ step, iteration: iteration() });
      return run;
    }
    function transition(step: string, pushBack = false): void {
      const observed = iteration();
      dagu("human-task", pushBack ? "push-back" : "complete", "feature", "--run-id", id, "--step", step,
        ...(pushBack ? ["--expected-iteration", String(observed)] : []),
        ...(!pushBack && step === "implement" ? ["--input", "SUMMARY=Recovery candidate", "--input", "MESSAGE=fix: recover candidate",
          "--input", "IMPLEMENTER=ImplementTest"] : []));
    }
    const candidate = () => JSON.parse(readFileSync(join(repo.state, "candidate.json"), "utf8")) as { sha: string };
    dagu("validate", dag);
    dagu("enqueue", "--run-id", id, dag);
    if (mode === "start_gate") {
      const run = await waiting("recover_start_gate");
      assert.equal(run.nodes.find(node => node.step.name === "start_gate")?.statusLabel, "succeeded");
      assert.match(new Transitions("recovery-owner").observe(run).wakeMessage ?? "", /step=recover_start_gate.*cause=rule=start_gate.fetch/);
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
      // No operator transition: onWait must return the failed candidate itself.
      await waiting("implement", before + 1);
      previousCandidate = candidate().sha;
      assert.equal(JSON.parse(readFileSync(join(repo.state, "gate.json"), "utf8")).sha, previousCandidate);
      assert.match(readFileSync(join(repo.state, "gate-transition.log"), "utf8"), /./);
      assert.equal(iteration(), before + 1);
      assert.equal(git(repo.worktree, "rev-parse", "HEAD"), previousCandidate);
      writeFileSync(join(repo.worktree, "required.txt"), "fixed\n");
      transition("implement");
    }
    if (mode === "push") {
      const failed = await waiting("recover_push");
      assert.equal(failed.nodes.find(node => node.step.name === "push")?.statusLabel, "failed");
      assert.match(new Transitions("recovery-owner").observe(failed).wakeMessage ?? "", /step=recover_push.*cause=rule=push.remote_lease/);
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
    ...liveDagu,
    timeout: 360_000,
  }, async (t) => {
    const fixture = await recoveryFixture();
    const { root, home, port, env, until, state } = fixture;
    const api = `http://127.0.0.1:${port}/api/v1`;
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
              // Admission is exercised against real Dagu in bundle-cli.test.ts;
              // this fixture isolates the lifecycle's post-admission routing.
              const admission = join(repo.root, "bin", "a4s-routing");
              writeFileSync(admission, `#!/bin/sh\nif [ "$1" != enqueue ]; then exec ${JSON.stringify(a4sBin)} "$@"; fi\ntest "$2" = --parent || exit 1\nshift 3\nexec dagu enqueue "$@"\n`);
              chmodSync(admission, 0o755);
            } else stubSuccessfulCloseGateGh(repo);
            git(repo.primary, "worktree", "remove", repo.worktree);
            git(repo.primary, "branch", "-D", repo.branch);
            rmSync(join(repo.primary, ".git", "dagu-feature"), { recursive: true, force: true });
            repo.worktree = join(repo.primary, ".workspace", "worktrees", "issue-189");
            writeFileSync(join(repo.primary, ".git", "info", "exclude"), "/.workspace/\n");
            const pocDefinition = join(repo.primary, ".workspace", "dagu", "dags", "poc.yaml");
            mkdirSync(dirname(pocDefinition), { recursive: true });
            writeFileSync(pocDefinition, "steps:\n  - id: experiment\n    run: echo isolated-poc\n");
            const source = readFileSync(definition, "utf8");
            const triage = mode === "poc"
              ? "  - id: triage\n    depends: admit\n    action: human.task\n    with:\n      prompt: Synthetic decision actor for PoC routing acceptance.\n      form:\n        type: object\n        properties:\n          POC:\n            type: string\n            enum: [yes, no]\n          QUESTION:\n            type: string\n          BASIS:\n            type: string\n          REQUIRED_TARGETS:\n            type: string\n          AUTHORIZED_TARGETS:\n            type: string\n          SCOPE_BASIS:\n            type: string\n        required: [POC, QUESTION, BASIS, REQUIRED_TARGETS, AUTHORIZED_TARGETS, SCOPE_BASIS]\n"
              : `  - id: triage\n    run: |\n      printf 'POC=no\\nQUESTION=runtime behavior\\nBASIS=regression test\\nREVIEW=fixture\\n' >> "$DAGU_OUTPUT_FILE"\n    outputs:\n      - name: POC\n      - name: QUESTION\n      - name: BASIS\n      - name: REVIEW\n`;
            // Reviewer verification and implementation/merge are outside this routing test.
            // Keep the production start/close gates, conditional checkpoints and exit handler.
            const decision = mode === "poc" ? extractStep(source, "triage_decision")
              : "  - id: triage_decision\n    depends: triage\n    run: echo reviewed-implementation\n";
            const implementation = mode === "poc"
              ? extractStep(source, "implement").replace("depends: escalation_decision", "depends: recover_start_gate_cancellation") + "  - id: await_merge\n    depends: implement\n    run: echo merged\n  - id: authorize_ci\n    depends: await_merge\n    run: echo authorized-candidate\n"
              : `  - id: implement\n    depends: start_gate\n    run: |\n      STATE=$(git -C "$PRIMARY" rev-parse --path-format=absolute --git-path "dagu-feature/runs/$RUN")\n      sha=$(git -C "$WORKTREE" rev-parse HEAD)\n      printf '%s\\n' "$sha" > "$STATE/tested-sha"\n      jq -n --arg sha "$sha" '{sha:$sha}' > "$STATE/candidate.json"\n      ${mode === "implementation-blocked" ? 'printf "operator changes\\n" > "$PRIMARY/README.txt"' : "echo implementation"}\n  - id: await_merge\n    depends: implement\n    run: echo merged\n  - id: authorize_ci\n    depends: await_merge\n    run: echo authorized-candidate\n`;
            const script = [
              "type: graph\nshell: bash\nmax_active_steps: 1\n",
              `params:\n  - ISSUE: "189"\n  - PR_NUMBER: ""\n  - OMP_SESSION_ID: close-owner\n`,
              `env:\n  - A4S_BIN: ${JSON.stringify(mode === "poc" ? join(repo.root, "bin", "a4s-routing") : a4sBin)}\n  - PRIMARY: ${JSON.stringify(repo.primary)}\n  - BASE_BRANCH: main\n  - BRANCH: dagu/issue-\${ISSUE}\n  - GATE: "true"\n  - REQUIRED_CHECK: validate\n  - PATH: ${join(repo.root, "bin")}:${process.env.PATH}\n  - WORKTREE: ${repo.worktree}\n  - RUN: \${context.run.id}\n  - DAGU_FEATURE_BUNDLE: test\n`,
              source.slice(source.indexOf("  - DAGU_RESOURCE_GUARD: |"), source.indexOf("steps:\n")),
              "steps:\n", ...(mode === "poc" ? ["admission", "admit"].map(id => extractStep(source, id)) : []), triage, decision,
              ...(mode === "poc" ? ["poc_scope_prepare", "poc_scope_decision", "poc_scope_decision_cancellation", "poc_scope_resolve", "recover_poc_scope", "recover_poc_scope_cancellation", "poc_admit"].map(id => extractStep(source, id)) : []),
              ...["detect_start_primary", "start_primary_unavailable", "start_gate", ...(mode === "poc" ? ["recover_start_gate"] : [])].map(id => extractStep(source, id)),
              implementation,
              ...["detect_close_primary", "close_primary_unavailable", "close_gate"].map(id =>
                extractStep(id === "close_gate" ? readFileSync(definitions[0][1], "utf8") : source, id).replace("await_merge_cancellation", "await_merge")),
              "handler_on:\n", source.slice(source.indexOf("  exit:\n")),
            ].join("");
            const dag = join(home, "dags", "feature.yaml");
            writeFileSync(dag, script);
            rmSync(join(repo.root, "bin", "dagu"));
            const runEnv = { ...env, A4S_BIN: mode === "poc" ? join(repo.root, "bin", "a4s-routing") : a4sBin, PATH: `${join(repo.root, "bin")}:${process.env.PATH}` };
            const dagu = (...args: string[]) => execFileSync("dagu", args, {
              cwd: root, env: runEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
            }).trim();
            const id = testRunId(mode);
            dagu("enqueue", "--run-id", id, dag);
            if (mode === "poc") {
              await state(id, "waiting");
              dagu("human-task", "complete", "feature", "--run-id", id, "--step", "triage",
                "--input", "POC=yes", "--input", "QUESTION=runtime behavior", "--input", "BASIS=regression test",
                "--input", 'REQUIRED_TARGETS=["local"]', "--input", 'AUTHORIZED_TARGETS=["local"]', "--input", "SCOPE_BASIS=isolated local fixture");
              const routed = await until("PoC parent finishes instead of waiting at implement", async () => {
                const response = await fetch(`${api}/dag-runs/feature/${id}`);
                if (!response.ok) return undefined;
                const detail = (await response.json() as { dagRunDetails: LiveDetail }).dagRunDetails;
                assert.notEqual(detail.nodes.find(node => node.step.name === "implement")?.statusLabel, "waiting",
                  "POC=yes parent must skip implement");
                return detail.statusLabel === "succeeded" ? detail : undefined;
              });
              assert.equal(routed.nodes.find(node => node.step.name === "implement")?.statusLabel, "skipped");
              const replacement = testRunId("replacement");
              dagu("enqueue", "--run-id", replacement, dag);
              const admitted = await state(replacement, "waiting");
              assert.equal(admitted.nodes.find(node => node.step.name === "admit")?.statusLabel, "succeeded");
              assert.equal(admitted.nodes.find(node => node.step.name === "triage")?.statusLabel, "waiting");
              dagu("human-task", "complete", "feature", "--run-id", replacement, "--step", "triage",
                "--input", "POC=yes", "--input", "QUESTION=runtime behavior", "--input", "BASIS=regression test",
                "--input", 'REQUIRED_TARGETS=["local"]', "--input", 'AUTHORIZED_TARGETS=["local"]', "--input", "SCOPE_BASIS=isolated local fixture");
              await state(replacement, "succeeded");
            }
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
            done.resolvedPrimary = repo.primary;
            const transitions = new Transitions("close-owner");
            transitions.observe({ ...done, statusLabel: "running" }, { baseline: true });
            assert.deepEqual(transitions.observe(done), {
              notification: { message: "dagu · feature #189 succeeded", type: "info" },
              wakeMessage: `[DAGU STATE] run=${id} status=succeeded issue=189 bundle=unstamped extension=${BUNDLE_VERSION} main=n/a compat=unstamped installed=unknown`,
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
  ...liveDagu,
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
          ? [{ step: "recover_start_gate", iteration: 0 }, { step: "implement", iteration: 1 },
            { step: "await_merge", iteration: 1 }]
          : mode === "gate"
            ? [{ step: "implement", iteration: 0 }, { step: "implement", iteration: 1 },
              { step: "await_merge", iteration: 1 }]
            : [{ step: "implement", iteration: 0 },
              { step: "recover_push", iteration: 0 }, { step: "await_merge", iteration: 1 }];
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

for (const [name, definition] of [definitions[0]]) {
  test(`${name} real Dagu checks primary freshness before admission without post-merge bootstrap`, {
    ...liveDagu,
    timeout: 115_000,
  }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "omp-dagu-freshness-"));
    const home = join(root, "dagu-home");
    mkdirSync(join(home, "dags"), { recursive: true });
    const listener = createServer();
    await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>(resolve => listener.close(() => resolve()));
    writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\nscheduler:\n  port: 0\n`);
    const env = { ...process.env, A4S_BIN: a4sBin, DAGU_PARAMS_JSON: "{}", DAGU_HOME: home, DAGU_COORDINATOR_ENABLED: "false" };
    const binary = execFileSync("which", ["dagu"], { encoding: "utf8" }).trim();
    t.diagnostic(`isolated Dagu binary=${binary} version=${liveDaguVersion} home=${home} port=${port}`);
    let serviceLog = "";
    const service = spawn(binary, ["start-all", "--host", "127.0.0.1", "--port", String(port)], {
      cwd: root, env, stdio: ["ignore", "pipe", "pipe"],
    });
    service.stdout.on("data", data => { serviceLog += data; });
    service.stderr.on("data", data => { serviceLog += data; });
    const api = `http://127.0.0.1:${port}/api/v1`;
    async function until<T>(description: string, probe: () => Promise<T | undefined>): Promise<T> {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const value = await probe();
        if (value !== undefined) return value;
        await delay(100);
      }
      throw new Error(`Timed out: ${description}\n${serviceLog}`);
    }
    const source = readFileSync(definition, "utf8");
    async function execute(repo: Repository, step: string) {
      const id = featureScriptEnv(repo).RUN!;
      const file = join(home, "dags", "probe.yaml");
      const scriptEnv = featureScriptEnv(repo);
      writeFileSync(file, [
        "type: graph\nshell: bash\nenv:\n",
        ...Object.entries(scriptEnv).filter((entry): entry is [string, string] => entry[1] !== undefined)
          .map(([key, value]) => `  - ${key}: ${JSON.stringify(value)}\n`),
        source.slice(source.indexOf("  - DAGU_RESOURCE_GUARD: |"), source.indexOf("steps:\n")),
        "steps:\n", extractStep(source, step).replace(/^    depends:.*\n/m, ""),
      ].join(""));
      execFileSync(binary, ["enqueue", "--run-id", id, file], { cwd: root, env });
      const result = await until(`${id} terminal`, async () => {
        const response = await fetch(`${api}/dag-runs/probe/${id}`);
        if (!response.ok) return undefined;
        const run = (await response.json() as { dagRunDetails: { statusLabel: string; nodes: Array<{ statusLabel: string; stdout?: string; stderr?: string }> } }).dagRunDetails;
        return ["succeeded", "failed"].includes(run.statusLabel) ? run : undefined;
      });
      const node = result.nodes[0]!;
      const stdout = node.stdout ? readFileSync(node.stdout, "utf8") : "";
      const stderr = node.stderr ? readFileSync(node.stderr, "utf8") : "";
      return { id, status: result.statusLabel, stdout, stderr };
    }
    try {
      await until("isolated Dagu ready", async () => {
        try { return (await fetch(`${api}/dag-runs`)).ok ? true : undefined; } catch { return undefined; }
      });
      for (const scenario of ["equal", "behind", "fast-forward", "ahead", "version"] as const) {
        const repo = repository(testRunId("freshness"));
        try {
          const manifest = join(repo.primary, "packages/issue-lifecycle/package.json");
          mkdirSync(dirname(manifest), { recursive: true });
          writeFileSync(manifest, JSON.stringify({ version: BUNDLE_VERSION }));
          git(repo.primary, "add", ".");
          git(repo.primary, "commit", "-m", "install bundle manifest");
          git(repo.primary, "push", "origin", "main");
          git(repo.worktree, "merge", "--ff-only", "main");
          if (scenario === "behind" || scenario === "fast-forward") {
            commit(repo, "upstream.txt", "origin advanced\n");
            git(repo.worktree, "push", "origin", "HEAD:main");
            if (scenario === "behind") writeFileSync(join(repo.primary, "README.txt"), "operator changes\n");
          } else if (scenario === "ahead") {
            writeFileSync(join(repo.primary, "ahead.txt"), "local commit\n");
            git(repo.primary, "add", ".");
            git(repo.primary, "commit", "-m", "unpublished main");
          } else if (scenario === "version") {
            writeFileSync(manifest, JSON.stringify({ version: "0.3.8" }));
          }
          const result = await execute(repo, "admit");
          const cause = { behind: "primary_behind", ahead: "primary_ahead", version: "version_stale" }[scenario as "behind" | "ahead" | "version"];
          if (cause) {
            assert.equal(result.status, "failed", JSON.stringify(result));
            assert.match(result.stderr, new RegExp(`cause=${cause} observed_sha=[a-f0-9]{40} expected_sha=[a-f0-9]{40} observed_version=\\S+ expected_version=${BUNDLE_VERSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
            assert.equal(existsSync(join(repo.primary, ".git", "dagu-feature", "owners", "issue-189")), false);
          } else {
            assert.equal(result.status, "succeeded", JSON.stringify(result));
            assert.equal(git(repo.primary, "rev-parse", "HEAD"), git(repo.primary, "rev-parse", "origin/main"));
            assert.equal(readFileSync(join(repo.primary, ".git", "dagu-feature", "owners", "issue-189"), "utf8"), `${result.id}\t${repo.branch}\n`);
          }
          t.diagnostic(`${scenario}: ${result.id} ${result.status} ${result.stderr.trim()}`);
        } finally { rmSync(repo.root, { recursive: true, force: true }); }
      }
      for (const changed of ["packages/issue-lifecycle/skills/issue-execution/feature.yaml", "packages/issue-lifecycle/CHANGELOG.md", "README.txt"]) {
        const repo = repository(testRunId("freshness-close"));
        try {
          commit(repo, "packages/issue-lifecycle/package.json", JSON.stringify({ version: BUNDLE_VERSION }));
          commit(repo, changed, "merged change\n");
          git(repo.primary, "merge", "--ff-only", repo.branch);
          git(repo.primary, "push", "origin", "main");
          stubSuccessfulCloseGateGh(repo);
          const log = join(repo.root, "bootstrap.args");
          const stub = join(repo.root, "bin", "dagu");
          writeFileSync(stub, `#!/bin/sh\ncase "$1" in\n  history) printf '[]\\n' ;;\n  enqueue) printf '%s\\n' "$@" > ${JSON.stringify(log)} ;;\n  *) exit 1 ;;\nesac\n`);
          chmodSync(stub, 0o755);
          const result = await execute(repo, "close_gate");
          assert.equal(result.status, "succeeded", JSON.stringify(result));
          assert.equal(existsSync(log), false);
          assert.match(result.stdout, /cleanup worktree=.*remote=absent/);
          t.diagnostic(`close_gate ${changed}: ${result.id} ${result.status}`);
        } finally { rmSync(repo.root, { recursive: true, force: true }); }
      }
    } finally {
      service.kill("SIGTERM");
      if (service.exitCode === null) await new Promise<void>(resolve => service.once("exit", () => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const [name, definition] of definitions) {
  test(`${name} optional validation uses native skip, SHA approval and iterative rejection`, {
    ...liveDagu,
    timeout: 180_000,
  }, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-dagu-validation-")));
    const home = join(root, "home");
    mkdirSync(join(home, "dags"), { recursive: true });
    async function freePort(): Promise<number> {
      const server = createServer();
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      return address.port;
    }
    const port = await freePort();
    const schedulerPort = await freePort();
    writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\nscheduler:\n  port: ${schedulerPort}\n`);
    const env = { ...process.env, DAGU_HOME: home, DAGU_COORDINATOR_ENABLED: "false" };
    let logs = "";
    const service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
    service.stdout.on("data", data => { logs += data; });
    service.stderr.on("data", data => { logs += data; });
    const api = `http://127.0.0.1:${port}/api/v1`;
    type Detail = RunDetails & { nodes: Array<{ step: { id: string; name: string; humanTask?: { prompt?: string } }; statusLabel: string; approvalIteration?: number; approvalInputs?: Record<string, string> }> };
    async function until<T>(probe: () => Promise<T | undefined>): Promise<T> {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const result = await probe();
        if (result !== undefined) return result;
        await delay(100);
      }
      throw new Error(`Validation transition timed out\n${logs}`);
    }
    async function state(id: string, status: string, step?: string): Promise<Detail> {
      return until(async () => {
        const response = await fetch(`${api}/dag-runs/feature/${id}`);
        if (!response.ok) return undefined;
        const run = (await response.json() as { dagRunDetails: Detail }).dagRunDetails;
        if (status !== "failed") assert.notEqual(run.statusLabel, "failed", JSON.stringify(run));
        return run.statusLabel === status && (!step || run.nodes.some(node => node.step.id === step && node.statusLabel === "waiting")) ? run : undefined;
      });
    }
    const dagu = (...args: string[]) => spawnSync("dagu", args, { env, encoding: "utf8", timeout: 10_000 });
    const command = (...args: string[]) => {
      const result = dagu(...args);
      assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
      return result.stdout;
    };
    try {
      await until(async () => { try { return (await fetch(`${api}/dag-runs`)).ok ? true : undefined; } catch { return undefined; } });
      for (const mode of ["empty", "gate-fail", "poc", "wrong-sha", "declared"] as const) {
        if (mode === "poc" && name !== "template") continue;
        const repo = repository();
        try {
          const id = testRunId("validation");
          const oldState = repo.state;
          repo.state = join(dirname(oldState), id);
          renameSync(oldState, repo.state);
          const procedure = ["declared", "wrong-sha", "poc"].includes(mode) ? "Run isolated smoke over the tested binary" : "";
          const source = readFileSync(definition, "utf8");
          const gate = extractStep(source, "gate").replace(/depends: conflict_review(?:_cancellation)?/, "depends: implement")
            .replace(/    retry_policy:\n      limit: 1\n      interval_sec: 5\n/, "")
            .replace("    run: |", "    preconditions:\n      - condition: '${steps.triage.outputs.POC}'\n        expected: 'no'\n    run: |");
          const vars = { ...featureScriptEnv(repo), VALIDATION: procedure, RUN: id, OMP_SESSION_ID: "parent-id", DAGU_PORT: String(port), GATE: mode === "gate-fail" ? "exit 1" : `printf 'gate\\n' >> ${JSON.stringify(join(root, id + ".gates"))}` };
          const dag = join(home, "dags", "feature.yaml");
          writeFileSync(dag, `type: graph\nshell: bash\nmax_active_steps: 1\nenv:\n`
            + Object.entries(vars).filter(([, value]) => value !== undefined).map(([key, value]) => `  - ${key}: ${JSON.stringify(value)}\n`).join("")
            + `steps:\n  - id: triage\n    run: printf 'POC=${mode === "poc" ? "yes" : "no"}\\n' >> "$DAGU_OUTPUT_FILE"\n    outputs:\n      - name: POC\n  - id: implement\n    depends: triage\n    action: human.task\n    with:\n      prompt: Implement candidate\n`
            + gate + extractStep(source, "recover_gate").replaceAll("rewind_to: implement_budget", "rewind_to: implement")
            + ["validation", "push", "recover_push"].map(step => extractStep(source, step)
              .replaceAll("rewind_to: implement_budget", "rewind_to: implement")).join(""));
          command("validate", dag);
          command("enqueue", "--run-id", id, dag);
          await state(id, "waiting", "implement");
          command("human-task", "complete", "feature", "--run-id", id, "--step", "implement");
          if (mode === "gate-fail") {
            const blocked = await state(id, "waiting", "recover_gate");
            assert.equal(blocked.nodes.find(node => node.step.id === "gate")?.statusLabel, "succeeded");
            assert.equal(blocked.nodes.find(node => node.step.id === "validation")?.statusLabel, "not_started");
            assert.equal(blocked.nodes.find(node => node.step.id === "push")?.statusLabel, "not_started");
            assert.equal(hasRef(repo.primary, `refs/remotes/origin/${repo.branch}`), false);
          } else if (mode === "wrong-sha") {
            await state(id, "waiting", "validation");
            command("human-task", "complete", "feature", "--run-id", id, "--step", "validation", "--input", "APPROVED=yes", "--input", `TESTED_SHA=${"0".repeat(40)}`);
            const rejected = await state(id, "waiting", "recover_push");
            assert.equal(rejected.nodes.find(node => node.step.id === "push")?.statusLabel, "succeeded");
            assert.equal(hasRef(repo.primary, `refs/remotes/origin/${repo.branch}`), false);
          } else if (mode === "declared") {
            const first = await state(id, "waiting", "validation");
            const sha = git(repo.worktree, "rev-parse", "HEAD");
            assert.match(first.nodes.find(node => node.step.id === "validation")!.step.humanTask!.prompt!, new RegExp(sha));
            const iteration = first.nodes.find(node => node.step.id === "validation")!.approvalIteration ?? 0;
            command("human-task", "push-back", "feature", "--run-id", id, "--step", "validation", "--expected-iteration", String(iteration), "--input", "REASON=smoke failed");
            const rewind = await state(id, "waiting", "implement");
            assert.equal(rewind.nodes.find(node => node.step.id === "implement")!.approvalIteration, iteration + 1);
            assert.match(JSON.stringify(rewind), /smoke failed/);
            commit(repo, "README.txt", "corrected smoke\n");
            const corrected = git(repo.worktree, "rev-parse", "HEAD");
            command("human-task", "complete", "feature", "--run-id", id, "--step", "implement");
            await state(id, "waiting", "validation");
            const stale = spawnSync("bash", ["-c", extractScript(definition, "  - id: push")], {
              encoding: "utf8", env: { ...vars, VALIDATION: procedure, APPROVED: "yes", TESTED_SHA: sha },
            });
            assert.notEqual(stale.status, 0, stale.stdout + stale.stderr);
            assert.match(stale.stderr, /rule=push.validation_sha expected=\S+ observed=\S+/);
            command("human-task", "complete", "feature", "--run-id", id, "--step", "validation", "--input", "APPROVED=yes", "--input", `TESTED_SHA=${corrected}`);
            await state(id, "succeeded");
            assert.equal(git(repo.primary, "rev-parse", `origin/${repo.branch}`), corrected);
            assert.equal(readFileSync(join(root, id + ".gates"), "utf8"), "gate\ngate\n");
            assert.deepEqual(JSON.parse(readFileSync(join(repo.state, "validation.json"), "utf8")), { sha: corrected, procedure, approved: "yes" });
          } else {
            const done = await state(id, "succeeded");
            const status = (step: string) => done.nodes.find(node => node.step.id === step)?.statusLabel;
            assert.equal(status("validation"), "skipped");
            assert.equal(status("push"), mode === "empty" ? "succeeded" : "skipped");
            assert.equal(hasRef(repo.primary, `refs/remotes/origin/${repo.branch}`), mode === "empty");
          }
        } finally { rmSync(repo.root, { recursive: true, force: true }); }
      }
    } finally {
      service.kill("SIGTERM");
      if (service.exitCode === null) await new Promise<void>(resolve => service.once("exit", () => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const [name, definition] of [
  ["PoC template", fileURLToPath(new URL("../../skills/issue-execution/poc.yaml", import.meta.url))],
  ["PoC rendered DAG", fileURLToPath(new URL(renderedPoc, import.meta.url))],
] as const) {
  test(`${name} base compares the primary manifest with origin before recording its base`, () => {
    const repo = repository();
    try {
      const manifest = join(repo.primary, "packages/issue-lifecycle/package.json");
      mkdirSync(dirname(manifest), { recursive: true });
      writeFileSync(manifest, JSON.stringify({ version: BUNDLE_VERSION }));
      git(repo.primary, "add", ".");
      git(repo.primary, "commit", "-m", "bundle manifest");
      git(repo.primary, "push", "origin", "main");
      const state = join(repo.primary, ".git/poc/runs/test-run");
      mkdirSync(state, { recursive: true });
      const output = join(repo.root, "base.outputs");
      const script = extractScript(definition, "  - id: base");
      const env = { ...featureScriptEnv(repo), DAGU_FEATURE_BUNDLE: "test", DAGU_OUTPUT_FILE: output };
      writeFileSync(manifest, JSON.stringify({ version: "0.3.8" }));
      const stale = spawnSync("bash", ["-c", script], { env, encoding: "utf8" });
      assert.equal(stale.status, 1);
      assert.match(stale.stderr, /cause=version_stale.*observed_version=0\.3\.8 expected_version=/);
      writeFileSync(manifest, JSON.stringify({ version: BUNDLE_VERSION }));
      const equal = spawnSync("bash", ["-c", script], { env, encoding: "utf8" });
      assert.equal(equal.status, 0, equal.stderr);
      assert.equal(readFileSync(join(state, "base.sha"), "utf8").trim(), git(repo.primary, "rev-parse", "origin/main"));
      assert.match(readFileSync(output, "utf8"), /BASE_SHA=[a-f0-9]{40}/);
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });
}

for (const [name, definition] of definitions) {
  test(`${name} isolated Dagu gates corrections and rebases before PR-head updates`, {
    ...liveDagu,
    timeout: 180_000,
  }, async () => {
    const repo = repository();
    const home = join(repo.root, "dagu-home");
    mkdirSync(join(home, "dags"), { recursive: true });
    const listener = createServer();
    await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    const run = testRunId("publication");
    const state = join(dirname(repo.state), run);
    renameSync(repo.state, state);
    repo.state = state;
    const identity = JSON.stringify({ primary: repo.primary, worktree: repo.worktree, branch: repo.branch, run, session: "parent-id" }) + "\n";
    writeFileSync(join(state, "identity"), identity);
    writeFileSync(git(repo.worktree, "rev-parse", "--path-format=absolute", "--git-path", "dagu-feature-owner"), identity);
    const fixtureBin = join(repo.root, "role-bin"); mkdirSync(fixtureBin);
    const env: NodeJS.ProcessEnv = { ...process.env, A4S_BIN: join(fixtureBin, "a4s"), PATH: `${fixtureBin}:${process.env.PATH}`, DAGU_PARAMS_JSON: "{}", DAGU_HOME: home, DAGU_PORT: String(port), DAGU_COORDINATOR_ENABLED: "false" };
    // This scheduler owns a new run's iteration independently of the parent role job.
    delete env.DAG_PUSHBACK_ITERATION;
    writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\n`);
    const source = readFileSync(definition, "utf8");
    const commandImplementation = extractStep(source, "implement").includes('"$A4S_BIN" role-jobs stage implement');
    const implementationReady = join(repo.root, "implementation-ready");
    const executor = join(fixtureBin, "execute.mts");
    writeFileSync(executor, `import {appendFileSync,existsSync,rmSync} from "node:fs";
import {setTimeout as delay} from "node:timers/promises";
import {dispatchStage} from ${JSON.stringify(new URL("../../src/role-dispatch.ts", import.meta.url).href)};
import {roleExecution} from ${JSON.stringify(new URL("../role-job-fixtures.ts", import.meta.url).href)};
await dispatchStage("implement",(name,value)=>appendFileSync(process.env.DAGU_OUTPUT_FILE,name+"="+value+"\\n"),async(job,assignment)=>{
  while(!existsSync(${JSON.stringify(implementationReady)})) await delay(100);
  rmSync(${JSON.stringify(implementationReady)});
  return roleExecution(job,assignment);
});
`);
    writeFileSync(join(fixtureBin, "a4s"), `#!/bin/sh\nif [ "$1 $2 $3" = "role-jobs stage implement" ]; then exec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(import.meta.resolve("tsx"))} ${JSON.stringify(executor)}; fi\nexec ${JSON.stringify(a4sBin)} "$@"\n`);
    chmodSync(join(fixtureBin, "a4s"), 0o755);
    writeFileSync(join(fixtureBin, "gh"), '#!/bin/sh\ncase "$*" in\n  "pr list "*) printf \'[]\\n\' ;;\n  *) printf \'{"title":"Fixture","body":"Acceptance","comments":[]}\\n\' ;;\nesac\n');
    chmodSync(join(fixtureBin, "gh"), 0o755);
    const steps = ["implement_budget", "escalation", "escalation_decision", "implement", "capture", "checkpoint_push", "rebase", "conflict_review", "gate", "recover_gate",
      "validation", "push"].map(step => extractStep(source, step)
        .replace(/    depends: recover_start_gate_cancellation\n/, "    depends: recover_start_gate\n")
        .replace(/    depends: rebase_escalation_decision\n/, "    depends: checkpoint_push\n")).join("\n");
    const resourceGuard = (parse(source).env as Array<Record<string, string>>)
      .find(entry => "DAGU_RESOURCE_GUARD" in entry)!.DAGU_RESOURCE_GUARD;
    const dag = join(home, "dags", "feature.yaml");
    writeFileSync(dag, `name: feature\ntype: graph\nshell: bash\nmax_active_steps: 1\nparams:\n  - ISSUE: "189"\n  - OMP_SESSION_ID: parent-id\nenv:\n${Object.entries({
      ISSUE: "189", PRIMARY: repo.primary, WORKTREE: repo.worktree, BRANCH: repo.branch, PATH: env.PATH, A4S_BIN: env.A4S_BIN,
      BASE_BRANCH: "main", GATE: "test -f acceptance.txt", VALIDATION: "", OMP_SESSION_ID: "parent-id", RUN: "${context.run.id}", DAGU_PORT: String(port),
      DAGU_RESOURCE_GUARD: resourceGuard,
    }).map(([key, value]) => `  - ${key}: ${JSON.stringify(value)}`).join("\n")}\nsteps:\n  - id: triage\n    run: echo POC=no >> "$DAGU_OUTPUT_FILE"\n    outputs:\n      - name: POC\n  - id: recover_start_gate\n    depends: triage\n    run: "true"\n${steps}\n  - id: after_push\n    depends: push\n    action: human.task\n    with:\n      prompt: "Observe published candidate or rebase in this same run."\n      push_back:\n        rewind_to: rebase\nhandler_on:\n  wait:\n    run: |\n${extractScript(definition, "  wait:").split("\n").map(line => `      ${line}`).join("\n")}\n`);
    writeFileSync(join(state, "receipt.json"), JSON.stringify(roleAdmission(repo.primary, home, run, readFileSync(dag, "utf8"))));
    let serviceLog = "";
    const service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(port)], {
      cwd: repo.root, env, stdio: ["ignore", "pipe", "pipe"],
    });
    service.stdout.on("data", data => { serviceLog += data; });
    service.stderr.on("data", data => { serviceLog += data; });
    const dagu = (...args: string[]) => execFileSync("dagu", args, { cwd: repo.root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    type Detail = { statusLabel: string; nodes: Array<{ step: { name: string }; statusLabel: string; approvalIteration?: number }> };
    async function untilStep(step: string, iteration?: number): Promise<Detail> {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/v1/dag-runs/feature/${run}`);
          if (response.ok) {
            const detail = (await response.json() as { dagRunDetails: Detail }).dagRunDetails;
            assert.ok(!["failed", "aborted"].includes(detail.statusLabel), JSON.stringify(detail));
            const expected = commandImplementation && step === "implement" ? "running" : "waiting";
            if (detail.statusLabel === expected && detail.nodes.some(node => node.step.name === step && node.statusLabel === expected &&
              (expected === "running" || iteration === undefined || (node.approvalIteration ?? 0) === iteration))) {
              const observed = expected === "running"
                ? JSON.parse(readFileSync(join(state, "escalation.json"), "utf8")).iteration
                : Number(dagu("status", "feature", "--run-id", run).match(/push-back iteration: (\d+)/)?.[1] ?? 0);
              if (iteration === undefined || observed === iteration) return detail;
            }
          }
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
        }
        await delay(100);
      }
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/dag-runs/feature/${run}`);
      const detail = await response.json() as { dagRunDetails: { nodes: Array<{ step: { name: string }; statusLabel: string; stderr?: string }> } };
      const logs = detail.dagRunDetails.nodes.map(node => `${node.step.name}: ${node.statusLabel}\n${node.stderr && existsSync(node.stderr) ? readFileSync(node.stderr, "utf8") : ""}`).join("\n");
      const transition = join(state, "gate-transition.log");
      throw new Error(`Timed out at ${step}\n${logs}\n${existsSync(transition) ? readFileSync(transition, "utf8") : "No gate transition"}\n${serviceLog}`);
    }
    const completeImplementation = () => {
      if (commandImplementation) writeFileSync(implementationReady, "ready\n");
      else dagu("human-task", "complete", "feature", "--run-id", run,
        "--step", "implement", "--input", "SUMMARY=Gated candidate", "--input", "MESSAGE=feat: gated candidate",
        "--input", "IMPLEMENTER=ImplementTest");
    };
    try {
      const deadline = Date.now() + 30_000;
      while (true) {
        try { if ((await fetch(`http://127.0.0.1:${port}/api/v1/dag-runs`)).ok) break; } catch { /* Service startup. */ }
        assert.ok(Date.now() < deadline, serviceLog);
        await delay(100);
      }
      writeFileSync(join(repo.worktree, "README.txt"), "initial candidate\n");
      dagu("enqueue", "--run-id", run, dag);
      await untilStep("implement", 0);
      const refsBefore = git(repo.primary, "ls-remote", "--heads", "origin");
      completeImplementation();
      await untilStep("implement", 1);
      const failed = git(repo.worktree, "rev-parse", "HEAD");
      assert.match(readFileSync(join(state, "gate-transition.log"), "utf8"), /./);
      assert.equal(git(repo.primary, "ls-remote", "--heads", "origin"), refsBefore);
      assert.equal(JSON.parse(readFileSync(join(state, "gate.json"), "utf8")).sha, failed);
      writeFileSync(join(repo.worktree, "acceptance.txt"), "accepted\n");
      writeFileSync(join(repo.worktree, "README.txt"), "fixed candidate\n");
      completeImplementation();
      const published = await untilStep("after_push", 1);
      const fixed = git(repo.worktree, "rev-parse", "HEAD");
      assert.equal(published.nodes.find(node => node.step.name === "gate")?.statusLabel, "succeeded");
      assert.equal(git(repo.primary, "rev-parse", `origin/${repo.branch}`), fixed);
      assert.notEqual(failed, fixed);
      writeFileSync(join(repo.primary, "upstream"), "upstream after publication\n");
      git(repo.primary, "add", "upstream");
      git(repo.primary, "commit", "-m", "upstream change");
      git(repo.primary, "push", "origin", "main");
      dagu("human-task", "push-back", "feature", "--run-id", run, "--step", "after_push", "--expected-iteration", "1");
      const rebasedWaiting = await untilStep("after_push", 2);
      assert.equal(rebasedWaiting.nodes.find(node => node.step.name === "gate")?.statusLabel, "succeeded");
      const rebased = git(repo.worktree, "rev-parse", "HEAD");
      assert.notEqual(rebased, fixed);
      assert.equal(git(repo.primary, "rev-parse", `origin/${repo.branch}`), rebased);
      dagu("human-task", "complete", "feature", "--run-id", run, "--step", "after_push");
    } finally {
      service.kill("SIGTERM");
      await new Promise<void>(resolve => {
        if (service.exitCode !== null) resolve();
        else service.once("exit", () => resolve());
      });
      rmSync(repo.root, { recursive: true, force: true });
    }
  });
}

test("adopted policy rejects run overrides before repository writes and admits operational inputs", liveDagu, async () => {
  const repo = repository();
  const home = join(repo.root, "dagu-home");
  const stage = join(repo.root, "staged", "config.json");
  const packageDir = fileURLToPath(new URL("../../", import.meta.url));
  const skillDir = fileURLToPath(new URL("../../skills/issue-execution/", import.meta.url));
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const env = {
    ...process.env, A4S_BIN: a4sBin, DAGU_PARAMS_JSON: "{}", DAGU_HOME: home, DAGU_PORT: String(port), PRIMARY: repo.primary, A4S_PRIMARY: repo.primary,
    GATE: "printf adopted-gate", REQUIRED_CHECK: "adopted-check", REPO: "fixture", BASE_BRANCH: "main",
    REBASE_RESOLVER: "printf adopted-resolver",
    STAGE: stage, TEST_PATHS: "test/", BUNDLE_NAME: "@a4s/issue-lifecycle", BUNDLE_VERSION,
    DAGU_VERSION: liveDaguVersion, SOURCE_NWO: "fixture/repo", SOURCE_SHA: "1".repeat(40), DAG_RUN_ID: "bootstrap-fixture",
  };
  mkdirSync(join(home, "dags"), { recursive: true });
  writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\n`);
  // Standalone starts still run the exit ownership guard, which reads enqueued
  // policy snapshots through the API. Serve them without consuming the queue.
  const service = spawn("dagu", ["server", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: repo.root, env, stdio: ["ignore", "pipe", "pipe"],
  });
  let serviceLog = "";
  service.stdout.on("data", data => { serviceLog += data; });
  service.stderr.on("data", data => { serviceLog += data; });
  const snapshot = (): string => {
    const hash = createHash("sha256");
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(directory, entry.name);
        hash.update(path);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile()) hash.update(readFileSync(path));
      }
    };
    visit(repo.primary);
    visit(repo.worktree);
    return hash.digest("hex");
  };
  try {
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/api/v1/dag-runs`)).ok; } catch {}
      if (ready) break;
      await delay(150);
    }
    assert.ok(ready, `isolated Dagu API ready\n${serviceLog}`);
    const rendered = spawnSync("bash", ["-c", extractScript(join(skillDir, "dagu-feature-bootstrap.yaml"), "  - id: write_config")], { encoding: "utf8", env });
    assert.equal(rendered.status, 0, rendered.stdout + rendered.stderr);
    const config = readConfigFile(stage);
    for (const name of ["feature.yaml", "poc.yaml"] as const) {
      writeFileSync(join(repo.root, "staged", name), materializeDag(packageDir, name, config, { version: BUNDLE_VERSION, source: `fixture/repo@${"1".repeat(40)}`, executable: a4sBin }));
    }
    for (const name of ["feature", "poc"]) {
      const definition = join(repo.root, "staged", `${name}.yaml`);
      for (const [parameter, value] of [["GATE", "true"], ["REBASE_RESOLVER", "true"], ["REQUIRED_CHECK", "arbitrary"], ["PRIMARY", "/foreign/clone"], ["BRANCH", "off-pattern"], ["GATE", ""], ["PRIMARY", repo.primary]] as const) {
        const before = snapshot();
        const result = spawnSync("dagu", ["start", "--run-id", testRunId(`${name}-${parameter.toLowerCase()}-${value.length}`), definition, "--", "ISSUE=189", `${parameter}=${value}`], { encoding: "utf8", env, timeout: 30_000 });
        assert.notEqual(result.status, 0, result.stdout);
        assert.match(result.stdout + result.stderr, new RegExp(`admission rejected run parameter: ${parameter}`));
        assert.match(result.stdout + result.stderr, /adopted policy PRIMARY=/);
        assert.equal(snapshot(), before, `${name} ${parameter} changed repository state`);
      }
    }
    const featureDefinition = join(repo.root, "staged", "feature.yaml");
    const accepted = spawnSync("dagu", ["start", "--only", "admission", "--run-id", testRunId("operational"), featureDefinition, "--", "ISSUE=274", "PR_NUMBER=275", "OMP_SESSION_ID=owner-session"], { encoding: "utf8", env, timeout: 30_000 });
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
    assert.match(accepted.stdout, /admission.*succeeded/);
    const enqueued = spawnSync("dagu", ["enqueue", "--run-id", testRunId("operational-queued"), featureDefinition, "--", "ISSUE=274", "PR_NUMBER=275", "OMP_SESSION_ID=owner-session"], { encoding: "utf8", env, timeout: 30_000 });
    assert.equal(enqueued.status, 0, enqueued.stdout + enqueued.stderr);
    const adopted = readFileSync(join(repo.root, "staged", "feature.yaml"), "utf8");
    assert.match(adopted, /- GATE: "printf adopted-gate"/);
    assert.match(adopted, /- REBASE_RESOLVER: "printf adopted-resolver"/);
    assert.match(adopted, /- REQUIRED_CHECK: "adopted-check"/);
    assert.ok(adopted.includes('- PRIMARY: "${A4S_PRIMARY}"'));
    assert.equal(adopted.includes(repo.primary), false);
    assert.match(adopted, /- BRANCH: dagu\/issue-\$\{ISSUE\}/);
    const promotion = extractScript(join(skillDir, "poc.yaml"), "  - id: dispose");
    const promotionRun = testRunId("promote-policy");
    const pocState = git(repo.primary, "rev-parse", "--path-format=absolute", "--git-path", `poc/runs/${promotionRun}`);
    mkdirSync(pocState, { recursive: true });
    const record = extractScript(join(skillDir, "poc.yaml"), "  - id: record");
    writeFileSync(join(pocState, "sections.jq"), record.split("<<'JQ'\n")[1]!.split("\nJQ")[0]!);
    for (const [file, value] of Object.entries({ "issue.number": "274", repo: "fixture/repo", verdict: "PASS", scope: "OK", created: "" })) writeFileSync(join(pocState, file), value);
    const result = `<!-- poc-verdict:PASS scope:OK run:${promotionRun} attempt:1 base:` + "1".repeat(40) + " -->\n" +
      ["Pregunta", "Proposición demostrada", "Ruta ejercitada", "Comandos y salida", "Después del PASS"].map(heading => `## ${heading}\npolicy proof\n`).join("\n");
    writeFileSync(join(repo.root, "issue.json"), JSON.stringify({ body: "## PoC\npolicy proof\n\n## Después del PASS\nversioned policy\n" }));
    writeFileSync(join(repo.root, "comments.json"), JSON.stringify([[{ body: result, html_url: "https://example.test/pass" }]]));
    const bin = join(repo.root, "promotion-bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), '#!/bin/sh\ncase "$1" in issue) cat "$POLICY_FIXTURE/issue.json";; api) cat "$POLICY_FIXTURE/comments.json";; *) exit 1;; esac\n');
    chmodSync(join(bin, "gh"), 0o755);
    writeFileSync(join(bin, "a4s-routing"), '#!/bin/sh\ntest "$1" = enqueue && test "$2" = --parent || exit 1\nshift 3\nexec dagu enqueue "$@"\n');
    chmodSync(join(bin, "a4s-routing"), 0o755);
    const adoptedDirectory = join(repo.primary, ".workspace", "dagu", "dags");
    mkdirSync(adoptedDirectory, { recursive: true });
    writeFileSync(join(adoptedDirectory, "feature.yaml"), adopted);
    const promoted = spawnSync("bash", ["-c", promotion], { encoding: "utf8", env: {
      ...env, A4S_BIN: join(bin, "a4s-routing"), RUN: promotionRun, PROMOTE: "yes", OMP_SESSION_ID: "owner-session",
      POLICY_FIXTURE: repo.root, PATH: `${bin}:${process.env.PATH}`,
    } });
    assert.equal(promoted.status, 0, promoted.stdout + promoted.stderr);
    const history = spawnSync("dagu", ["history", "feature", "--format", "json", "--status", "queued"], { encoding: "utf8", env });
    assert.equal(history.status, 0, history.stdout + history.stderr);
    const promotedRun = (JSON.parse(history.stdout) as Array<{ dagRunId: string; params: string }>).find(run => run.dagRunId === `feature-${promotionRun}`);
    assert.ok(promotedRun);
    assert.equal(promotedRun.params, "ISSUE=274 OMP_SESSION_ID=owner-session POC_BASIS=https://example.test/pass PR_NUMBER=");
  } finally {
    service.kill("SIGTERM");
    await new Promise<void>(resolve => {
      if (service.exitCode !== null || service.signalCode !== null) resolve();
      else service.once("exit", () => resolve());
    });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

for (const [dag, step, retry, action] of [
  ["feature", "conflict_review", "rebase", "complete"],
  ["feature", "conflict_review", "rebase", "rewind"],
  ["feature", "dependency_review", "checkpoint_push", "complete"],
  ["poc", "fix_result", "scope_gate", "rewind"],
] as const) {
  test(`${dag} ${step} ${action} diagnoses a rejected stale-process transition`, () => {
    const root = mkdtempSync(join(tmpdir(), "omp-dagu-stale-dispatch-"));
    try {
      const bin = join(root, "bin");
      mkdirSync(bin);
      writeFileSync(join(root, "conflict-action"), action);
      writeFileSync(join(root, "dependency-action"), action);
      writeFileSync(join(bin, "dagu"), `#!/usr/bin/env bash
if [[ "$1" == status ]]; then
  if [[ -f "$FIXTURE/rejected" ]]; then
    printf 'Failed - now\\n'
  else
    printf 'Waiting - now\\n'
  fi
else
  touch "$FIXTURE/rejected"
  echo 'retry target is no longer the latest attempt' >&2
  exit 1
fi
`);
      writeFileSync(join(bin, "curl"), '#!/usr/bin/env bash\nprintf \'%s\\n\' \'{"entries":[{"attemptId":"775836","type":"dag.run.failed","data":{"dag_run_status":{"error":"process terminated unexpectedly - stale local process detected"}}}]}\'\n');
      chmodSync(join(bin, "dagu"), 0o755);
      chmodSync(join(bin, "curl"), 0o755);
      const definition = fileURLToPath(new URL(`../../skills/issue-execution/${dag}.yaml`, import.meta.url));
      const wait = extractScript(definition, "  wait:");
      // Execute the exact detached dispatcher body synchronously to observe its exit.
      const dispatcher = wait.split("nohup bash -c '\n")[1]!.split(/\n\s+' _/)[0]!;
      const args = dag === "feature" ? [root, "stale-run", step, step.replace("_review", "").replace("_transition", "") + "-action"] : ["stale-run"];
      const result = spawnSync("bash", ["-c", dispatcher, "_", ...args], {
        encoding: "utf8", env: { ...process.env, FIXTURE: root, PATH: `${bin}:${process.env.PATH}` },
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /retry target is no longer the latest attempt/);
      assert.match(result.stderr, new RegExp(`run=stale-run attempt=775836 step=${step}`));
      assert.ok(result.stderr.includes(`dagu retry --run-id stale-run --step ${retry} --downstream ${dag}`));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("real Dagu automatically recovers a stale Failed feature in one reconcile tick", {
  ...liveDagu,
  timeout: 120_000,
}, async t => {
  const fixture = await recoveryFixture();
  const id = `stale-recovery-${fixture.suffix}`;
  const repo = repository(id);
  try {
    const file = join(fixture.home, "dags", "feature.yaml");
    const artifact = compiledArtifact(fixture.home);
    const binary = join(fixture.home, "cache", "a4s", artifact.version, "a4s");
    const admittedSpec = `name: feature\ntype: graph\nshell: bash\nenv:\n  - PRIMARY: ${JSON.stringify(repo.primary)}\n  - A4S_BIN: ${JSON.stringify(binary)}\nparams:\n  - RETAINED: original\nsteps:\n  - id: start_gate\n    run: echo retained-predecessor\n  - id: implement\n    depends: start_gate\n    action: human.task\n    with:\n      prompt: Recover this checkpoint in the same run\n`;
    writeFileSync(file, admittedSpec);
    writeFileSync(join(repo.state, "receipt.json"), JSON.stringify(roleAdmission(repo.primary, fixture.home, id, admittedSpec, artifact)));
    const started = spawnSync("dagu", ["start", "--run-id", id, file], { env: fixture.env, encoding: "utf8" });
    assert.equal(started.status, 0, started.stderr);
    await fixture.state(id, "waiting");
    const eventsDirectory = join(fixture.home, "logs", "admin", "events");
    const waitingEvent = await fixture.until("native Waiting admin event", async () =>
      readAdminEvents(eventsDirectory).find(event => event.dag_run_id === id && event.type === "dag.run.waiting"));
    assert.ok(waitingEvent.attempt_id);
    assert.ok(waitingEvent.source_instance);
    // Inject the scheduler repair snapshot in this isolated store. The race
    // itself is external; retry and checkpoint restoration use real Dagu.
    const store = join(fixture.home, "data", "dag-runs", "feature");
    const statusPath = readdirSync(store, { recursive: true }).map(String).find(path => path.endsWith("/status.jsonl"));
    assert.ok(statusPath);
    const statusFile = join(store, statusPath);
    const snapshot = JSON.parse(readFileSync(statusFile, "utf8").trim().split("\n").at(-1)!);
    snapshot.status = 2;
    snapshot.error = STALE_PROCESS_ERROR;
    for (const node of snapshot.nodes) if (node.status === 7 || node.status === 0) node.status = 2;
    appendFileSync(statusFile, JSON.stringify(snapshot) + "\n");
    // Only the external scheduler overwrite is injected. Detection, budgeting,
    // CLI retry and checkpoint restoration run through the real reconcile step.
    const failedAt = new Date().toISOString();
    appendFileSync(join(eventsDirectory, "stale-repair-fixture.jsonl"), JSON.stringify({
      ...waitingEvent, type: "dag.run.failed", occurred_at: failedAt, recorded_at: failedAt,
      source_service: "scheduler", source_instance: "isolated-scheduler:64722",
      data: { dag_run_status: { ...snapshot, error: STALE_PROCESS_ERROR } },
    }) + "\n");
    const status = spawnSync("dagu", ["status", "--run-id", id, "feature"], { env: fixture.env, encoding: "utf8" });
    assert.match(status.stdout, /^Failed -/);
    const response = await fetch(`http://127.0.0.1:${fixture.port}/api/v1/dag-runs/feature/${id}`);
    const before = (await response.json() as { dagRunDetails: LiveDetail }).dagRunDetails;
    assert.equal(before.statusLabel, "failed");
    assert.equal(before.dagRunId, id);
    const script = extractScript(fileURLToPath(new URL("../../skills/issue-execution/reconcile.yaml", import.meta.url)), "  - id: recover_stale");
    const tick = join(fixture.home, "dags", "recovery-tick.yaml");
    writeFileSync(tick, `name: recovery-tick\nshell: bash\nenv:\n  - A4S_BIN: ${JSON.stringify(binary)}\nsteps:\n  - id: recover_stale\n    run: |\n${script.split("\n").map(line => `      ${line}`).join("\n")}\n`);
    const retried = spawn("dagu", ["start", "--run-id", `tick-${fixture.suffix}`, tick], {
      env: fixture.env, stdio: ["ignore", "pipe", "pipe"],
    });
    let retryLog = "";
    retried.stdout.on("data", chunk => { retryLog += chunk; });
    retried.stderr.on("data", chunk => { retryLog += chunk; });
    const exited = new Promise<number | null>(resolve => {
      retried.once("exit", resolve);
    });
    const waiting = await fixture.until("same run returns to Waiting", async () => {
      if (retried.exitCode !== null) assert.equal(retried.exitCode, 0, retryLog);
      const response = await fetch(`http://127.0.0.1:${fixture.port}/api/v1/dag-runs/feature/${id}`);
      const run = (await response.json() as { dagRunDetails: LiveDetail }).dagRunDetails;
      return run.statusLabel === "waiting" ? run : undefined;
    });
    assert.equal(waiting.dagRunId, id);
    assert.equal(waiting.nodes.find(node => node.step.name === "implement")?.statusLabel, "waiting");
    assert.equal(await exited, 0);
    const ledger = JSON.parse(readFileSync(join(fixture.home, "stale-recovery.json"), "utf8"));
    assert.equal(ledger.recoveries.length, 1);
    assert.equal(ledger.recoveries[0].run, id);
    assert.equal(ledger.recoveries[0].attempt, waitingEvent.attempt_id);
    assert.equal(ledger.recoveries[0].step, "start_gate");
    const after = JSON.parse(readFileSync(statusFile, "utf8").trim().split("\n").at(-1)!);
    assert.deepEqual(after.params, snapshot.params);
    t.diagnostic(`Dagu ${liveDaguVersion}; one native reconcile recovery step; injected scheduler overwrite only; same run=${id}; attempt=${waitingEvent.attempt_id}; step=start_gate; restored implement=waiting; parameters preserved; retries=1`);
  } finally {
    await fixture.close();
    rmSync(repo.root, { recursive: true, force: true });
  }
});

type GateEvent = { kind: "START" | "END"; run: string; at: number; pid: number };

function gateExclusionFixture() {
  const first = repository();
  const firstRun = testRunId("gate-holder");
  const secondRun = testRunId("gate-waiter");
  const originalState = first.state;
  first.state = join(dirname(first.state), firstRun);
  renameSync(originalState, first.state);
  const second: Repository = {
    ...first, branch: "dagu/issue-190",
    worktree: join(first.primary, ".workspace", "worktrees", "issue-190"),
    state: join(dirname(first.state), secondRun),
  };
  git(first.primary, "worktree", "add", "-b", second.branch, second.worktree, "origin/main");
  mkdirSync(second.state);
  writeFileSync(join(second.state, "base"), git(second.worktree, "rev-parse", "HEAD"));
  recordCandidate(second);
  for (const [repo, run] of [[first, firstRun], [second, secondRun]] as const) {
    writeFileSync(join(repo.state, "receipt.json"), JSON.stringify(roleAdmission(repo.primary, join(first.root, "dagu-home"), run, readFileSync(definitions[0][1], "utf8"))));
  }
  const body = join(first.root, "gate-body.py");
  const eventsFile = join(first.root, "events.jsonl");
  writeFileSync(body, `
import json, os, pathlib, sys, time
root = pathlib.Path(__file__).parent
run = os.environ["RUN"]
def event(kind):
    row = {"kind": kind, "run": run, "at": time.time_ns(), "pid": os.getpid()}
    fd = os.open(root / "events.jsonl", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    os.write(fd, (json.dumps(row) + "\\n").encode())
    os.close(fd)
event("START")
release = root / ("release-" + run)
deadline = time.monotonic() + 45
while not release.exists():
    if time.monotonic() > deadline:
        sys.exit(90)
    time.sleep(0.02)
event("END")
sys.exit(int(release.read_text()))
`);
  const gate = `exec python3 ${JSON.stringify(body)}`;
  const events = (): GateEvent[] => existsSync(eventsFile)
    ? readFileSync(eventsFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as GateEvent) : [];
  const release = (run: string, code = 0) => writeFileSync(join(first.root, `release-${run}`), String(code));
  const lock = join(first.root, "dagu-home", "a4s", "heavy-slot.lock");
  return { first, second, firstRun, secondRun, gate, events, release, lock };
}

async function gateUntil<T>(description: string, probe: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = probe();
    if (result !== undefined) return result;
    await delay(25);
  }
  throw new Error(`Timed out: ${description}`);
}

type GateProcess = {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderr: () => string;
};

function gateProcess(script: string, repo: Repository, run: string, gate: string): GateProcess {
  let stderr = "";
  const child = spawn("bash", ["-c", script], {
    env: { ...featureScriptEnv(repo), RUN: run, GATE: gate },
    cwd: repo.root, detached: true, stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", data => { stderr += data; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, exited, stderr: () => stderr };
}

function assertGateWindows(events: GateEvent[], holder: string, waiter: string, killedAt?: number) {
  const holderStart = events.find(event => event.run === holder && event.kind === "START")!;
  const holderEnd = events.find(event => event.run === holder && event.kind === "END");
  const waiterStart = events.find(event => event.run === waiter && event.kind === "START")!;
  const waiterEnd = events.find(event => event.run === waiter && event.kind === "END")!;
  assert.ok(holderStart && waiterStart && waiterEnd, JSON.stringify(events));
  const end = holderEnd?.at ?? killedAt;
  assert.ok(end !== undefined && waiterStart.at >= end, JSON.stringify(events));
  assert.ok(waiterEnd.at >= waiterStart.at);
}

for (const outcome of ["success", "failure", "cancellation", "SIGKILL", "surviving descendant"] as const) {
  test(`template gate bodies serialize and release after ${outcome}`, { timeout: 30_000 }, async () => {
    const fixture = gateExclusionFixture();
    const { first, second, firstRun, secondRun, gate, events, release, lock } = fixture;
    const script = extractScript(definitions[0][1], "  - id: gate");
    const holder = gateProcess(script, first, firstRun, gate);
    let waiter: GateProcess | undefined;
    try {
      await gateUntil("holder body starts", () => events().find(event => event.run === firstRun));
      const owner = JSON.parse(readFileSync(lock, "utf8")) as { run: string; pid: number };
      assert.equal(owner.run, firstRun);
      assert.equal(owner.pid, holder.child.pid);
      waiter = gateProcess(script, second, secondRun, gate);
      await gateUntil("waiter logs holder", () => waiter!.stderr().includes(`"run": "${firstRun}"`) && waiter!.stderr().includes("gate: waiting") ? true : undefined);
      assert.match(waiter.stderr(), new RegExp(`"pid": ${owner.pid}`));
      assert.equal(events().filter(event => event.run === secondRun).length, 0);
      const candidate = readFileSync(join(second.state, "candidate.json"), "utf8");
      let killedAt: number | undefined;
      if (outcome === "SIGKILL" || outcome === "cancellation") {
        killedAt = Date.now() * 1_000_000;
        process.kill(-owner.pid, outcome === "SIGKILL" ? "SIGKILL" : "SIGTERM");
      } else if (outcome === "surviving descendant") {
        process.kill(owner.pid, "SIGKILL");
        await holder.exited;
        await delay(200);
        assert.equal(events().filter(event => event.run === secondRun).length, 0);
        release(firstRun);
      } else {
        release(firstRun, outcome === "failure" ? 17 : 0);
      }
      const holderResult = await holder.exited;
      if (outcome === "failure") assert.equal(holderResult.code, 17);
      else if (outcome === "success") assert.equal(holderResult.code, 0, holder.stderr());
      else assert.equal(holderResult.signal, outcome === "cancellation" ? "SIGTERM" : "SIGKILL");
      await gateUntil("waiter body starts", () => events().find(event => event.run === secondRun));
      release(secondRun);
      assert.equal((await waiter.exited).code, 0, waiter.stderr());
      assertGateWindows(events(), firstRun, secondRun, killedAt);
      assert.equal(readFileSync(join(second.state, "candidate.json"), "utf8"), candidate);
      assert.equal(JSON.parse(readFileSync(join(second.state, "gate.json"), "utf8")).sha, git(second.worktree, "rev-parse", "HEAD"));
    } finally {
      for (const process of [holder, waiter]) {
        if (process?.child.pid) {
          try { globalThis.process.kill(-process.child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
          await process.exited;
        }
      }
      rmSync(first.root, { recursive: true, force: true });
    }
  });
}

test("real Dagu gate exclusion covers completion, retry, native rewind, BEHIND and holder death", {
  ...liveDagu, timeout: 240_000,
}, async (t) => {
  const queueConfig = "queues:\n  enabled: true\n  config:\n    - name: a4s\n      max_concurrency: 8\n";
  const runtime = await recoveryFixture(queueConfig);
  const source = readFileSync(definitions[0][1], "utf8");
  const dag = join(runtime.home, "dags", "feature.yaml");
  const command = (...args: string[]) => execFileSync("dagu", args, { env: runtime.env, encoding: "utf8", timeout: 10_000 });
  const detail = async (run: string): Promise<LiveDetail | undefined> => {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/api/v1/dag-runs/feature/${run}`);
    return response.ok ? (await response.json() as { dagRunDetails: LiveDetail }).dagRunDetails : undefined;
  };
  try {
    for (const entry of ["completion", "retry", "native rewind", "BEHIND", "holder death", "failure", "cancellation"] as const) {
      const { first, second, firstRun, secondRun, gate, events, release, lock } = gateExclusionFixture();
      let retry: ChildProcess | undefined;
      let retryExit: Promise<number | null> | undefined;
      try {
        const vars = { A4S_BIN: a4sBin, PRIMARY: first.primary, WORKTREE: "${TREE}", BRANCH: "${FEATURE_BRANCH}", RUN: "${context.run.id}", GATE: gate, PATH: process.env.PATH, DAGU_HOME: join(first.root, "dagu-home"), A4S_HEAVY_SLOT_HELD: "" };
        writeFileSync(dag, "type: graph\nshell: bash\nqueue: a4s\nparams:\n  - TREE: ''\n  - FEATURE_BRANCH: ''\n  - CHECKPOINT: ''\nenv:\n"
          + Object.entries(vars).map(([key, value]) => `  - ${key}: ${JSON.stringify(value)}\n`).join("")
          + "steps:\n  - id: admission\n    action: human.task\n    with:\n      prompt: Admit disposable gate candidate\n"
          + "  - id: rebase\n    depends: admission\n    run: echo rebase\n  - id: conflict_review\n    depends: rebase\n    run: echo clean\n"
          + extractStep(source, "gate").replace(/depends: conflict_review(?:_cancellation)?/, "depends: conflict_review")
          + "  - id: rewind\n    depends: gate\n    preconditions:\n      - condition: '${CHECKPOINT}'\n        expected: rewind\n    action: human.task\n    with:\n      prompt: Disposable native rebase rewind\n      push_back:\n        rewind_to: rebase\n"
          + extractStep(source, "await_merge").replace("depends: auto_merge", "depends: gate")
            .replace("rewind_to: rebase_budget", "rewind_to: rebase")
            .replace("    action: human.task", "    preconditions:\n      - condition: '${CHECKPOINT}'\n        expected: merge\n    action: human.task"));
        command("validate", dag);
        const checkpoint = entry === "native rewind" ? "rewind" : entry === "BEHIND" ? "merge" : "";
        for (const [repo, run] of [[first, firstRun], [second, secondRun]] as const) {
          command("enqueue", "--run-id", run, dag, "--", `TREE=${repo.worktree}`, `FEATURE_BRANCH=${repo.branch}`, `CHECKPOINT=${run === secondRun ? checkpoint : ""}`);
          await runtime.state(run, "waiting");
        }
        const complete = (run: string) => command("human-task", "complete", "feature", "--run-id", run, "--step", "admission");
        const repeated = ["retry", "native rewind", "BEHIND"].includes(entry);
        if (repeated) {
          release(secondRun);
          complete(secondRun);
          await runtime.state(secondRun, checkpoint ? "waiting" : "succeeded");
          rmSync(join(first.root, `release-${secondRun}`));
        }
        const baseline = events().length;
        complete(firstRun);
        await runtime.until("holder body starts", async () => events().slice(baseline).find(event => event.run === firstRun));
        const owner = JSON.parse(readFileSync(lock, "utf8")) as { pid: number; run: string };
        assert.equal(owner.run, firstRun);
        const candidate = readFileSync(join(second.state, "candidate.json"), "utf8");
        if (entry === "retry") {
          retry = spawn("dagu", ["retry", "--run-id", secondRun, "--step", "rebase", "--downstream", "feature"], { env: runtime.env, stdio: ["ignore", "pipe", "pipe"] });
          let retryLog = "";
          retry.stdout!.on("data", chunk => { retryLog += chunk; });
          retry.stderr!.on("data", chunk => { retryLog += chunk; });
          retry.once("exit", code => { if (code !== 0) t.diagnostic(`dagu retry exit=${code}: ${retryLog}`); });
          retryExit = new Promise(resolve => retry!.once("exit", resolve));
        } else if (checkpoint) {
          command("human-task", "push-back", "feature", "--run-id", secondRun, "--step", checkpoint === "merge" ? "await_merge" : "rewind",
            "--expected-iteration", "0");
        } else complete(secondRun);
        const waiting = await runtime.until("waiter Running with holder diagnostics", async () => {
          const run = await detail(secondRun);
          const step = run?.nodes.find(node => node.step.name === "gate");
          if (step?.statusLabel !== "running" || !step.stderr || !existsSync(step.stderr)) return undefined;
          const log = readFileSync(step.stderr, "utf8");
          return log.includes("gate: waiting") && log.includes(`"run": "${firstRun}"`) && log.includes(`"pid": ${owner.pid}`) ? run : undefined;
        });
        assert.equal(waiting.dagRunId, secondRun);
        assert.equal(events().slice(baseline).filter(event => event.run === secondRun).length, 0);
        // An unrelated run uses the same eight-slot queue while both gates are Running.
        const controlRun = testRunId("gate-control");
        const control = join(runtime.home, "dags", "control.yaml");
        writeFileSync(control, "queue: a4s\nsteps:\n  - id: control\n    run: echo independent\n  - id: push_like\n    depends: control\n    run: echo progressed\n");
        command("enqueue", "--run-id", controlRun, control);
        await runtime.until("unrelated queue progress", async () => {
          const response = await fetch(`http://127.0.0.1:${runtime.port}/api/v1/dag-runs/control/${controlRun}`);
          return response.ok && (await response.json() as { dagRunDetails: { statusLabel: string } }).dagRunDetails.statusLabel === "succeeded" ? true : undefined;
        });
        assert.equal(events().slice(baseline).filter(event => event.run === secondRun).length, 0);
        let killedAt: number | undefined;
        if (entry === "holder death") {
          killedAt = Date.now() * 1_000_000;
          // Make the native automatic retry short; the killed attempt has no END.
          process.kill(-owner.pid, "SIGKILL");
          release(firstRun);
        } else if (entry === "cancellation") {
          killedAt = Date.now() * 1_000_000;
          command("stop", "--run-id", firstRun, "feature");
        } else release(firstRun, entry === "failure" ? 17 : 0);
        await runtime.until("waiter enters after release", async () => events().slice(baseline).find(event => event.run === secondRun));
        release(secondRun);
        await runtime.state(secondRun, checkpoint ? "waiting" : "succeeded");
        if (retryExit) assert.equal(await retryExit, 0);
        const holderResult = await runtime.until("holder gate and run terminal", async () => {
          const run = await detail(firstRun);
          const status = run?.nodes.find(node => node.step.name === "gate")?.statusLabel;
          const expected = entry === "failure" ? ["failed"] : entry === "cancellation" ? ["aborted", "canceled", "cancelled"] : ["succeeded"];
          const terminal = ["succeeded", "partially_succeeded", "failed", "aborted"];
          return run && status && expected.includes(status) && terminal.includes(run.statusLabel) ? run : undefined;
        });
        const window = events().slice(baseline);
        if (entry === "failure" || entry === "holder death") {
          assert.equal(window.filter(event => event.run === firstRun && event.kind === "START").length, 2, JSON.stringify(window));
        }
        // The native retry after SIGKILL may start after the waiter; compare the killed attempt.
        const firstEnd = window.findIndex(event => event.run === firstRun && event.kind === "END");
        const killedWindow = entry === "holder death" && firstEnd >= 0
          ? window.filter((event, index) => event.run !== firstRun || index === 0) : window;
        assertGateWindows(killedWindow, firstRun, secondRun, killedAt);
        assert.equal(readFileSync(join(second.state, "candidate.json"), "utf8"), candidate);
        const timing: GateEvidence = JSON.parse(readFileSync(join(second.state, "gate.json"), "utf8"));
        assert.equal(timing.sha, git(second.worktree, "rev-parse", "HEAD"));
        const wait = timing.attempts.at(-1)!.phases.find(phase => phase.name === "lock_wait")!;
        const releaseAt = killedAt ?? window.find(event => event.run === firstRun && event.kind === "END")!.at;
        assert.ok(wait.startedAt <= releaseAt / 1_000_000);
        assert.ok(wait.endedAt >= Math.floor(releaseAt / 1_000_000));
        assert.ok(wait.durationMs > 0);
        assert.ok(readFileSync(join(runtime.home, "config.yaml"), "utf8").endsWith(queueConfig));
        t.diagnostic(`Dagu ${liveDaguVersion}; entry=${entry}; holder=${firstRun}/${holderResult.statusLabel}; waiter=${secondRun}; queue=a4s/8; independent=${controlRun}; windows=${JSON.stringify(window)}`);
      } finally {
        for (const run of [firstRun, secondRun]) {
          const current = await detail(run);
          if (current && ["running", "queued"].includes(current.statusLabel)) {
            command("stop", "--run-id", run, "feature");
            await runtime.until(`${run} stopped before fixture removal`, async () => {
              const stopped = await detail(run);
              return stopped && ["succeeded", "partially_succeeded", "failed", "aborted", "canceled"].includes(stopped.statusLabel) ? stopped : undefined;
            });
          }
        }
        if (retry && retry.exitCode === null && retry.signalCode === null) {
          retry.kill("SIGTERM");
          await retryExit;
        }
        rmSync(first.root, { recursive: true, force: true });
      }
    }
  } finally { await runtime.close(); }
});

type GatePhase = { name: string; workspace?: string; startedAt: number; endedAt: number; exitCode: number; durationMs: number };
type GateAttempt = { id: string; iteration: number; startedAt: number; endedAt: number; exitCode: number; result: string; durationMs: number; phases: GatePhase[] };
type GateEvidence = { schemaVersion: number; sha: string; gate: string; result: string; attempts: GateAttempt[] };

function timedNpmGate(repo: Repository): string {
  const failOnce = join(repo.root, "fail-once");
  writeFileSync(failOnce, "");
  writeFileSync(join(repo.worktree, "package.json"), JSON.stringify({
    name: "gate-fixture", private: true, workspaces: ["packages/*"],
    scripts: { test: "npm test --workspaces", typecheck: "npm run typecheck --workspaces" },
  }));
  writeFileSync(join(repo.worktree, ".gitignore"), "node_modules/\n");
  for (const workspace of ["first", "second"]) {
    const fail = workspace === "second"
      ? `const fs=require('node:fs');if(fs.existsSync(${JSON.stringify(failOnce)})){fs.unlinkSync(${JSON.stringify(failOnce)});process.exit(17)}`
      : "";
    writeFileSync(join(repo.worktree, "packages", workspace, "package.json"), JSON.stringify({
      name: workspace, version: "1.0.0",
      scripts: {
        test: `node -e ${JSON.stringify(fail || "process.exit(0)")}`,
        typecheck: "tsc --noEmit --allowJs check.js",
      },
    }));
    writeFileSync(join(repo.worktree, "packages", workspace, "check.js"), "const value = 1;\n");
  }
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: repo.worktree, env: { ...process.env, A4S_GATE_JOURNAL: "" }, stdio: "pipe",
  });
  git(repo.worktree, "add", ".");
  git(repo.worktree, "commit", "-m", "test: real npm gate phases");
  recordCandidate(repo);
  return "npm ci --ignore-scripts --no-audit --no-fund && npm test && npm run typecheck";
}

function assertTimedAttempt(attempt: GateAttempt, exitCode: number): void {
  assert.equal(attempt.exitCode, exitCode);
  assert.equal(attempt.result, exitCode === 0 ? "PASS" : "FAIL");
  assert.equal(attempt.durationMs, attempt.endedAt - attempt.startedAt);
  let cursor = attempt.startedAt;
  for (const phase of attempt.phases) {
    assert.ok(phase.startedAt >= cursor, JSON.stringify(attempt));
    assert.ok(phase.endedAt >= phase.startedAt && phase.endedAt <= attempt.endedAt, JSON.stringify(phase));
    assert.equal(phase.durationMs, phase.endedAt - phase.startedAt);
    cursor = phase.endedAt;
  }
  assert.equal(cursor, attempt.endedAt);
  assert.ok(attempt.phases.some(phase => phase.name === "lock_wait"));
  assert.ok(attempt.phases.some(phase => phase.name === "install"));
  assert.deepEqual(attempt.phases.filter(phase => phase.name === "tests").map(phase => phase.workspace),
    ["packages/first", "packages/second"]);
}

for (const [name, definition] of definitions) {
  test(`${name} gate records failed phases and preserves a second passing attempt`, { timeout: 30_000 }, () => {
    const repo = repository();
    try {
      const gate = timedNpmGate(repo);
      const script = extractScript(definition, "  - id: gate");
      const env = { ...featureScriptEnv(repo), GATE: gate };
      const failed = spawnSync("bash", ["-c", script], { env, encoding: "utf8" });
      // npm translates a lifecycle script's 17 into its own nonzero status.
      assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
      const first: GateEvidence = JSON.parse(readFileSync(join(repo.state, "gate.json"), "utf8"));
      assert.equal(first.schemaVersion, 1);
      assert.equal(first.result, "FAIL");
      assert.equal(first.gate, gate);
      assert.equal(first.attempts.length, 1);
      assertTimedAttempt(first.attempts[0]!, failed.status!);
      assert.equal(first.attempts[0]!.phases.find(phase => phase.name === "tests" && phase.workspace === "packages/second")?.exitCode, 17);
      assert.ok(first.attempts[0]!.phases.every(phase => phase.name !== "typecheck" && phase.name !== "post_checks"));
      const passed = spawnSync("bash", ["-c", script], { env, encoding: "utf8" });
      assert.equal(passed.status, 0, passed.stdout + passed.stderr);
      const evidence: GateEvidence = JSON.parse(readFileSync(join(repo.state, "gate.json"), "utf8"));
      assert.equal(evidence.attempts.length, 2);
      assert.deepEqual(evidence.attempts[0], first.attempts[0]);
      assert.notEqual(evidence.attempts[0]!.id, evidence.attempts[1]!.id);
      const attempt = evidence.attempts[1]!;
      assertTimedAttempt(attempt, 0);
      assert.deepEqual(attempt.phases.filter(phase => phase.name === "typecheck").map(phase => phase.workspace),
        ["packages/first", "packages/second"]);
      assert.ok(attempt.phases.some(phase => phase.name === "post_checks"));
      assert.ok(attempt.phases.every(phase => phase.exitCode === 0));
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });
}

test("real Dagu gate timing retains failed automatic retry and every npm phase inside the step window", {
  ...liveDagu, timeout: 60_000,
}, async (t) => {
  const runtime = await recoveryFixture();
  const id = testRunId("gate-timing");
  const repo = repository(id);
  try {
    const gate = timedNpmGate(repo);
    const variables = { ...featureScriptEnv(repo), RUN: id, GATE: gate };
    const step = extractStep(readFileSync(definitions[0][1], "utf8"), "gate")
      .replace("    depends: conflict_review_cancellation\n", "");
    const dag = join(runtime.home, "dags", "feature.yaml");
    writeFileSync(dag, "type: graph\nshell: bash\nenv:\n"
      + Object.entries(variables).filter(([, value]) => value !== undefined).map(([key, value]) => `  - ${key}: ${JSON.stringify(value)}\n`).join("")
      + "steps:\n" + step);
    const start = Date.now();
    execFileSync("dagu", ["enqueue", "--run-id", id, dag], { env: runtime.env, stdio: "pipe" });
    await runtime.state(id, "succeeded");
    const end = Date.now();
    const evidence: GateEvidence = JSON.parse(readFileSync(join(repo.state, "gate.json"), "utf8"));
    assert.equal(evidence.attempts.length, 2);
    assert.equal(evidence.result, "PASS");
    for (const [index, attempt] of evidence.attempts.entries()) {
      assertTimedAttempt(attempt, index === 0 ? attempt.exitCode : 0);
      assert.equal(attempt.iteration, 0);
      assert.ok(attempt.startedAt >= start && attempt.endedAt <= end);
    }
    assert.notEqual(evidence.attempts[0]!.exitCode, 0);
    assert.equal(evidence.attempts[0]!.phases.find(phase => phase.name === "tests" && phase.workspace === "packages/second")?.exitCode, 17);
    assert.deepEqual(evidence.attempts[1]!.phases.filter(phase => phase.name === "typecheck").map(phase => phase.workspace),
      ["packages/first", "packages/second"]);
    t.diagnostic(`Dagu ${liveDaguVersion}; run=${id}; gate.json=${JSON.stringify(evidence)}`);
  } finally {
    await runtime.close();
    rmSync(repo.root, { recursive: true, force: true });
  }
});

function featureOwnership(repo: Repository): string[] {
  const resources = join(repo.primary, ".git", "dagu-feature", "resources");
  return [
    join(repo.state, "identity"),
    join(repo.state, "resource.json"),
    join(repo.state, "candidate.json"),
    join(repo.state, "base"),
    join(repo.state, "tested-sha"),
    join(repo.state, "codeql-observation.json"),
    join(repo.primary, ".git", "worktrees", "issue-189", "dagu-feature-owner"),
    ...readdirSync(resources).map(name => join(resources, name)),
  ];
}

test("seeded feature repository matches a fresh fixture and stays isolated", () => {
  const fresh = materializeFeature("test-run", true);
  const copy = repository();
  const other = repository("feature-isolated");
  const again = repository();
  const view = (repo: Repository, run: string) => normalizedFixtureSnapshot({
    root: repo.root,
    primary: repo.primary,
    worktree: repo.worktree,
    remote: join(repo.root, "remote.git"),
    ownership: featureOwnership(repo),
  }, [[run, "$RUN"]]);
  try {
    const baseline = view(fresh, "test-run");
    assert.equal(view(copy, "test-run"), baseline);
    assert.equal(view(other, "feature-isolated"), baseline);
    assert.equal(view(again, "test-run"), baseline);
    assert.equal(git(copy.primary, "config", "--get", "remote.origin.url"), join(copy.root, "remote.git"));
    assert.equal(readlinkSync(join(copy.root, "bin", "a4s")), readlinkSync(join(fresh.root, "bin", "a4s")));
    assert.notEqual(copy.root, other.root);
    commit(copy, "README.txt", "mutated\n");
    git(copy.primary, "config", "user.name", "Mutated Observer");
    git(copy.worktree, "push", "origin", "HEAD:refs/heads/mutated-copy");
    writeFileSync(join(copy.state, "resource.json"), "{\"run\":\"mutated\"}\n");
    assert.equal(view(other, "feature-isolated"), baseline);
    assert.equal(view(again, "test-run"), baseline);
    assert.notEqual(view(copy, "test-run"), baseline);
    assert.equal(readFileSync(join(other.worktree, "README.txt"), "utf8"), "base\n");
    assert.equal(git(other.primary, "ls-remote", "origin", "refs/heads/mutated-copy"), "");
  } finally {
    for (const repo of [fresh, copy, other, again]) rmSync(repo.root, { recursive: true, force: true });
  }
});

type CacheGatePhase = GatePhase & { cache?: string; classification?: string; reason?: string; cacheKey?: string };

function writeGateCachePackage(root: string, directory: string, manifest: unknown, files: Record<string, string>): void {
  const packageDir = join(root, directory);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [name, text] of Object.entries(files)) {
    const target = join(packageDir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
}

function writeGateCacheFixture(worktree: string): void {
  rmSync(join(worktree, "packages", "first"), { recursive: true, force: true });
  rmSync(join(worktree, "packages", "second"), { recursive: true, force: true });
  writeGateCachePackage(worktree, ".", {
    name: "gate-cache-fixture", private: true, workspaces: ["packages/*"],
    scripts: { test: "npm test --workspaces --if-present", typecheck: "npm run typecheck --workspaces --if-present" },
  }, { ".gitignore": "node_modules/\n" });
  writeFileSync(join(worktree, "package-lock.json"), `${JSON.stringify({ name: "gate-cache-fixture", lockfileVersion: 3, packages: {} }, null, 2)}\n`);
  mkdirSync(join(worktree, "scripts"), { recursive: true });
  writeFileSync(join(worktree, "scripts", "gate-asset.txt"), "asset\n");
  writeGateCachePackage(worktree, "packages/lib", {
    name: "lib", version: "1.0.0",
    scripts: { test: "node --test test/*.test.js", typecheck: "node --check src/lib.js" },
  }, {
    "tsconfig.json": `${JSON.stringify({ include: ["src/**/*.js", "test/**/*.js"] })}\n`,
    "src/lib.js": "module.exports = { value: 1 };\n",
    "test/lib.test.js": "const test = require('node:test');\nconst lib = require('../src/lib.js');\ntest('value', () => { if (lib.value !== 1) throw new Error('value'); });\n",
    "test/git-state.test.js": readFileSync(new URL("../fixtures/gate-cache-git-state.js", import.meta.url), "utf8"),
  });
  writeGateCachePackage(worktree, "packages/app", {
    name: "app", version: "1.0.0", dependencies: { lib: "1.0.0" },
    scripts: { test: "node --test test/app.test.js", typecheck: "node --check src/app.js" },
  }, {
    "tsconfig.json": `${JSON.stringify({ include: ["src/**/*.js"] })}\n`,
    "src/app.js": "module.exports = { name: 'app' };\n",
    "test/app.test.js": [
      "const test = require('node:test');",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "test('reads the shared asset and probe', () => {",
      "  const asset = fs.readFileSync(path.join(__dirname, '../../../scripts/gate-asset.txt'), 'utf8');",
      "  if (!asset || !process.env.A4S_CACHE_PROBE) throw new Error('asset');",
      "  void process.env.ORCA_SESSION;",
      "  void process.env.PI_CODING_AGENT_DIR;",
      "});",
      "",
    ].join("\n"),
  });
  writeGateCachePackage(worktree, "packages/other", {
    name: "other", version: "1.0.0",
    scripts: { test: "node --test test/other.test.js", typecheck: "node --check src/other.js" },
  }, {
    "tsconfig.json": `${JSON.stringify({ include: ["src/**/*.js"] })}\n`,
    "src/other.js": "module.exports = { name: 'other' };\n",
    "test/other.test.js": "const test = require('node:test');\ntest('stable', () => {});\n",
  });
}

test("gate cache reuses passes across linked worktrees and invalidates each input class", { timeout: 180_000 }, () => {
  const repo = repository("gate-cache-a");
  const requireCache = createRequire(import.meta.url);
  const { lookup, cacheDirectory } = requireCache("../../bin/gate-cache.cjs") as {
    lookup: (cacheDir: string, key: string) => { result?: string } | undefined;
    cacheDirectory: (worktree: string) => string;
  };
  try {
    writeGateCacheFixture(repo.worktree);
    git(repo.worktree, "add", "-A");
    git(repo.worktree, "commit", "-m", "test: gate cache fixture");
    recordCandidate(repo);
    const baseSha = git(repo.worktree, "rev-parse", "HEAD");
    const script = extractScript(definitions[0]![1], "  - id: gate");
    const gateEnv = {
      ...featureScriptEnv(repo),
      GATE: "npm test && npm run typecheck",
      A4S_CACHE_PROBE: "one",
      ORCA_SESSION: "agent-a",
      PI_CODING_AGENT_DIR: "/tmp/agent-a",
      npm_config_package_lock: "false",
      npm_config_update_notifier: "false",
      npm_config_fund: "false",
      npm_config_audit: "false",
    };
    const restoreBase = (): void => {
      git(repo.worktree, "reset", "--hard", baseSha);
      recordCandidate(repo);
    };
    const commitChange = (message: string): void => {
      git(repo.worktree, "add", "-A");
      git(repo.worktree, "commit", "-m", message);
      recordCandidate(repo);
    };
    const run = (env: NodeJS.ProcessEnv) => spawnSync("bash", ["-c", script], { env, encoding: "utf8" });
    const leaves = (state: string): CacheGatePhase[] => {
      const evidence: GateEvidence = JSON.parse(readFileSync(join(state, "gate.json"), "utf8"));
      return evidence.attempts.at(-1)!.phases.filter(phase => phase.workspace?.startsWith("packages/")) as CacheGatePhase[];
    };
    const task = (phases: CacheGatePhase[], workspace: string, name: string, classification = "cached"): CacheGatePhase => {
      const found = phases.find(phase => phase.workspace === workspace && phase.name === name && phase.classification === classification);
      assert.ok(found, phases.map(phase => `${phase.workspace} ${phase.name} ${phase.classification ?? "-"} ${phase.cache ?? "-"} ${phase.exitCode}`).join("\n"));
      return found;
    };
    const assertStatus = (phases: CacheGatePhase[], expected: Array<[string, string, string, string]>): void => {
      for (const [workspace, name, classification, cache] of expected) {
        const found = task(phases, workspace, name, classification);
        assert.equal(found.cache, cache, `${workspace} ${name} ${classification}`);
        assert.equal(found.exitCode, 0, found.reason ?? "");
      }
    };
    const cachedTasks: Array<[string, string, string]> = [
      ["packages/lib", "tests", "cached"],
      ["packages/lib", "typecheck", "cached"],
      ["packages/app", "tests", "cached"],
      ["packages/app", "typecheck", "cached"],
      ["packages/other", "tests", "cached"],
      ["packages/other", "typecheck", "cached"],
    ];
    const coldExpected: Array<[string, string, string, string]> = [
      ...cachedTasks.map(([workspace, name, classification]) => [workspace, name, classification, "miss"] as [string, string, string, string]),
      ["packages/lib", "tests", "always", "executed"],
    ];
    const cold = run(gateEnv);
    assert.equal(cold.status, 0, cold.stdout + cold.stderr);
    assert.match(cold.stdout, /tested_sha=/);
    const coldPhases = leaves(repo.state);
    assertStatus(coldPhases, coldExpected);
    assert.match(task(coldPhases, "packages/lib", "tests", "always").reason ?? "", /git-state/);
    assert.equal(JSON.parse(readFileSync(join(cacheDirectory(repo.worktree), "config.json"), "utf8")).remote, false);
    const stored = task(coldPhases, "packages/app", "tests").cacheKey!;
    assert.equal(lookup(cacheDirectory(repo.worktree), stored)?.result, "PASS");

    const other = join(repo.primary, ".workspace", "worktrees", "issue-190");
    git(repo.primary, "worktree", "add", "-b", "dagu/issue-190", other, baseSha);
    const secondState = join(repo.primary, ".git", "dagu-feature", "runs", "gate-cache-b");
    mkdirSync(secondState, { recursive: true });
    writeFileSync(join(secondState, "candidate.json"), readFileSync(join(repo.state, "candidate.json")));
    const warm = run({
      ...gateEnv, WORKTREE: other, BRANCH: "dagu/issue-190", RUN: "gate-cache-b",
      ORCA_SESSION: "agent-b", PI_CODING_AGENT_DIR: "/tmp/agent-b",
    });
    assert.equal(warm.status, 0, warm.stdout + warm.stderr);
    const warmPhases = leaves(secondState);
    assertStatus(warmPhases, cachedTasks.map(([workspace, name, classification]) => [workspace, name, classification, "hit"] as [string, string, string, string]).concat([["packages/lib", "tests", "always", "executed"]]));
    for (const [workspace, name, classification] of cachedTasks) {
      assert.equal(task(warmPhases, workspace, name, classification).cacheKey, task(coldPhases, workspace, name, classification).cacheKey);
    }

    const expectMisses = (misses: Array<[string, string, string]>): void => {
      const result = run(gateEnv);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const phases = leaves(repo.state);
      assertStatus(phases, cachedTasks.map(([workspace, name, classification]) => {
        const miss = misses.some(([itemWorkspace, itemName, itemClassification]) => itemWorkspace === workspace && itemName === name && itemClassification === classification);
        return [workspace, name, classification, miss ? "miss" : "hit"] as [string, string, string, string];
      }).concat([["packages/lib", "tests", "always", "executed"]]));
      restoreBase();
    };
    writeFileSync(join(repo.worktree, "packages/lib/src/lib.js"), "module.exports = { value: 1 };\n// source revision\n");
    commitChange("test: source revision");
    expectMisses([["packages/lib", "tests", "cached"], ["packages/lib", "typecheck", "cached"], ["packages/app", "tests", "cached"], ["packages/app", "typecheck", "cached"]]);
    writeFileSync(join(repo.worktree, "packages/lib/test/lib.test.js"), `${readFileSync(join(repo.worktree, "packages/lib/test/lib.test.js"), "utf8")}// test revision\n`);
    commitChange("test: test revision");
    expectMisses([["packages/lib", "tests", "cached"], ["packages/lib", "typecheck", "cached"]]);
    writeFileSync(join(repo.worktree, "package-lock.json"), `${readFileSync(join(repo.worktree, "package-lock.json"), "utf8")}\n`);
    commitChange("test: lockfile revision");
    expectMisses(cachedTasks);
    const appManifest = join(repo.worktree, "packages/app/package.json");
    writeFileSync(appManifest, readFileSync(appManifest, "utf8").replace('"lib": "1.0.0"', '"lib": "1.0.1"'));
    commitChange("test: dependency revision");
    expectMisses([["packages/app", "tests", "cached"], ["packages/app", "typecheck", "cached"]]);
    writeFileSync(join(repo.worktree, "scripts/gate-asset.txt"), "changed\n");
    commitChange("test: root asset revision");
    expectMisses([["packages/app", "tests", "cached"]]);
    const probe = run({ ...gateEnv, A4S_CACHE_PROBE: "two" });
    assert.equal(probe.status, 0, probe.stdout + probe.stderr);
    assertStatus(leaves(repo.state), cachedTasks.map(([workspace, name, classification]) => [workspace, name, classification, workspace === "packages/app" && name === "tests" ? "miss" : "hit"] as [string, string, string, string]).concat([["packages/lib", "tests", "always", "executed"]]));
    const tool = run({ ...gateEnv, A4S_GATE_CACHE_TOOL: "v2" });
    assert.equal(tool.status, 0, tool.stdout + tool.stderr);
    assertStatus(leaves(repo.state), coldExpected);

    const failingTest = join(repo.worktree, "packages/app/test/app.test.js");
    writeFileSync(failingTest, "const test = require('node:test');\ntest('fails closed', () => { throw new Error('gate cache failure'); });\n");
    commitChange("test: failing app check");
    for (const attempt of [1, 2]) {
      const failed = run(gateEnv);
      assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
      const failedTask = task(leaves(repo.state), "packages/app", "tests");
      assert.equal(failedTask.cache, "miss", `attempt ${attempt}`);
      assert.notEqual(failedTask.exitCode, 0);
      assert.equal(lookup(cacheDirectory(repo.worktree), failedTask.cacheKey!), undefined);
    }
    writeFileSync(failingTest, `${readFileSync(join(repo.worktree, "packages/app/test/app.test.js"), "utf8").replace("throw new Error('gate cache failure');", "if (!process.env.A4S_CACHE_PROBE) throw new Error('probe');")}// corrected\n`);
    commitChange("test: corrected app check");
    const corrected = run(gateEnv);
    assert.equal(corrected.status, 0, corrected.stdout + corrected.stderr);
    const correctedTask = task(leaves(repo.state), "packages/app", "tests");
    assert.equal(correctedTask.cache, "miss");
    assert.equal(lookup(cacheDirectory(repo.worktree), correctedTask.cacheKey!)?.result, "PASS");
    const reused = run(gateEnv);
    assert.equal(reused.status, 0, reused.stdout + reused.stderr);
    assert.equal(task(leaves(repo.state), "packages/app", "tests").cache, "hit");
    assert.equal(task(leaves(repo.state), "packages/lib", "tests", "always").cache, "executed");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("applied render real push lease rejection reaches stderr and the owner notice", { ...liveDagu, timeout: 60_000 }, async () => {
  const fixture = await recoveryFixture();
  const repo = repository(testRunId("diagnostic-push"));
  try {
    const original = git(repo.worktree, "rev-parse", "HEAD");
    git(repo.worktree, "push", "origin", `HEAD:refs/heads/${repo.branch}`);
    commit(repo, "README.txt", "candidate for rejected lease\n");
    recordCandidate(repo);
    const concurrent = git(repo.worktree, "commit-tree", "HEAD^{tree}", "-p", original, "-m", "concurrent remote update");
    git(repo.worktree, "push", "origin", `${concurrent}:refs/dagu/race`);
    runScript(extractScript(renderedFeature, "  - id: gate"), repo);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(join(repo.root, "bin", "git"), `#!/bin/sh\ncase " $* " in *" push "*refs/heads/*)\n"${realGit}" -C ${JSON.stringify(join(repo.root, "remote.git"))} update-ref refs/heads/${repo.branch} ${concurrent} || exit\n;; esac\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    const file = join(fixture.home, "dags", "feature.yaml");
    const id = repo.state.split("/").at(-1)!;
    const spec = {
      name: "feature", type: "graph", shell: "bash",
      params: [{ ISSUE: "189" }, { OMP_SESSION_ID: "diagnostic-owner" }],
      env: { ...featureScriptEnv(repo), OMP_SESSION_ID: "diagnostic-owner", DAGU_PORT: String(fixture.port) },
      steps: [
        { id: "push", continue_on: { failure: true }, run: extractScript(renderedFeature, "  - id: push") },
        { id: "recover_push", depends: "push", preconditions: [{ condition: "${push.exit_code}", expected: "re:^[1-9][0-9]*$" }],
          action: "human.task", with: { prompt: "Static prompt must not be the cause." } },
      ],
    };
    // Apply only to an isolated fixture; production adoption remains operator-owned.
    writeFileSync(file, stringify(spec));
    execFileSync("dagu", ["enqueue", "--run-id", id, file], { env: fixture.env, stdio: "pipe" });
    const failed = await fixture.state(id, "waiting");
    const node = failed.nodes.find(node => node.step.name === "push")!;
    const stderr = readFileSync(node.stderr!, "utf8");
    const rule = `rule=push.remote_lease expected=${original} observed=${concurrent}`;
    assert.ok(stderr.includes(rule), stderr);
    const notice = new Transitions("diagnostic-owner").observe(failed).wakeMessage!;
    assert.ok(notice.includes(`cause=${rule}`), JSON.stringify(failed) + notice);
    if (process.env.A4S_DIAGNOSTIC_EVIDENCE) {
      writeFileSync(join(process.env.A4S_DIAGNOSTIC_EVIDENCE, "push.err"), stderr);
      writeFileSync(join(process.env.A4S_DIAGNOSTIC_EVIDENCE, "push-rest.json"), JSON.stringify(failed, null, 2));
      writeFileSync(join(process.env.A4S_DIAGNOSTIC_EVIDENCE, "push-notice.txt"), notice);
    }
  } finally {
    await fixture.close();
    rmSync(repo.root, { recursive: true, force: true });
  }
});
