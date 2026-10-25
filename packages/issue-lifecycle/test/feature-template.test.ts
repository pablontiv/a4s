import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { Transitions } from "../src/status/progress.ts";
import type { RunDetails } from "../src/status/progress.ts";
import { BUNDLE_VERSION } from "../src/bundle.ts";
import { stubHistory, withResourceGuard } from "./resource-fixtures.ts";
import { liveDagu, liveDaguVersion } from "./fixtures/live-dagu.ts";
import { roleAdmission, roleExecution } from "./role-job-fixtures.ts";
import { jobId, type JobBinding } from "../src/role-jobs.ts";
import { roleAssignment, runRoleJob } from "../src/role-dispatch.ts";
import "./waiting-cancellation.test.ts";
import { testRunId } from "./fixtures/run-id.ts";
import { renderedFeature, renderedPoc } from "./fixtures/rendered-feature.ts";

const timingBin = mkdtempSync(join(tmpdir(), "a4s-gate-cli-"));
symlinkSync(fileURLToPath(new URL("../bin/dagu-gate.cjs", import.meta.url)), join(timingBin, "dagu-gate"));
symlinkSync(fileURLToPath(new URL("../bin/dagu-feature-protect.ts", import.meta.url)), join(timingBin, "dagu-feature-protect"));
process.env.PATH = `${timingBin}:${process.env.PATH ?? ""}`;
after(() => rmSync(timingBin, { recursive: true, force: true }));

const definitions = [
  ["template", fileURLToPath(new URL("../skills/issue-execution/feature.yaml", import.meta.url))],
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

function repository(run = "test-run"): Repository {
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
  return { root, primary, worktree, branch, state };
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

type FilesEvidence = { metadata?: string; pages?: string; metadataExit?: number; pagesExit?: number };

function stubSuccessfulCloseGateGh(repo: Repository, files = "README.txt", evidence: FilesEvidence = {}): void {
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
  "repo view ${repo.root}/remote.git --json nameWithOwner --jq .nameWithOwner") printf 'fixture/repo\\n' ;;
  "api repos/fixture/repo/pulls/190") cat ${JSON.stringify(join(repo.root, "pr-metadata.json"))}; exit ${evidence.metadataExit ?? 0} ;;
  "api --paginate --slurp repos/fixture/repo/pulls/190/files?per_page=100") cat ${JSON.stringify(join(repo.root, "pr-files.json"))}; exit ${evidence.pagesExit ?? 0} ;;
  *) printf 'unexpected gh invocation: %s\\n' "$*" >&2; exit 1 ;;
esac
`,
  );
  writeFileSync(join(repo.root, "pr-metadata.json"), evidence.metadata ?? JSON.stringify({ changed_files: 1 }));
  writeFileSync(join(repo.root, "pr-files.json"), evidence.pages ?? JSON.stringify([[{ filename: files }]]));
  chmodSync(executable, 0o755);
}

const firstFilePage = Array.from({ length: 100 }, (_, index) => ({ filename: `src/file-${index}.ts` }));
const fileEvidenceCases: Array<{ name: string; evidence: FilesEvidence; bootstrap?: boolean; error?: RegExp }> = [
  { name: "skill on the second full-response page", evidence: {
    metadata: '{"changed_files":101}',
    pages: JSON.stringify([firstFilePage, [{ filename: "packages/issue-lifecycle/skills/issue-execution/feature.yaml" }]]),
  }, bootstrap: true },
  { name: "changelog", evidence: { pages: '[[{"filename":"packages/issue-lifecycle/CHANGELOG.md"}]]' }, bootstrap: true },
  { name: "unrelated path with an embedded newline", evidence: {
    pages: JSON.stringify([[{ filename: "src/notes\npackages/issue-lifecycle/CHANGELOG.md" }]]),
  } },
  { name: "zero changed files", evidence: { metadata: '{"changed_files":0}', pages: "[[]]" } },
  ...[
    ["metadata API failure", { metadataExit: 1 }, /metadata lookup failed/],
    ["files API failure", { pagesExit: 1 }, /pages lookup failed/],
    ["malformed metadata JSON", { metadata: "{" }, /invalid changed-file metadata/],
    ["multiple metadata documents", { metadata: '{"changed_files":1}\n{"changed_files":1}' }, /one metadata document/],
    ["missing count", { metadata: "{}" }, /invalid changed_files/],
    ["string count", { metadata: '{"changed_files":"1"}' }, /invalid changed_files/],
    ["fractional count", { metadata: '{"changed_files":1.5}' }, /invalid changed_files/],
    ["negative count", { metadata: '{"changed_files":-1}' }, /invalid changed_files/],
    ["exact endpoint ceiling", { metadata: '{"changed_files":3000}' }, /endpoint ceiling/],
    ["above endpoint ceiling", { metadata: '{"changed_files":3001}' }, /endpoint ceiling/],
    ["malformed files JSON", { pages: "[" }, /invalid or incomplete/],
    ["multiple files documents", { pages: '[[]]\n[[]]' }, /one files document/],
    ["non-array pages", { pages: "{}" }, /invalid files pages/],
    ["missing zero-file page", { metadata: '{"changed_files":0}', pages: "[]" }, /missing files pages/],
    ["non-array page", { pages: "[{}]" }, /invalid files page/],
    ["oversized page", { metadata: '{"changed_files":101}', pages: JSON.stringify([[...firstFilePage, { filename: "extra" }]]) }, /oversized files page/],
    ["short intermediate page", { metadata: '{"changed_files":2}', pages: '[[{"filename":"one"}],[{"filename":"two"}]]' }, /incomplete files page/],
    ["non-object record", { pages: '[[null]]' }, /invalid file record/],
    ["missing filename", { pages: '[[{}]]' }, /invalid filename/],
    ["non-string filename", { pages: '[[{"filename":7}]]' }, /invalid filename/],
    ["empty filename", { pages: '[[{"filename":""}]]' }, /empty filename/],
    ["count mismatch", { metadata: '{"changed_files":2}' }, /count mismatch/],
    ["duplicate across pages", { metadata: '{"changed_files":101}', pages: JSON.stringify([firstFilePage, [firstFilePage[0]]]) }, /duplicate filenames/],
  ].map(([name, evidence, error]) => ({ name: name as string, evidence: evidence as FilesEvidence, error: error as RegExp })),
];

for (const scenario of fileEvidenceCases) {
  test(`maintained close validates ${scenario.name}`, () => {
    const repo = repository();
    try {
      commit(repo, "packages/issue-lifecycle/package.json", JSON.stringify({ version: BUNDLE_VERSION }));
      git(repo.primary, "merge", "--ff-only", repo.branch);
      git(repo.primary, "push", "origin", "main");
      stubSuccessfulCloseGateGh(repo, "README.txt", scenario.evidence);
      const log = join(repo.root, "bootstrap.args");
      const executable = join(repo.root, "bin", "dagu");
      writeFileSync(executable, `#!/bin/sh\ncase "$1" in\nhistory) printf '[]\\n';;\nenqueue) printf '%s\\n' "$@" > ${JSON.stringify(log)};;\n*) exit 1;;\nesac\n`);
      chmodSync(executable, 0o755);
      const result = spawnSync("bash", ["-c", extractScript(definitions[0][1], "  - id: close_gate")], {
        encoding: "utf8", env: featureScriptEnv(repo),
      });
      if (scenario.error) {
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stderr, scenario.error);
        assert.match(readFileSync(join(repo.state, "cleanup-diagnostic"), "utf8"), /changed-file/);
        assert.equal(readFileSync(join(repo.state, "cleanup-phase"), "utf8"), "branch-removed\n");
        assert.equal(existsSync(log), false);
      } else {
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(readFileSync(join(repo.state, "cleanup-phase"), "utf8"), "complete\n");
        assert.equal(existsSync(log), scenario.bootstrap === true);
        if (scenario.bootstrap) assert.match(readFileSync(log, "utf8"), /dagu-feature-bootstrap\.yaml/);
      }
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });
}

function featureScriptEnv(repo: Repository): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME,
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

for (const [name, definition] of definitions) {
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
      writeFileSync(gh, `#!/bin/bash
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
      const resolver = fileURLToPath(new URL("../bin/dagu-bundle-rebase.mjs", import.meta.url));
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
    const run = "test-run"; const home = join(repo.root, "dagu-home"); mkdirSync(home);
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
    runScript(extractScript(definition, "  - id: capture"), repo, { IMPLEMENTER: result.id, OMP_SESSION_ID: "parent-id" });
    runScript(extractScript(definition, "  - id: gate"), repo);
    runScript(extractScript(definition, "  - id: push"), repo);
    const candidate = JSON.parse(readFileSync(join(repo.state, "candidate.json"), "utf8"));
    assert.equal(git(repo.primary, "ls-remote", "origin", `refs/heads/${repo.branch}`).split(/\s/)[0], candidate.sha);
    assert.equal(candidate.implementation.inputSha, binding.sha);
    assert.notEqual(candidate.sha, binding.sha);
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

test("template isolated PoC parent succeeds after exactly one child enqueue across the complete implementation graph", { timeout: 60_000 }, () => {
  const run = testRunId("poc-parent");
  const repo = repository(run);
  git(repo.primary, "worktree", "remove", repo.worktree);
  try {
    const home = join(repo.root, "dagu-home");
    mkdirSync(join(home, "dags"), { recursive: true });
    const bin = join(repo.root, "bin");
    const calls = join(repo.root, "external-calls");
    writeFileSync(calls, "");
    writeFileSync(join(bin, "gh"), `#!/bin/bash\nprintf '%s\\n' "gh $*" >> ${JSON.stringify(calls)}\n`);
    writeFileSync(join(bin, "dagu-poc-scope"), `#!/bin/bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fileURLToPath(new URL("../bin/dagu-poc-scope.ts", import.meta.url)))} "$@"\n`);
    writeFileSync(join(bin, "dagu-feature-bundle"), `#!/bin/bash
set -euo pipefail
arguments="$*"
while [[ $# -gt 0 && "$1" != -- ]]; do shift; done
[[ "$1" == -- ]]
shift
for parameter in "$@"; do export "$parameter"; done
dagu-poc-scope require
printf '%s\\n' "dagu-feature-bundle $arguments" >> ${JSON.stringify(calls)}
`);
    for (const command of ["gh", "dagu-poc-scope", "dagu-feature-bundle"]) chmodSync(join(bin, command), 0o755);
    const source = readFileSync(definitions[0][1], "utf8");
    const dag = join(home, "dags", "feature.yaml");
    const variables = {
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
      `gh issue comment 189 --body-file ${join(repo.primary, ".git", "dagu-feature", "runs", run, "triage.md")}`,
      `dagu-feature-bundle enqueue --run-id poc-${run} ${repo.primary}/.workspace/dagu/dags/poc.yaml -- ISSUE=189 QUESTION=runtime behavior BASE_BRANCH=main OMP_SESSION_ID=parent-id REQUIRED_TARGETS=["linux-arm64"] AUTHORIZED_TARGETS=["linux-arm64"] SCOPE_BASIS=regression test authorized linux-arm64 SCOPE_REQUEST=${request.id}`,
    ]);
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

for (const [name, definition] of definitions) {
  const exitScript = extractScript(definition, "  exit:");
  const checkpointScript = extractScript(definition, "  - id: checkpoint_push");
  const closeGateScript = extractScript(definitions[0][1], "  - id: close_gate");

  const captureScript = extractScript(definition, "  - id: capture");
  const gateScript = extractScript(definition, "  - id: gate");

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
      assert.match(rejected.stderr, /full.patch digest mismatch for mismatch/);
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
      assert.match(rejected.stderr, new RegExp(`PoC base ${side} is not an ancestor of origin/main`));
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
      assert.match(rejected.stderr, /published PoC patch does not apply/);
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
      assert.match(dirty.stderr, /worktree changes are not the published PoC basis; preserved/);
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
      stubGh(repo, "", 1);
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
  test(`${name} every candidate publication follows the gate and optional validation`, () => {
    const source = readFileSync(definition, "utf8");
    for (const [step, dependency] of [
      ["recover_gate", "gate"], ["validation", "recover_gate_cancellation"],
      ["push", "validation_cancellation"], ["pr", "recover_push_cancellation"], ["code_scanning", "pr"], ["auto_merge", "code_scanning"],
    ]) assert.match(extractStep(source, step!), new RegExp(`depends: ${dependency}`));
    const publications = source.split("\n  - id:").filter(block => block.includes('push "--force-with-lease=$remote_ref:$expected" --set-upstream origin "$sha:$remote_ref"'));
    assert.equal(publications.length, 1);
    assert.match(publications[0]!, /^ push\n/);
    assert.match(extractStep(source, "await_merge"), /rewind_to: rebase/);
    assert.match(extractStep(source, "await_ci"), /rewind_to: implement/);
  });
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
      stubGh(repo, "", 1);
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
      assert.match(attempt().stderr, /no gated candidate/);
      const gateScript = extractScript(definition, "  - id: gate");
      const gateOptions = { encoding: "utf8", env: { ...featureScriptEnv(repo), GATE: "true" } } as const;
      assert.equal(spawnSync("bash", ["-c", gateScript], gateOptions).status, 0);
      commit(repo, "README.txt", "changed after gate\n");
      const stale = attempt();
      assert.equal(stale.status, 1);
      assert.match(stale.stderr, /stale candidate.*revalidation required/);
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
  for (const [step, downstream] of [["start_gate", "implement"], ["gate", "validation"], ["push", "pr"]]) {
    test(`${name} ${step} routes failure through its recovery checkpoint`, () => {
      const source = readFileSync(definition, "utf8");
      assert.match(extractStep(source, step!), /continue_on:\n      failure: true/);
      const recovery = extractStep(source, `recover_${step}`);
      assert.ok(recovery.includes(`condition: "\${${step}.exit_code}"`));
      const rewind = step === "gate" ? "implement_budget" : step;
      assert.match(recovery, new RegExp(`^        rewind_to: ${rewind}$`, "m"));
      assert.match(recovery, /continue_on: skipped/);
      const path = step === "start_gate"
        ? ["recover_start_gate", "recover_start_gate_cancellation", "implement_budget", "escalation",
          "escalation_cancellation", "escalation_decision", downstream]
        : [`recover_${step}`, `recover_${step}_cancellation`, downstream];
      for (let index = 1; index < path.length; index++) {
        assert.match(extractStep(source, path[index]!), new RegExp(`^    depends: ${path[index - 1]}$`, "m"));
      }
    });
  }
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
}

for (const [name, definition] of [
  ...definitions,
  ["PoC template", fileURLToPath(new URL("../skills/issue-execution/poc.yaml", import.meta.url))],
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
  ["PoC template", fileURLToPath(new URL("../skills/issue-execution/poc.yaml", import.meta.url))],
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
        const diagnostic = gate === "base" && failure === "ff-only" ? "cause=primary_ahead" : `${gate}: ${failure}`;
        assert.ok(result.stderr.includes(diagnostic), result.stderr);
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
        `params:\n  - ISSUE: "189"\n  - BASE_BRANCH: main\n  - PR_NUMBER: ""\n  - OMP_SESSION_ID: retained-owner\n`,
        `env:\n  - PRIMARY: ${JSON.stringify(repo.primary)}\n  - BRANCH: dagu/issue-\${ISSUE}\n  - GATE: "true"\n  - REQUIRED_CHECK: validate\n  - PATH: ${env.PATH}\n  - WORKTREE: ${repo.worktree}\n  - RUN: \${context.run.id}\n  - DAGU_FEATURE_BUNDLE: test\n`,
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
      assert.match(mismatch.stderr, new RegExp(`ownership identity mismatch.*requesting_run=${second}.*observed=.*expected=`));
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
    const resolver = fileURLToPath(new URL("../bin/dagu-bundle-rebase.mjs", import.meta.url));
    const evidence = join(repo.root, "resolver-refs");
    const resolverCommand = `printf '%s\\n' "$DAGU_REBASE_BASE $DAGU_REBASE_CANDIDATE $DAGU_REBASE_UPSTREAM $(git rev-parse REBASE_HEAD)" > ${JSON.stringify(evidence)}; node ${JSON.stringify(resolver)}`;
    // Synthetic triage/implement actors and deliberate post-capture failure isolate native handoff.
    const file = join(home, "dags", "feature.yaml");
    writeFileSync(file, [
      "type: graph\nshell: bash\nmax_active_steps: 1\n",
      `params:\n  - ISSUE: "189"\n  - BASE_BRANCH: main\n  - PR_NUMBER: ""\n  - OMP_SESSION_ID: retained-owner\n  - RETAIN: "no"\n`,
      `env:\n  - PRIMARY: ${JSON.stringify(repo.primary)}\n  - BRANCH: dagu/issue-\${ISSUE}\n  - GATE: "true"\n  - REQUIRED_CHECK: validate\n  - PATH: ${env.PATH}\n  - WORKTREE: ${repo.worktree}\n  - RUN: \${context.run.id}\n  - DAGU_FEATURE_BUNDLE: test\n  - REBASE_RESOLVER: ${JSON.stringify(resolverCommand)}\n`,
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
  const env: NodeJS.ProcessEnv = { ...process.env, DAGU_PARAMS_JSON: "{}", DAGU_HOME: home, DAGU_PORT: String(port), DAGU_COORDINATOR_ENABLED: "false" };
  // Fixture CLI retries are user requests; its scheduler supplies dispatch context.
  delete env.DAGU_QUEUE_DISPATCH_RETRY;
  delete env.DAG_PUSHBACK_ITERATION;
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
      `params:\n  - ISSUE: "189"\n  - BASE_BRANCH: main\n  - PR_NUMBER: ""\n  - VALIDATION: ""\n  - OMP_SESSION_ID: recovery-owner\n`,
      `env:\n  - PRIMARY: ${JSON.stringify(repo.primary)}\n  - BRANCH: dagu/issue-\${ISSUE}\n  - GATE: test -f required.txt\n  - REQUIRED_CHECK: validate\n  - PATH: ${bin}:${process.env.PATH}\n  - WORKTREE: ${repo.worktree}\n  - RUN: \${context.run.id}\n  - DAGU_FEATURE_BUNDLE: test\n  - DAGU_PORT: "${fixture.port}"\n`,
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
    const dagu = (...args: string[]) => execFileSync("dagu", args, {
      cwd: root, env: { ...env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const iteration = () => Number(dagu("status", "feature", "--run-id", id).match(/push-back iteration: (\d+)/)?.[1] ?? 0);
    async function waiting(step: string): Promise<LiveDetail> {
      const run = await until(`${id} waiting ${step}`, async () => {
        const run = await state(id, "waiting");
        if (step === "implement" && run.nodes.some(node => node.step.name === "recover_start_gate" && node.statusLabel === "waiting")) {
          throw new Error(run.nodes.filter(node => node.stderr).map(node => `${node.step.name}: ${readFileSync(node.stderr!, "utf8")}`).join("\n"));
        }
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
    }
    if (mode === "push") {
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
    ...liveDagu,
    timeout: 360_000,
  }, async (t) => {
    assert.match(liveDaguVersion, /2\.20\.1/);
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
              const admission = join(repo.root, "bin", "dagu-feature-bundle");
              writeFileSync(admission, '#!/bin/sh\ntest "$1" = enqueue || exit 1\nexec dagu "$@"\n');
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
              : `  - id: implement\n    depends: start_gate\n    run: |\n      git -C "$WORKTREE" rev-parse HEAD > "$(git -C "$PRIMARY" rev-parse --path-format=absolute --git-path "dagu-feature/runs/$RUN")/tested-sha"\n      ${mode === "implementation-blocked" ? 'printf "operator changes\\n" > "$PRIMARY/README.txt"' : "echo implementation"}\n  - id: await_merge\n    depends: implement\n    run: echo merged\n  - id: authorize_ci\n    depends: await_merge\n    run: echo authorized-candidate\n`;
            const script = [
              "type: graph\nshell: bash\nmax_active_steps: 1\n",
              `params:\n  - ISSUE: "189"\n  - BASE_BRANCH: main\n  - PR_NUMBER: ""\n  - OMP_SESSION_ID: close-owner\n`,
              `env:\n  - PRIMARY: ${JSON.stringify(repo.primary)}\n  - BRANCH: dagu/issue-\${ISSUE}\n  - GATE: "true"\n  - REQUIRED_CHECK: validate\n  - PATH: ${join(repo.root, "bin")}:${process.env.PATH}\n  - WORKTREE: ${repo.worktree}\n  - RUN: \${context.run.id}\n  - DAGU_FEATURE_BUNDLE: test\n`,
              source.slice(source.indexOf("  - DAGU_RESOURCE_GUARD: |"), source.indexOf("steps:\n")),
              "steps:\n", ...(mode === "poc" ? ["admission", "admit"].map(id => extractStep(source, id)) : []), triage, decision,
              ...(mode === "poc" ? ["poc_scope_prepare", "poc_scope_decision", "poc_scope_resolve", "poc_admit"].map(id => extractStep(source, id)) : []),
              ...["detect_start_primary", "start_primary_unavailable", "start_gate", ...(mode === "poc" ? ["recover_start_gate"] : [])].map(id => extractStep(source, id)),
              implementation,
              ...["detect_close_primary", "close_primary_unavailable", "close_gate"].map(id =>
                extractStep(id === "close_gate" ? readFileSync(definitions[0][1], "utf8") : source, id).replace("await_merge_cancellation", "await_merge")),
              "handler_on:\n", source.slice(source.indexOf("  exit:\n")),
            ].join("");
            const dag = join(home, "dags", "feature.yaml");
            writeFileSync(dag, script);
            rmSync(join(repo.root, "bin", "dagu"));
            const runEnv = { ...env, PATH: `${join(repo.root, "bin")}:${process.env.PATH}` };
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
              wakeMessage: `[DAGU STATE] run=${id} status=succeeded issue=189 bundle=unstamped extension=${BUNDLE_VERSION} main=n/a compat=unstamped`,
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
            ? [{ step: "implement", iteration: 0 }, { step: "recover_gate", iteration: 0 },
              { step: "implement", iteration: 1 },
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
  test(`${name} real Dagu checks primary freshness before admission and enqueues bootstrap after merge`, {
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
    const env = { ...process.env, DAGU_PARAMS_JSON: "{}", DAGU_HOME: home, DAGU_COORDINATOR_ENABLED: "false" };
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
          stubSuccessfulCloseGateGh(repo, changed);
          const log = join(repo.root, "bootstrap.args");
          const stub = join(repo.root, "bin", "dagu");
          writeFileSync(stub, `#!/bin/sh\ncase "$1" in\n  history) printf '[]\\n' ;;\n  enqueue) printf '%s\\n' "$@" > ${JSON.stringify(log)} ;;\n  *) exit 1 ;;\nesac\n`);
          chmodSync(stub, 0o755);
          const result = await execute(repo, "close_gate");
          assert.equal(result.status, "succeeded", JSON.stringify(result));
          if (changed.startsWith("packages/issue-lifecycle/")) {
            const skill = join(repo.primary, "packages/issue-lifecycle/skills/issue-execution");
            assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
              "enqueue", "--run-id", `bootstrap-a4s-v${BUNDLE_VERSION.replace(/\./g, "-")}`,
              join(skill, "dagu-feature-bootstrap.yaml"), "--", `PRIMARY=${repo.primary}`, `SKILL_DIR=${skill}`,
            ]);
          } else {
            assert.match(result.stdout, /cleanup worktree=.*remote=absent/);
          }
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
          const validationParam = source.match(/    VALIDATION:\n[\s\S]*?(?=    OMP_SESSION_ID:)/)![0]!
            .replace(/      default: .+\n/, `      default: ${JSON.stringify(procedure)}\n`)
            .replace(/      enum: .+\n/, `      enum: [${JSON.stringify(procedure)}]\n`);
          const params = `params:\n  type: object\n  properties:\n${validationParam}`;
          const gate = extractStep(source, "gate").replace(/depends: conflict_review(?:_cancellation)?/, "depends: implement")
            .replace(/    retry_policy:\n      limit: 1\n      interval_sec: 5\n/, "")
            .replace("    run: |", "    preconditions:\n      - condition: '${steps.triage.outputs.POC}'\n        expected: 'no'\n    run: |");
          const vars = { ...featureScriptEnv(repo), RUN: id, OMP_SESSION_ID: "parent-id", DAGU_PORT: String(port), GATE: mode === "gate-fail" ? "exit 1" : `printf 'gate\\n' >> ${JSON.stringify(join(root, id + ".gates"))}` };
          const dag = join(home, "dags", "feature.yaml");
          writeFileSync(dag, `type: graph\nshell: bash\nmax_active_steps: 1\n${params}env:\n`
            + Object.entries(vars).filter(([, value]) => value !== undefined).map(([key, value]) => `  - ${key}: ${JSON.stringify(value)}\n`).join("")
            + `steps:\n  - id: triage\n    run: printf 'POC=${mode === "poc" ? "yes" : "no"}\\n' >> "$DAGU_OUTPUT_FILE"\n    outputs:\n      - name: POC\n  - id: implement\n    depends: triage\n    action: human.task\n    with:\n      prompt: Implement candidate\n`
            + gate + extractStep(source, "recover_gate").replaceAll("rewind_to: implement_budget", "rewind_to: implement")
            + ["validation", "push", "recover_push"].map(step => extractStep(source, step)
              .replaceAll("rewind_to: implement_budget", "rewind_to: implement")).join(""));
          command("validate", dag);
          const overrideId = testRunId("override");
          const override = dagu("enqueue", "--run-id", overrideId, dag, "--", "VALIDATION=changed");
          assert.notEqual(override.status, 0, override.stdout + override.stderr);
          assert.equal((await fetch(`${api}/dag-runs/feature/${overrideId}`)).status, 404);
          command("enqueue", "--run-id", id, dag);
          await state(id, "waiting", "implement");
          command("human-task", "complete", "feature", "--run-id", id, "--step", "implement");
          if (mode === "gate-fail") {
            const blocked = await state(id, "waiting", "recover_gate");
            assert.equal(blocked.nodes.find(node => node.step.id === "gate")?.statusLabel, "failed");
            assert.equal(blocked.nodes.find(node => node.step.id === "validation")?.statusLabel, "not_started");
            assert.equal(blocked.nodes.find(node => node.step.id === "push")?.statusLabel, "not_started");
            assert.equal(hasRef(repo.primary, `refs/remotes/origin/${repo.branch}`), false);
          } else if (mode === "wrong-sha") {
            await state(id, "waiting", "validation");
            command("human-task", "complete", "feature", "--run-id", id, "--step", "validation", "--input", "APPROVED=yes", "--input", `TESTED_SHA=${"0".repeat(40)}`);
            const rejected = await state(id, "waiting", "recover_push");
            assert.equal(rejected.nodes.find(node => node.step.id === "push")?.statusLabel, "failed");
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
            assert.match(stale.stderr, /approval SHA .* differs from tested candidate/);
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
  ["PoC template", fileURLToPath(new URL("../skills/issue-execution/poc.yaml", import.meta.url))],
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
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${fixtureBin}:${process.env.PATH}`, DAGU_PARAMS_JSON: "{}", DAGU_HOME: home, DAGU_PORT: String(port), DAGU_COORDINATOR_ENABLED: "false" };
    // This scheduler owns a new run's iteration independently of the parent role job.
    delete env.DAG_PUSHBACK_ITERATION;
    writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\n`);
    const source = readFileSync(definition, "utf8");
    const commandImplementation = extractStep(source, "implement").includes("dagu-role-jobs stage implement");
    const implementationReady = join(repo.root, "implementation-ready");
    const executor = join(fixtureBin, "execute.ts");
    writeFileSync(executor, `import {existsSync,rmSync} from "node:fs";
import {setTimeout as delay} from "node:timers/promises";
import {dispatchStage} from ${JSON.stringify(new URL("../src/role-dispatch.ts", import.meta.url).href)};
import {roleExecution} from ${JSON.stringify(new URL("./role-job-fixtures.ts", import.meta.url).href)};
await dispatchStage("implement",(name,value)=>require("node:fs").appendFileSync(process.env.DAGU_OUTPUT_FILE,name+"="+value+"\\n"),async(job,assignment)=>{
  while(!existsSync(${JSON.stringify(implementationReady)})) await delay(100);
  rmSync(${JSON.stringify(implementationReady)});
  return roleExecution(job,assignment);
});
`);
    writeFileSync(join(fixtureBin, "dagu-role-jobs"), `#!/bin/sh\nexec bun ${JSON.stringify(executor)} "$@"\n`);
    chmodSync(join(fixtureBin, "dagu-role-jobs"), 0o755);
    writeFileSync(join(fixtureBin, "gh"), '#!/bin/sh\nprintf \'{"title":"Fixture","body":"Acceptance","comments":[]}\\n\'\n');
    chmodSync(join(fixtureBin, "gh"), 0o755);
    const steps = ["implement_budget", "escalation", "escalation_decision", "implement", "capture", "rebase", "conflict_review", "gate", "recover_gate",
      "validation", "push"].map(step => extractStep(source, step)
        .replace(/    depends: recover_start_gate_cancellation\n/, "    depends: recover_start_gate\n")
        .replace(/    depends: rebase_escalation_decision\n/, "    depends: capture\n")).join("\n");
    const dag = join(home, "dags", "feature.yaml");
    writeFileSync(dag, `name: feature\ntype: graph\nshell: bash\nmax_active_steps: 1\nparams:\n  - ISSUE: "189"\n  - OMP_SESSION_ID: parent-id\nenv:\n${Object.entries({
      ISSUE: "189", PRIMARY: repo.primary, WORKTREE: repo.worktree, BRANCH: repo.branch, PATH: env.PATH,
      BASE_BRANCH: "main", GATE: "test -f acceptance.txt", VALIDATION: "", OMP_SESSION_ID: "parent-id", RUN: "${context.run.id}", DAGU_PORT: String(port),
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
              (expected === "running" || iteration === undefined || (node.approvalIteration ?? 0) === iteration))) return detail;
          }
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
        }
        await delay(100);
      }
      throw new Error(`Timed out at ${step}\n${serviceLog}`);
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
      completeImplementation();
      await untilStep("recover_gate", 0);
      const refsBefore = git(repo.primary, "ls-remote", "--heads", "origin");
      const failed = git(repo.worktree, "rev-parse", "HEAD");
      dagu("human-task", "push-back", "feature", "--run-id", run, "--step", "recover_gate", "--expected-iteration", "0");
      await untilStep("implement", 1);
      assert.equal(git(repo.primary, "ls-remote", "--heads", "origin"), refsBefore);
      assert.equal(git(repo.worktree, "rev-parse", "HEAD"), failed);
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
  const stage = join(repo.root, "staged", "feature.yaml");
  const skillDir = fileURLToPath(new URL("../skills/issue-execution/", import.meta.url));
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const env = {
    ...process.env, DAGU_PARAMS_JSON: "{}", DAGU_HOME: home, DAGU_PORT: String(port), PRIMARY: repo.primary, A4S_PRIMARY: repo.primary, SKILL_DIR: skillDir,
    GATE: "printf adopted-gate", REQUIRED_CHECK: "adopted-check", REPO: "fixture", BASE_BRANCH: "main",
    REBASE_RESOLVER: "printf adopted-resolver",
    STAGE: stage, TEST_PATHS: "test/", BUNDLE_NAME: "@a4s/issue-lifecycle", BUNDLE_VERSION,
    DAGU_VERSION: "2.20.1", SOURCE_NWO: "fixture/repo", SOURCE_SHA: "1".repeat(40), DAG_RUN_ID: "bootstrap-fixture",
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
    const rendered = spawnSync("bash", ["-c", extractScript(join(skillDir, "dagu-feature-bootstrap.yaml"), "  - id: render")], { encoding: "utf8", env });
    assert.equal(rendered.status, 0, rendered.stdout + rendered.stderr);
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
    const accepted = spawnSync("dagu", ["start", "--only", "admission", "--run-id", testRunId("operational"), stage, "--", "ISSUE=274", "PR_NUMBER=275", "OMP_SESSION_ID=owner-session"], { encoding: "utf8", env, timeout: 30_000 });
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
    assert.match(accepted.stdout, /admission.*succeeded/);
    const enqueued = spawnSync("dagu", ["enqueue", "--run-id", testRunId("operational-queued"), stage, "--", "ISSUE=274", "PR_NUMBER=275", "OMP_SESSION_ID=owner-session"], { encoding: "utf8", env, timeout: 30_000 });
    assert.equal(enqueued.status, 0, enqueued.stdout + enqueued.stderr);
    const adopted = readFileSync(stage, "utf8");
    assert.match(adopted, /- GATE: "printf adopted-gate"/);
    assert.match(adopted, /- REBASE_RESOLVER: "printf adopted-resolver"/);
    assert.match(adopted, /- REQUIRED_CHECK: "adopted-check"/);
    assert.ok(adopted.includes('- PRIMARY: "${A4S_PRIMARY}"'));
    assert.equal(adopted.includes(repo.primary), false);
    assert.match(adopted, /- BRANCH: dagu\/issue-\$\{ISSUE\}/);
    const promotion = extractScript(join(skillDir, "poc.yaml"), "  - id: dispose");
    assert.match(promotion, /ISSUE="\$ISSUE" \\\n\s+BASE_BRANCH="\$BASE_BRANCH" OMP_SESSION_ID="\$OMP_SESSION_ID"/);
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
    writeFileSync(join(bin, "dagu-feature-bundle"), '#!/bin/sh\nexec dagu "$@"\n');
    chmodSync(join(bin, "dagu-feature-bundle"), 0o755);
    const adoptedDirectory = join(repo.primary, ".workspace", "dagu", "dags");
    mkdirSync(adoptedDirectory, { recursive: true });
    writeFileSync(join(adoptedDirectory, "feature.yaml"), adopted);
    const promoted = spawnSync("bash", ["-c", promotion], { encoding: "utf8", env: {
      ...env, RUN: promotionRun, PROMOTE: "yes", OMP_SESSION_ID: "owner-session",
      POLICY_FIXTURE: repo.root, PATH: `${bin}:${process.env.PATH}`,
    } });
    assert.equal(promoted.status, 0, promoted.stdout + promoted.stderr);
    const history = spawnSync("dagu", ["history", "feature", "--format", "json", "--status", "queued"], { encoding: "utf8", env });
    assert.equal(history.status, 0, history.stdout + history.stderr);
    const promotedRun = (JSON.parse(history.stdout) as Array<{ dagRunId: string; params: string }>).find(run => run.dagRunId === `feature-${promotionRun}`);
    assert.ok(promotedRun);
    assert.equal(promotedRun.params, "BASE_BRANCH=main ISSUE=274 OMP_SESSION_ID=owner-session POC_BASIS=https://example.test/pass PR_NUMBER= VALIDATION=");
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
      writeFileSync(join(bin, "dagu"), `#!/bin/bash
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
      writeFileSync(join(bin, "curl"), '#!/bin/bash\nprintf \'%s\\n\' \'{"entries":[{"attemptId":"775836","type":"dag.run.failed","data":{"dag_run_status":{"error":"process terminated unexpectedly - stale local process detected"}}}]}\'\n');
      chmodSync(join(bin, "dagu"), 0o755);
      chmodSync(join(bin, "curl"), 0o755);
      const definition = fileURLToPath(new URL(`../skills/issue-execution/${dag}.yaml`, import.meta.url));
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

test("real Dagu retries a Failed feature predecessor to the same Waiting checkpoint", {
  ...liveDagu,
  timeout: 120_000,
}, async () => {
  assert.equal(liveDaguVersion, "2.20.1");
  const fixture = await recoveryFixture();
  try {
    const id = `stale-recovery-${fixture.suffix}`;
    const file = join(fixture.home, "dags", "feature.yaml");
    writeFileSync(file, "name: feature\ntype: graph\nshell: bash\nsteps:\n  - id: start_gate\n    run: echo retained-predecessor\n  - id: implement\n    depends: start_gate\n    action: human.task\n    with:\n      prompt: Recover this checkpoint in the same run\n");
    const started = spawnSync("dagu", ["start", "--run-id", id, file], { env: fixture.env, encoding: "utf8" });
    assert.equal(started.status, 0, started.stderr);
    await fixture.state(id, "waiting");
    // Inject the scheduler repair snapshot in this isolated store. The race
    // itself is external; retry and checkpoint restoration use real Dagu.
    const store = join(fixture.home, "data", "dag-runs", "feature");
    const statusPath = readdirSync(store, { recursive: true }).map(String).find(path => path.endsWith("/status.jsonl"));
    assert.ok(statusPath);
    const statusFile = join(store, statusPath);
    const snapshot = JSON.parse(readFileSync(statusFile, "utf8").trim().split("\n").at(-1)!);
    snapshot.status = 2;
    snapshot.error = "process terminated unexpectedly - stale local process detected";
    for (const node of snapshot.nodes) if (node.status === 7 || node.status === 0) node.status = 2;
    appendFileSync(statusFile, JSON.stringify(snapshot) + "\n");
    const status = spawnSync("dagu", ["status", "--run-id", id, "feature"], { env: fixture.env, encoding: "utf8" });
    assert.match(status.stdout, /^Failed -/);
    const response = await fetch(`http://127.0.0.1:${fixture.port}/api/v1/dag-runs/feature/${id}`);
    const before = (await response.json() as { dagRunDetails: LiveDetail }).dagRunDetails;
    assert.equal(before.statusLabel, "failed");
    assert.equal(before.dagRunId, id);
    const retried = spawn("dagu", ["retry", "--run-id", id, "--step", "start_gate", "--downstream", "feature"], {
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
  } finally { await fixture.close(); }
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
  const lock = join(first.primary, ".git", "dagu-feature", "gate.lock");
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
        const vars = { PRIMARY: first.primary, WORKTREE: "${TREE}", BRANCH: "${FEATURE_BRANCH}", RUN: "${context.run.id}", GATE: gate, PATH: process.env.PATH };
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
