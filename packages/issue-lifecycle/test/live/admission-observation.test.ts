import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { appendObservation, type Receipt } from "../../src/admission.ts";
import { inProcessAdmissionFixture } from "../fixtures/compiled-admission.ts";
import { identity } from "../../src/identity.ts";
import { roleAdmission } from "../role-job-fixtures.ts";

function fixture(t: TestContext, run: string) {
  const consumer = inProcessAdmissionFixture();
  t.after(() => consumer.dispose());
  const receipt = roleAdmission(consumer.packageDir, consumer.home, run, '"$A4S_BIN" role-jobs stage triage',
    { version: identity.version, commit: "a".repeat(40), digest: "b".repeat(64) });
  const path = consumer.receipt(run);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(receipt));
  return { path, receipt, read: () => JSON.parse(readFileSync(path, "utf8")) as Receipt };
}

function writer(t: TestContext, path: string, run: string, kind: string, pause = false) {
  const source = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const [path, run, kind, pause] = process.argv.slice(1);
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to === path) {
        fs.writeSync(1, "prepared\\n");
        if (pause === "yes") fs.readSync(0, Buffer.alloc(1), 0, 1, null);
      }
      return rename(from, to);
    };
    // Load after patching builtins so the child can stop at the real atomic-rename boundary.
    syncBuiltinESMExports();
    const { appendObservation } = await import(${JSON.stringify(new URL("../../src/admission.ts", import.meta.url).href)});
    fs.writeSync(1, "started\\n");
    appendObservation(path, { dag: "feature", run, attempt: 1, category: "execution", kind, data: { writer: kind } });
    fs.writeSync(1, "done\\n");
  `;
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", source,
    path, run, kind, pause ? "yes" : "no"], { stdio: ["pipe", "pipe", "pipe"], timeout: 8_000 });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const done = once(child, "close");
  t.after(async () => { child.kill("SIGKILL"); await done; });
  return { child, output: () => stdout,
    async ready(marker: string) {
      while (!stdout.includes(`${marker}\n`)) {
        await Promise.race([once(child.stdout, "data"), done.then(() => assert.fail(`Writer exited before ${marker}: ${stderr}`))]);
      }
    },
    async finish() {
      const [code, signal] = await done;
      assert.equal(code, 0, `${stderr}; signal=${signal}`);
      assert.match(stdout, /done\n/);
    }, done };
}

test("read-only observations retain legacy and immutable artifact fields despite orphaned mkdir locks", t => {
  const f = fixture(t, "legacy-observation");
  for (const schema of [1, 2] as const) {
    const receipt = structuredClone(f.receipt);
    receipt.schemaVersion = schema;
    if (schema === 1) { delete receipt.artifact; delete receipt.artifactSupport; delete receipt.contracts; }
    writeFileSync(f.path, JSON.stringify(receipt));
    mkdirSync(`${f.path}.lock`, { recursive: true });
    appendObservation(f.path, { dag: "feature", run: receipt.runReceipt.run, attempt: 1, category: "execution", kind: "read-only-report", data: { state: "retained" } });
    const observed = f.read();
    assert.deepEqual(observed.initial, receipt.initial);
    assert.deepEqual(observed.artifact, receipt.artifact);
    assert.deepEqual(observed.artifactSupport, receipt.artifactSupport);
    assert.deepEqual(observed.contracts, receipt.contracts);
    assert.equal(observed.schemaVersion, schema);
    assert.equal(observed.runReceipt.observations.length, 1);
    assert.equal(statSync(`${f.path}.flock`).isFile(), true);
  }
});

test("killing an observation writer before atomic rename releases its lock for another process", { timeout: 15_000 }, async t => {
  const f = fixture(t, "crash-observation");
  const interrupted = writer(t, f.path, f.receipt.runReceipt.run, "interrupted", true);
  await interrupted.ready("prepared");
  assert.equal(existsSync(`${f.path}.${interrupted.child.pid}.tmp`), true);
  assert.deepEqual(f.read(), f.receipt, "the interrupted append has not replaced the receipt");
  interrupted.child.kill("SIGKILL");
  const [code, signal] = await interrupted.done;
  assert.equal(code, null);
  assert.equal(signal, "SIGKILL");
  await writer(t, f.path, f.receipt.runReceipt.run, "recovered").finish();
  const observed = f.read();
  assert.deepEqual(observed.initial, f.receipt.initial);
  assert.deepEqual(observed.runReceipt.observations.map(row => row.kind), ["recovered"]);
  assert.equal(statSync(`${f.path}.flock`).isFile(), true);
});

test("two contending processes both persist their receipt observations", { timeout: 15_000 }, async t => {
  const f = fixture(t, "concurrent-observations");
  const first = writer(t, f.path, f.receipt.runReceipt.run, "first", true);
  await first.ready("prepared");
  const second = writer(t, f.path, f.receipt.runReceipt.run, "second");
  await second.ready("started");
  // Real processes and kernel flock cannot be advanced by fake timers.
  await sleep(150);
  assert.equal(second.output().includes("prepared\n"), false, "the second writer must wait outside the read/modify/write section");
  first.child.stdin.end("x");
  await Promise.all([first.finish(), second.finish()]);
  const observed = f.read();
  assert.deepEqual(observed.initial, f.receipt.initial);
  assert.deepEqual(observed.runReceipt.observations.map(row => [row.kind, row.data]), [
    ["first", { writer: "first" }], ["second", { writer: "second" }],
  ]);
});
