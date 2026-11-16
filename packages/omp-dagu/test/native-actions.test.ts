import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { extractScript, runBash } from "./shell.ts";

const definitions = [
  fileURLToPath(new URL("../skills/dagu-feature/feature.yaml", import.meta.url)),
  fileURLToPath(new URL("../../../.workspace/dagu/dags/feature.yaml", import.meta.url)),
];
const dagu = process.env.DAGU_BIN;
const execute = promisify(execFile);

for (const definition of definitions) {
  test(`${definition} classifies merge, recovery and terminal observations fail-closed`, () => {
    const classify = extractScript(definition, "  - id: classify_pr");
    const verify = extractScript(definition, "  - id: verify_merge_poll");
    const verifyMerged = extractScript(definition, "  - id: verify_merged");
    for (const [state, mergeState, active, draft, merged, ready, recovery] of [
      ["closed", "unknown", false, false, true, true, false],
      ["open", "behind", true, false, false, true, true],
      ["open", "dirty", true, false, false, true, true],
      ["open", "dirty", false, false, false, true, false],
      ...["clean", "blocked", "unstable", "unknown"].map((value) => ["open", value, true, false, false, false, false] as const),
      ["closed", "clean", true, false, false, true, false],
      ["open", "clean", false, false, false, true, false],
      ["open", "clean", true, true, false, true, false],
      ["open", "has_hooks", true, false, false, true, false],
      ["open", "unexpected", true, false, false, true, false],
    ] as const) {
      const env = {
        PATH: process.env.PATH,
        MERGED: String(merged),
        RECOVERY: String(recovery),
        OBSERVATION: `state=${state.toUpperCase()}/mergeStateStatus=${mergeState.toUpperCase()}/autoMerge=${active}/draft=${draft}`,
        RESPONSE: JSON.stringify({ state, mergeable_state: mergeState, auto_merge: active ? {} : null, draft, merged }),
      };
      const result = runBash(classify, { encoding: "utf8", env });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { ready, recovery, observation: env.OBSERVATION });
      const verified = runBash(verify, { encoding: "utf8", env });
      assert.equal(verified.status === 0, merged || recovery);
      assert.equal(verified.stderr.includes(env.OBSERVATION), true);
      assert.equal(runBash(verifyMerged, { encoding: "utf8", env }).status === 0, merged);
    }
  });

  test(`${definition} routes reviews with native state and iteration-guarded REST only`, () => {
    const source = readFileSync(definition.replace("feature.yaml", "reconcile.yaml"), "utf8");
    const route = extractScript(definition.replace("feature.yaml", "reconcile.yaml"), "  - id: route");
    const root = mkdtempSync(join(tmpdir(), "omp-dagu-route-"));
    try {
      for (const [step, review, expected] of [
        ["dependency_review", "complete", "complete"], ["dependency_review", "rewind", "push-back"],
        ["conflict_review", "complete", "complete"], ["conflict_review", "rewind", "push-back"],
        ["merge_review", "none", "push-back"], ["implement", "rewind", "none"],
        ["triage", "complete", "none"], ["dependency_review", "none", "none"],
      ] as const) {
        const output = join(root, "output");
        writeFileSync(output, "");
        const result = runBash(route, { encoding: "utf8", env: { PATH: process.env.PATH, STEP: step, REVIEW: review, DAGU_OUTPUT_FILE: output } });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(output, "utf8"), `operation=${expected}\n`);
      }
      assert.match(source, /action: http.request[\s\S]*?method: POST/);
      assert.doesNotMatch(source, /dagu human-task|id: (complete|keep_waiting|unreconciled)\n|gh pr view/);
      assert.match(source, /id: leftovers\n/);
      assert.match(source, /id: orphan\n/);
      const feature = readFileSync(definition, "utf8");
      assert.match(feature, /condition: \$\{MERGE_POLL_RESULT.outputValues.ready\}\n      expected: "true"\n      interval_sec: 60/);
      assert.match(feature, /id: verify_merge_poll\n    depends: await_merge/);
      assert.match(feature, /id: close_gate\n    depends: verify_merged/);
      assert.match(feature, /id: merge_review[\s\S]*?condition: \$\{MERGE_POLL_RESULT.outputValues.recovery\}[\s\S]*?action: human.task[\s\S]*?rewind_to: rebase/);
      assert.match(feature, /id: reset_close_gate\n    action: state.delete[\s\S]*?scope: root_dag/);
      assert.match(feature, /id: mark_close_gate\n    depends: finish_close_gate\n    action: state.set/);
      assert.doesNotMatch(feature, /nohup|dependency-action|conflict-action|touch .*close-gate-succeeded/);
      assert.doesNotMatch(feature.slice(feature.indexOf("\n---\n")), /action: human.task/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

async function nativeRun(root: string, source: string, env: NodeJS.ProcessEnv = {}, args: string[] = []) {
  const path = join(root, "fixture.yaml");
  writeFileSync(path, source);
  try {
    const result = await execute(dagu!, ["start", "--run-id", "contract", path, ...args], {
      env: { ...process.env, DAGU_HOME: join(root, "dagu"), ...env },
      maxBuffer: 4 * 1024 * 1024,
    });
    return { status: 0, ...result };
  } catch (error) {
    const result = error as Error & { code: number; stdout: string; stderr: string };
    return { status: result.code, stdout: result.stdout, stderr: result.stderr };
  }
}

async function nativeStatus(root: string): Promise<string> {
  const { stdout } = await execute(dagu!, ["status", "--run-id", "contract", "fixture"], {
    env: { ...process.env, DAGU_HOME: join(root, "dagu") },
  });
  return stdout;
}

function contents(path: string): string {
  if (!existsSync(path)) return "";
  return readdirSync(path, { withFileTypes: true }).map((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? contents(child) : readFileSync(child, "utf8");
  }).join("\n");
}

test("Dagu 2.26.0 rendered feature POC=yes succeeds with its implementation and close path skipped", { skip: !dagu }, async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-dagu-native-poc-"));
  try {
    const primary = join(root, "primary"), bin = join(root, "bin"), calls = join(root, "calls");
    mkdirSync(join(primary, ".workspace", "dagu", "dags"), { recursive: true });
    mkdirSync(bin);
    execFileSync("git", ["init", "-q", primary]);
    writeFileSync(calls, "");
    writeFileSync(join(primary, ".workspace", "dagu", "dags", "poc.yaml"), readFileSync(definitions[1]!.replace("feature.yaml", "poc.yaml"), "utf8"));
    writeFileSync(join(bin, "dagu"), `#!/usr/bin/env bash
set -euo pipefail
export DAGU_HOME=${JSON.stringify(join(root, "dagu"))}
if [[ "$1" == enqueue ]]; then printf 'enqueue\\n' >> ${JSON.stringify(calls)}; fi
exec ${JSON.stringify(dagu)} "$@"
`, { mode: 0o755 });
    writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash
set -euo pipefail
[[ "$1 $2" == "issue comment" ]]
printf 'comment\\n' >> ${JSON.stringify(calls)}
`, { mode: 0o755 });
    const source = readFileSync(definitions[1]!, "utf8");
    // Supply only the human answer; every downstream step is the actual rendered graph.
    const steps = [...source.slice(0, source.indexOf("\nhandler_on:")).matchAll(/^  - id: (\S+)$/gm)]
      .map((match) => match[1]!).filter((step) => step !== "triage");
    const result = await nativeRun(root, source, {
      PATH: `${bin}:${process.env.PATH}`,
    }, [
      ...steps.flatMap((step) => ["--only", step]),
      "--output", "triage.POC=yes", "--output", "triage.QUESTION=Runtime behavior",
      "--output", "triage.BASIS=Unexercised runtime", "--output", "triage.REVIEW=",
      "--", "ISSUE=981", `PRIMARY=${primary}`, "BRANCH=dagu/issue-981",
      "BASE_BRANCH=main", "OMP_SESSION_ID=fixture",
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const status = await nativeStatus(root);
    assert.match(status, /Succeeded/);
    for (const step of ["start_gate", "implement", "verify_merge_poll", "merge_review", "verify_merged", "close_gate"]) {
      assert.match(status, new RegExp(`${step}[^\\n]*[Ss]kipped`), status);
    }
    assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["enqueue", "comment"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Dagu 2.26.0 native poll binding, exhausted-repeat guard and secret redaction", { skip: !dagu }, async () => {
  const source = readFileSync(definitions[0]!, "utf8");
  const token = "issue-966-fixture-not-a-real-credential";
  for (const { merged, state, mergeState, active, outcome, calls } of [
    { merged: true, state: "closed", mergeState: "clean", active: false, outcome: "merged", calls: 1 },
    { merged: false, state: "open", mergeState: "clean", active: true, outcome: "failure", calls: 2 },
    { merged: false, state: "closed", mergeState: "clean", active: true, outcome: "failure", calls: 1 },
    { merged: false, state: "open", mergeState: "clean", active: false, outcome: "failure", calls: 1 },
    { merged: false, state: "open", mergeState: "dirty", active: true, outcome: "recovery", calls: 1 },
    { merged: false, state: "open", mergeState: "behind", active: true, outcome: "recovery", calls: 1 },
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), "omp-dagu-native-poll-"));
    let requested = 0;
    const server = createServer((request, response) => {
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      requested++;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ merged, state, draft: false, mergeable_state: mergeState, auto_merge: active ? {} : null }));
    });
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      // Load the real tail, including merge_review; earlier feature steps require an implementation and reviewer transcript.
      const parent = source.slice(source.indexOf("  - id: await_merge"), source.indexOf("\nhandler_on:"))
        .replace("    depends: auto_merge\n", "    depends: rebase\n")
        .replaceAll("${steps.auto_merge.outputs.repo}", "fixture")
        .replaceAll("${steps.auto_merge.outputs.pr}", '"1"')
        .replace("      interval_sec: 60", "      interval_sec: 1\n      limit: 2");
      const child = source.slice(source.indexOf("---\nname: poll-pr-merged"), source.indexOf("---\nname: close-feature"))
        .replace("https://api.github.com/repos/${REPO}/pulls/${PR}", `http://127.0.0.1:${address.port}/repos/fixture/pulls/1`);
      const closeHeader = source.slice(source.indexOf("---\nname: close-feature"), source.indexOf("  - id: reset_close_gate"));
      const fixture = `shell: /run/current-system/sw/bin/bash
type: graph
params: {ISSUE: "966", RUN: contract, PRIMARY: "${root}", WORKTREE: "${root}", BRANCH: fixture, BASE_BRANCH: main, REQUIRED_CHECK: validate}
steps:
  - id: rebase
    run: "true"
${parent}
${child}
${closeHeader}  - id: closed
    run: echo close-gate-ran
`;
      const result = await nativeRun(root, fixture, { GH_TOKEN: token });
      assert.equal(result.status === 0, outcome !== "failure", `${result.stdout}\n${result.stderr}`);
      assert.equal(requested, calls);
      const status = await nativeStatus(root);
      if (outcome === "merged") {
        assert.match(status, /merge_review[^\n]*[Ss]kipped/, status);
        assert.match(status, /verify_merged[^\n]*[Ss]ucceeded/, status);
        assert.match(status, /close_gate[^\n]*[Ss]ucceeded/, status);
      } else if (outcome === "recovery") {
        assert.match(status, /Waiting/);
        assert.match(status, /merge_review[^\n]*[Ww]aiting/, status);
      }
      const evidence = contents(join(root, "dagu"));
      assert.equal(evidence.includes(token), false, "secret must not appear in persisted runtime evidence");
      assert.match(evidence, /merge observation: /);
      if (outcome === "failure") assert.match(result.stdout + result.stderr, /verify_merge_poll.*failed|Failed/s);
    } finally {
      const closed = once(server, "close");
      server.close();
      await closed;
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("Dagu 2.26.0 native worktree idempotence and root-DAG state reset", { skip: !dagu }, async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-dagu-native-state-"));
  const repo = join(root, "repo"), worktree = join(root, "worktree");
  try {
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-q", "--allow-empty", "-m", "base"]);
    const fixture = `name: feature
shell: /run/current-system/sw/bin/bash
type: graph
steps:
  - id: add
    working_dir: ${repo}
    action: git.worktree.add
    with: {path: ${worktree}, branch: fixture, create_branch: true, base: main}
  - id: add_again
    depends: add
    working_dir: ${repo}
    action: git.worktree.add
    with: {path: ${worktree}, branch: fixture, create_branch: true, base: main}
  - id: seed
    depends: add_again
    action: state.set
    with: {scope: root_dag, key: issue-966/contract/close-gate-succeeded, value: true}
  - id: reset
    depends: seed
    action: dag.run
    with: {dag: reset-close}
  - id: read
    depends: reset
    action: state.get
    with: {scope: root_dag, key: issue-966/contract/close-gate-succeeded, default: false}
    output: CLOSE_STATE
  - id: verify
    depends: read
    run: test '\${CLOSE_STATE.value}' = false
  - id: remove
    depends: verify
    working_dir: ${repo}
    action: git.worktree.remove
    with: {path: ${worktree}, branch: fixture, delete_branch: true, force_delete_branch: true}
  - id: remove_again
    depends: remove
    working_dir: ${repo}
    action: git.worktree.remove
    with: {path: ${worktree}, branch: fixture, delete_branch: true, force_delete_branch: true}
---
name: reset-close
shell: /run/current-system/sw/bin/bash
type: graph
steps:
  - id: delete
    action: state.delete
    with: {scope: root_dag, key: issue-966/contract/close-gate-succeeded}
`;
    const result = await nativeRun(root, fixture);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(existsSync(worktree), false);
    assert.equal(execFileSync("git", ["-C", repo, "branch", "--list", "fixture"], { encoding: "utf8" }), "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Dagu 2.26.0 native review POST fails on a stale expectedIteration", { skip: !dagu }, async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-dagu-native-review-"));
  let received: unknown;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received = { method: request.method, url: request.url, body: JSON.parse(body) };
    response.writeHead(409, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "expectedIteration is stale" }));
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const reconcile = readFileSync(definitions[0]!.replace("feature.yaml", "reconcile.yaml"), "utf8");
    const transition = reconcile.slice(reconcile.indexOf("  - id: transition"), reconcile.indexOf("  - id: orphan"));
    const fixture = `shell: /run/current-system/sw/bin/bash
type: graph
env:
  RUN: fixture
steps:
  - id: observe
    outputs:
      - name: api_url
      - name: step
      - name: iteration
    run: |
      printf 'api_url=http://127.0.0.1:${address.port}\\nstep=merge_review\\niteration=0\\n' >> "$DAGU_OUTPUT_FILE"
  - id: route
    depends: observe
    outputs:
      - name: operation
    run: printf 'operation=push-back\\n' >> "$DAGU_OUTPUT_FILE"
${transition}`;
    const result = await nativeRun(root, fixture);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(received, {
      method: "POST",
      url: "/api/v1/dag-runs/feature/fixture/human-tasks/merge_review/push-back?expectedIteration=0",
      body: {},
    });
    assert.match(contents(join(root, "dagu")), /409|expectedIteration is stale/);
  } finally {
    const closed = once(server, "close");
    server.close();
    await closed;
    rmSync(root, { recursive: true, force: true });
  }
});
