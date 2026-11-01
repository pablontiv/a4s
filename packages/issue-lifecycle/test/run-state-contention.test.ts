import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { initializeStation } from "@a4s/launcher/station";
import { stationRoot, stationTransaction } from "@a4s/launcher/station-state";
import { artifactToken } from "@a4s/launcher/release";
import { leaseRun, type VerifiedRun } from "../src/run-artifact.ts";
import { receipt } from "./fixtures/reconcile-bench-classify.ts";
import { stationFixture } from "./fixtures/station.ts";
import { deferred, inProcessLock } from "./fixtures/state-lock.ts";

test("a feature-step transaction meets its deadline during two observers' repeated per-run verification", async t => {
  const f = stationFixture(t), artifact = await f.release("r1");
  await initializeStation(f.home, artifact, f.dependencies);
  const cached = await f.dependencies.inspect!(f.home, artifact), primary = join(f.root, "primary");
  const entered = Array.from({ length: 2 }, () => Array.from({ length: 4 }, deferred));
  const release = Array.from({ length: 2 }, () => Array.from({ length: 4 }, deferred));
  const dependencies = { ...f.dependencies, withFileLock: inProcessLock(100) };
  const observers = entered.map((runs, session) => (async () => {
    for (let index = 0; index < runs.length; index++) {
      const run = `session-${session}-run-${index}`, state = join(primary, ".git/dagu-feature/runs", run), path = join(state, "receipt.json");
      const value = receipt(primary, f.home, run, artifact);
      mkdirSync(state, { recursive: true }); writeFileSync(path, JSON.stringify(value));
      const { lease } = await leaseRun(primary, run, { ...dependencies, async verify() {
        runs[index]!.resolve();
        // Represents git lookup, station-tool hashes and full artifact inspection.
        await release[session]![index]!.promise;
        return { primary, home: f.home, state, path, receipt: value, cached };
      } });
      rmSync(join(stationRoot(f.home), "leases", `${lease.id}.json`));
    }
  })());
  try {
    for (let index = 0; index < 4; index++) {
      await Promise.all(entered.map(runs => runs[index]!.promise));
      assert.equal(await stationTransaction(f.home, async () => "feature-step committed", dependencies), "feature-step committed");
      for (const session of release) session[index]!.resolve();
    }
    await Promise.all(observers);
  } finally {
    for (const session of release) for (const gate of session) gate.resolve();
    await Promise.allSettled(observers);
  }
});

test("run lease commit rechecks immutable receipt bindings and cache presence without rejecting new observations", async t => {
  const f = stationFixture(t), artifact = await f.release("r1");
  await initializeStation(f.home, artifact, f.dependencies);
  const cached = await f.dependencies.inspect!(f.home, artifact), primary = join(f.root, "primary");
  for (const change of ["binding", "observation", "cache"] as const) {
    const run = `changed-${change}`, state = join(primary, ".git/dagu-feature/runs", run), path = join(state, "receipt.json");
    const value = receipt(primary, f.home, run, artifact), context: VerifiedRun = { primary, home: f.home, state, path, receipt: value, cached };
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value));
    const dispatch = leaseRun(primary, run, { ...f.dependencies, async verify() {
      const latest = structuredClone(value);
      if (change === "binding") latest.initial.execution.primary = "/another-primary";
      if (change === "observation") latest.runReceipt.observations.push({ at: "2026-10-29T00:00:00Z", dag: "feature", run, attempt: 1, category: "execution", kind: "status", data: "running" });
      writeFileSync(path, JSON.stringify(latest));
      if (change === "cache") rmSync(cached.directory, { recursive: true });
      return context;
    } });
    if (change === "binding") await assert.rejects(dispatch, /Run receipt changed during dispatch preparation/);
    else if (change === "cache") await assert.rejects(dispatch, { code: "ENOENT" });
    else assert.equal(artifactToken((await dispatch).lease.artifact), artifactToken(artifact));
  }
});
