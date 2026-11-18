import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, constants, copyFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createSupervisor } from "../supervisor/supervisor.ts";
import { poll, withStation } from "./station.mjs";

const path = (relative) => realpathSync(fileURLToPath(new URL(relative, import.meta.url)));

test("the supervisor starts, observes and resolves an isolated Dagu triage run", { timeout: 35_000 }, async ({ signal }) => {
  const definition = path("../../../.workspace/dagu/pilot/pi-triage-slice.yaml");
  const companion = path("../../../.workspace/dagu/pilot/pi-triage-slice.mjs");
  await withStation(definition, signal, async ({ sandbox, state, runs, opts }) => {
    const workerEntry = join(opts.cwd, "triage.mjs");
    copyFileSync(path("../worker/triage.mjs"), workerEntry, constants.COPYFILE_EXCL);
    chmodSync(workerEntry, 0o600);
    const profile = (access) => {
      const configPath = join(opts.cwd, `${access}.json`);
      writeFileSync(configPath, JSON.stringify({
        schemaVersion: 1, access, apiPort: sandbox.port,
        daguBin: realpathSync(sandbox.binary), daguHome: realpathSync(sandbox.home),
        daguConfig: realpathSync(sandbox.config), dagFile: realpathSync(sandbox.dagFile),
        workerEntry, stateRoot: realpathSync(state), pathDirs: [realpathSync(sandbox.bin)],
      }), { mode: 0o600 });
      return createSupervisor(configPath);
    };
    const manual = profile("supervise");
    const observer = profile("observe");
    const runId = `pi-slice-supervisor-${randomUUID()}`;
    assert.equal((await observer.start(runId, signal)).outcome, "read_only");
    assert.equal((await observer.status(runId, signal)).outcome, "not_found");
    runs.add(runId);
    assert.equal((await manual.start(runId, signal)).outcome, "started");
    const read = () => observer.status(runId, signal);
    const waiting = await poll("supervisor sees decide", read,
      (result) => result.snapshot?.phase === "awaiting_decision", signal);
    const { token, triage } = waiting.snapshot;
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.equal(triage.issue, "fixture-1");
    assert.equal(triage.runId, runId);
    const unexpectedConfirmation = () => assert.fail("non-writable or stale request asked for confirmation");
    assert.equal((await observer.decide(runId, "APPROVE", token, unexpectedConfirmation, signal)).outcome, "read_only");
    const staleToken = `${token[0] === "0" ? "1" : "0"}${token.slice(1)}`;
    assert.equal((await manual.decide(runId, "APPROVE", staleToken, unexpectedConfirmation, signal)).outcome, "stale");
    assert.equal((await manual.decide(runId, "APPROVE", token, async () => false, signal)).outcome, "denied");
    assert.deepEqual(await read(), waiting);
    const approved = await manual.decide(runId, "APPROVE", token, async (message) => {
      assert.ok(message.includes(runId) && message.includes("DECISION=APPROVE"));
      return true; // Exercises the adapter boundary, not the T3 composer UI.
    }, signal);
    assert.equal(approved.outcome, "completed");
    const closed = await poll("supervisor sees verdict", read,
      (result) => result.snapshot?.runStatus === "succeeded" && result.snapshot.verdict !== null, signal);
    assert.deepEqual(closed.snapshot.verdict, { schemaVersion: 1, runId, decision: "APPROVE" });
    assert.equal((await manual.decide(runId, "APPROVE", token, unexpectedConfirmation, signal)).outcome, "already_resolved");
    runs.delete(runId);
  }, { companions: [companion], prefixApi: false });
});
