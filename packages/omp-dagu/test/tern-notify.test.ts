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
const line = '[researcher] literal="quotes" backslash=\\ unicode=á <probe>literal</probe>';
const pane = "2516850835458";

function runFixture(ids: string[], expected: number, timeout = "0", partial = false): void {
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
    writeFileSync(tern, `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.CALLS_FILE, JSON.stringify(args) + "\\n");
if (args[0] === "send" && args[1] === ${JSON.stringify(pane)}) {
  if (args[2] === "paste" && args.length === 4) writeFileSync(process.env.SENT_FILE, args[3]);
  else if (args[2] !== "keys" || args[3] !== "Enter" || args.length !== 4) process.exit(1);
} else if (args.length === 2 && args[0] === "inspect" && args[1] === "--json") {
  const sent = readFileSync(process.env.SENT_FILE, "utf8");
  const token = sent.slice(${line.length + 1});
  writeFileSync(process.env.SESSION_FILE,
    readFileSync(process.env.FIXTURE_FILE, "utf8").replaceAll("[msg 1794730169-965]", token));
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
    assert.equal(sent.slice(0, line.length + 1), `${line} `);
    assert.match(sent.slice(line.length + 1), /^\[msg \d+-\d+\]$/);
    const calls = readFileSync(callsFile, "utf8").trimEnd().split("\n").map((raw) => JSON.parse(raw));
    assert.deepEqual(calls, [
      ["send", pane, "paste", sent],
      ["send", pane, "keys", "Enter"],
      ["inspect", "--json"],
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

test("times out on a missing token and ignores assistant, tool and custom tokens", () => {
  runFixture(["missing"], 2, "1");
  runFixture(["assistant", "tool", "custom", "missing"], 2);
});

test("ignores a partially written trailing JSONL record", () => {
  runFixture(["idle"], 0, "0", true);
});
