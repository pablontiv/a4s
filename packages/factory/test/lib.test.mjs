import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT, exitFor, isUnreachable, parseVerdict, resolveT3, threadPhase } from "../src/lib.mjs";
import { instancesFromLines } from "../src/instances.mjs";

const FACTORY = join(dirname(fileURLToPath(import.meta.url)), "..");

test("parseVerdict takes the last JSON line, also inside a code fence", () => {
  const text = 'done\n```json\n{"verdict":"pass","findings":["ok"],"commit":"abc","question":null}\n```';
  assert.equal(parseVerdict(text).verdict, "pass");
  assert.equal(parseVerdict("no json here"), null);
  assert.equal(parseVerdict('{"verdict":"maybe"}'), null);
  assert.equal(parseVerdict('{"verdict":"pass"\n'), null);
});

test("exitFor maps verdicts to station exit codes", () => {
  assert.equal(exitFor({ verdict: "pass" }), EXIT.PASS);
  assert.equal(exitFor({ verdict: "blocked" }), EXIT.PASS);
  assert.equal(exitFor({ verdict: "fail" }), EXIT.WORKER_FAIL);
  assert.equal(exitFor(null), EXIT.MALFORMED);
});

test("isUnreachable recognises T3 server outages, not worker failures", () => {
  assert.ok(isUnreachable("No running T3 Code server uses /x. Start T3 Code, then retry."));
  assert.ok(isUnreachable("Could not reach the T3 Code server (HTTP 503)"));
  assert.ok(!isUnreachable("Run failed: tool error"));
});

test("threadPhase distinguishes idle, waiting and busy", () => {
  assert.equal(threadPhase({ status: "completed", activeRunId: null, pendingBackgroundTasks: [], pendingRequestCount: 0 }), "idle");
  assert.equal(threadPhase({ status: "running", activeRunId: "r", pendingBackgroundTasks: [], pendingRequestCount: 0 }), "busy");
  assert.equal(threadPhase({ status: "completed", activeRunId: null, pendingBackgroundTasks: [{}], pendingRequestCount: 0 }), "busy");
  assert.equal(threadPhase({ status: "waiting", activeRunId: null, pendingBackgroundTasks: [], pendingRequestCount: 1 }), "waiting");
});

test("resolveT3 follows the running server version and fails closed", () => {
  const home = mkdtempSync(join(tmpdir(), "t3home-")); const versions = mkdtempSync(join(tmpdir(), "t3v-"));
  assert.match(resolveT3(home, versions).error, /server-runtime/);
  mkdirSync(join(home, "userdata"));
  writeFileSync(join(home, "userdata", "server-runtime.json"), JSON.stringify({ serverVersion: "9.9.9", origin: "http://x" }));
  assert.match(resolveT3(home, versions).error, /no t3 CLI for server version 9.9.9/);
  mkdirSync(join(versions, "9.9.9")); writeFileSync(join(versions, "9.9.9", "t3"), "");
  assert.equal(resolveT3(home, versions).bin, join(versions, "9.9.9", "t3"));
});

test("line instances are isolated and restricted to their allowlist", () => {
  const inst = instancesFromLines(join(FACTORY, "lines.json"), "/bin/pi")["pi-impl"];
  const args = inst.config.launchArgs;
  for (const flag of ["--no-extensions", "--no-mcp", "--no-skills", "--no-context-files", "--tools"]) assert.ok(args.includes(flag), flag);
  assert.ok(args.includes(join(FACTORY, "prompts", "impl.md")));
  assert.deepEqual(inst.environment, [{ name: "A4S_LINE", value: "impl" }]);
});

test("the cycle DAG declares every station output", () => {
  const dag = readFileSync(join(FACTORY, "dags", "cycle.yaml"), "utf8");
  for (const k of ["result", "thread_id", "model", "question", "commit", "findings", "worktree"]) assert.ok(dag.includes(`{name: ${k}}`), k);
});

test("an absolute prompt path is kept absolute", () => {
  const dir = mkdtempSync(join(tmpdir(), "lines-"));
  const p = join(dir, "lines.json");
  writeFileSync(p, JSON.stringify({ lines: { impl: { provider: "pi-impl", instance: { prompt: "/abs/impl.md" } } } }));
  assert.ok(instancesFromLines(p, "/bin/pi")["pi-impl"].config.launchArgs.endsWith("--append-system-prompt /abs/impl.md"));
});

test("the cycle passes LINES straight through (no shell variables Dagu could expand)", () => {
  const dag = readFileSync(join(FACTORY, "dags", "cycle.yaml"), "utf8");
  assert.ok(dag.includes('--lines "$LINES"'));
  assert.ok(!dag.includes('lines="$LINES"'));
});
