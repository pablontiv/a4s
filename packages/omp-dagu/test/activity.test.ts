import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ACTIVITY_MAX_LENGTH,
  activityTarget,
  readActivity,
  sanitizeActivity,
} from "../src/status/activity.ts";
import type { RunDetails } from "../src/status/progress.ts";

const commandRun: RunDetails = {
  name: "feature",
  dagRunId: "a4s-issue-182",
  statusLabel: "running",
  params: "ISSUE=182 PRIMARY=/tmp/a4s OMP_SESSION_ID=session-main",
  nodes: [{ step: { id: "gate-id", name: "gate" }, statusLabel: "running" }],
};

const agentRun: RunDetails = {
  ...commandRun,
  statusLabel: "waiting",
  nodes: [{ step: { name: "implement" }, statusLabel: "waiting" }],
};

function message(timestamp: string, name: string, args: Record<string, unknown>): string {
  return JSON.stringify({
    type: "message",
    timestamp,
    message: { role: "assistant", content: [{ type: "toolCall", name, arguments: args }] },
  });
}

async function transcriptFixture(files: Record<string, string>): Promise<{ root: string; sessionDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "omp-dagu-activity-"));
  const sessionDir = path.join(root, "sessions");
  const artifacts = path.join(sessionDir, "2026-10-15_session-main");
  await mkdir(artifacts, { recursive: true });
  await writeFile(`${artifacts}.jsonl`, "coordinator\n");
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(artifacts, name), content);
  return { root, sessionDir };
}

async function activity(run: RunDetails, sessionDir: string, now = Date.parse("2026-10-15T16:00:12Z")) {
  const target = activityTarget(run);
  assert.ok(target);
  return readActivity("http://unused", run, target, { sessionDir, now: () => now }, new AbortController().signal);
}

test("command activity reads the last non-empty line from the Dagu step log", async () => {
  let requested = "";
  const server = createServer((request, response) => {
    requested = request.url ?? "";
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ content: "installing\nnpm test\n\n" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const target = activityTarget(commandRun);
    assert.deepEqual(target, {
      key: "dagrun:feature/a4s-issue-182:command:gate-id",
      kind: "command",
      step: "gate-id",
    });
    const result = await readActivity(
      `http://127.0.0.1:${address.port}`,
      commandRun,
      target,
      {},
      new AbortController().signal,
    );
    assert.equal(requested, "/api/v1/dag-runs/feature/a4s-issue-182/steps/gate-id/log?tail=3");
    assert.equal(result, "> npm test");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("agent activity renders the tool, intention and age", async () => {
  const fixture = await transcriptFixture({
    "Implement182.jsonl": `${message("2026-10-15T16:00:06Z", "bash", { i: "Restoring temporary pin adjustment", title: "Fallback", command: "true" })}\n`,
  });
  try {
    assert.equal(await activity(agentRun, fixture.sessionDir), "bash Restoring temporary pin adjustment (6s)");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("agent activity falls back to the principal tool argument when i is absent", async () => {
  const fixture = await transcriptFixture({
    "Implement182.jsonl": `${message("2026-10-15T16:00:10Z", "edit", { path: "src/status/activity.ts" })}\n`,
  });
  try {
    assert.equal(await activity(agentRun, fixture.sessionDir), "edit src/status/activity.ts (2s)");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("agent activity uses eval title before its principal argument and supports tool-only calls", async () => {
  for (const [args, expected] of [
    [{ title: "Probe", path: "fallback" }, "eval Probe (2s)"],
    [{}, "eval (2s)"],
  ] as const) {
    const fixture = await transcriptFixture({
      "Implement182.jsonl": `${message("2026-10-15T16:00:10Z", "eval", args)}\n`,
    });
    try {
      assert.equal(await activity(agentRun, fixture.sessionDir), expected);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("agent activity ignores a partial trailing JSONL entry", async () => {
  const complete = message("2026-10-15T16:00:00Z", "read", { i: "Reading stable entry" });
  const partial = message("2026-10-15T16:00:11Z", "edit", { i: "Incomplete entry" }).slice(0, 50);
  const fixture = await transcriptFixture({ "Implement182.jsonl": `${complete}\n${partial}` });
  try {
    assert.equal(await activity(agentRun, fixture.sessionDir), "read Reading stable entry (12s)");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("the newest retry transcript supplies agent activity", async () => {
  const fixture = await transcriptFixture({
    "Implement182.jsonl": `${message("2026-10-15T15:59:50Z", "read", { i: "Old attempt" })}\n`,
    "Implement182v2.jsonl": `${message("2026-10-15T16:00:10Z", "write", { i: "New attempt" })}\n`,
  });
  try {
    const artifacts = path.join(fixture.sessionDir, "2026-10-15_session-main");
    await utimes(path.join(artifacts, "Implement182.jsonl"), new Date(1000), new Date(1000));
    await utimes(path.join(artifacts, "Implement182v2.jsonl"), new Date(2000), new Date(2000));
    assert.equal(await activity(agentRun, fixture.sessionDir), "write New attempt (2s)");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("missing command logs and subagent transcripts leave activity empty", async () => {
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const fixture = await transcriptFixture({});
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const commandTarget = activityTarget(commandRun);
    assert.ok(commandTarget);
    assert.equal(await readActivity(
      `http://127.0.0.1:${address.port}`,
      commandRun,
      commandTarget,
      {},
      new AbortController().signal,
    ), undefined);
    assert.equal(await activity(agentRun, fixture.sessionDir), undefined);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("activity text replaces controls and truncates the widget payload", () => {
  const result = sanitizeActivity(`tool\u001b\n${"x".repeat(ACTIVITY_MAX_LENGTH + 40)}`);
  assert.equal(result.includes("\u001b"), false);
  assert.equal(result.includes("\n"), false);
  assert.equal(result.length, ACTIVITY_MAX_LENGTH);
  assert.equal(result.endsWith("…"), true);
});

test("agent activity resolves PRIMARY from the enqueued adoption spec", async t => {
  const fixture = await transcriptFixture({
    "Implement182.jsonl": `${message("2026-10-15T16:00:06Z", "bash", { i: "Reading rendered policy" })}\n`,
  });
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    spec: `env:\n  - PRIMARY: ${JSON.stringify(fixture.root)}\n`,
  })));
  try {
    assert.equal(await activity({ ...agentRun, params: "ISSUE=182 OMP_SESSION_ID=session-main" }, fixture.sessionDir), "bash Reading rendered policy (6s)");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
