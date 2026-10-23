import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { resourceDecision, shellWords } from "../src/resources.ts";
import extension from "../src/triage/index.ts";
import { withResourceGuard } from "./resource-fixtures.ts";

const definitions = ["../skills/dagu-feature/feature.yaml", "../../../.workspace/dagu/dags/feature.yaml"].map(path => fileURLToPath(new URL(path, import.meta.url)));
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dagu-resource-")));
  const primary = join(root, "primary space"), remote = join(root, "remote.git");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", primary]);
  git(primary, "config", "user.name", "Test"); git(primary, "config", "user.email", "test@example.com");
  writeFileSync(join(primary, "value"), "base\n");
  git(primary, "add", "."); git(primary, "commit", "-qm", "base");
  git(primary, "remote", "add", "origin", remote); git(primary, "push", "-qu", "origin", "main");
  writeFileSync(join(primary, ".git", "info", "exclude"), "/.workspace/\n");
  const bin = join(root, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "dagu"), `#!/bin/sh\nif [ -f '${root}/fail' ]; then echo 'history unavailable' >&2; exit 2; fi\ncat '${root}/'"$2"'.json'\n`);
  chmodSync(join(bin, "dagu"), 0o755);
  const history = (kind: string, rows: unknown[]) => writeFileSync(join(root, `${kind}.json`), JSON.stringify(rows));
  history("feature", []); history("poc", []);
  const worktree = join(primary, ".workspace", "worktrees", "issue-215"), branch = "dagu/issue-215";
  const row = (run: string, status: string, kind = "feature") => ({ name: kind, dagRunId: run, status, params: `PRIMARY=${primary} ISSUE=215 BRANCH=${kind === "feature" ? branch : ""}` });
  const env = { ...process.env, DAGU_PARAMS_JSON: "{}", PATH: `${bin}:${process.env.PATH}`, PRIMARY: primary, WORKTREE: worktree, BRANCH: branch, ISSUE: "215", RUN: "owner", OMP_SESSION_ID: "resource-test-session", BASE_BRANCH: "main", GATE: "true", REQUIRED_CHECK: "validate", DAGU_FEATURE_BUNDLE: "test" };
  return { root, primary, branch, worktree, git, history, row, env };
}
function script(definition: string, marker: string) {
  const lines = readFileSync(definition, "utf8").split("\n");
  const offset = lines.indexOf(marker);
  assert.notEqual(offset, -1, `missing ${marker} in ${definition}`);
  const anchor = lines.indexOf("    run: &feature_cleanup |");
  const start = anchor >= 0 && (marker === "  exit:" || marker === "  - id: close_gate")
    ? anchor : lines.indexOf("    run: |", offset);
  assert.notEqual(start, -1, `missing run block after ${marker}`);
  let end = start + 1;
  while (end < lines.length && (lines[end]!.startsWith("      ") || lines[end] === "")) end++;
  return withResourceGuard((marker === "  - id: close_gate" ? "CLEANUP_CLOSE=true\n" : "") +
    lines.slice(start + 1, end).map(line => line.slice(6)).join("\n"), definition);
}

test("shared shell words preserve Bash literal hashes, quoting and continuations", () => {
  for (const text of [
    "'quoted # text' \"double # text\" escaped\\#text foo#bar",
    '"backslash\\#hash" \'single\\#hash\'',
    "one \\\n two # ignored --input IMPLEMENTER=Other",
    "'' \"\" # trailing comment",
    "'single quoted \\\n continuation' \"double quoted \\\n continuation\"",
  ]) {
    const actual = execFileSync("bash", ["-c", `set -- ${text}\nprintf '%s\\0' "$@"`], { encoding: "utf8" }).split("\0").slice(0, -1);
    assert.deepEqual(shellWords(text), actual, text);
  }
});

test("resource guard honors comments and retains the following command boundary", async t => {
  const repo = fixture(), previousPath = process.env.PATH;
  process.env.PATH = repo.env.PATH;
  t.after(() => { process.env.PATH = previousPath; rmSync(repo.root, { recursive: true, force: true }); });
  repo.git(repo.primary, "worktree", "add", "-b", repo.branch, repo.worktree, "origin/main");
  repo.history("feature", [repo.row("owner", "waiting")]);
  const event = (command: string) => ({ toolName: "bash", toolCallId: "comment", input: { command } });
  assert.equal(await resourceDecision(event("echo safe # git branch -D dagu/issue-215"), repo.primary), undefined);
  const decision = await resourceDecision(event("echo safe # ignored\n git branch -D dagu/issue-215"), repo.primary);
  assert.ok(decision && "block" in decision && decision.block);
  assert.match(decision.reason!, /belongs to active run owner \(waiting\)/);
});

test("OMP bash resource guard protects feature and PoC owners in every active state and canonical alias", async t => {
  const repo = fixture(), previousPath = process.env.PATH;
  process.env.PATH = repo.env.PATH;
  t.after(() => { process.env.PATH = previousPath; rmSync(repo.root, { recursive: true, force: true }); });
  repo.git(repo.primary, "worktree", "add", "-b", repo.branch, repo.worktree, "origin/main");
  const poc = join(repo.primary, ".workspace", "worktrees", "poc-experiment");
  repo.git(repo.primary, "worktree", "add", "-b", "poc/experiment", poc, "origin/main");
  const alias = join(repo.root, "alias"); symlinkSync(repo.primary, alias);
  const directAlias = join(repo.root, "candidate"); symlinkSync(repo.worktree, directAlias);
  const snapshot = () => JSON.stringify([repo.git(repo.primary, "worktree", "list", "--porcelain"), repo.git(repo.primary, "show-ref"), repo.git(repo.primary, "rev-parse", "HEAD"), readFileSync(join(repo.worktree, "value"), "utf8")]);
  const before = snapshot();
  const handlers: Record<string, Function> = {};
  extension({ on(name: string, handler: Function) { handlers[name] = handler; } });
  for (const status of ["queued", "running", "waiting"]) {
    repo.history("feature", [repo.row("owner", status)]);
    repo.history("poc", [repo.row("experiment", status, "poc")]);
    for (const command of [
      'git worktree remove .workspace/worktrees/issue-215',
      `git -C '${alias}' worktree remove --force '${repo.worktree}'`,
      `cd '${alias}' && rm -rf .workspace/worktrees/issue-215`,
      `rm -r '${directAlias}'`,
      `rm -rf '${repo.worktree}/value'`,
      'git branch -D dagu/issue-215',
      'git branch -d dagu/issue-215',
      `git worktree remove '${poc}'`,
      `rm -rf '${poc}'`,
      'git branch -D poc/experiment',
    ]) {
      const decision = await handlers.tool_call!({ toolName: "bash", toolCallId: command, input: { command } }, { cwd: repo.primary });
      assert.equal(decision?.block, true, command);
      assert.match(decision.reason, new RegExp(`belongs to active run ${command.includes("experiment") ? "experiment" : "owner"} \\(${status}\\)`));
      assert.equal(snapshot(), before);
    }
  }
  repo.history("feature", [{ ...repo.row("branch-owner", "waiting"), params: `PRIMARY=${alias} BRANCH=${repo.branch}` }]);
  assert.match((await resourceDecision({ toolName: "bash", toolCallId: "alias", input: { command: `git worktree remove '${repo.worktree}'` } }, repo.primary) as { reason: string }).reason, /branch-owner/);
  assert.match((await resourceDecision({ toolName: "bash", toolCallId: "relative-cwd", input: { command: "git worktree remove .workspace/worktrees/issue-215", cwd: "primary space" } }, repo.root) as { reason: string }).reason, /branch-owner/);
  for (const command of ["rm -rf /", `rm -rf '${alias}'`, `rm -rf '${repo.root}'`, `git worktree remove '${repo.primary}'`, "git branch -D main"]) {
    assert.match((await resourceDecision({ toolName: "bash", toolCallId: command, input: { command } }, repo.primary) as { reason: string }).reason, /protected primary/);
  }
  assert.equal(snapshot(), before);
});

test("resource ownership resolves the enqueued adoption snapshot and derived feature branch", async t => {
  const repo = fixture(), previousPath = process.env.PATH;
  process.env.PATH = repo.env.PATH;
  t.after(() => { process.env.PATH = previousPath; rmSync(repo.root, { recursive: true, force: true }); });
  repo.git(repo.primary, "worktree", "add", "-b", repo.branch, repo.worktree, "origin/main");
  repo.history("feature", [{ ...repo.row("adopted-owner", "waiting"), params: "ISSUE=215 OMP_SESSION_ID=owner-session" }]);
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    assert.equal(new URL(String(url)).pathname, "/api/v1/dag-runs/feature/adopted-owner/spec");
    return Response.json({ spec: `env:\n  - PRIMARY: ${JSON.stringify(repo.primary)}\n` });
  });
  for (const command of ["git branch -D dagu/issue-215", `git worktree remove '${repo.worktree}'`]) {
    const decision = await resourceDecision({ toolName: "bash", toolCallId: command, input: { command } }, repo.primary);
    assert.ok(decision && "block" in decision);
    assert.match(decision.reason, /belongs to active run adopted-owner \(waiting\)/);
  }
});

test("terminal/unowned resources pass, ordinary paths keep behavior, history failures diagnose managed deletion", async t => {
  const repo = fixture(), previousPath = process.env.PATH; process.env.PATH = repo.env.PATH;
  t.after(() => { process.env.PATH = previousPath; rmSync(repo.root, { recursive: true, force: true }); });
  repo.git(repo.primary, "worktree", "add", "-b", repo.branch, repo.worktree, "origin/main");
  const event = (command: string) => ({ toolName: "bash", toolCallId: command, input: { command, cwd: repo.primary } });
  for (const status of ["succeeded", "failed", "aborted"]) {
    repo.history("feature", [repo.row("old", status)]);
    assert.equal(await resourceDecision(event(`git worktree remove '${repo.worktree}'`), "/"), undefined);
    assert.equal(await resourceDecision(event(`git branch -D ${repo.branch}`), "/"), undefined);
  }
  writeFileSync(join(repo.root, "fail"), "fail");
  assert.match((await resourceDecision(event(`rm -rf '${repo.worktree}'`), "/") as { reason: string }).reason, /cannot verify ownership.*history unavailable/s);
  assert.equal(await resourceDecision(event("rm -rf ordinary-directory"), "/"), undefined);
  assert.equal(await resourceDecision(event("rm -rf .workspace/ordinary-directory"), "/"), undefined);
  rmSync(join(repo.root, "fail"));
  repo.history("feature", Array.from({ length: 1000 }, (_, i) => repo.row(`other-${i}`, "waiting")));
  assert.match((await resourceDecision(event(`git worktree remove '${repo.worktree}'`), "/") as { reason: string }).reason, /ownership is incomplete/);
  repo.history("feature", [{ ...repo.row("owner", "waiting"), params: {} }]);
  assert.match((await resourceDecision(event(`git worktree remove '${repo.worktree}'`), "/") as { reason: string }).reason, /Malformed feature history row/);
  repo.history("feature", []);
  assert.equal(await resourceDecision(event(`git worktree remove '${repo.worktree}'`), "/"), undefined);
  repo.git(repo.primary, "worktree", "remove", repo.worktree); repo.git(repo.primary, "branch", "-D", repo.branch);
  assert.equal(existsSync(repo.worktree), false);
});

for (const definition of definitions) {
  test(`${definition} admission protects a feature owner resolved from its adopted snapshot`, t => {
    const repo = fixture(); t.after(() => rmSync(repo.root, { recursive: true, force: true }));
    repo.history("feature", [{ ...repo.row("adopted-owner", "waiting"), params: "ISSUE=215 OMP_SESSION_ID=owner-session" }]);
    const snapshot = join(repo.root, "snapshot.json");
    writeFileSync(snapshot, JSON.stringify({ spec: `env:\n  - PRIMARY: ${JSON.stringify(repo.primary)}\n` }));
    const curl = join(repo.root, "bin", "curl");
    writeFileSync(curl, `#!/bin/sh\ncat '${snapshot}'\n`);
    chmodSync(curl, 0o755);
    const result = spawnSync("bash", ["-c", script(definition, "  - id: admit")], { env: { ...repo.env, RUN: "requesting-run" }, encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /belongs to active run adopted-owner \(waiting\)/);
  });

  test(`${definition} admission/creation retries preserve candidate data, serialize claimants and transfer terminal ownership`, async t => {
    const repo = fixture(); t.after(() => rmSync(repo.root, { recursive: true, force: true }));
    const create = script(definition, "  - id: start_gate");
    repo.history("feature", [repo.row("owner", "running")]);
    const run = (extra = {}) => spawnSync("bash", ["-c", create], { env: { ...repo.env, ...extra }, encoding: "utf8" });
    let result = run(); assert.equal(result.status, 0, result.stderr);
    writeFileSync(join(repo.worktree, "value"), "candidate commit\n"); repo.git(repo.worktree, "add", "."); repo.git(repo.worktree, "commit", "-qm", "candidate");
    writeFileSync(join(repo.worktree, "untracked"), "preserve me\n");
    const head = repo.git(repo.worktree, "rev-parse", "HEAD");
    for (let i = 0; i < 2; i++) { result = run(); assert.equal(result.status, 0, result.stderr); }
    assert.equal(repo.git(repo.worktree, "rev-parse", "HEAD"), head);
    assert.equal(readFileSync(join(repo.worktree, "untracked"), "utf8"), "preserve me\n");
    result = run({ RUN: "intruder" }); assert.equal(result.status, 1); assert.match(result.stderr, /belongs to active run owner \(running\)/);
    writeFileSync(join(repo.root, "fail"), "fail");
    result = run(); assert.equal(result.status, 1); assert.match(result.stderr, /ownership history read failed/);
    rmSync(join(repo.root, "fail"));
    assert.equal(repo.git(repo.worktree, "rev-parse", "HEAD"), head);
    let owner = "owner";
    for (const terminal of ["failed", "aborted", "succeeded", "rejected", "partially_succeeded"]) {
      const replacement = `replacement-${terminal}`;
      repo.history("feature", [repo.row(owner, terminal), repo.row(replacement, "running")]);
      result = run({ RUN: replacement }); assert.equal(result.status, 0, result.stderr);
      assert.equal(repo.git(repo.worktree, "rev-parse", "HEAD"), head);
      assert.equal(readFileSync(join(repo.worktree, "untracked"), "utf8"), "preserve me\n");
      owner = replacement;
    }
    const cleanup = script(definition, "  exit:");
    result = spawnSync("bash", ["-c", cleanup], { env: repo.env, encoding: "utf8" });
    assert.equal(result.status, 1); assert.match(result.stderr, /belongs to active run replacement/);
    assert.equal(repo.git(repo.primary, "for-each-ref", "--format=%(refname)", "refs/heads/dagu/"), `refs/heads/${repo.branch}`);
    assert.equal(repo.git(repo.primary, "worktree", "list", "--porcelain").match(/worktree /g)?.length, 2);
  });

  test(`${definition} simultaneous admission selects one owner and same-owner concurrent creation converges`, async t => {
    const repo = fixture(); t.after(() => rmSync(repo.root, { recursive: true, force: true }));
    repo.history("feature", [repo.row("first", "queued"), repo.row("second", "queued")]);
    const admit = script(definition, "  - id: admit");
    const launch = (body: string, run: string) => new Promise<{ code: number | null; error: string }>(resolve => {
      const child = spawn("bash", ["-c", body], { env: { ...repo.env, RUN: run } }); let error = "";
      child.stderr.on("data", chunk => { error += chunk; }); child.on("close", code => resolve({ code, error }));
    });
    const outcomes = await Promise.all([launch(admit, "first"), launch(admit, "second")]);
    assert.deepEqual(outcomes.map(r => r.code).sort(), [0, 1]);
    const winner = outcomes[0]!.code === 0 ? "first" : "second";
    assert.match(outcomes.find(r => r.code === 1)!.error, /belongs to active run .* \(queued\)/);
    const create = script(definition, "  - id: start_gate");
    const creations = await Promise.all([launch(create, winner), launch(create, winner)]);
    assert.deepEqual(creations.map(r => r.code), [0, 0], JSON.stringify(creations));
    assert.equal(repo.git(repo.primary, "worktree", "list", "--porcelain").match(/worktree /g)?.length, 2);
    assert.equal(repo.git(repo.primary, "for-each-ref", "--format=%(refname)", "refs/heads/dagu/"), `refs/heads/${repo.branch}`);
  });
}

for (const path of ["../skills/dagu-feature/poc.yaml", "../../../.workspace/dagu/dags/poc.yaml"]) {
  const definition = fileURLToPath(new URL(path, import.meta.url));
  test(`${path} PoC concurrent retries reuse the canonical run candidate and preserve files`, async t => {
    const repo = fixture(); t.after(() => rmSync(repo.root, { recursive: true, force: true }));
    const state = join(repo.primary, ".git", "poc", "runs", "owner");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "base.sha"), repo.git(repo.primary, "rev-parse", "HEAD"));
    const worktree = join(repo.primary, ".workspace", "worktrees", "poc-owner");
    const env = { ...repo.env, WORKTREE: worktree };
    const create = script(definition, "  - id: worktree");
    const launch = () => new Promise<{ code: number | null; error: string }>(resolve => {
      const child = spawn("bash", ["-c", create], { env }); let error = "";
      child.stderr.on("data", chunk => { error += chunk; }); child.on("close", code => resolve({ code, error }));
    });
    const outcomes = await Promise.all([launch(), launch()]);
    assert.deepEqual(outcomes.map(result => result.code), [0, 0], JSON.stringify(outcomes));
    writeFileSync(join(worktree, "candidate"), "preserved\n");
    const retry = await launch(); assert.equal(retry.code, 0, retry.error);
    assert.equal(readFileSync(join(worktree, "candidate"), "utf8"), "preserved\n");
    assert.equal(repo.git(repo.primary, "for-each-ref", "--format=%(refname)", "refs/heads/poc/"), "refs/heads/poc/owner");
    assert.equal(repo.git(repo.primary, "worktree", "list", "--porcelain").match(/worktree /g)?.length, 2);
  });
}

for (const definition of [...definitions, ...["../skills/dagu-feature/poc.yaml", "../../../.workspace/dagu/dags/poc.yaml"].map(path => fileURLToPath(new URL(path, import.meta.url)))]) {
  test(`${definition} primary-target rejection preserves a primary without a managed directory`, t => {
    const repo = fixture(); t.after(() => rmSync(repo.root, { recursive: true, force: true }));
    const before = JSON.stringify([readdirSync(repo.primary), repo.git(repo.primary, "show-ref"), repo.git(repo.primary, "worktree", "list", "--porcelain"), readFileSync(join(repo.primary, "value"), "utf8")]);
    const markers = definition.endsWith("/poc.yaml") ? ["  - id: worktree", "  exit:"] : ["  - id: admit", "  - id: close_gate", "  exit:"];
    for (const marker of markers) {
      const result = spawnSync("bash", ["-c", script(definition, marker)], { env: { ...repo.env, WORKTREE: repo.primary }, encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /protected primary/);
      assert.equal(JSON.stringify([readdirSync(repo.primary), repo.git(repo.primary, "show-ref"), repo.git(repo.primary, "worktree", "list", "--porcelain"), readFileSync(join(repo.primary, "value"), "utf8")]), before);
    }
  });
}
