#!/usr/bin/env node
// The one helper that moves an issue's factory state, which lives in its GitHub labels:
//   factory:ready (to admit) -> factory:running (admission) -> closed by the cycle | factory:needs-human (+ comment)
// Works on GitHub (`--repo R`, via gh) or on an ISSUES_FILE fixture (`--issues-file F`, same JSON as `gh issue list`).
//   labels.mjs move   --issue N --to ready|running|needs-human|done [--comment T] (--repo R | --issues-file F)
//   labels.mjs finish --issue N --state S --run ID --steps "a=succeeded,b=failed" (--repo R | --issues-file F)
//       decides after a failed run: back to ready (retryable, < MAX_RUNS runs) or needs-human with a comment.
//   labels.mjs success --issue N (--repo R | --issues-file F)   drops the state labels of a delivered issue.
// `finish` and `success` only act on issues labelled factory:running (never on hand-started runs).
// Run bookkeeping (`$STATE/<n>/attempts.json`) is kept by `reserveAttempt` / `releaseAttempt` (used by admit.mjs).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { MAX_RUNS, decideAfterFailure } from "./lib.mjs";
import { failedStep, parseSteps } from "./notify.mjs";

export const LABEL = Object.freeze({ READY: "factory:ready", RUNNING: "factory:running", NEEDS_HUMAN: "factory:needs-human" });
const STATE_LABELS = Object.values(LABEL);
const TARGET = { ready: [LABEL.READY], running: [LABEL.RUNNING], "needs-human": [LABEL.NEEDS_HUMAN], done: [] };

export const labelNames = (issue) => (issue?.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name));
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return d; } };
const writeJson = (f, v) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(v, null, 1)); };

/** Source of an issue: a fixture file or GitHub. */
export function source({ issuesFile, repo }) {
  if (issuesFile) {
    const all = () => readJson(issuesFile, []);
    const edit = (n, fn) => {
      const list = all();
      let i = list.find((x) => String(x.number) === String(n));
      if (!i) list.push(i = { number: Number(n), labels: [] });
      fn(i); writeJson(issuesFile, list);
    };
    return {
      labels: (n) => labelNames(all().find((x) => String(x.number) === String(n))),
      set(n, add, remove, comment) {
        edit(n, (i) => {
          const objs = (i.labels ?? []).some((l) => typeof l !== "string");
          const names = labelNames(i).filter((l) => !remove.includes(l));
          for (const a of add) if (!names.includes(a)) names.push(a);
          i.labels = names.map((name) => (objs ? { name } : name));
          if (comment) (i.comments ??= []).push(comment);
        });
      },
    };
  }
  if (!repo) throw new Error("--repo or --issues-file is required");
  const gh = (args) => { const r = spawnSync("gh", args, { encoding: "utf8" }); if (r.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${r.stderr}`); return r.stdout; };
  return {
    labels: (n) => labelNames({ labels: JSON.parse(gh(["issue", "view", String(n), "-R", repo, "--json", "labels"])).labels }),
    set(n, add, remove, comment) {
      for (const l of add) spawnSync("gh", ["label", "create", l, "-R", repo], { encoding: "utf8" }); // exists already: ignored
      const args = ["issue", "edit", String(n), "-R", repo];
      for (const l of add) args.push("--add-label", l);
      for (const l of remove) args.push("--remove-label", l);
      if (add.length || remove.length) gh(args);
      if (comment) gh(["issue", "comment", String(n), "-R", repo, "--body", comment]);
    },
  };
}

/** Move the issue to `to` (ready|running|needs-human|done): exactly one state label, or none for done. */
export function moveLabel(src, n, to, comment) {
  const add = TARGET[to];
  if (!add) throw new Error(`unknown state ${to}`);
  const current = src.labels(n);
  src.set(n, add.filter((l) => !current.includes(l)), STATE_LABELS.filter((l) => !add.includes(l) && current.includes(l)), comment);
}

// ---- run bookkeeping: $STATE/<n>/attempts.json = {last, streak, parked, lastAt, resetBy?, resetAt?, held?} ----
const attemptsFile = (state, n) => join(state, String(n), "attempts.json");
export const readAttempts = (state, n) => ({ last: 0, streak: 0, parked: false, ...readJson(attemptsFile(state, n), {}) });

/** Remember that the admit step saw `factory:hold` on the issue: the next admission is a fresh run budget. */
export function markHeld(state, n) {
  mkdirSync(join(state, String(n)), { recursive: true });
  writeJson(attemptsFile(state, n), { ...readAttempts(state, n), held: true });
}

/**
 * Next attempt number k and run count since the last human decision; persisted so a crash never reuses a run-id.
 * A human decision is a park (needs-human, then ready) or a hold (`held`: the admit step saw it, or the caller found it
 * in the label history); either resets `streak` to 1 and records `resetBy` / `resetAt`.
 */
export function reserveAttempt(state, n, { held = false } = {}) {
  const prev = readAttempts(state, n);
  const now = new Date().toISOString();
  const resetBy = prev.parked ? "needs-human" : (held || prev.held) ? "hold" : null;
  const { held: _h, ...keep } = prev;
  const next = resetBy
    ? { ...keep, last: prev.last + 1, streak: 1, parked: false, resetBy, resetAt: now, lastAt: now }
    : { ...keep, last: prev.last + 1, streak: prev.streak + 1, parked: false, lastAt: now };
  writeJson(attemptsFile(state, n), next);
  return { k: next.last, prev };
}
export const releaseAttempt = (state, n, prev) => writeJson(attemptsFile(state, n), prev);

/** A new attempt must not replay the stored pass/blocked of an earlier one: archive such station states. */
export function archiveStaleStations(state, n) {
  for (const line of ["impl", "qa"]) {
    const f = join(state, String(n), `${line}.json`);
    const last = readJson(f, { attempts: [] }).attempts?.at?.(-1);
    if (last && (last.outcome === "pass" || last.outcome === "blocked" || last.outcome === "violation")) renameSync(f, `${f}.${Date.now()}`);
  }
}

const lastAttempt = (state, n, line) => readJson(join(state, String(n), `${line}.json`), { attempts: [] }).attempts?.at?.(-1);

/** The station attempt that failed the step. The `qa` step also runs the implementation repair (qafix): the later attempt wins, impl on a tie when it did not pass. */
function failingAttempt(state, n, failed) {
  if (failed === "implement" || failed === "require_pass") return lastAttempt(state, n, "impl");
  if (failed !== "qa") return undefined;
  const qa = lastAttempt(state, n, "qa"), impl = lastAttempt(state, n, "impl");
  if (impl && impl.outcome !== "pass" && (impl.startedAt ?? 0) >= (qa?.startedAt ?? 0)) return impl;
  return qa;
}

/**
 * The `qa` step failed inside the implementation repair (qafix) and the repair attempt produced no findings
 * (infra / stuck / thread failed): an infrastructure failure, not a verdict on the work.
 */
export function isRepairInfra(state, n, failed) {
  if (failed !== "qa") return false;
  const qa = lastAttempt(state, n, "qa"), impl = lastAttempt(state, n, "impl");
  // the repair is the failing station only when failingAttempt picked impl (explicit station check, not object identity)
  if (!impl || impl.outcome === "pass" || (impl.startedAt ?? 0) < (qa?.startedAt ?? 0)) return false;
  const a = impl;
  if (a.findings?.length || a.question) return false;
  return ["infra", "stuck", "fail"].includes(a.outcome);
}

/** Outcome of a failed run: that of the station that failed; any other failing step is a `fail`. */
export function runOutcome(state, n, failed) {
  if (!["implement", "require_pass", "qa"].includes(failed)) return "fail";
  if (isRepairInfra(state, n, failed)) return "infra";
  const o = failingAttempt(state, n, failed)?.outcome;
  if (failed === "require_pass") return o === "blocked" ? "blocked" : "fail";
  if (o === undefined || o === "pass") return "fail";
  return o;
}

export const findingsText = (state, n, failed, run) => {
  if (failed === "integrate" || failed === "validate" || failed === "ci") {
    const f = readJson(join(state, String(n), "step-failure.json"), null);
    if (f && f.step === failed && f.run === run) return { question: "", findings: f.findings ?? [] };
  }
  // a failed repair keeps the findings of the QA round that triggered it
  const last = isRepairInfra(state, n, failed) ? lastAttempt(state, n, "qa") : failingAttempt(state, n, failed);
  return { question: last?.question ?? "", findings: last?.findings ?? [] };
};

// ---- carry-over: $STATE/<n>/carry.json = {run, step, findings} of the failed run that went back to ready ----
const carryFile = (state, n) => join(state, String(n), "carry.json");
export const readCarry = (state, n) => readJson(carryFile(state, n), null);
export const clearCarry = (state, n) => rmSync(carryFile(state, n), { force: true });
export function writeCarry(state, n, carry) { mkdirSync(join(state, String(n)), { recursive: true }); writeJson(carryFile(state, n), carry); }

/** The `## Previous run findings` section appended to brief.md ("" when there is no carry-over). */
export function carrySection(state, n) {
  const c = readCarry(state, n);
  if (!c) return "";
  const list = (c.findings ?? []).map((f) => `- ${typeof f === "string" ? f : JSON.stringify(f)}`);
  return ["", "## Previous run findings", "",
    `- Run: ${c.run}`, `- Failed step: ${c.step}`, "- Findings (fix every one, each with a regression test):",
    ...(list.length ? list : ["- (none recorded; see the run log)"]), ""].join("\n");
}

/** After a failed run: ready again or needs-human with a comment. Returns {to, outcome, failed}. */
export function finishRun(src, { issue, state, run, steps }) {
  if (!src.labels(issue).includes(LABEL.RUNNING)) return { to: null };
  const failed = failedStep(parseSteps(steps)) ?? "unknown";
  const outcome = runOutcome(state, issue, failed);
  const at = readAttempts(state, issue);
  const repairInfra = isRepairInfra(state, issue, failed);
  // an infrastructure failure of the QA repair is not a normal run: refund it, so it never parks the issue
  const to = repairInfra ? "ready" : decideAfterFailure(outcome, at.streak);
  // refund once per run: a retried transition (GitHub outage, reconciliation) must not refund the same run again
  if (repairInfra && at.refundedRun !== String(run)) writeJson(attemptsFile(state, issue), { ...at, streak: Math.max(0, at.streak - 1), refundedRun: String(run) });
  const { question, findings } = findingsText(state, issue, failed, run);
  if (to === "ready") {
    moveLabel(src, issue, "ready");
    writeCarry(state, issue, { run, step: failed, at: new Date().toISOString(), findings: question && !findings.length ? [question] : findings });
  } else {
    clearCarry(state, issue);
    writeJson(attemptsFile(state, issue), { ...at, parked: true });
    moveLabel(src, issue, "needs-human", [
      `Factory: run ${run} needs a human.`,
      `- Outcome: ${outcome}${outcome === "blocked" ? "" : ` (run ${at.streak} of ${MAX_RUNS} since ${at.resetAt ? `${at.resetBy} reset at ${at.resetAt}` : "the first run"})`}`,
      `- Failed step: ${failed}`,
      `- Question: ${question || (findings.length ? findings.join("; ") : "none; see the run log")}`,
      "",
      `Put \`${LABEL.READY}\` back on this issue to admit a new attempt.`,
    ].join("\n"));
  }
  return { to, outcome, failed };
}

// ---- handler record: $STATE/<n>/handled.json = {run, event, at, ok}; reconciliation re-runs only runs without ok:true ----
const handledFile = (state, n) => join(state, String(n), "handled.json");
export const readHandled = (state, n) => readJson(handledFile(state, n), null);
export const recordHandled = (state, n, run, event, ok) => writeJson(handledFile(state, n), { run, event, at: new Date().toISOString(), ok });
export const isHandled = (state, n, run) => { const h = readHandled(state, n); return h?.run === run && h.ok === true; };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const [cmd, ...rest] = process.argv.slice(2);
    const { values: a } = parseArgs({ args: rest, options: { issue: { type: "string" }, to: { type: "string" }, comment: { type: "string" }, state: { type: "string" }, run: { type: "string", default: "unknown" }, steps: { type: "string", default: "" }, repo: { type: "string" }, "issues-file": { type: "string" } } });
    if (!a.issue) throw new Error("--issue is required");
    if (cmd === "carry") { if (!a.state) throw new Error("--state is required"); process.stdout.write(carrySection(a.state, a.issue)); process.exit(0); }
    const src = source({ issuesFile: a["issues-file"], repo: a.repo });
    if (cmd === "move") { moveLabel(src, a.issue, a.to, a.comment); if (a.state && a.to !== "ready") clearCarry(a.state, a.issue); console.log(`#${a.issue} -> ${a.to}`); }
    else if (cmd === "finish") {
      if (!a.state) throw new Error("--state is required");
      let r;
      try { r = finishRun(src, { issue: a.issue, state: a.state, run: a.run, steps: a.steps }); }
      catch (e) { recordHandled(a.state, a.issue, a.run, "failure", false); throw e; }
      recordHandled(a.state, a.issue, a.run, "failure", true);
      console.log(r.to ? `#${a.issue} -> ${r.to} (outcome ${r.outcome}, failed step ${r.failed})` : `#${a.issue} not ${LABEL.RUNNING}: untouched`);
    } else if (cmd === "success") {
      try { if (src.labels(a.issue).includes(LABEL.RUNNING)) moveLabel(src, a.issue, "done"); }
      catch (e) { if (a.state) recordHandled(a.state, a.issue, a.run, "success", false); throw e; }
      if (a.state) { clearCarry(a.state, a.issue); recordHandled(a.state, a.issue, a.run, "success", true); }
      console.log(`#${a.issue} done`);
    } else throw new Error(`unknown command ${cmd}`);
  } catch (e) { console.error(`labels: ${e.message}`); process.exit(30); }
}
