import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import type { JobBinding } from "./role-jobs.ts";
import { isRecord } from "../../launcher/src/type-guard.ts";
import { redactRoots } from "./host-paths.ts";

export interface GateFailureEvidence {
  run: string;
  sha: string;
  iteration: number;
  gateAttemptId: string;
  exitCode: number;
  command: string;
  failures: { phase: string; workspace?: string; command?: string; exitCode: number }[];
  diagnostic: string;
  diagnosticTruncated: boolean;
}

const DIAGNOSTIC_LIMIT = 8192;
const COMMAND_LIMIT = 2048;
const PHASE_LIMIT = 128;
const WORKSPACE_LIMIT = 512;
const FAILED_PHASE_LIMIT = 8;
const RAW_WINDOW_LIMIT = DIAGNOSTIC_LIMIT * 4;
const RAW_CAPTURE_LIMIT = DIAGNOSTIC_LIMIT * 8;
// Match failure-formatted lines, never marker words in passing TAP/spec titles.
const FAILURE_MARKER = /^(?![^\S\n]*(?:ok\b|#[^\S\n]*Subtest:|✔))[^\S\n]*(?:not ok\b|✖(?:[^\S\n]|$)|FAIL\b|(?:#[^\S\n]*)?(?:[\w.$]*Error|error)(?:[^\S\n]+\[[^\]\n]+\])?:|(?:[^\n]*\(\d+,\d+\):[^\S\n]*|[^\n]*:\d+:\d+[^\S\n]+-[^\S\n]*)?error TS\d+:)/m;
const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Diagnostic = Pick<GateFailureEvidence, "diagnostic" | "diagnosticTruncated">;

function carriedText(value: string, binding: JobBinding): string {
  // Newlines are the only control characters retained in carried diagnostics.
  const text = redactRoots(stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}]/gu, character => character === "\n" ? character : ""),
    [[binding.worktree, "<worktree>"], [binding.repo, "<repo>"]]);
  // Quoted host paths may contain spaces; relative paths after placeholders stay useful.
  const quoted = text.replace(/(["'`])(?:[A-Za-z]:[\\/]|\\\\|\/)[^\n]*?\1/g, (_match, quote: string) => `${quote}<host-path>${quote}`);
  return quoted.replace(/(^|[\s"'`(\[{:;,=])(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s"'`<>()\[\]{}|;,]*/g,
    (_match, prefix: string) => `${prefix}<host-path>`);
}

function selectedDiagnostic(text: string, start: number, omittedPrefix: boolean, omittedSuffix: boolean): Diagnostic {
  const selected = text.slice(start);
  return {
    diagnostic: selected.slice(0, DIAGNOSTIC_LIMIT).trim() || (omittedPrefix
      ? "Gate output unavailable: no complete diagnostic lines remain within the bounded gate-output.log window."
      : "Gate output unavailable: gate-output.log contains no diagnostic text."),
    diagnosticTruncated: omittedPrefix || start > 0 || omittedSuffix || selected.length > DIAGNOSTIC_LIMIT,
  };
}

function readDiagnostic(binding: JobBinding, state: string): Diagnostic {
  let fd: number | undefined;
  try {
    fd = openSync(join(state, "gate-output.log"), "r");
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("Gate output is not a regular file");
    const size = stat.size;
    const buffer = Buffer.allocUnsafe(16 * 1024);
    const decoder = new StringDecoder("utf8");
    let position = 0;
    let eof = false;
    const nextChunk = (): string | undefined => {
      if (position >= size || eof) return undefined;
      const count = readSync(fd!, buffer, 0, Math.min(buffer.length, size - position), position);
      if (count === 0) { eof = true; return decoder.end(); }
      position += count;
      return decoder.write(buffer.subarray(0, count)) + (position >= size ? decoder.end() : "");
    };
    let raw = "";
    let omittedPrefix = false;
    let discardingPartialLine = false;
    for (let chunk = nextChunk(); chunk !== undefined; chunk = nextChunk()) {
      if (discardingPartialLine) {
        const newline = chunk.indexOf("\n");
        if (newline < 0) continue;
        chunk = chunk.slice(newline + 1);
        discardingPartialLine = false;
      }
      raw += chunk;
      let text = carriedText(raw, binding);
      let marker = FAILURE_MARKER.exec(text);
      if (marker) {
        let captureTruncated = false;
        // Retain the first failure and a little context, not a later summary.
        while (text.length - Math.max(0, marker.index - 512) < DIAGNOSTIC_LIMIT && raw.length < RAW_CAPTURE_LIMIT) {
          const next = nextChunk();
          if (next === undefined) break;
          raw += next;
          if (raw.length > RAW_CAPTURE_LIMIT) { raw = raw.slice(0, RAW_CAPTURE_LIMIT); captureTruncated = true; }
          text = carriedText(raw, binding);
          marker = FAILURE_MARKER.exec(text);
          if (!marker) break;
        }
        const start = marker ? Math.max(0, marker.index - 512) : Math.max(0, text.length - DIAGNOSTIC_LIMIT);
        return selectedDiagnostic(text, start, omittedPrefix, captureTruncated || position < size);
      }
      if (raw.length > RAW_WINDOW_LIMIT) {
        const start = raw.length - RAW_WINDOW_LIMIT;
        // A clipped first line could turn a passing title into FAIL, or expose
        // a host-path suffix after its absolute prefix was discarded.
        const newline = raw[start - 1] === "\n" ? start - 1 : raw.indexOf("\n", start);
        discardingPartialLine = newline < 0;
        raw = newline < 0 ? "" : raw.slice(newline + 1);
        omittedPrefix = true;
      }
    }
    const text = carriedText(raw, binding);
    return selectedDiagnostic(text, Math.max(0, text.length - DIAGNOSTIC_LIMIT), omittedPrefix, false);
  } catch {
    return {
      diagnostic: "Gate output unavailable: gate-output.log is missing or unreadable for the latest failed GATE command.",
      diagnosticTruncated: false,
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Read only the latest finalized failure for this candidate; all carried text is untrusted. */
export function readGateFailure(binding: JobBinding, state: string): GateFailureEvidence | undefined {
  try {
    if (!/^[a-f0-9]{40}$/.test(binding.sha) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(binding.run)
      || !Number.isSafeInteger(binding.iteration) || binding.iteration < 0) return undefined;
    const gate: unknown = JSON.parse(readFileSync(join(state, "gate.json"), "utf8"));
    if (!isRecord(gate) || gate.schemaVersion !== 1 || gate.sha !== binding.sha || gate.result !== "FAIL"
      || typeof gate.gate !== "string" || !Array.isArray(gate.attempts)) return undefined;
    // Never search backwards: a later pass, running attempt or invalid record supersedes old failures.
    const attempt: unknown = gate.attempts.at(-1);
    if (!isRecord(attempt) || typeof attempt.id !== "string" || !ATTEMPT_ID.test(attempt.id)
      || attempt.result !== "FAIL" || typeof attempt.exitCode !== "number" || !Number.isSafeInteger(attempt.exitCode) || attempt.exitCode === 0
      || typeof attempt.endedAt !== "number" || !Number.isSafeInteger(attempt.endedAt) || attempt.endedAt <= 0
      || typeof attempt.iteration !== "number" || !Number.isSafeInteger(attempt.iteration)
      || attempt.iteration < 0 || attempt.iteration > binding.iteration || !Array.isArray(attempt.phases)) return undefined;
    const failures: GateFailureEvidence["failures"] = [];
    let commandFailed = false;
    let checksFailed = false;
    for (const phase of attempt.phases) {
      if (!isRecord(phase) || typeof phase.name !== "string" || !phase.name
        || typeof phase.exitCode !== "number" || !Number.isSafeInteger(phase.exitCode)
        || (phase.workspace !== undefined && typeof phase.workspace !== "string")
        || (phase.command !== undefined && typeof phase.command !== "string")) return undefined;
      if (phase.exitCode === 0) continue;
      if (["command", "tests", "typecheck", "install"].includes(phase.name)) commandFailed = true;
      if (["pre_checks", "post_checks"].includes(phase.name)) checksFailed = true;
      if (failures.length < FAILED_PHASE_LIMIT) failures.push({
        phase: carriedText(phase.name, binding).slice(0, PHASE_LIMIT),
        ...(typeof phase.workspace === "string" ? { workspace: carriedText(phase.workspace, binding).slice(0, WORKSPACE_LIMIT) } : {}),
        ...(typeof phase.command === "string" ? { command: carriedText(phase.command, binding).slice(0, COMMAND_LIMIT) } : {}),
        exitCode: phase.exitCode,
      });
    }
    const diagnostic = commandFailed && !checksFailed ? readDiagnostic(binding, state) : {
      diagnostic: `Gate output unavailable: ${checksFailed ? "the latest attempt failed in pre/post checks" : "no failed GATE command phase was recorded"}.`
        + ` Failed phases: ${failures.map(failure => `${failure.phase} (exit ${failure.exitCode})`).join(", ") || "not recorded"}. gate-output.log was not read.`,
      diagnosticTruncated: false,
    };
    return {
      run: binding.run,
      sha: binding.sha,
      iteration: attempt.iteration,
      gateAttemptId: attempt.id,
      exitCode: attempt.exitCode,
      command: carriedText(gate.gate, binding).slice(0, COMMAND_LIMIT),
      failures,
      ...diagnostic,
    };
  } catch {
    return undefined;
  }
}
