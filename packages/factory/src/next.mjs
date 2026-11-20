#!/usr/bin/env node
// Mechanical ordering (see CONTRACTS.md "Ordering contract"): which unblocked issues fill the free run slots.
//   next.mjs (--issues-file F | --fetch-issues --repo R) --limits L [--inflight-file F | --dagu-home H --dagu-config C] [--repo R] [--dry]
// F: JSON like `gh issue list --state all --json number,labels,body,state,stateReason,comments`.
// Without --repo (or with --dry) it only prints the choice; with --repo it labels and comments on GitHub.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkIssue, parseBlockedBy } from "./issue-contract.mjs";
import { repoSlug } from "./admit.mjs";
import { labelNames, source } from "./labels.mjs";

export const MILESTONES = ["M0", "M1", "M2", "M3"];
const EXCLUDED = ["factory:ready", "factory:hold", "factory:running", "factory:needs-human"];
export const CYCLE_MARK = "<!-- factory:cycle -->";

/** Operator policy of limits.json; throws naming the field, the expected value and the observed one. */
export function validateLimits(j) {
  const bad = (field, expected, v) => { throw new Error(`limits.json: field "${field}" expected ${expected}, observed ${JSON.stringify(v)}`); };
  if (j === null || typeof j !== "object" || Array.isArray(j)) bad("(root)", "an object", j);
  if (j.version !== 1) bad("version", "1", j.version);
  if (!Number.isInteger(j.maxActiveRuns) || j.maxActiveRuns < 1) bad("maxActiveRuns", "an integer >= 1", j.maxActiveRuns);
  return j;
}
export function loadPolicy(file) {
  let j;
  try { j = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new Error(`limits.json: cannot read ${file}: ${e.message}`); }
  return validateLimits(j);
}

const isClosed = (i) => String(i?.state ?? "open").toLowerCase() === "closed";
const reason = (i) => String(i?.stateReason ?? "").toLowerCase().replace(/[ _-]/g, "") || "unknown";
const milestoneOf = (i) => MILESTONES.filter((m) => labelNames(i).includes(m)).sort()[0] ?? null;
const commentBodies = (i) => (i?.comments ?? []).map((c) => (typeof c === "string" ? c : c?.body ?? ""));

/** Strongly connected components with a cycle (size > 1 or a self-loop) of the graph {n: [m...]}. */
function cycles(graph) {
  let idx = 0; const index = new Map(), low = new Map(), stack = [], on = new Set(), out = [];
  const visit = (v) => {
    index.set(v, idx); low.set(v, idx++); stack.push(v); on.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!graph.has(w)) continue;
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const comp = []; let w;
      do { w = stack.pop(); on.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1 || (graph.get(v) ?? []).includes(v)) out.push(comp.sort((a, b) => a - b));
    }
  };
  for (const v of [...graph.keys()].sort((a, b) => a - b)) if (!index.has(v)) visit(v);
  return out;
}

/**
 * Full analysis. issues: every issue (open and closed). inFlight: issues (or {number}) of the runs in flight.
 * @returns {{picked: object[], log: string[], holds: {number, blocker}[], cycles: {members: number[], comment: string, notify: number[]}[]}}
 */
export function analyze(issues, inFlight, limits, conflicts = () => false) {
  const byNum = new Map(issues.map((i) => [Number(i.number), i]));
  const log = [], holds = [], cyc = [];
  const open = issues.filter((i) => !isClosed(i));
  const blockers = new Map(open.map((i) => [Number(i.number), parseBlockedBy(i.body).blockers]));

  for (const members of cycles(blockers)) {
    const text = `${CYCLE_MARK}\nCycle in \`Blocked by\`: ${[...members, members[0]].map((n) => `#${n}`).join(" -> ")}. None of these issues will be picked until the cycle is broken.`;
    const notify = members.filter((n) => !commentBodies(byNum.get(n)).some((c) => c.includes(CYCLE_MARK)));
    cyc.push({ members, comment: text, notify });
    log.push(`cycle ${members.map((n) => `#${n}`).join(", ")}: not picked${notify.length ? "" : " (already commented)"}`);
  }
  const inCycle = new Set(cyc.flatMap((c) => c.members));

  const candidates = [];
  for (const i of open) {
    const n = Number(i.number), names = labelNames(i);
    if (!names.includes("factory") || EXCLUDED.some((l) => names.includes(l))) continue;
    const ms = milestoneOf(i);
    if (!ms) { log.push(`rejected #${n}: no milestone label (${MILESTONES.join("/")})`); continue; }
    const c = checkIssue(i.body);
    if (!c.ok) { log.push(`rejected #${n}: breaks the issue contract: ${c.problems.join("; ")}`); continue; }
    candidates.push({ issue: i, n, ms });
  }
  candidates.sort((a, b) => a.ms.localeCompare(b.ms) || a.n - b.n);

  const ok = [];
  for (const { issue, n, ms } of candidates) {
    const why = [];
    let held = null;
    for (const b of blockers.get(n)) {
      const bi = byNum.get(b);
      if (bi && isClosed(bi)) { if (reason(bi) === "notplanned") held ??= b; else if (reason(bi) !== "completed") why.push(`#${b} closed with ${reason(bi)} reason, not completed`); }
      else why.push(bi ? `#${b} is open` : `#${b} not found`);
    }
    if (held !== null) { holds.push({ number: n, blocker: held }); log.push(`hold #${n}: blocker #${held} was closed as not planned`); continue; }
    if (inCycle.has(n)) { continue; }
    if (why.length) { log.push(`skipped #${n} (${ms}): blocked, ${why.join(", ")}`); continue; }
    ok.push({ issue, n, ms });
  }

  const free = Math.max(0, limits.maxActiveRuns - inFlight.length);
  const picked = [];
  if (free === 0) {
    log.push(`no free slot: ${inFlight.length} in flight, maxActiveRuns ${limits.maxActiveRuns}`);
    for (const { n, ms } of ok) log.push(`skipped #${n} (${ms}): no free slot`);
  }
  else for (const { issue, n, ms } of ok) {
    if (picked.length >= free) { log.push(`skipped #${n} (${ms}): no free slot left (${free} free, ${picked.length} picked)`); continue; }
    const others = [...inFlight, ...picked];
    const hit = others.find((o) => conflicts(issue, o));
    if (hit) { log.push(`skipped #${n} (${ms}): conflicts with #${hit.number}`); continue; }
    picked.push(issue);
    log.push(`picked #${n}: ${ms}, unblocked, slot ${picked.length}/${free}`);
  }
  return { picked, log, holds, cycles: cyc };
}

/** At most `limits.maxActiveRuns - inFlight.length` issues to run next; see CONTRACTS.md "Ordering contract". */
export const pickNext = (issues, inFlight, limits, conflicts = () => false) => analyze(issues, inFlight, limits, conflicts).picked;

const FROM_DATE = 1; // explicit lower bound (unix seconds): every run since the epoch, never a default window
const ACTIVE = new Set(["queued", "running", "waiting"]);
/** In-flight factory runs from Dagu: `cycle` runs queued, running or waiting. */
export async function daguInFlight({ url, fetchFn = fetch }) {
  const runs = [];
  const seen = new Set();
  let cursor = "";
  do {
    const r = await fetchFn(`${url}/api/v1/dag-runs?name=cycle&limit=500&fromDate=${FROM_DATE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`dagu dag-runs -> ${r.status}`);
    const j = await r.json();
    runs.push(...(j.dagRuns ?? []));
    cursor = j.nextCursor ?? "";
    if (cursor) { if (seen.has(cursor)) throw new Error("dagu dag-runs: repeated cursor"); seen.add(cursor); }
  } while (cursor);
  return runs.filter((d) => d.name === "cycle" && ACTIVE.has(String(d.statusLabel ?? "").toLowerCase()))
    .map((d) => ({ number: Number(/^factory-issue-(\d+)-/.exec(d.dagRunId ?? "")?.[1] ?? NaN), runId: d.dagRunId }));
}

const defaultGh = (args) => { const r = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 1 << 28 }); if (r.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${r.stderr}`); return r.stdout; };
const jsonLines = (out) => out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

/** Every issue of the repo (open and closed, PRs excluded), read with `gh api --paginate` to exhaustion; no fixed limit. */
export function fetchIssues(repo, gh = defaultGh) {
  const slug = repoSlug(repo);
  if (!slug) throw new Error(`cannot read the repository slug of ${repo}`);
  const jq = ".[] | select(.pull_request | not) | {number, state, stateReason: .state_reason, labels: [.labels[].name], body: (.body // \"\")}";
  return jsonLines(gh(["api", "--paginate", `repos/${slug}/issues?state=all&per_page=100`, "--jq", jq]));
}
/** Comment bodies of one issue, paginated to exhaustion. */
export function fetchComments(repo, n, gh = defaultGh) {
  const slug = repoSlug(repo);
  return jsonLines(gh(["api", "--paginate", `repos/${slug}/issues/${n}/comments?per_page=100`, "--jq", ".[] | {body}"]));
}

async function main() {
  const { values: a } = parseArgs({ options: { "issues-file": { type: "string" }, "fetch-issues": { type: "boolean" }, limits: { type: "string" }, "inflight-file": { type: "string" }, "dagu-home": { type: "string" }, "dagu-config": { type: "string" }, repo: { type: "string" }, dry: { type: "boolean" } } });
  const limits = loadPolicy(a.limits);
  const issues = a["fetch-issues"] ? fetchIssues(a.repo) : JSON.parse(readFileSync(a["issues-file"], "utf8"));
  let inFlight;
  if (a["inflight-file"]) inFlight = JSON.parse(readFileSync(a["inflight-file"], "utf8")).map((x) => (typeof x === "object" ? x : { number: x }));
  else {
    const { daguUrl } = await import("./breaker.mjs");
    inFlight = await daguInFlight({ url: daguUrl(process.env, a["dagu-home"] ?? process.env.DAGU_HOME, a["dagu-config"] ?? process.env.DAGU_CONFIG) });
  }
  const byNum = new Map(issues.map((i) => [Number(i.number), i]));
  inFlight = inFlight.map((x) => byNum.get(Number(x.number)) ?? x);
  let r = analyze(issues, inFlight, limits);
  if (a["fetch-issues"] && r.cycles.length) { // cycle members: read their comments (paginated) to comment only once
    for (const n of r.cycles.flatMap((c) => c.members)) { const i = byNum.get(n); if (i) i.comments = fetchComments(a.repo, n); }
    r = analyze(issues, inFlight, limits);
  }
  console.log(`next: ${inFlight.length} in flight, maxActiveRuns ${limits.maxActiveRuns}`);
  for (const l of r.log) console.log(`next: ${l}`);
  console.log(`next: choice ${r.picked.length ? r.picked.map((i) => `#${i.number}`).join(" ") : "(none)"}`);
  if (a.dry || !a.repo) return; // fixture (ISSUES_FILE): only print the choice
  const src = source({ repo: a.repo });
  for (const h of r.holds) src.set(h.number, ["factory:hold"], [], `Blocker #${h.blocker} was closed as not planned, so this issue is on \`factory:hold\`. Remove the blocker or decide manually.`);
  for (const c of r.cycles) for (const n of c.notify) src.set(n, [], [], c.comment);
  for (const i of r.picked) src.set(i.number, ["factory:ready"], []);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(`next: ${e.message}`); process.exit(30); });
