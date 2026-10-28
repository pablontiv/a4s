import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readGateFailure } from "../src/gate-failure.ts";
import type { JobBinding } from "../src/role-jobs.ts";

const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const LATEST_ID = "22222222-2222-4222-8222-222222222222";

function attempt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: FIRST_ID, iteration: 2, startedAt: 1000, endedAt: 2000, result: "FAIL", exitCode: 1,
    phases: [{ name: "tests", workspace: "packages/example", command: "node --test test/*.test.ts", exitCode: 1 }],
    ...overrides,
  };
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a4s-gate-failure-")));
  const repo = join(root, "repo"); const worktree = join(repo, "candidate"); const state = join(root, "state");
  mkdirSync(worktree, { recursive: true }); mkdirSync(state);
  const binding: JobBinding = {
    repo, worktree, lane: "feature", dag: "feature", run: "feature-729", stage: "implement", role: "implement",
    sha: "a".repeat(40), iteration: 3, attempt: "3:2026-10-28T00:00:00Z",
  };
  return {
    root, repo, worktree, state, binding,
    gate: (overrides: Record<string, unknown> = {}) => writeFileSync(join(state, "gate.json"), JSON.stringify({
      schemaVersion: 1, sha: binding.sha, gate: "npm ci && npm test && npm run typecheck", result: "FAIL", attempts: [attempt()], ...overrides,
    })),
    log: (text: string) => writeFileSync(join(state, "gate-output.log"), text),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("same-SHA evidence carries the latest finalized FAIL, configured command and failed leaf phases", () => {
  const f = fixture();
  try {
    f.gate({ attempts: [attempt(), attempt({
      id: LATEST_ID, iteration: 3, exitCode: 2,
      phases: [
        { name: "install", command: "npm ci", exitCode: 0 },
        { name: "typecheck", workspace: "packages/latest", command: "tsc --noEmit", exitCode: 2 },
      ],
    })] });
    f.log("error TS2322: latest candidate is not assignable\n");
    assert.deepEqual(readGateFailure(f.binding, f.state), {
      run: f.binding.run, sha: f.binding.sha, iteration: 3, gateAttemptId: LATEST_ID, exitCode: 2,
      command: "npm ci && npm test && npm run typecheck",
      failures: [{ phase: "typecheck", workspace: "packages/latest", command: "tsc --noEmit", exitCode: 2 }],
      diagnostic: "error TS2322: latest candidate is not assignable", diagnosticTruncated: false,
    });
    f.gate();
    assert.equal(readGateFailure(f.binding, f.state)?.iteration, 2, "an earlier failed iteration may inform the returning implementation");
  } finally { f.cleanup(); }
});

test("gate PASS/RUNNING, stale SHA and unsupported or malformed metadata are excluded", () => {
  const f = fixture();
  try {
    f.log("FAIL stale evidence must not be carried\n");
    for (const [label, overrides] of [
      ["passed gate", { result: "PASS" }], ["running gate", { result: "RUNNING" }],
      ["stale SHA", { sha: "b".repeat(40) }], ["missing SHA", { sha: null }],
      ["unsupported schema", { schemaVersion: 2 }], ["missing command", { gate: null }],
      ["non-array attempts", { attempts: {} }], ["no attempts", { attempts: [] }],
    ] as const) {
      f.gate(overrides);
      assert.equal(readGateFailure(f.binding, f.state), undefined, label);
    }
    writeFileSync(join(f.state, "gate.json"), "{torn");
    assert.equal(readGateFailure(f.binding, f.state), undefined);
    rmSync(join(f.state, "gate.json"));
    assert.equal(readGateFailure(f.binding, f.state), undefined);
  } finally { f.cleanup(); }
});

test("the latest PASS, RUNNING or invalid attempt never falls back to an older failure", () => {
  const f = fixture();
  try {
    f.log("FAIL earlier attempt output\n");
    for (const [label, overrides] of [
      ["passed", { result: "PASS", exitCode: 0 }],
      ["running", { result: "RUNNING", endedAt: null, exitCode: null }],
      ["not finalized", { endedAt: null }], ["string timestamp", { endedAt: "2000" }],
      ["invalid timestamp", { endedAt: -1 }], ["successful exit", { exitCode: 0 }],
      ["string exit", { exitCode: "1" }], ["fractional exit", { exitCode: 1.5 }],
      ["missing status", { result: null }], ["missing phases", { phases: null }],
      ["invalid UUID", { id: "latest-attempt" }], ["path attempt", { id: `../${LATEST_ID}` }],
      ["UUID with suffix", { id: `${LATEST_ID}.jsonl` }], ["non-string id", { id: 123 }],
    ] as const) {
      f.gate({ attempts: [attempt(), attempt({ id: LATEST_ID, ...overrides })] });
      assert.equal(readGateFailure(f.binding, f.state), undefined, label);
    }
    f.gate({ attempts: [attempt(), null] });
    assert.equal(readGateFailure(f.binding, f.state), undefined);
  } finally { f.cleanup(); }
});

test("future and malformed iterations cannot authorize evidence or revive an older failure", () => {
  const f = fixture();
  try {
    for (const iteration of [4, -1, 1.5, "2", null, Number.MAX_SAFE_INTEGER + 1]) {
      f.gate({ attempts: [attempt(), attempt({ id: LATEST_ID, iteration })] });
      assert.equal(readGateFailure(f.binding, f.state), undefined, `iteration=${iteration}`);
    }
    f.gate();
    assert.equal(readGateFailure({ ...f.binding, iteration: -1 }, f.state), undefined);
    assert.equal(readGateFailure({ ...f.binding, run: "../other-run" }, f.state), undefined);
    const longRun = "r".repeat(201);
    assert.equal(readGateFailure({ ...f.binding, run: longRun }, f.state)?.run, longRun);
  } finally { f.cleanup(); }
});

test("failed phase fields are validated rather than coercing malformed evidence", () => {
  const f = fixture();
  try {
    for (const phase of [
      null, "tests", { name: "tests", exitCode: "1" }, { name: "tests", exitCode: null },
      { name: "tests", exitCode: 1.5 }, { name: 7, exitCode: 1 }, { name: "", exitCode: 1 },
      { name: "tests", exitCode: 1, workspace: {} }, { name: "tests", exitCode: 1, command: [] },
    ]) {
      f.gate({ attempts: [attempt(), attempt({ id: LATEST_ID, phases: [phase] })] });
      assert.equal(readGateFailure(f.binding, f.state), undefined, JSON.stringify(phase));
    }
  } finally { f.cleanup(); }
});

test("pre/post-check failures report the phase and never carry stale gate-output.log", () => {
  const f = fixture();
  try {
    f.log("FAIL STALE_GATE_OUTPUT from a previous invocation\n");
    for (const name of ["pre_checks", "post_checks"]) {
      const phases = name === "pre_checks" ? [{ name, exitCode: 1 }] : [{ name: "command", exitCode: 0 }, { name, exitCode: 1 }];
      f.gate({ attempts: [attempt(), attempt({ id: LATEST_ID, phases })] });
      const evidence = readGateFailure(f.binding, f.state);
      assert.ok(evidence);
      assert.deepEqual(evidence.failures, [{ phase: name, exitCode: 1 }]);
      assert.ok(evidence.diagnostic.includes(`${name} (exit 1)`));
      assert.match(evidence.diagnostic, /gate-output\.log was not read/);
      assert.doesNotMatch(evidence.diagnostic, /STALE_GATE_OUTPUT/);
      assert.equal(evidence.diagnosticTruncated, false);
    }
    f.gate({ attempts: [attempt({ phases: [{ name: "lock_wait", exitCode: 1 }] })] });
    assert.match(readGateFailure(f.binding, f.state)!.diagnostic, /no failed GATE command phase was recorded/);
    assert.doesNotMatch(readGateFailure(f.binding, f.state)!.diagnostic, /STALE_GATE_OUTPUT/);
    f.gate({ attempts: [attempt({ phases: [] })] });
    assert.match(readGateFailure(f.binding, f.state)!.diagnostic, /Failed phases: not recorded/);
  } finally { f.cleanup(); }
});

test("only failed command/tests/typecheck/install phases establish a failed GATE invocation", () => {
  const f = fixture();
  try {
    f.log("Error: CURRENT_GATE_OUTPUT\n");
    for (const name of ["command", "tests", "typecheck", "install"]) {
      f.gate({ attempts: [attempt({ phases: [{ name, exitCode: 1 }] })] });
      assert.equal(readGateFailure(f.binding, f.state)?.diagnostic, "Error: CURRENT_GATE_OUTPUT", name);
    }
    f.gate({ attempts: [attempt({ phases: [{ name: "tests", exitCode: 0 }, { name: "overhead", exitCode: 1 }] })] });
    assert.match(readGateFailure(f.binding, f.state)!.diagnostic, /gate-output\.log was not read/);
    f.gate({ attempts: [attempt({ phases: [{ name: "command", exitCode: 1 }, { name: "post_checks", exitCode: 1 }] })] });
    assert.match(readGateFailure(f.binding, f.state)!.diagnostic, /gate-output\.log was not read/);
  } finally { f.cleanup(); }
});

test("missing, empty and unreadable gate logs leave explicit diagnostic unavailability", () => {
  const f = fixture();
  try {
    f.gate();
    const missing = readGateFailure(f.binding, f.state);
    assert.ok(missing);
    assert.match(missing.diagnostic, /Gate output unavailable:.*missing or unreadable/);
    assert.equal(missing.diagnosticTruncated, false);
    f.log("");
    assert.match(readGateFailure(f.binding, f.state)!.diagnostic, /contains no diagnostic text/);
    f.log("\u001b[32m\u001b[0m\u0000\u0007");
    assert.match(readGateFailure(f.binding, f.state)!.diagnostic, /contains no diagnostic text/);
    rmSync(join(f.state, "gate-output.log"));
    mkdirSync(join(f.state, "gate-output.log"));
    assert.match(readGateFailure(f.binding, f.state)!.diagnostic, /missing or unreadable/);
  } finally { f.cleanup(); }
});

test("the first failure after a long successful preamble wins over a later failure summary", () => {
  const f = fixture();
  try {
    f.gate();
    f.log("ok 1 - successful preamble\n".repeat(12000)
      + "context immediately before first failure\nnot ok 2 - FIRST_FAILURE\nAssertionError: expected the corrected value\n"
      + "subsequent ordinary output\n".repeat(3000) + "FAIL LATER_SUMMARY\n");
    const evidence = readGateFailure(f.binding, f.state);
    assert.ok(evidence);
    assert.match(evidence.diagnostic, /context immediately before first failure/);
    assert.match(evidence.diagnostic, /not ok 2 - FIRST_FAILURE/);
    assert.match(evidence.diagnostic, /AssertionError: expected the corrected value/);
    assert.doesNotMatch(evidence.diagnostic, /LATER_SUMMARY/);
    assert.ok(evidence.diagnostic.length <= 8192);
    assert.equal(evidence.diagnosticTruncated, true);
  } finally { f.cleanup(); }
});

test("passing TAP/spec titles containing failure words do not hide a later real failure", () => {
  const f = fixture();
  try {
    f.gate();
    const passing = [
      "# Subtest: existing entries fail closed on metadata, missing content, or modified payload and never reseal",
      "ok 1 - existing entries fail closed on metadata, missing content, or modified payload and never reseal",
      "# Subtest: station queue capacity is read-only and malformed or ambiguous entries fail",
      "ok 2 - station queue capacity is read-only and malformed or ambiguous entries fail",
      "# Subtest: FAIL/error/AssertionError remain untrusted fixture text",
      "ok 3 - FAIL/error/AssertionError remain untrusted fixture text",
      "✔ Error: and AssertionError: are passing spec title examples",
      "ok 4 - src/example.ts(1,2): error TS2322: is expected fixture output",
      "# Subtest: src/example.ts:1:2 - error TS2322: is expected fixture output",
    ].join("\n") + "\n";
    // Force a rolling-window boundary inside a passing title before its FAIL word.
    const prefix = "ok 0 - EARLY_PASS_SENTINEL ".padEnd(16 * 1024, "x") + "FAIL in a passing title\n";
    f.log(prefix + passing.repeat(200) + "PASSING_TITLES_TAIL\n");
    assert.match(readGateFailure(f.binding, f.state)!.diagnostic, /PASSING_TITLES_TAIL$/);
    f.log(prefix + passing.repeat(200)
      + "not ok 5 - TRUE_CANDIDATE_FAILURE\nAssertionError: USEFUL_FAILURE_MESSAGE after the long passing preamble\n"
      + "ordinary subsequent output\n".repeat(1000));
    const evidence = readGateFailure(f.binding, f.state);
    assert.ok(evidence);
    assert.match(evidence.diagnostic, /not ok 5 - TRUE_CANDIDATE_FAILURE/);
    assert.match(evidence.diagnostic, /AssertionError: USEFUL_FAILURE_MESSAGE/);
    assert.doesNotMatch(evidence.diagnostic, /EARLY_PASS_SENTINEL/);
    assert.ok(evidence.diagnostic.length <= 8192);
    assert.equal(evidence.diagnosticTruncated, true);
  } finally { f.cleanup(); }
});

test("rolling windows discard incomplete host-path lines instead of carrying relative-looking suffixes", () => {
  const f = fixture();
  try {
    f.gate();
    const longPath = "/home/private-user/" + "PRIVATE_PATH_FRAGMENT/".repeat(6000);
    f.log(longPath + "\nnot ok 1 - BOUNDARY_FAILURE\nAssertionError: useful bounded diagnostic\n");
    const failure = readGateFailure(f.binding, f.state);
    assert.ok(failure);
    assert.match(failure.diagnostic, /not ok 1 - BOUNDARY_FAILURE/);
    assert.match(failure.diagnostic, /AssertionError: useful bounded diagnostic/);
    assert.doesNotMatch(failure.diagnostic, /PRIVATE_PATH_FRAGMENT|private-user/);
    assert.equal(failure.diagnosticTruncated, true);
    f.log(longPath + "\nordinary final summary\n");
    const tail = readGateFailure(f.binding, f.state);
    assert.ok(tail);
    assert.match(tail.diagnostic, /ordinary final summary$/);
    assert.doesNotMatch(tail.diagnostic, /PRIVATE_PATH_FRAGMENT|private-user/);
    f.log(longPath);
    const unavailable = readGateFailure(f.binding, f.state);
    assert.ok(unavailable);
    assert.match(unavailable.diagnostic, /Gate output unavailable: no complete diagnostic lines/);
    assert.doesNotMatch(unavailable.diagnostic, /PRIVATE_PATH_FRAGMENT|private-user/);
    assert.equal(unavailable.diagnosticTruncated, true);
  } finally { f.cleanup(); }
});

test("all supported failure markers can focus a bounded excerpt", () => {
  const f = fixture();
  try {
    f.gate();
    for (const marker of [
      "not ok 2", "FAIL suite", "AssertionError: unequal", "Error: broken command",
      "# AssertionError [ERR_ASSERTION]: unequal", "error TS2322: incompatible",
      "src/example.ts(1,2): error TS2322: incompatible", "src/example.ts:1:2 - error TS2322: incompatible", "✖ broken test",
    ]) {
      f.log("ok 1\n".repeat(4000) + marker + "\nuseful details\n");
      const evidence = readGateFailure(f.binding, f.state);
      assert.ok(evidence);
      assert.ok(evidence.diagnostic.includes(marker));
      assert.match(evidence.diagnostic, /useful details/);
      assert.equal(evidence.diagnosticTruncated, true);
    }
  } finally { f.cleanup(); }
});

test("failure markers and UTF-8 characters crossing read chunks are retained", () => {
  const f = fixture();
  try {
    f.gate();
    for (const text of [
      ".".repeat(16 * 1024 - 3) + "\nFAIL split marker\nuseful details\n",
      ".".repeat(16 * 1024 - 2) + "\n✖ split UTF-8 marker\nuseful details\n",
    ]) {
      f.log(text);
      const evidence = readGateFailure(f.binding, f.state);
      assert.ok(evidence);
      assert.match(evidence.diagnostic, /(?:FAIL split marker|✖ split UTF-8 marker)/);
      assert.match(evidence.diagnostic, /useful details/);
      assert.doesNotMatch(evidence.diagnostic, /\ufffd/);
    }
  } finally { f.cleanup(); }
});

test("large text has bounded commands, phase entries and diagnostic tail fallback", () => {
  const f = fixture();
  try {
    const phases = Array.from({ length: 12 }, (_, index) => ({
      name: `phase_${index}_${"p".repeat(300)}`, workspace: `${f.worktree}/${"w".repeat(2000)}`,
      command: `node ${"c".repeat(5000)}`, exitCode: index + 1,
    }));
    // The invoking phase still matters when it follows all eight carried failures.
    phases.push({ name: "command", workspace: ".", command: "npm test", exitCode: 1 });
    f.gate({ gate: `npm test ${"g".repeat(12000)}`, attempts: [attempt({ phases })] });
    f.log("BEGINNING_SENTINEL\n" + "ordinary successful output\n".repeat(12000) + "TAIL_SENTINEL\n");
    const evidence = readGateFailure(f.binding, f.state);
    assert.ok(evidence);
    assert.equal(evidence.command.length, 2048);
    assert.equal(evidence.failures.length, 8);
    for (const phase of evidence.failures) {
      assert.equal(phase.phase.length, 128);
      assert.equal(phase.workspace!.length, 512);
      assert.equal(phase.command!.length, 2048);
      assert.match(phase.workspace!, /^<worktree>\//);
    }
    assert.ok(evidence.diagnostic.length <= 8192);
    assert.match(evidence.diagnostic, /TAIL_SENTINEL$/);
    assert.doesNotMatch(evidence.diagnostic, /BEGINNING_SENTINEL/);
    assert.equal(evidence.diagnosticTruncated, true);
    assert.ok(JSON.stringify(evidence).length < 35000);
  } finally { f.cleanup(); }
});

test("all carried text strips ANSI/control characters and redacts binding and absolute host paths", () => {
  const f = fixture();
  try {
    f.gate({
      gate: `\u001b[32mnpm test\u001b[0m --prefix "${f.worktree}" && cat /var/private/token C:\\Users\\secret-user\\token\u0000`,
      attempts: [attempt({ phases: [
        { name: "\u001b[31mtests\u001b[0m\u0000", workspace: `${f.worktree}/packages/example\u0007`, command: `node ${f.repo}/runner.ts /etc/private.conf\u202e`, exitCode: 1 },
        { name: "command", exitCode: 1 },
      ] })],
    });
    f.log("\u001b[31mnot ok 1 - redaction\u001b[0m\n"
      + `at ${f.worktree}/src/test.ts:9\nprimary ${f.repo}/package.json\n`
      + 'quoted "/opt/build user/private.txt" and /tmp/private-run/file.log\n'
      + "windows C:\\Users\\secret-user\\file.ts and \\\\server\\private-share\\file.ts\n"
      + "\u001b]8;;https://private.invalid/location\u0007link text\u001b]8;;\u0007\n"
      + "\u0000\u0007\u0008\u001b[2K\u202e\u200b");
    const evidence = readGateFailure(f.binding, f.state);
    assert.ok(evidence);
    const text = [evidence.command, evidence.diagnostic, ...evidence.failures.flatMap(phase => [phase.phase, phase.workspace ?? "", phase.command ?? ""])].join("\n");
    assert.doesNotMatch(text.replaceAll("\n", ""), /[\p{Cc}\p{Cf}]/u);
    assert.ok(!text.includes(f.root));
    assert.doesNotMatch(text, /\/var\/private|\/etc\/private|\/opt\/build|\/tmp\/private|secret-user|private-share|private\.invalid/);
    assert.match(evidence.command, /--prefix "<worktree>"/);
    assert.match(evidence.diagnostic, /<worktree>\/src\/test\.ts:9/);
    assert.match(evidence.diagnostic, /<repo>\/package\.json/);
    assert.match(evidence.diagnostic, /quoted "<host-path>"/);
    assert.match(evidence.diagnostic, /link text/);
    assert.equal(evidence.failures[0]!.phase, "tests");
    assert.equal(evidence.diagnosticTruncated, false);
  } finally { f.cleanup(); }
});
