import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Transitions } from "../src/status/progress.ts";
import type { RunDetails } from "../src/status/progress.ts";
import { BUNDLE_VERSION } from "../src/bundle.ts";

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
  return lines.slice(runIndex + 1, end).map((line) => line.slice(6)).join("\n");
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
  };
}

function runFailingCloseGate(script: string, repo: Repository) {
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: featureScriptEnv(repo),
  });
}

function runScript(script: string, repo: Repository): string {
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    cwd: repo.root,
    env: featureScriptEnv(repo),
  });
  assert.equal(result.status, 0, `script failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
}

for (const [name, definition] of definitions) {
  const exitScript = extractScript(definition, "  exit:");
  const checkpointScript = extractScript(definition, "  - id: checkpoint_push");
  const closeGateScript = extractScript(definition, "  - id: close_gate");
  const autoMergeScript = extractScript(definition, "  - id: auto_merge");

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
        assert.ok(result.stdout.includes(`worktree=${repo.worktree}`));
      }
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} auto_merge sends the tested body with terminal trailers and the closing reference`, () => {
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
      const bin = join(repo.root, "bin");
      mkdirSync(bin, { recursive: true });
      const executable = join(bin, "gh");
      const argsFile = join(repo.root, "merge-args");
      writeFileSync(executable, `#!/bin/sh
case "$*" in
  "pr view ${repo.branch} --json headRefOid --jq .headRefOid") printf '${sha}\\n' ;;
  "pr view ${repo.branch} --json number --jq .number") printf '190\\n' ;;
  "pr view ${repo.branch} --json body --jq .body") printf 'Closes #189\\n' ;;
  "pr merge "*) printf '%s\\0' "$@" > "${argsFile}" ;;
  *) printf 'unexpected gh invocation: %s\\n' "$*" >&2; exit 1 ;;
esac
`);
      chmodSync(executable, 0o755);
      assert.match(runScript(autoMergeScript, repo), new RegExp(`pr=190\\nhead_sha=${sha}`));
      const mergeBody = `Closes #189\n\n${commitBody}`;
      assert.deepEqual(readFileSync(argsFile, "utf8").split("\0"), [
        "pr", "merge", repo.branch, "--auto", "--squash", "--match-head-commit", sha, "--body", mergeBody, "",
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
      assert.match(output, /Recovery: push/);
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
      assert.match(output, /Recovery: push/);
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
  test(`${name} real Dagu closes implementation runs and succeeds after enqueuing a PoC`, {
    skip: daguAvailable.status !== 0 || !/2\.20\.1/.test(daguAvailable.stdout) ? "Dagu 2.20.1 binary required for live integration" : false,
    timeout: 180_000,
  }, async (t) => {
    assert.match(daguAvailable.stdout, /2\.20\.1/);
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
    writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\n`);
    let serviceLog = "";
    const service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(port)], {
      cwd: root, env, stdio: ["ignore", "pipe", "pipe"],
    });
    service.stdout.on("data", data => { serviceLog += data; });
    service.stderr.on("data", data => { serviceLog += data; });
    const api = `http://127.0.0.1:${port}/api/v1`;
    type Detail = RunDetails & {
      nodes: Array<{ step: { name: string }; statusLabel: string; stdout?: string; stderr?: string }>;
      onExit?: { statusLabel: string };
    };
    async function until<T>(description: string, probe: () => Promise<T | undefined>): Promise<T> {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const value = await probe();
        if (value !== undefined) return value;
        await delay(150);
      }
      throw new Error(`Timed out: ${description}\n${serviceLog}`);
    }
    async function state(id: string, expected: string): Promise<Detail> {
      return until(`${id} ${expected}`, async () => {
        const response = await fetch(`${api}/dag-runs/feature/${id}`);
        if (!response.ok) return undefined;
        const run = (await response.json() as { dagRunDetails: Detail }).dagRunDetails;
        assert.ok(!["failed", "aborted"].includes(run.statusLabel), JSON.stringify(run));
        return run.statusLabel === expected ? run : undefined;
      });
    }
    try {
      await until("isolated Dagu ready", async () => {
        try { return (await fetch(`${api}/dag-runs`)).ok ? true : undefined; } catch { return undefined; }
      });
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
              "steps:\n", triage, decision,
              ...["detect_start_primary", "start_primary_unavailable", "start_gate"].map(id => extractStep(source, id)),
              implementation,
              ...["detect_close_primary", "close_primary_unavailable", "close_gate"].map(id => extractStep(source, id)),
              "handler_on:\n", source.slice(source.indexOf("  exit:\n")),
            ].join("");
            const dag = join(home, "dags", "feature.yaml");
            writeFileSync(dag, script);
            const runEnv = { ...env, PATH: `${join(repo.root, "bin")}:${process.env.PATH}` };
            const dagu = (...args: string[]) => execFileSync("dagu", args, {
              cwd: root, env: runEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
            }).trim();
            const id = mode;
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
      service.kill("SIGTERM");
      await new Promise<void>(resolve => {
        if (service.exitCode !== null) resolve();
        else service.once("exit", () => resolve());
      });
      rmSync(root, { recursive: true, force: true });
    }
  });
}
