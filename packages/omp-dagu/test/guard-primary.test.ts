import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import extension from "../src/triage/index.ts";
import { encodePrimary, primarySessionDecision } from "../src/triage/primary.ts";

const event = { toolName: "bash", toolCallId: "complete", input: { command: "dagu human-task complete feature --run-id run-236 --step triage --input POC=no" } };

test("primary guard rejects foreign repositories and transcript namespaces, preserving matching review flow", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "guard-primary-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primary = join(root, "primary");
  const foreign = join(root, "foreign");
  for (const repo of [primary, foreign]) {
    await mkdir(repo);
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "initial"]);
  }
  const linked = join(root, "linked");
  execFileSync("git", ["-C", primary, "worktree", "add", "--detach", linked]);
  const alias = join(root, "alias");
  await symlink(primary, alias);
  const home = await realpath(homedir());
  const tmp = await realpath(process.env.TMPDIR || "/tmp");
  const session = (repo: string) => join(home, ".omp", "agent", "sessions", encodePrimary(repo, home, tmp), "date_session");
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ dagRunDetails: { params: `PRIMARY=${primary}` } }));
  t.after(() => { globalThis.fetch = original; });
  for (const [cwd, dir] of [[foreign, session(foreign)], [linked, session(linked)], [primary, session(foreign)]]) {
    const decision = await primarySessionDecision(event, { cwd: cwd!, sessionManager: { getSessionDir: () => dir! } });
    assert.ok(decision && "block" in decision);
    assert.ok(decision.reason.includes(primary));
    assert.match(decision.reason, /omp -p --cwd/);
  }
  for (const cwd of [primary, alias, linked]) {
    assert.equal(await primarySessionDecision(event, { cwd, sessionManager: { getSessionDir: () => session(primary) } }), undefined);
  }
  const handlers: Record<string, Function> = {};
  extension({ on(name: string, handler: Function) { handlers[name] = handler; } });
  const request = await handlers.tool_call!(event, { cwd: primary, sessionManager: { getSessionDir: () => session(primary) } });
  assert.match(request.reason, /TRIAGE_REVIEW_REQUIRED/);
  await handlers.tool_call!({ toolName: "task", toolCallId: "review", input: { agent: "triage-reviewer", task: request.reason } });
  handlers.tool_result!({ toolName: "task", toolCallId: "review", input: {}, details: { results: [{ index: 0, id: "Review236", agent: "triage-reviewer", exitCode: 0, output: JSON.stringify({ poc: "no", behavior: "proven", question: "", reason: "existing behavior" }) }] } });
  assert.equal(await handlers.tool_call!({ ...event, input: { command: `${event.input.command} --input REVIEW=Review236` } }, { cwd: primary, sessionManager: { getSessionDir: () => session(primary) } }), undefined);
  globalThis.fetch = async () => { throw new Error("offline"); };
  const failed = await primarySessionDecision(event, { cwd: primary, sessionManager: { getSessionDir: () => session(primary) } });
  assert.ok(failed && "block" in failed);
  assert.match(failed.reason, /TRIAGE_PRIMARY_CHECK_FAILED/);
  assert.equal(await primarySessionDecision({ ...event, input: { command: event.input.command.replace("POC=no", "POC=yes") } }, { cwd: foreign, sessionManager: { getSessionDir: () => session(foreign) } }), undefined);
});

test("PRIMARY encoding follows the DAG home, temporary, and absolute namespaces", () => {
  assert.equal(encodePrimary("/home/me", "/home/me", "/tmp"), "-");
  assert.equal(encodePrimary("/home/me/repo", "/home/me", "/tmp"), "-repo");
  assert.equal(encodePrimary("/tmp", "/home/me", "/tmp"), "-tmp");
  assert.equal(encodePrimary("/tmp/a:b\\c", "/home/me", "/tmp"), "-tmp-a-b-c");
  assert.equal(encodePrimary("/other/repo", "/home/me", "/tmp"), "--other-repo--");
});
