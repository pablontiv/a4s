#!/usr/bin/env node
// Admission: admit ONE issue as a factory run.
//   admit.mjs --issue <n> --dag <cycle.yaml> [--issues-file F [--live] | --repo R] [--state S] [--dagu-home D] [--config C] [--param K=V ...]
// Admits only when the issue carries the label `factory:ready` (never plain `factory`, the classification label).
// Run-id is `factory-issue-<n>-<k>`, k = attempt number from 1 (kept in `$STATE/<n>/attempts.json`, --state), so a new
// attempt is never a duplicate; without --state k is 1. Admission moves the label factory:ready -> factory:running
// (src/labels.mjs) before enqueueing; an enqueue failure puts it back. Dagu rejects a duplicate run-id: "duplicate".
// The issue body must satisfy the issue contract (issue-contract.mjs); otherwise it is not enqueued.
// Carried findings ($STATE/<n>/carry.json) are dropped unless the admission is an automatic retry (shouldClearCarry).
// Exit codes: 0 admitted, 20 not labelled, 21 duplicate, 22 contract, 30 infra.
//   admit.mjs --list F   prints the numbers of the issues in F that carry the label (one per line).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { checkIssue } from "./issue-contract.mjs";
import { archiveStaleStations, clearCarry, moveLabel, readCarry, releaseAttempt, reserveAttempt, source } from "./labels.mjs";

export const ADMIT_LABEL = "factory:ready";
export const EXIT = Object.freeze({ ADMITTED: 0, NOT_LABELLED: 20, DUPLICATE: 21, CONTRACT: 22, INFRA: 30 });

export const runIdFor = (n, k = 1) => `factory-issue-${n}-${k}`;

/** Label names of an issue-like object; labels may be strings or {name}. */
export const labelNames = (issue) => (issue?.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name));
export const HOLD_LABEL = "factory:hold";
export const isHeld = (issue) => labelNames(issue).includes(HOLD_LABEL);
export const isAdmissible = (issue) => labelNames(issue).includes(ADMIT_LABEL);

/** owner/repo of a GitHub remote URL (or an owner/repo string); null otherwise. */
export const repoSlug = (repo) => /(?:github\.com[:/])?([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(String(repo ?? ""))?.slice(1, 3).join("/") ?? null;

/** Times (ISO) the issue was labelled factory:hold: GitHub issue events when live, else the fixture's `events`. */
export function holdEvents(o, issue, gh = (args) => spawnSync("gh", args, { encoding: "utf8" })) {
  const fromList = (events) => (events ?? []).filter((e) => e?.event === "labeled" && (e.label?.name ?? e.label) === HOLD_LABEL).map((e) => e.created_at);
  if (!(o.live || !o.issuesFile) || !o.repo) return fromList(issue.events);
  const slug = repoSlug(o.repo);
  if (!slug) throw new Error(`cannot read the label history of ${o.repo}`);
  const r = gh(["api", "--paginate", `repos/${slug}/issues/${o.issue}/events`, "--jq", `.[] | select(.event == "labeled" and .label.name == "${HOLD_LABEL}") | .created_at`]);
  if (r.status !== 0) throw new Error(`gh api issue events failed: ${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean);
}

/**
 * The carried findings survive only an automatic retry. Any human decision since the failed run (a park, or the
 * issue labelled factory:hold now or at any time after carry.json was written) makes the admission a fresh start.
 */
export function shouldClearCarry(o, issue, prev, carry, gh) {
  if (!carry) return false;
  if (prev.parked || isHeld(issue)) return true;
  const since = Date.parse(carry.at ?? "");
  if (Number.isNaN(since)) return false;
  try { return holdEvents(o, issue, gh).some((t) => Date.parse(t) >= since); }
  catch (e) { console.error(`admit: ${e.message}; carried findings dropped`); return true; }
}

/** True when Dagu's enqueue failure means the run-id already exists. */
export const isDuplicate = (text) => /already exists/i.test(text);

function parseArgs(argv) {
  const o = { params: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === "--issue") o.issue = v();
    else if (a === "--repo") o.repo = v();
    else if (a === "--live") o.live = true; // --issues-file is a snapshot of GitHub: labels move on --repo
    else if (a === "--state") o.state = v();
    else if (a === "--dag") o.dag = v();
    else if (a === "--issues-file") o.issuesFile = v();
    else if (a === "--dagu-home") o.daguHome = v();
    else if (a === "--config") o.config = v();
    else if (a === "--param") o.params.push(v());
    else if (a === "--list") o.list = v();
    else if (a === "--clear-held") o.clearHeld = v(); // F: clear carry.json of every issue in F labelled factory:hold (needs --state)
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

function loadIssue(o) {
  if (o.issuesFile) {
    const all = JSON.parse(readFileSync(o.issuesFile, "utf8"));
    return all.find((i) => String(i.number) === String(o.issue)) ?? { number: o.issue, labels: [] };
  }
  if (!o.repo) throw new Error("--repo is required without --issues-file");
  const r = spawnSync("gh", ["issue", "view", String(o.issue), "-R", o.repo, "--json", "number,labels,body"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`gh issue view failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

export function admit(o, daguBin = process.env.DAGU_BIN ?? "dagu") {
  let issue;
  try { issue = loadIssue(o); } catch (e) { console.error(`admit: ${e.message}`); return EXIT.INFRA; }
  if (!isAdmissible(issue)) { console.log(`not-labelled #${o.issue} (needs ${ADMIT_LABEL})`); return EXIT.NOT_LABELLED; }
  const contract = checkIssue(issue.body);
  if (!contract.ok) {
    console.log(`contract #${o.issue} violates the issue contract:`);
    for (const p of contract.problems) console.log(`- ${p}`);
    return EXIT.CONTRACT;
  }
  let k = 1, prev = null, src;
  try {
    src = o.live ? source({ repo: o.repo }) : source({ issuesFile: o.issuesFile, repo: o.repo });
    if (o.state) { archiveStaleStations(o.state, o.issue); ({ k, prev } = reserveAttempt(o.state, o.issue)); if (shouldClearCarry(o, issue, prev, readCarry(o.state, o.issue))) clearCarry(o.state, o.issue); }
    moveLabel(src, o.issue, "running");
  } catch (e) {
    if (prev) releaseAttempt(o.state, o.issue, prev);
    console.error(`admit: ${e.message}`); return EXIT.INFRA;
  }
  const rollback = () => {
    if (prev) releaseAttempt(o.state, o.issue, prev);
    try { moveLabel(src, o.issue, "ready"); } catch (e) { console.error(`admit: could not restore ${ADMIT_LABEL}: ${e.message}`); }
  };
  const runId = runIdFor(o.issue, k);
  // explicit name: inside an admit step Dagu would register the run under the parent DAG's name
  const args = ["enqueue", "--run-id", runId, "--name", basename(o.dag).replace(/\.ya?ml$/, "")];
  if (o.daguHome) args.push("--dagu-home", o.daguHome);
  if (o.config) args.push("--config", o.config);
  args.push(o.dag, "--", `ISSUE=${o.issue}`, ...o.params);
  // clean env: drop the parent step's DAG_* run variables
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("DAG_")));
  const r = spawnSync(daguBin, args, { encoding: "utf8", env });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.error) { console.error(`admit: ${r.error.message}`); rollback(); return EXIT.INFRA; }
  if (r.status === 0) { console.log(`admitted #${o.issue} run-id=${runId}`); return EXIT.ADMITTED; }
  if (isDuplicate(out)) { console.log(`duplicate #${o.issue} run-id=${runId}`); return EXIT.DUPLICATE; }
  console.error(`admit: dagu enqueue -> ${r.status}\n${out}`);
  rollback();
  return EXIT.INFRA;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`admit: ${e.message}`); process.exit(EXIT.INFRA); }
  if (o.clearHeld) {
    try {
      if (!o.state) throw new Error("--state is required");
      for (const i of JSON.parse(readFileSync(o.clearHeld, "utf8"))) if (isHeld(i)) { clearCarry(o.state, i.number); console.log(`hold #${i.number}: carry cleared`); }
      process.exit(0);
    } catch (e) { console.error(`admit: ${e.message}`); process.exit(EXIT.INFRA); }
  }
  if (o.list) {
    try {
      for (const i of JSON.parse(readFileSync(o.list, "utf8"))) if (isAdmissible(i)) console.log(i.number);
      process.exit(0);
    } catch (e) { console.error(`admit: ${e.message}`); process.exit(EXIT.INFRA); }
  }
  if (!o.issue || !o.dag) { console.error("admit: --issue and --dag are required"); process.exit(EXIT.INFRA); }
  process.exit(admit(o));
}
