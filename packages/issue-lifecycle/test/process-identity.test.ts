import assert from "node:assert/strict";
import childProcess, { type ExecFileSyncOptions } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { probeProcess, processMatches, processStart } from "../../launcher/src/process-identity.ts";
import { executorAlive, executorIdentity, RoleJobStore, type JobBinding } from "../src/role-jobs.ts";
import { stopWorker, workerAlive } from "../src/long-computation.ts";

const starts: Record<string, string> = {
  C: "Thu Oct 29 05:49:57 2026",
  "es_MX.UTF-8": "jue oct 29 05:49:57 2026",
  "fr_FR.UTF-8": "jeu. oct. 29 05:49:57 2026",
};
const readyAt = "2026-10-29T05:50:00Z";

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a4s-process-identity-")));
  const repo = join(root, "repo"); mkdirSync(repo);
  const binding: JobBinding = { repo, worktree: repo, lane: "feature", dag: "feature", run: "feature-771",
    stage: "implement", role: "implement", sha: "a".repeat(40), iteration: 0, attempt: "locale-test" };
  const dead = new Set<number>();
  const reused = new Set<number>();
  const probes: Array<{ command: string; locale: string | undefined }> = [];
  let discoverable = true;
  t.mock.method(process, "kill", (pid: number) => {
    if (dead.has(pid)) throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    return true;
  });
  const saved = { ...process.env };
  const probe = t.mock.method(childProcess, "execFileSync", (command: string, args: string[], options: ExecFileSyncOptions) => {
    const locale = options.env?.LC_ALL || options.env?.LC_TIME || options.env?.LANG;
    probes.push({ command, locale });
    if (command === "locale") {
      assert.deepEqual(args, ["-a"]);
      if (!discoverable) throw new Error("locale inventory unavailable");
      return "C\nPOSIX\nes_MX.UTF-8\nfr_FR.UTF-8\n";
    }
    assert.equal(command, "ps");
    assert.deepEqual(args, ["-p", args[1], "-o", "lstart="]);
    const pid = Number(args[1]);
    if (dead.has(pid)) throw new Error("No such process");
    // Same day/time/year in a different month must not match a legacy owner.
    const started = starts[locale ?? "C"] ?? starts.C!;
    return `${reused.has(pid) ? started.replace(/Oct|oct/g, "Nov") : started}\n`;
  });
  syncBuiltinESMExports();
  t.after(() => {
    probe.mock.restore(); syncBuiltinESMExports();
    for (const key of ["LC_ALL", "LC_TIME", "LANG"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, binding, home: join(root, "dagu"), directory: join(root, "job"), dead, reused, probes,
    failDiscovery: () => { discoverable = false; } };
}

function operatorLocale() {
  process.env.LC_ALL = "fr_FR.UTF-8";
  process.env.LC_TIME = "es_MX.UTF-8";
  process.env.LANG = "fr_FR.UTF-8";
}

test("recover keeps a live executor running across caller locales and accepts its terminal result", t => {
  const f = fixture(t);
  process.env.LC_ALL = "es_MX.UTF-8";
  process.env.LC_TIME = "es_MX.UTF-8";
  let store = new RoleJobStore(f.home, 1);
  try {
    const claim = store.claim(f.binding, f.directory, readyAt, () => {});
    assert.equal(claim.kind, "claimed"); if (claim.kind !== "claimed") return;
    assert.equal(claim.job.executor.processStartedAt, `ps-c:${starts.C}`);
    store.close();
    operatorLocale();
    store = new RoleJobStore(f.home, 1);
    const recovered = store.claim(f.binding, f.directory, readyAt, () => {});
    assert.equal(recovered.kind, "active");
    if (recovered.kind === "active") assert.equal(recovered.job.state, "running");
    assert.ok(f.probes.every(probe => probe.command === "ps" && probe.locale === "C"));
    store.finish(claim.job, { schemaVersion: 1, id: claim.job.id, binding: f.binding, executor: claim.job.executor,
      state: "completed", readyAt, startedAt: claim.job.startedAt, finishedAt: readyAt, readyToStartMs: 0 });
    assert.equal(store.claim(f.binding, f.directory, readyAt, () => {}).kind, "terminal");
  } finally { store.close(); }
});

for (const locale of Object.keys(starts)) {
  test(`recover retains an immutable legacy ${locale} identity across locales`, t => {
    const f = fixture(t);
    process.env.LC_ALL = locale;
    // This is the pre-upgrade identity read, without a forced child locale.
    const legacy = { host: hostname(), pid: process.pid,
      processStartedAt: childProcess.execFileSync("ps", ["-p", String(process.pid), "-o", "lstart="],
        { encoding: "utf8", env: process.env }).trim() };
    const store = new RoleJobStore(f.home, 1);
    try {
      const claim = store.claim(f.binding, f.directory, readyAt, () => {}, legacy);
      assert.equal(claim.kind, "claimed"); if (claim.kind !== "claimed") return;
      operatorLocale();
      const recovered = store.claim(f.binding, f.directory, readyAt, () => {});
      assert.equal(recovered.kind, "active");
      if (recovered.kind === "active") {
        assert.equal(recovered.job.state, "running");
        assert.deepEqual(recovered.job.executor, legacy);
      }
      store.finish(claim.job, { schemaVersion: 1, id: claim.job.id, binding: f.binding, executor: legacy,
        state: "completed", readyAt, startedAt: claim.job.startedAt, finishedAt: readyAt, readyToStartMs: 0 });
    } finally { store.close(); }
  });
}

for (const recorded of [`ps-c:${starts.C}`, starts["es_MX.UTF-8"]!]) {
  for (const condition of ["dead", "reused"] as const) {
    test(`recover interrupts a ${condition} executor with ${recorded.startsWith("ps-c:") ? "fixed" : "legacy"} identity`, t => {
      const f = fixture(t);
      const owner = { host: hostname(), pid: 4321, processStartedAt: recorded };
      const store = new RoleJobStore(f.home, 1);
      try {
        assert.equal(store.claim(f.binding, f.directory, readyAt, () => {}, owner).kind, "claimed");
        f[condition].add(owner.pid);
        operatorLocale();
        const recovered = store.claim(f.binding, f.directory, readyAt, () => {});
        assert.equal(recovered.kind, "terminal");
        if (recovered.kind === "terminal") assert.equal(recovered.result.state, "interrupted");
      } finally { store.close(); }
    });
  }
}

test("legacy locale discovery failure preserves ownership instead of interrupting it", t => {
  const f = fixture(t);
  const store = new RoleJobStore(f.home, 1);
  try {
    const owner = { host: hostname(), pid: process.pid, processStartedAt: starts["es_MX.UTF-8"]! };
    assert.equal(store.claim(f.binding, f.directory, readyAt, () => {}, owner).kind, "claimed");
    f.failDiscovery();
    assert.throws(() => store.claim(f.binding, f.directory, readyAt, () => {}), /locale inventory unavailable/);
    const preserved = new RoleJobStore(f.home, 1, () => true);
    try { assert.equal(preserved.claim(f.binding, f.directory, readyAt, () => {}).kind, "active"); }
    finally { preserved.close(); }
  } finally { store.close(); }
});

test("worker liveness and stop use the same fixed and legacy identity comparison", t => {
  const f = fixture(t);
  const signals: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
  t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
    if (signal === 0) {
      if (f.dead.has(pid)) throw Object.assign(new Error("No such process"), { code: "ESRCH" });
      return true;
    }
    signals.push({ pid, signal }); return true;
  });
  operatorLocale();
  for (const recorded of [processStart(process.pid)!, starts["es_MX.UTF-8"]!]) {
    const worker = { schemaVersion: 1, pid: 4321, processStartedAt: recorded };
    writeFileSync(join(f.root, "worker.json"), JSON.stringify(worker));
    assert.equal(workerAlive(f.root), true);
    stopWorker(f.root);
    const count = signals.length;
    for (const condition of ["dead", "reused"] as const) {
      f[condition].add(worker.pid);
      assert.equal(workerAlive(f.root), false);
      stopWorker(f.root);
      assert.equal(signals.length, count);
      f[condition].clear();
    }
  }
  assert.deepEqual(signals, [{ pid: 4321, signal: "SIGTERM" }, { pid: 4321, signal: "SIGTERM" }]);
});

test("missing processes cannot record identities and foreign-host ownership stays uncertain/live", t => {
  const f = fixture(t);
  f.dead.add(process.pid);
  assert.equal(processStart(process.pid), undefined);
  assert.throws(executorIdentity, /could not record/);
  assert.equal(processMatches(process.pid, starts.C!), false);
  f.probes.length = 0;
  assert.equal(executorAlive({ host: `${hostname()}-foreign`, pid: process.pid, processStartedAt: starts.C! }), true);
  assert.deepEqual(f.probes, []);
});

test("ps failure is unknown, never evidence that an existing process is dead", t => {
  fixture(t);
  t.mock.method(childProcess, "execFileSync", () => { throw new Error("ps permission denied"); });
  syncBuiltinESMExports();
  assert.equal(probeProcess(process.pid, `ps-c:${starts.C}`), "unknown");
  assert.throws(() => processMatches(process.pid, `ps-c:${starts.C}`), /unknown.*ps permission denied/);
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("not permitted"), { code: "EPERM" }); });
  assert.equal(probeProcess(process.pid, `ps-c:${starts.C}`), "unknown");
});

test("tri-state probe distinguishes alive, missing and PID reuse", t => {
  const f = fixture(t), pid = 4321, start = `ps-c:${starts.C}`;
  assert.equal(probeProcess(pid, start), "alive");
  f.reused.add(pid);
  assert.equal(probeProcess(pid, start), "dead-or-reused");
  f.reused.delete(pid); f.dead.add(pid);
  assert.equal(probeProcess(pid, start), "dead-or-reused");
});
