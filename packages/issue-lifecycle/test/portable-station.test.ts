import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseAllDocuments } from "yaml";
import { exampleConfig } from "../../launcher/src/config.ts";
import { agentDirectory } from "../src/agent-directory.ts";
import { main } from "../src/commands/bundle.ts";
import { LIFECYCLE_DAGS, materializeDag } from "../src/materialize.ts";
import { admittedCoordinator, planningTranscript } from "../src/planning-transcript.ts";
import { useStation } from "./fixtures/service-environment.ts";
import triageGuard from "../src/triage/index.ts";
import type { CallDecision } from "../src/triage/guard.ts";
import { enqueueArguments } from "../src/admission.ts";

async function run(args: string[], t: test.TestContext): Promise<{ out: string; err: string; code: number }> {
  const out: string[] = [], err: string[] = [];
  const previous = process.exitCode;
  process.exitCode = 0;
  t.mock.method(console, "log", (line: string) => { out.push(line); });
  t.mock.method(console, "error", (line: string) => { err.push(line); });
  await main(args);
  const code = Number(process.exitCode ?? 0);
  process.exitCode = previous;
  return { out: out.join("\n"), err: err.join("\n"), code };
}

test("release hashing emits byte-exact lowercase SHA-256 for empty, binary, spaced and dash-prefixed files", async t => {
  const dir = mkdtempSync(join(tmpdir(), "a4s hash "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binary = Buffer.from([0, 255, 10, 13, 0, 128, 7]);
  for (const [name, bytes] of [["empty", Buffer.alloc(0)], ["-binary patch", binary], ["text  with  spaces", Buffer.from("diff --git a b\n")]] as const) {
    const file = join(dir, name);
    writeFileSync(file, bytes);
    const result = await run(["sha256", "--file", file], t);
    assert.equal(result.code, 0, result.err);
    assert.equal(result.out, createHash("sha256").update(bytes).digest("hex"));
    assert.match(result.out, /^[a-f0-9]{64}$/);
    t.mock.restoreAll();
  }
  assert.equal((await run(["sha256", "--file", join(dir, "empty")], t)).out, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  t.mock.restoreAll();
  const missing = await run(["sha256", "--file", join(dir, "absent")], t);
  assert.equal(missing.code, 1);
  assert.equal(missing.out, "");
});

test("agent directory keeps profile precedence", () => {
  const saved = { ...process.env };
  try {
    for (const key of ["OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_DIR", "PI_CODING_AGENT_DIR"]) delete process.env[key];
    process.env.PI_PROFILE = "pi";
    assert.equal(agentDirectory("/home/u"), "/home/u/.omp/profiles/pi/agent");
    process.env.OMP_PROFILE = "omp";
    assert.equal(agentDirectory("/home/u"), "/home/u/.omp/profiles/omp/agent");
    process.env.OMP_PROFILE = "";
    assert.equal(agentDirectory("/home/u"), "/home/u/.omp/agent");
    process.env.OMP_PROFILE = "default";
    assert.equal(agentDirectory("/home/u"), "/home/u/.omp/agent");
    process.env.PI_CONFIG_DIR = ".custom";
    assert.equal(agentDirectory("/home/u"), "/home/u/.custom/agent");
    process.env.PI_CODING_AGENT_DIR = "/opt/agent";
    assert.equal(agentDirectory("/home/u"), "/opt/agent");
    process.env.OMP_PROFILE = "omp";
    assert.equal(agentDirectory("/home/u"), "/home/u/.custom/profiles/omp/agent");
    process.env.OMP_PROFILE = "  omp  ";
    process.env.PI_CONFIG_DIR = "/absolute/custom";
    assert.equal(agentDirectory("/home/u"), "/home/u/absolute/custom/profiles/omp/agent");
    delete process.env.OMP_PROFILE;
    assert.equal(agentDirectory("/home/u"), "/home/u/absolute/custom/profiles/pi/agent");
    process.env.PI_PROFILE = " ";
    assert.equal(agentDirectory("/home/u"), "/opt/agent");
  } finally {
    for (const key of ["OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_DIR", "PI_CODING_AGENT_DIR"]) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

function layout(root: string, session: string, reviews: string[] = ["REVIEW_1"], header = session): { parent: string; dir: string } {
  mkdirSync(root, { recursive: true });
  const parent = join(root, `2026-10-23T22-00-00Z_${session}.jsonl`);
  writeFileSync(parent, JSON.stringify({ type: "session", id: header }) + "\n");
  const dir = parent.slice(0, -".jsonl".length);
  mkdirSync(dir, { recursive: true });
  for (const review of reviews) writeFileSync(join(dir, `${review}.jsonl`), JSON.stringify({ type: "session", id: `child-${review}` }) + "\n");
  return { parent, dir };
}

test("planning lookup is bound to the admitted session and transcript root", t => {
  const dir = mkdtempSync(join(tmpdir(), "a4s planning root "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const service = join(dir, "service-home", ".omp", "agent", "sessions", "-primary");
  const admitted = join(dir, "custom profile", "agent", "sessions", "-primary");
  layout(service, "owner-session");
  const decoy = layout(join(dir, "other", "sessions"), "other-session");
  const found = layout(admitted, "owner-session");
  const coordinator = admittedCoordinator("owner-session", { sessionId: "owner-session", transcriptRoot: admitted });
  assert.deepEqual(coordinator, { session: "owner-session", transcriptRoot: admitted });
  assert.deepEqual(planningTranscript(coordinator, "owner-session", "REVIEW_1"), { transcript: join(found.dir, "REVIEW_1.jsonl"), parent: found.parent });
  assert.notEqual(found.dir, decoy.dir);
});

test("planning lookup fails closed without searching another root", t => {
  const dir = mkdtempSync(join(tmpdir(), "a4s planning fail "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "admitted");
  const fallback = join(dir, "home", ".omp", "agent", "sessions", "-primary");
  layout(fallback, "owner-session");
  const bound = { session: "owner-session", transcriptRoot: root };
  assert.throws(() => planningTranscript(null, "owner-session", "REVIEW_1"), /Missing admitted coordinating session/);
  assert.throws(() => planningTranscript(bound, "owner-session", "REVIEW_1"), /Cannot read admitted coordinating transcript root/);
  mkdirSync(root, { recursive: true });
  assert.throws(() => planningTranscript(bound, "owner-session", "REVIEW_1"), /found 0/);
  layout(root, "owner-session");
  assert.throws(() => planningTranscript(bound, "owner-session", "REVIEW_2"), /Missing planning reviewer transcript/);
  writeFileSync(join(root, "2026-10-24T00-00-00Z_owner-session.jsonl"), "");
  assert.throws(() => planningTranscript(bound, "owner-session", "REVIEW_1"), /found 2/);
  const foreign = join(dir, "foreign");
  layout(foreign, "owner-session", ["REVIEW_1"], "someone-else");
  assert.throws(() => planningTranscript({ session: "owner-session", transcriptRoot: foreign }, "owner-session", "REVIEW_1"), /Foreign or ambiguous/);
  assert.throws(() => planningTranscript({ session: "other", transcriptRoot: root }, "owner-session", "REVIEW_1"), /differs from OMP_SESSION_ID/);
});

test("admission binds coordinator evidence and rejects conflicts", () => {
  assert.equal(admittedCoordinator("owner-session", undefined), undefined);
  assert.equal(admittedCoordinator("owner-session", { sessionId: "owner-session" }), undefined);
  assert.throws(() => admittedCoordinator("owner-session", { sessionId: "other", transcriptRoot: "/root" }), /differs/);
  assert.throws(() => admittedCoordinator("owner-session", { transcriptRoot: "relative/root" }), /absolute directory/);
  assert.throws(() => admittedCoordinator("owner-session", { transcriptRoot: "/root/$HOME" }), /absolute directory/);
  assert.throws(() => admittedCoordinator("owner-session", { transcriptRoot: "/a" }, { session: "owner-session", transcriptRoot: "/b" }), /Ambiguous/);
  assert.throws(() => admittedCoordinator("owner-session", undefined, { session: "foreign", transcriptRoot: "/b" }), /Foreign/);
  assert.deepEqual(admittedCoordinator("owner-session", undefined, { session: "owner-session", transcriptRoot: "/b" }), { session: "owner-session", transcriptRoot: "/b" });
});

test("native tool interception retains the actual coordinating identity through CLI admission parsing", async t => {
  const dir = mkdtempSync(join(tmpdir(), "a4s coordinating profile "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transcriptRoot = join(dir, "custom", "profiles", "coordinator", "agent", "sessions", "-repo");
  const saved = process.env.DAGU_ADMISSION_SESSION;
  t.after(() => { if (saved === undefined) delete process.env.DAGU_ADMISSION_SESSION; else process.env.DAGU_ADMISSION_SESSION = saved; });
  let result: Promise<CallDecision> = Promise.resolve(undefined);
  triageGuard({ on: (_event, handler) => {
    result = Promise.resolve(handler({
      toolName: "bash", toolCallId: "admit",
      input: { command: 'for run in one; do dagu enqueue --run-id "$run" planning -- OMP_SESSION_ID=owner-session; done' },
    }, { cwd: dir, sessionManager: { getSessionId: () => "owner-session", getSessionDir: () => transcriptRoot } }));
  } }, async () => undefined);
  const decision = await result;
  assert.ok(decision && "input" in decision);
  const encoded = (decision.input.command as string).match(/DAGU_ADMISSION_SESSION='([^']+)'/);
  assert.ok(encoded, "the release-bound admission must receive captured native context");
  process.env.DAGU_ADMISSION_SESSION = encoded[1];
  const options = enqueueArguments(["--run-id", "one", "planning", "--", "OMP_SESSION_ID=owner-session"], dir);
  assert.equal(options.session?.sessionId, "owner-session");
  assert.equal(options.session?.transcriptRoot, transcriptRoot);
  assert.deepEqual(admittedCoordinator("owner-session", options.session), { session: "owner-session", transcriptRoot });
  assert.throws(() => admittedCoordinator("foreign-session", options.session), /differs from OMP_SESSION_ID/);
});

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
test("release templates hash only through the release executable and carry no ambient profile", t => {
  for (const name of LIFECYCLE_DAGS) assert.doesNotMatch(readFileSync(join(packageRoot, "skills/issue-execution", name), "utf8"), /shasum|\.omp\/agent\/sessions/, name);
  const home = mkdtempSync(join(tmpdir(), "a4s render "));
  const restore = useStation(home, "http://127.0.0.1:19643");
  t.after(() => { restore(); rmSync(home, { recursive: true, force: true }); });
  const saved = process.env.OMP_PROFILE;
  process.env.OMP_PROFILE = "bootstrap-caller";
  t.after(() => { if (saved === undefined) delete process.env.OMP_PROFILE; else process.env.OMP_PROFILE = saved; });
  const coordinator = { session: "owner-session", transcriptRoot: join(home, "profile with spaces", "sessions", "-primary") };
  const rendered = materializeDag(packageRoot, "planning.yaml", exampleConfig(), { version: "fixture", source: "fixture", executable: "/release/a4s", coordinator });
  const env = Object.assign({}, ...parseAllDocuments(rendered)[0]!.toJSON().env);
  assert.deepEqual(JSON.parse(env.COORDINATING_SESSION), coordinator);
  assert.doesNotMatch(rendered, /bootstrap-caller/);
  const none = Object.assign({}, ...parseAllDocuments(materializeDag(packageRoot, "planning.yaml", exampleConfig(), { version: "fixture", source: "fixture" })) [0]!.toJSON().env);
  assert.equal(none.COORDINATING_SESSION, "null");
});
