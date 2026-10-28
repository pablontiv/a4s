import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  CONFIG_PATH,
  CONFIG_SCHEMA_VERSION,
  configFromEnvironment,
  exampleConfig,
  parseConfig,
  readCommittedConfig,
  serializeConfig,
} from "../src/config.ts";

test("config schema rejects unknown fields, bad versions and non-integers", () => {
  const valid = exampleConfig({ lane: "a4s", queueConcurrency: 8 });
  assert.equal(valid.schemaVersion, CONFIG_SCHEMA_VERSION);
  assert.throws(() => parseConfig({ ...valid, bootstrap: "run" }), /unknown field bootstrap/);
  assert.throws(() => parseConfig({ ...valid, escalation: { ...valid.escalation, extra: 1 } }), /config escalation rejected unknown field/);
  assert.throws(() => parseConfig({ ...valid, schemaVersion: 2 }), /schemaVersion=2 expected 1/);
  assert.throws(() => parseConfig({ ...valid, schemaVersion: "1" }), /schemaVersion="1" expected 1/);
  for (const queueConcurrency of [0, -1, 1.5, 9007199254740992, "8"]) {
    assert.throws(() => parseConfig({ ...valid, queueConcurrency }), /queueConcurrency must be a positive integer/);
  }
  assert.throws(() => parseConfig({ ...valid, blockerReporting: "sometimes" }), /blockerReporting="sometimes"/);
  assert.throws(() => parseConfig({ ...valid, lane: "" }), /config lane is invalid/);
  assert.equal(serializeConfig(valid).endsWith("\n"), true);
  assert.deepEqual(parseConfig(JSON.parse(serializeConfig(valid))), valid);
});

test("bootstrap environment becomes the strict config document", () => {
  const config = configFromEnvironment({
    REPO: "a4s", BASE_BRANCH: "main", QUEUE_CONCURRENCY: "8", GATE: "npm test",
    REQUIRED_CHECK: "validate", TEST_PATHS: "test", REBASE_RESOLVER: "",
    A4S_BLOCKER_REPORTING: "ask", CODE_SCANNING: "required",
    CODEQL_SECURITY_THRESHOLD: "high_or_higher", CODEQL_ALERTS_THRESHOLD: "errors",
    ESCALATION_PUSHBACKS: "3", ESCALATION_FINDINGS: "2", ESCALATION_SECONDS: "3600",
    ESCALATION_CI_BLOCKED: "2", ESCALATION_POC_INCONCLUSIVE: "2",
  });
  assert.equal(config.lane, "a4s");
  assert.equal(config.queueConcurrency, 8);
  assert.equal(config.validation, "");
  assert.throws(() => configFromEnvironment({
    REPO: "a4s", BASE_BRANCH: "main", QUEUE_CONCURRENCY: "0", GATE: "npm test",
    REQUIRED_CHECK: "validate", TEST_PATHS: "test",
    A4S_BLOCKER_REPORTING: "ask", CODE_SCANNING: "required",
    CODEQL_SECURITY_THRESHOLD: "high_or_higher", CODEQL_ALERTS_THRESHOLD: "errors",
    ESCALATION_PUSHBACKS: "3", ESCALATION_FINDINGS: "2", ESCALATION_SECONDS: "3600",
    ESCALATION_CI_BLOCKED: "2", ESCALATION_POC_INCONCLUSIVE: "2",
  }), /QUEUE_CONCURRENCY must be a positive integer/);
});

test("committed config rejects a missing, dirty or invalid file", () => {
  const repo = mkdtempSync(join(tmpdir(), "a4s-config-"));
  const path = join(repo, CONFIG_PATH);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  try {
    git("init", "-b", "main");
    git("config", "user.email", "config@example.test");
    git("config", "user.name", "Config Test");
    git("commit", "-qm", "empty", "--allow-empty");
    assert.throws(() => readCommittedConfig(repo), /missing committed config file.*config\.json/);
    mkdirSync(dirname(path), { recursive: true });
    // The retired policy filename must not satisfy the committed config requirement.
    const retiredPath = join(dirname(path), "\u0061nswers.json");
    writeFileSync(retiredPath, serializeConfig(exampleConfig()));
    git("add", retiredPath);
    git("commit", "-qm", "retired policy only");
    assert.throws(() => readCommittedConfig(repo), /missing committed config file.*\.workspace\/dagu\/config\.json/);
    writeFileSync(path, "{");
    git("add", CONFIG_PATH);
    git("commit", "-qm", "broken");
    assert.throws(() => readCommittedConfig(repo), /invalid JSON/);
    writeFileSync(path, serializeConfig(exampleConfig({ lane: "fixture" })));
    git("add", CONFIG_PATH);
    git("commit", "-qm", "config");
    const loaded = readCommittedConfig(repo);
    assert.equal(loaded.config.lane, "fixture");
    assert.equal(loaded.digest.length, 64);
    writeFileSync(path, serializeConfig(exampleConfig({ lane: "other" })));
    assert.throws(() => readCommittedConfig(repo), /uncommitted config file/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
