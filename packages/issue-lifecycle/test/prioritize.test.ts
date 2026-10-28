import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Receipt } from "../src/admission.ts";
import { fixtureArtifact } from "./fixtures/artifact.ts";
import { identity } from "../src/identity.ts";
import { USED_CONTRACTS } from "../src/artifact-receipt.ts";

const command = fileURLToPath(new URL("../bin/dagu-feature-prioritize.ts", import.meta.url));
const execute = promisify(execFile);
interface Entry { name: string; dagRunId: string; statusLabel: string; params: string; spec: string }
interface State { entries: Entry[]; queue: string[]; calls: string[][]; failure?: string; concurrency: number }

async function fixture(ids: string[], options: { waiting?: boolean; failure?: string; concurrency?: number; admitted?: boolean; ambiguous?: boolean; mismatch?: "params" | "spec" | "primary" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "prioritize-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  execFileSync("git", ["init", "-q", root]);
  const admitted = options.admitted !== false;
  const { version, commit, digest } = fixtureArtifact(root);
  const params = ["ISSUE=334", 'OMP_SESSION_ID=literal "quoted value" {"key":"value"}'];
  // Adopted feature/PoC definitions carry JSON-schema params and a literal
  // env.PRIMARY policy; receipt argv omits sourced defaults and policy fields.
  const entries = ids.map((id, i): Entry => ({
    name: i % 2 === 0 ? "feature" : "poc", dagRunId: id, statusLabel: options.waiting && id === "u" ? "waiting" : "queued",
    params: `BASE_BRANCH=main ISSUE=334 ${params[1]}${options.ambiguous ? " OMP_SESSION_ID=ambiguous" : ""}`,
    spec: `name: ${i % 2 === 0 ? "feature" : "poc"}\nqueue: repo\nparams:\n  type: object\n  additionalProperties: true\n  required: [ISSUE]\n  properties:\n    ISSUE:\n      type: string\n    BASE_BRANCH:\n      type: string\n      default: main\n    OMP_SESSION_ID:\n      type: string\n      default: ""\nenv:\n  - PRIMARY: ${JSON.stringify(root)}\nsteps:\n  - name: retained_${id}\n    command: echo original-${id}\n`,
  }));
  if (admitted) for (const entry of entries) {
    const path = join(root, ".git", "dagu-feature", "runs", entry.dagRunId, "receipt.json");
    mkdirSync(dirname(path), { recursive: true });
    const receipt: Receipt = {
      schemaVersion: 2, artifact: { version, commit, digest }, artifactSupport: identity.support, contracts: USED_CONTRACTS,
      sourceVersion: { version, commit, origin: "https://github.com/pablontiv/a4s.git" },
      deploymentFingerprint: "original-deployment",
      initial: {
        admittedAt: "2026-10-21T10:30:57.000Z",
        deployment: { installedDAG: { snapshot: entry.spec, relationship: "materialized-from-cache" }, config: { schemaVersion: 1, commit: "b".repeat(40), digest: "c".repeat(64) } },
        runtimeAndModels: {},
        execution: { primary: options.mismatch === "primary" ? "/different-primary" : realpathSync(root), repo: realpathSync(root), parameters: options.mismatch === "params" ? ["ISSUE=999"] : params, dagSnapshot: options.mismatch === "spec" ? `${entry.spec}# different snapshot\n` : entry.spec },
        eventsAndExternalState: {},
      },
      runReceipt: { dag: entry.name, run: entry.dagRunId, attempt: 1, observations: [] },
    };
    writeFileSync(path, JSON.stringify(receipt));
  }
  const initial: State = { entries, queue: ids.filter(id => entries.find(e => e.dagRunId === id)!.statusLabel === "queued"), calls: [], concurrency: options.concurrency ?? 1, ...(options.failure ? { failure: options.failure } : {}) };
  const statePath = join(root, "state.json");
  writeFileSync(statePath, JSON.stringify(initial));
  // Current deployment is deliberately unrelated to retained per-run exports.
  writeFileSync(join(root, "feature.yaml"), "name: feature\nqueue: changed\nsteps:\n  - command: echo CHANGED\n");
  writeFileSync(join(bin, "dagu"), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
if (args[0] === 'version') { console.log("2.24.0"); process.exit(0); }
const state = JSON.parse(fs.readFileSync(process.env.STATE, 'utf8'));
state.calls.push(args);
const save = () => fs.writeFileSync(process.env.STATE, JSON.stringify(state));
if (args[0] === 'dequeue') {
 const dir = path.join(process.env.DAGU_HOME, 'data', 'prioritize');
 const recovery = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0], 'recovery.json'), 'utf8'));
 assert.deepEqual(recovery.order.map(e => e.dagRunId), ${JSON.stringify(initial.queue)});
 for (const entry of recovery.entries) assert.equal(fs.readFileSync(entry.snapshot, 'utf8'), entry.spec);
 const id = args[2].split(':').at(-1);
 if (state.failure === 'dequeue-' + id) { save(); process.exit(17); }
 state.queue = state.queue.filter(value => value !== id);
 state.entries.find(e => e.dagRunId === id).statusLabel = 'hidden';
 save();
 if (state.failure === 'after-dequeue-' + id) process.exit(18);
} else if (args[0] === 'enqueue') {
 const id = args[args.indexOf('--run-id') + 1];
 if (state.failure === 'enqueue-' + id) { save(); console.error('controlled enqueue failure'); process.exit(19); }
 const entry = state.entries.find(e => e.dagRunId === id);
 assert.equal(args[args.indexOf('--name') + 1], entry.name);
 assert.equal(args[args.indexOf('--queue') + 1], 'repo');
 const snapshot = args[args.indexOf('--run-id') + 2];
 assert.equal(fs.readFileSync(snapshot, 'utf8'), entry.spec);
 if (${admitted}) assert.deepEqual(args.slice(args.indexOf('--') + 1), ${JSON.stringify(params)});
 else assert.equal(args.slice(args.indexOf('--') + 1).join(' '), entry.params);
 state.queue.push(id); entry.statusLabel = 'queued'; save();
} else { console.error('unexpected command'); process.exit(20); }
`);
  chmodSync(join(bin, "dagu"), 0o755);
  const requests: string[] = [];
  const state = () => JSON.parse(readFileSync(statePath, "utf8")) as State;
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    requests.push(url.pathname);
    const value = state();
    let body: unknown;
    if (url.pathname === "/api/v1/queues/repo") body = { name: "repo", maxConcurrency: value.concurrency };
    else if (url.pathname === "/api/v1/queues/repo/items") {
      // Multiple pages exercise native head-to-tail cursor capture.
      const offset = Number(url.searchParams.get("cursor") || 0);
      body = { items: value.queue.slice(offset, offset + 2).map(id => value.entries.find(e => e.dagRunId === id)), ...(offset + 2 < value.queue.length ? { nextCursor: String(offset + 2) } : {}) };
    } else {
      const match = /^\/api\/v1\/dag-runs\/([^/]+)\/([^/]+)(\/spec)?$/.exec(url.pathname);
      const entry = match && value.entries.find(e => e.name === match[1] && e.dagRunId === match[2] && e.statusLabel !== "hidden");
      if (entry) body = match![3] ? { spec: entry.spec } : { dagRunDetails: entry };
    }
    if (!body) { response.statusCode = 404; body = { message: "not found" }; }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  const target = entries.find(entry => entry.dagRunId === "u")!;
  return {
    root, initial, state, requests,
    async invoke() {
      try {
        const { stdout, stderr } = await execute(process.execPath, [command, target.name, "u"], {
          cwd: root, env: { ...process.env, DAGU_HOME: root, DAGU_URL: `http://127.0.0.1:${port}`, STATE: statePath, PATH: `${bin}:${process.env.PATH}` },
        });
        return { status: 0, stdout, stderr };
      } catch (error) {
        const result = error as { code: number; stdout: string; stderr: string };
        return { status: Number(result.code), stdout: result.stdout, stderr: result.stderr };
      }
    },
    close() { server.closeAllConnections(); server.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("prioritize continues adopted JSON-schema/env PRIMARY snapshots with original argv, defaults and immutable receipts", async () => {
  const f = await fixture(["a", "b", "u"], { admitted: true });
  const receipts = f.initial.entries.map(e => join(f.root, ".git", "dagu-feature", "runs", e.dagRunId, "receipt.json"));
  const bytes = receipts.map(path => readFileSync(path, "utf8"));
  try {
    const result = await f.invoke();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.state().queue, ["u", "a", "b"]);
    assert.match(result.stdout, /PRIORITIZED feature u queue=repo moved=2/);
    assert.match(result.stdout, /REQUEUED feature a/);
    assert.match(result.stdout, /REQUEUED poc b/);
    assert.deepEqual(receipts.map(path => readFileSync(path, "utf8")), bytes);
    assert.equal(f.state().concurrency, 1);
  } finally { f.close(); }
});

test("prioritize accepts receipt version 2 and rejects unsupported versions without dequeuing", async () => {
  for (const schemaVersion of [1, 2, 3, "2", null]) {
    const f = await fixture(["a", "b", "u"], { admitted: true });
    try {
      for (const entry of f.initial.entries) {
        const path = join(f.root, ".git", "dagu-feature", "runs", entry.dagRunId, "receipt.json");
        const receipt = JSON.parse(readFileSync(path, "utf8"));
        writeFileSync(path, JSON.stringify({ ...receipt, schemaVersion }));
      }
      const result = await f.invoke();
      if (schemaVersion === 2) {
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(f.state().queue, ["u", "a", "b"]);
      } else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Unsupported admission receipt schemaVersion=|hard cutover/);
        assert.deepEqual(f.state(), f.initial);
        assert.equal(existsSync(join(f.root, "data", "prioritize")), false);
      }
    } finally { f.close(); }
  }
});

test("prioritize reports moved=0 when the run is already first", async () => {
  const f = await fixture(["u", "a", "b"]);
  try {
    const result = await f.invoke();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "PRIORITIZED feature u queue=repo moved=0\n");
    assert.deepEqual(f.state(), f.initial);
  } finally { f.close(); }
});

test("prioritize rejects waiting with NOT_QUEUED and exit 1 unchanged", async () => {
  const f = await fixture(["a", "b", "u"], { waiting: true });
  try {
    const result = await f.invoke();
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "NOT_QUEUED feature u status=waiting\n");
    assert.deepEqual(f.state(), f.initial);
  } finally { f.close(); }
});

test("prioritize reports LOST with B's original parameters and usable snapshot when B re-enqueue fails", async () => {
  const f = await fixture(["a", "b", "u"], { failure: "enqueue-b" });
  try {
    const result = await f.invoke();
    assert.equal(result.status, 1);
    assert.deepEqual(f.state().queue, ["u", "a"]);
    const line = result.stderr.split("\n").find(line => line.startsWith("LOST poc b "))!;
    assert.ok(line, result.stderr);
    assert.ok(line.includes(`params=${JSON.stringify(f.initial.entries[1]!.params)}`));
    const operations = join(f.root, "data", "prioritize");
    const recovery = JSON.parse(readFileSync(join(operations, readdirSync(operations)[0]!, "recovery.json"), "utf8")) as { entries: { run: Entry; snapshot: string; args: string[] }[] };
    const b = recovery.entries.find(entry => entry.run.dagRunId === "b")!;
    assert.equal(readFileSync(b.snapshot, "utf8"), f.initial.entries[1]!.spec);
    assert.ok(line.includes(`argv=${JSON.stringify(["dagu", ...b.args])}`));
    assert.match(result.stderr, /INCOMPLETE/);
    assert.match(result.stdout, /REQUEUED feature a/);
  } finally { f.close(); }
});

test("prioritize preserves all other relative order when the target has successors", async () => {
  const f = await fixture(["a", "u", "b", "c"]);
  try {
    const result = await f.invoke();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.state().queue, ["u", "a", "b", "c"]);
    assert.match(result.stdout, /PRIORITIZED poc u queue=repo moved=3/);
  } finally { f.close(); }
});

for (const failure of ["dequeue-b", "after-dequeue-b"]) test(`prioritize recovers removed runs in order on ${failure}`, async () => {
  const f = await fixture(["a", "b", "u"], { failure });
  try {
    const result = await f.invoke();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /INCOMPLETE/);
    const queued = f.state().queue;
    assert.deepEqual([...queued].sort(), ["a", "b", "u"]);
    if (failure === "after-dequeue-b") assert.deepEqual(queued, ["u", "a", "b"]);
    else assert.deepEqual(queued, ["b", "u", "a"]);
  } finally { f.close(); }
});

test("prioritize requires repository concurrency one before mutation", async () => {
  const f = await fixture(["a", "b", "u"], { concurrency: 2 });
  try {
    const result = await f.invoke();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires maxConcurrency=1/);
    assert.deepEqual(f.state(), f.initial);
  } finally { f.close(); }
});

test("prioritize rejects a missing artifact-bound receipt before dequeue", async () => {
  const f = await fixture(["a", "b", "u"], { admitted: false, ambiguous: true });
  try {
    const result = await f.invoke();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Missing artifact-bound admission receipt.*nothing dequeued/);
    assert.deepEqual(f.state(), f.initial);
  } finally { f.close(); }
});

for (const mismatch of ["params", "spec", "primary"] as const) test(`prioritize rejects admission/native ${mismatch} mismatch before dequeue`, async () => {
  const f = await fixture(["a", "b", "u"], { admitted: true, mismatch });
  try {
    const result = await f.invoke();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Original admission.*mismatch.*nothing dequeued/);
    assert.deepEqual(f.state(), f.initial);
  } finally { f.close(); }
});
