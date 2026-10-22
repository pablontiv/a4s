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
  // omp's SessionManager.getSessionDir() returns the per-primary bucket that holds the transcripts.
  const session = (repo: string) => join(home, ".omp", "agent", "sessions", encodePrimary(repo, home, tmp));
  const profileSession = join(home, ".omp", "profiles", "coordinador", "agent", "sessions", encodePrimary(primary, home, tmp));
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ dagRunDetails: { params: `PRIMARY=${primary}` } }));
  t.after(() => { globalThis.fetch = original; });
  for (const [cwd, dir] of [[foreign, session(foreign)], [linked, session(linked)], [primary, session(foreign)], [primary, profileSession], [primary, `${session(primary)}-other`]]) {
    const decision = await primarySessionDecision(event, { cwd: cwd!, sessionManager: { getSessionDir: () => dir! } });
    assert.ok(decision && "block" in decision);
    assert.ok(decision.reason.includes(`primary.expected=${primary}`));
    assert.ok(decision.reason.includes(`transcriptDir.expected=${session(primary)}`));
    assert.ok(decision.reason.includes(`transcriptDir.observed=${dir}`));
  }
  for (const cwd of [primary, alias, linked]) {
    assert.equal(await primarySessionDecision(event, { cwd, sessionManager: { getSessionDir: () => session(primary) } }), undefined);
    assert.equal(await primarySessionDecision(event, { cwd, sessionManager: { getSessionDir: () => join(session(primary), "date_session") } }), undefined);
  }
  const handlers: Record<string, Function> = {};
  extension({ on(name: string, handler: Function) { handlers[name] = handler; } });
  const request = await handlers.tool_call!(event, { cwd: primary, sessionManager: { getSessionDir: () => session(primary) } });
  assert.match(request.reason, /TRIAGE_REVIEW_REQUIRED/);
  await handlers.tool_call!({ toolName: "task", toolCallId: "review", input: { agent: "triage-reviewer", task: request.reason } });
  handlers.tool_result!({ toolName: "task", toolCallId: "review", input: {}, details: { results: [{ index: 0, id: "Review236", agent: "triage-reviewer", exitCode: 0, output: JSON.stringify({ poc: "no", behavior: "proven", question: "Already supported?", reason: "existing behavior" }) }] } });
  assert.equal(await handlers.tool_call!({ ...event, input: { command: `${event.input.command} --input REVIEW=Review236` } }, { cwd: primary, sessionManager: { getSessionDir: () => session(primary) } }), undefined);
  globalThis.fetch = async url => new Response(JSON.stringify(String(url).endsWith("/spec")
    ? { spec: `env:\n  - PRIMARY: ${JSON.stringify(primary)}\n` }
    : { dagRunDetails: { name: "feature", dagRunId: "run-236", params: "ISSUE=236" } }));
  assert.equal(await primarySessionDecision(event, { cwd: primary, sessionManager: { getSessionDir: () => session(primary) } }), undefined);
  const renderedMismatch = await primarySessionDecision(event, { cwd: foreign, sessionManager: { getSessionDir: () => session(foreign) } });
  assert.ok(renderedMismatch && "block" in renderedMismatch);
  assert.match(renderedMismatch.reason, /TRIAGE_PRIMARY_MISMATCH/);
  globalThis.fetch = async () => { throw new Error("offline"); };
  const failed = await primarySessionDecision(event, { cwd: primary, sessionManager: { getSessionDir: () => session(primary) } });
  assert.ok(failed && "block" in failed);
  assert.match(failed.reason, /TRIAGE_PRIMARY_CHECK_FAILED/);
  assert.ok(failed.reason.includes(`primary.observed=${primary}`));
  assert.ok(failed.reason.includes(`transcriptDir.observed=${session(primary)}`));
  assert.match(failed.reason, /primary.expected=<unresolved run PRIMARY>/);
  assert.match(failed.reason, /transcriptDir.expected=<unresolved PRIMARY transcript namespace>/);
  assert.match(failed.reason, /cause=offline/);
  assert.equal(await primarySessionDecision({ ...event, input: { command: event.input.command.replace("POC=no", "POC=yes") } }, { cwd: foreign, sessionManager: { getSessionDir: () => session(foreign) } }), undefined);
});

test("primary guard accepts effective profile/config namespaces and fails closed on runtime path errors", async t => {
  const keys = ["HOME", "OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_DIR", "PI_CODING_AGENT_DIR"] as const;
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  const root = await realpath(await mkdtemp(join(tmpdir(), "guard-profile-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primary = join(root, "primary");
  const home = join(root, "home");
  await mkdir(home);
  await mkdir(primary);
  execFileSync("git", ["init", "-q", primary]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ dagRunDetails: { params: `PRIMARY=${primary}` } }));
  t.after(() => { globalThis.fetch = originalFetch; });
  const tmp = await realpath(process.env.TMPDIR || "/tmp");
  const encoded = encodePrimary(primary, home, tmp);
  const coding = join(root, "coding dir");
  for (const [env, agent] of [
    [{ OMP_PROFILE: "work" }, join(home, ".omp", "profiles", "work", "agent")],
    [{ PI_PROFILE: "work" }, join(home, ".omp", "profiles", "work", "agent")],
    [{ OMP_PROFILE: "", PI_PROFILE: "work" }, join(home, ".omp", "agent")],
    [{ OMP_PROFILE: "default", PI_PROFILE: "work" }, join(home, ".omp", "agent")],
    [{ OMP_PROFILE: " work ", PI_PROFILE: "other", PI_CODING_AGENT_DIR: coding }, join(home, ".omp", "profiles", "work", "agent")],
    [{ OMP_PROFILE: "work", PI_CONFIG_DIR: ".custom", PI_CODING_AGENT_DIR: coding }, join(home, ".custom", "profiles", "work", "agent")],
    [{ PI_CONFIG_DIR: ".custom" }, join(home, ".custom", "agent")],
    [{ OMP_PROFILE: "", PI_PROFILE: "work", PI_CONFIG_DIR: ".custom", PI_CODING_AGENT_DIR: coding }, coding],
  ] as const) {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, { HOME: home }, env);
    const sessionDir = join(agent, "sessions", encoded);
    assert.equal(await primarySessionDecision(event, { cwd: primary, sessionManager: { getSessionDir: () => sessionDir } }), undefined, JSON.stringify(env));
    const mismatch = await primarySessionDecision(event, { cwd: primary, sessionManager: { getSessionDir: () => `${sessionDir}-other` } });
    assert.ok(mismatch && "block" in mismatch);
    assert.ok(mismatch.reason.includes(sessionDir));
  }
  const failure = await primarySessionDecision(event, {
    cwd: primary,
    sessionManager: { getSessionDir() { throw new Error("runtime transcript path unavailable"); } },
  });
  assert.ok(failure && "block" in failure);
  assert.match(failure.reason, /TRIAGE_PRIMARY_CHECK_FAILED.*runtime transcript path unavailable/);
});

test("PRIMARY encoding follows the DAG home, temporary, and absolute namespaces", () => {
  assert.equal(encodePrimary("/home/me", "/home/me", "/tmp"), "-");
  assert.equal(encodePrimary("/home/me/repo", "/home/me", "/tmp"), "-repo");
  assert.equal(encodePrimary("/tmp", "/home/me", "/tmp"), "-tmp");
  assert.equal(encodePrimary("/tmp/a:b\\c", "/home/me", "/tmp"), "-tmp-a-b-c");
  assert.equal(encodePrimary("/other/repo", "/home/me", "/tmp"), "--other-repo--");
});

test("session directory failures return a fail-closed decision with the original cause and diagnostic fields", async () => {
  const cwd = process.cwd();
  for (const [getSessionDir, cause] of [
    [() => { throw new Error("session directory unavailable"); }, /cause=session directory unavailable/],
    [() => undefined as unknown as string, /cause=.*paths\[0\].*must be of type string.*undefined/],
  ] as const) {
    const decision = await primarySessionDecision(event, { cwd, sessionManager: { getSessionDir } });
    assert.ok(decision && "block" in decision);
    assert.equal(decision.block, true);
    assert.match(decision.reason, /^TRIAGE_PRIMARY_CHECK_FAILED:/);
    assert.match(decision.reason, cause);
    assert.ok(decision.reason.includes(`primary.observed=${cwd}`));
    assert.match(decision.reason, /primary.expected=<unresolved run PRIMARY>/);
    assert.match(decision.reason, /transcriptDir.expected=<unresolved PRIMARY transcript namespace>/);
    assert.match(decision.reason, /transcriptDir.observed=<unavailable session transcript directory>/);
  }
});
