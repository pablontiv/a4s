#!/usr/bin/env node
// Re-QA decision after the rebase in `integrate` (#1091).
//   requa.mjs decide ISSUE_FILES INCOMING_FILES      files of newline-separated paths; prints `true` or `false`
//   requa.mjs log --file F --from MS --to MS --incoming N --result R [--findings JSON]
//                                                   writes {from,to,ms,...} (the re-QA wait and duration; counts toward
//                                                   no window timeout and no step timeout of the original QA)
//   requa.mjs fail --file F --run R --findings JSON  step-failure.json of a failed re-QA (routed as an `integrate` failure)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** Every path an entry stands for: a string, `{path, oldPath}`, `{from, to}` or an array of those (renames count by both paths). */
const pathsOf = (e) => {
  if (e == null) return [];
  if (typeof e === "string") return e ? [e] : [];
  if (Array.isArray(e)) return e.flatMap(pathsOf);
  return [e.path, e.oldPath, e.from, e.to, e.old, e.new].filter((p) => typeof p === "string" && p);
};

/**
 * Pure: must QA review the rebased commit again? True when any file changed by the issue's commit was also changed by the
 * commits it was rebased onto. Renames count by both paths (a rename into or out of a touched path is a change of it).
 */
export function needsReQa(issueFiles, incomingFiles) {
  const touched = new Set((issueFiles ?? []).flatMap(pathsOf));
  return (incomingFiles ?? []).flatMap(pathsOf).some((p) => touched.has(p));
}

const lines = (f) => readFileSync(f, "utf8").split("\n").filter(Boolean);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sub, ...rest] = process.argv.slice(2);
  if (sub === "decide") {
    console.log(String(needsReQa(lines(rest[0]), lines(rest[1]))));
  } else if (sub === "log") {
    const { values: a } = parseArgs({ args: rest, options: { file: { type: "string" }, from: { type: "string" }, to: { type: "string" }, incoming: { type: "string", default: "0" }, result: { type: "string" }, findings: { type: "string", default: "[]" } } });
    const rec = { from: new Date(Number(a.from)).toISOString(), to: new Date(Number(a.to)).toISOString(), ms: Number(a.to) - Number(a.from), incomingCommits: Number(a.incoming), result: a.result, findings: JSON.parse(a.findings) };
    mkdirSync(dirname(a.file), { recursive: true });
    writeFileSync(a.file, JSON.stringify(rec) + "\n");
    console.error(`re-qa: ${rec.result} in ${Math.round(rec.ms / 1000)}s (${rec.incomingCommits} incoming commit(s))`);
  } else if (sub === "fail") {
    const { values: a } = parseArgs({ args: rest, options: { file: { type: "string" }, run: { type: "string" }, findings: { type: "string", default: "[]" } } });
    let f = []; try { f = JSON.parse(a.findings); } catch { f = [a.findings]; }
    if (!Array.isArray(f)) f = [String(f)];
    if (!f.length) f = ["QA did not pass the rebased commit"];
    mkdirSync(dirname(a.file), { recursive: true });
    writeFileSync(a.file, JSON.stringify({ run: a.run, step: "integrate", findings: f.map((x) => `re-qa: ${typeof x === "string" ? x : JSON.stringify(x)}`) }) + "\n");
  } else { console.error("usage: requa.mjs decide|log|fail"); process.exit(2); }
}
