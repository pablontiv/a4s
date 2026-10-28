import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resourceDecision as decideResources, shellWords, type ResourceExecutor } from "../src/resources.ts";
import extension from "../src/triage/index.ts";
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
  const execute: ResourceExecutor = async (file, args) => {
    assert.equal(file, "dagu");
    assert.deepEqual(args, ["history", args[1], "--format", "json", "--from", "1970-01-01", "--status", "queued,running,waiting", "--limit", "1000"]);
    if (existsSync(join(root, "fail"))) throw new Error("history unavailable");
    return { stdout: readFileSync(join(root, `${args[1]}.json`), "utf8") };
  };
  const history = (kind: string, rows: unknown[]) => writeFileSync(join(root, `${kind}.json`), JSON.stringify(rows));
  history("feature", []); history("poc", []);
  const worktree = join(primary, ".workspace", "worktrees", "issue-215"), branch = "dagu/issue-215";
  const row = (run: string, status: string, kind = "feature") => ({ name: kind, dagRunId: run, status, params: `PRIMARY=${primary} ISSUE=215 BRANCH=${kind === "feature" ? branch : ""}` });
  const resourceDecision: typeof decideResources = (event, cwd) => decideResources(event, cwd, execute);
  return { root, primary, branch, worktree, git, history, row, resourceDecision };
}

test("shared shell words preserve Bash literal hashes, quoting and continuations", () => {
  for (const [text, expected] of [
    ["'quoted # text' \"double # text\" escaped\\#text foo#bar", ["quoted # text", "double # text", "escaped#text", "foo#bar"]],
    ['"backslash\\#hash" \'single\\#hash\'', ["backslash\\#hash", "single\\#hash"]],
    ["one \\\n two # ignored --input IMPLEMENTER=Other", ["one", "two"]],
    ["'' \"\" # trailing comment", ["", ""]],
    ["'single quoted \\\n continuation' \"double quoted \\\n continuation\"", ["single quoted \\\n continuation", "double quoted  continuation"]],
  ] as const) assert.deepEqual(shellWords(text), expected, text);
});

test("resource guard honors comments and retains the following command boundary", async t => {
  const repo = fixture(), resourceDecision = repo.resourceDecision;
  t.after(() => rmSync(repo.root, { recursive: true, force: true }));
  repo.git(repo.primary, "worktree", "add", "-b", repo.branch, repo.worktree, "origin/main");
  repo.history("feature", [repo.row("owner", "waiting")]);
  const event = (command: string) => ({ toolName: "bash", toolCallId: "comment", input: { command } });
  assert.equal(await resourceDecision(event("echo safe # git branch -D dagu/issue-215"), repo.primary), undefined);
  const decision = await resourceDecision(event("echo safe # ignored\n git branch -D dagu/issue-215"), repo.primary);
  assert.ok(decision && "block" in decision && decision.block);
  assert.match(decision.reason!, /belongs to active run owner \(waiting\)/);
});

test("OMP bash resource guard protects feature and PoC owners in every active state and canonical alias", async t => {
  const repo = fixture(), resourceDecision = repo.resourceDecision;
  t.after(() => rmSync(repo.root, { recursive: true, force: true }));
  repo.git(repo.primary, "worktree", "add", "-b", repo.branch, repo.worktree, "origin/main");
  const poc = join(repo.primary, ".workspace", "worktrees", "poc-experiment");
  repo.git(repo.primary, "worktree", "add", "-b", "poc/experiment", poc, "origin/main");
  const alias = join(repo.root, "alias"); symlinkSync(repo.primary, alias);
  const directAlias = join(repo.root, "candidate"); symlinkSync(repo.worktree, directAlias);
  const snapshot = () => JSON.stringify([repo.git(repo.primary, "worktree", "list", "--porcelain"), repo.git(repo.primary, "show-ref"), repo.git(repo.primary, "rev-parse", "HEAD"), readFileSync(join(repo.worktree, "value"), "utf8")]);
  const before = snapshot();
  const handlers: Record<string, Function> = {};
  extension({ on(name: string, handler: Function) { handlers[name] = handler; } }, resourceDecision);
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
  const repo = fixture(), resourceDecision = repo.resourceDecision;
  t.after(() => rmSync(repo.root, { recursive: true, force: true }));
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

test("resource guard allows independent clone removal and keeps active admitted primaries", async t => {
  const repo = fixture(), resourceDecision = repo.resourceDecision;
  t.after(() => rmSync(repo.root, { recursive: true, force: true }));
  const scratch = join(repo.root, "scratch clone");
  execFileSync("git", ["init", "-q", "-b", "main", scratch]);
  repo.git(scratch, "config", "user.name", "Test"); repo.git(scratch, "config", "user.email", "test@example.com");
  writeFileSync(join(scratch, "value"), "scratch\n");
  repo.git(scratch, "add", "."); repo.git(scratch, "commit", "-qm", "scratch");
  const event = (command: string) => ({ toolName: "bash", toolCallId: command, input: { command } });
  const reason = async (command: string, cwd = repo.primary) =>
    (await resourceDecision(event(command), cwd) as { reason?: string }).reason ?? "";
  t.mock.method(globalThis, "fetch", async () => Response.json({ spec: `env:\n  - PRIMARY: ${JSON.stringify(repo.primary)}\n` }));

  assert.equal(await resourceDecision(event(`rm -rf '${scratch}'`), repo.primary), undefined);
  assert.equal(await resourceDecision(event(`git -C '${scratch}' branch -D main`), repo.primary), undefined);

  repo.history("feature", [repo.row("owner", "running")]);
  assert.equal(await resourceDecision(event(`rm -rf '${scratch}'`), repo.primary), undefined);
  assert.equal(await resourceDecision(event(`git -C '${scratch}' branch -D main`), scratch), undefined);
  assert.match(await reason(`rm -rf '${repo.primary}'`, scratch), /protected primary/);
  assert.match(await reason(`rm -rf '${repo.root}'`, scratch), /protected primary/);
  assert.match(await reason("git branch -D main", repo.primary), /protected primary/);

  repo.history("feature", [{ ...repo.row("adopted-owner", "waiting"), params: "ISSUE=215 OMP_SESSION_ID=owner-session" }]);
  assert.match(await reason(`rm -rf '${repo.primary}'`, scratch), /protected primary/);
  assert.equal(await resourceDecision(event(`rm -rf '${scratch}'`), scratch), undefined);

  repo.history("feature", []);

  repo.git(repo.primary, "worktree", "add", "-b", repo.branch, repo.worktree, "origin/main");
  repo.history("feature", [repo.row("owner", "waiting")]);
  assert.match(await reason(`rm -rf '${repo.worktree}'`), /belongs to active run owner \(waiting\)/);

  writeFileSync(join(repo.root, "fail"), "fail");
  assert.match(await reason(`rm -rf '${scratch}'`, scratch), /cannot verify ownership.*history unavailable/s);
});

test("terminal/unowned resources pass, ordinary paths keep behavior, history failures diagnose managed deletion", async t => {
  const repo = fixture(), resourceDecision = repo.resourceDecision;
  t.after(() => rmSync(repo.root, { recursive: true, force: true }));
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

