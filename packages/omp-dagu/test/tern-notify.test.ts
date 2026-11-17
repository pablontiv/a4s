import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("../scripts/tern-notify.sh", import.meta.url));
const fixtures = readFileSync(new URL("./fixtures/tern-notify/messages.jsonl", import.meta.url), "utf8")
  .trimEnd().split("\n");
const line = '[researcher] /home/operator/handoffs/quotes"backslash\\unicode-á.md';
const pane = "2516850835458";

function runFixture(ids: string[], expected: number, timeout = "0", partial = false, stale = false): void {
  const directory = mkdtempSync(join(tmpdir(), "omp-dagu-tern-notify-"));
  try {
    const fixture = join(directory, "fixture.jsonl");
    const callsFile = join(directory, "calls.jsonl");
    const sentFile = join(directory, "sent.txt");
    const session = join(directory, "session.jsonl");
    const tern = join(directory, "tern.cjs");
    const records = fixtures.filter((raw) => ids.includes(JSON.parse(raw).id));
    assert.equal(records.length, ids.length, "every requested fixture exists");
    writeFileSync(fixture, `${records.join("\n")}\n${partial ? '{"type":"message"' : ""}`);
    writeFileSync(session, stale ? `${fixtures.find(raw => JSON.parse(raw).id === "idle")}\n` : "");
    writeFileSync(tern, `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.CALLS_FILE, JSON.stringify(args) + "\\n");
if (args[0] === "send" && args[1] === ${JSON.stringify(pane)}) {
  if (args[2] === "paste" && args.length === 4) {
    writeFileSync(process.env.SENT_FILE, args[3]);
    appendFileSync(process.env.SESSION_FILE, readFileSync(process.env.FIXTURE_FILE, "utf8"));
  } else if (args[2] !== "keys" || args[3] !== "Enter" || args.length !== 4) process.exit(1);
} else if (args.length === 2 && args[0] === "inspect" && args[1] === "--json") {
  console.log(JSON.stringify({ panes: [
    { pane: 1, omp_session_file: "/not-the-target" },
    { pane: ${pane}, omp_session_file: process.env.SESSION_FILE }
  ] }));
} else process.exit(1);
`);
    chmodSync(tern, 0o755);
    const result = spawnSync(script, [pane, line], {
      encoding: "utf8",
      timeout: 5_000,
      env: {
        ...process.env,
        TERN_BIN: tern,
        TERN_NOTIFY_TIMEOUT: timeout,
        CALLS_FILE: callsFile,
        SENT_FILE: sentFile,
        SESSION_FILE: session,
        FIXTURE_FILE: fixture,
      },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, expected, result.stdout + result.stderr);
    const sent = readFileSync(sentFile, "utf8");
    assert.equal(sent, line, "the wire message contains only sender and artifact path, without a token");
    const calls = readFileSync(callsFile, "utf8").trimEnd().split("\n").map((raw) => JSON.parse(raw));
    assert.deepEqual(calls, [
      ["inspect", "--json"],
      ["send", pane, "paste", line],
      ["send", pane, "keys", "Enter"],
    ], "paste and Enter occur once, in order; failures never trigger resends");
    if (expected !== 0) assert.match(result.stderr, /do not resend blindly/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("confirms exact idle and busy steering user messages", () => {
  runFixture(["idle"], 0);
  runFixture(["busy"], 0);
});

test("decodes string content and joins text parts without image content", () => {
  runFixture(["string"], 0);
  runFixture(["parts"], 0);
});

test("detects operator partial text, whitespace and wrapper contamination", () => {
  runFixture(["contaminated"], 1);
  runFixture(["whitespace"], 1);
  runFixture(["wrapped"], 1);
});

test("times out on a missing message and ignores assistant, tool and custom messages", () => {
  runFixture(["missing"], 2, "1");
  runFixture(["assistant", "tool", "custom", "missing"], 2);
});

test("ignores a partially written trailing JSONL record", () => {
  runFixture(["idle"], 0, "0", true);
});

test("does not confirm an older identical user message", () => {
  runFixture(["missing"], 2, "0", false, true);
});

test("rejects extra inline text and anything other than sender plus one absolute path before transport", () => {
  const directory = mkdtempSync(join(tmpdir(), "omp-dagu-tern-notify-"));
  try {
    const callsFile = join(directory, "calls.jsonl");
    const tern = join(directory, "tern.cjs");
    writeFileSync(tern, `#!${process.execPath}
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.CALLS_FILE, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(1);
`, { mode: 0o755 });
    for (const payload of [
      "[coordinator 1005] First sentence. Second sentence.",
      "[researcher] One trivial notice.",
      "[supervisor] review handoff: /home/operator/handoff.md",
      "[researcher] /home/operator/handoff.md extra",
      "[researcher] /home/operator/first.md /home/operator/second.md",
      "[researcher] https://example.test/handoff.md",
      "[researcher] ./handoff.md",
      "[researcher] ~/handoff.md",
      '[researcher] "/home/operator/handoff.md"',
      "[researcher] /home/operator/with space.md",
      "[] /home/operator/handoff.md",
      "researcher /home/operator/handoff.md",
      " [researcher] /home/operator/handoff.md",
      "[researcher]  /home/operator/handoff.md",
      "[researcher] /home/operator/handoff.md ",
    ]) {
      writeFileSync(callsFile, "");
      const result = spawnSync(script, [pane, payload], {
        encoding: "utf8",
        timeout: 5_000,
        env: { ...process.env, TERN_BIN: tern, TERN_NOTIFY_TIMEOUT: "0", CALLS_FILE: callsFile },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 3, `${payload}: ${result.stdout}${result.stderr}`);
      assert.equal(readFileSync(callsFile, "utf8"), "", "rejection must not paste, press Enter or inspect");
      assert.match(result.stderr, /absolute artifact path>; nothing was pasted/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
