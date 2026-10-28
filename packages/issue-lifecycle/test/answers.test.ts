import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  ANSWERS_PATH,
  ANSWERS_SCHEMA_VERSION,
  answersFromEnvironment,
  exampleAnswers,
  parseAnswers,
  readCommittedAnswers,
  serializeAnswers,
} from "../src/answers.ts";

test("answers schema rejects unknown fields, bad versions and non-integers", () => {
  const valid = exampleAnswers({ lane: "a4s", queueConcurrency: 8 });
  assert.equal(valid.schemaVersion, ANSWERS_SCHEMA_VERSION);
  assert.throws(() => parseAnswers({ ...valid, bootstrap: "run" }), /unknown field bootstrap/);
  assert.throws(() => parseAnswers({ ...valid, escalation: { ...valid.escalation, extra: 1 } }), /answers escalation rejected unknown field/);
  assert.throws(() => parseAnswers({ ...valid, schemaVersion: 2 }), /schemaVersion=2 expected 1/);
  assert.throws(() => parseAnswers({ ...valid, schemaVersion: "1" }), /schemaVersion="1" expected 1/);
  for (const queueConcurrency of [0, -1, 1.5, 9007199254740992, "8"]) {
    assert.throws(() => parseAnswers({ ...valid, queueConcurrency }), /queueConcurrency must be a positive integer/);
  }
  assert.throws(() => parseAnswers({ ...valid, blockerReporting: "sometimes" }), /blockerReporting="sometimes"/);
  assert.throws(() => parseAnswers({ ...valid, lane: "" }), /answers lane is invalid/);
  assert.equal(serializeAnswers(valid).endsWith("\n"), true);
  assert.deepEqual(parseAnswers(JSON.parse(serializeAnswers(valid))), valid);
});

test("bootstrap environment becomes the strict answers document", () => {
  const answers = answersFromEnvironment({
    REPO: "a4s", BASE_BRANCH: "main", QUEUE_CONCURRENCY: "8", GATE: "npm test",
    REQUIRED_CHECK: "validate", TEST_PATHS: "test", REBASE_RESOLVER: "",
    A4S_BLOCKER_REPORTING: "ask", CODE_SCANNING: "required",
    CODEQL_SECURITY_THRESHOLD: "high_or_higher", CODEQL_ALERTS_THRESHOLD: "errors",
    ESCALATION_PUSHBACKS: "3", ESCALATION_FINDINGS: "2", ESCALATION_SECONDS: "3600",
    ESCALATION_CI_BLOCKED: "2", ESCALATION_POC_INCONCLUSIVE: "2",
  });
  assert.equal(answers.lane, "a4s");
  assert.equal(answers.queueConcurrency, 8);
  assert.equal(answers.validation, "");
  assert.throws(() => answersFromEnvironment({
    REPO: "a4s", BASE_BRANCH: "main", QUEUE_CONCURRENCY: "0", GATE: "npm test",
    REQUIRED_CHECK: "validate", TEST_PATHS: "test",
    A4S_BLOCKER_REPORTING: "ask", CODE_SCANNING: "required",
    CODEQL_SECURITY_THRESHOLD: "high_or_higher", CODEQL_ALERTS_THRESHOLD: "errors",
    ESCALATION_PUSHBACKS: "3", ESCALATION_FINDINGS: "2", ESCALATION_SECONDS: "3600",
    ESCALATION_CI_BLOCKED: "2", ESCALATION_POC_INCONCLUSIVE: "2",
  }), /QUEUE_CONCURRENCY must be a positive integer/);
});

test("committed answers reject a missing, dirty or invalid file", () => {
  const repo = mkdtempSync(join(tmpdir(), "a4s-answers-"));
  const path = join(repo, ANSWERS_PATH);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  try {
    git("init", "-b", "main");
    git("config", "user.email", "answers@example.test");
    git("config", "user.name", "Answers Test");
    git("commit", "-qm", "empty", "--allow-empty");
    assert.throws(() => readCommittedAnswers(repo), /missing committed answers file/);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{");
    git("add", ANSWERS_PATH);
    git("commit", "-qm", "broken");
    assert.throws(() => readCommittedAnswers(repo), /invalid JSON/);
    writeFileSync(path, serializeAnswers(exampleAnswers({ lane: "fixture" })));
    git("add", ANSWERS_PATH);
    git("commit", "-qm", "answers");
    const loaded = readCommittedAnswers(repo);
    assert.equal(loaded.answers.lane, "fixture");
    assert.equal(loaded.digest.length, 64);
    writeFileSync(path, serializeAnswers(exampleAnswers({ lane: "other" })));
    assert.throws(() => readCommittedAnswers(repo), /uncommitted answers file/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
