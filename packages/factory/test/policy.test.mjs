import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OUTCOMES, POLICY, planNext, validateState, retryExitCodes, outcomeForStatus } from "../src/lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const line = { model: "m", escalate_to: "big" };
const st = (outcome, extra = {}) => ({ attempts: [{ threadId: "t1", outcome, ...extra }] });

test("POLICY covers the vocabulary exactly", () => {
  assert.deepEqual(Object.keys(POLICY).sort(), [...OUTCOMES].sort());
  assert.deepEqual(POLICY, { pass: "stop", blocked: "resume", fail: "escalate", malformed: "escalate", stuck: "escalate", timeout: "escalate", cancelled: "same-model", infra: "reattach", violation: "halt" });
});

test("previous cancelled -> model, even after many attempts", () => {
  const s = { attempts: [{ outcome: "fail" }, { outcome: "fail" }, { outcome: "cancelled" }] };
  assert.deepEqual(planNext(line, s), { kind: "new", model: "m" });
});

test("previous blocked + answer -> same thread", () => {
  assert.deepEqual(planNext(line, st("blocked", { question: "q" }), { answer: "a" }), { kind: "resume", threadId: "t1" });
});

test("previous fail/malformed/timeout -> escalate_to", () => {
  for (const o of ["fail", "malformed", "stuck", "timeout"]) assert.deepEqual(planNext(line, st(o)), { kind: "new", model: "big" });
});

test("previous infra -> reattach", () => {
  assert.deepEqual(planNext(line, st("infra", { model: "m" })), { kind: "reattach", threadId: "t1", model: "m" });
});

test("unknown outcome in state is an error", () => {
  assert.throws(() => validateState(st("waiting")), /unknown outcome/);
  assert.throws(() => validateState(st("completed")), /unknown outcome/);
  assert.doesNotThrow(() => validateState(st(undefined)));
});

test("cycle.yaml retry_policy of every station step matches POLICY", () => {
  const dag = readFileSync(join(ROOT, "dags", "cycle.yaml"), "utf8");
  const steps = dag.split(/\n  - id: /).slice(1).filter((s) => s.includes("src/station.mjs"));
  const withPolicy = steps.filter((s) => /retry_policy:/.test(s));
  assert.ok(withPolicy.some((s) => s.startsWith("implement")), "implement declares a retry_policy");
  for (const s of withPolicy) {
    const m = s.match(/retry_policy:[\s\S]*?exit_code: \[([^\]]*)\]/);
    assert.ok(m, `${s.split("\n")[0]}: retry_policy exit_code`);
    const codes = m[1].split(",").map((x) => Number(x.trim())).sort((x, y) => x - y);
    assert.deepEqual(codes, retryExitCodes(), `${s.split("\n")[0]}: exit_code must be the codes of escalate outcomes`);
  }
});

test("terminal thread status -> outcome", () => {
  assert.equal(outcomeForStatus("cancelled"), "cancelled");
  for (const s of ["failed", "error", "interrupted", "idle"]) assert.equal(outcomeForStatus(s), "fail");
});

test("previous pass -> stop", () => {
  assert.equal(planNext(line, st("pass")).kind, "stop");
});

test("previous blocked without answer -> await on its own thread, never a new one", () => {
  const p = planNext(line, st("blocked", { question: "q" }));
  assert.equal(p.kind, "await");
  assert.equal(p.attempt.threadId, "t1");
});

test("infra without a thread (failed start) -> new attempt", () => {
  assert.deepEqual(planNext(line, { attempts: [{ outcome: "infra" }] }), { kind: "new", model: "m" });
});

test("lines.json: every line lists web_search and requires pi-web-search; QA has edit and write", () => {
  const { lines } = JSON.parse(readFileSync(join(ROOT, "lines.json"), "utf8"));
  for (const n of ["impl", "qa", "inbox", "research"]) {
    assert.ok(lines[n].instance.tools.some((x) => x.replace(/^\*/, "") === "web_search"), `${n} web_search`);
    assert.ok(lines[n].instance.packages.includes("pi-web-search"), `${n} package`);
  }
  for (const tool of ["read", "bash", "edit", "write"]) assert.ok(lines.qa.instance.tools.includes(tool), tool);
});

test("qa prompt and contracts state the permissions principle", () => {
  const qa = readFileSync(join(ROOT, "prompts", "qa.md"), "utf8");
  for (const s of ["npm ci", "selftest:stub", "Never run `scripts/factory-gate.sh` or `npm run selftest`", "daily selftest (check <name>)", "/tmp", "violation"]) assert.ok(qa.includes(s), s);
  const c = readFileSync(join(ROOT, "CONTRACTS.md"), "utf8");
  for (const s of ["Permissions contract", "integrate", "shared Git state", "QA does not change the candidate", "no secrets"]) assert.ok(c.includes(s), s);
  assert.match(readFileSync(join(ROOT, "..", "..", "AGENTS.md"), "utf8"), /permisos máximos/);
});

test("CONTRACTS.md: every src/ or test/ file the permissions table cites exists, and unenforced limits are declared", () => {
  const c = readFileSync(join(ROOT, "CONTRACTS.md"), "utf8");
  const sec = c.slice(c.indexOf("## Permissions contract"), c.indexOf("## DAG step contract"));
  const files = [...sec.matchAll(/`((?:src|test)\/[\w.-]+)`/g)].map((m) => m[1]);
  assert.ok(files.length >= 6);
  for (const f of files) assert.ok(existsSync(join(ROOT, f)), f);
  assert.equal((sec.match(/not enforced by code yet/g) || []).length, 2);
  assert.match(sec, /#1061/);
});

test("AGENTS.md: live-factory and secrets limits are declared prompt-only (#1061), not code-enforced", () => {
  const a = readFileSync(join(ROOT, "..", "..", "AGENTS.md"), "utf8");
  const sec = a.slice(a.indexOf("## Límites operativos"));
  assert.match(sec, /Aún no aplicados por código, solo regla de prompt/);
  assert.match(sec, /#1061/);
  const line = sec.split("\n").find((l) => l.includes("Aún no aplicados por código"));
  assert.match(line, /fábrica viva/); assert.match(line, /secretos/);
  assert.doesNotMatch(sec, /no con prohibiciones en prompts/);
  const enforced = sec.split("\n").find((l) => l.startsWith("- Aplicados por código"));
  assert.doesNotMatch(enforced, /fábrica viva|secretos/);
});
