#!/usr/bin/env node
// Admission-time reconciliation: an open issue labelled factory:running whose latest `cycle` run is finished in Dagu
// gets the transition its success/failure handler should have applied (the handler could not reach GitHub or T3).
//   reconcile.mjs (--issues-file F | --repo R) --state S [--dagu-home H] [--dagu-config C]
// A running or queued latest run is left alone. Idempotent: a run with a successful $STATE/<n>/handled.json record is
// skipped, and finish/success only act on factory:running issues. Logs `reconciled #n run <id>`.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { repoSlug } from "./admit.mjs";
import { LABEL, finishRun, isHandled, labelNames, moveLabel, clearCarry, recordHandled, source } from "./labels.mjs";

const FINISHED_OK = new Set(["succeeded", "success"]);
const FINISHED_BAD = new Set(["failed", "aborted", "canceled", "cancelled", "rejected"]);
export const runIdNumber = (id) => { const m = /^factory-issue-(\d+)-(\d+)$/.exec(id ?? ""); return m ? { n: Number(m[1]), k: Number(m[2]) } : null; };

/** Latest (highest k) cycle run per issue number from a Dagu dag-runs list. */
export function latestRuns(dagRuns) {
  const latest = new Map();
  for (const d of dagRuns) {
    const id = runIdNumber(d.dagRunId);
    if (d.name !== "cycle" || !id) continue;
    if (!latest.has(id.n) || latest.get(id.n).k < id.k) latest.set(id.n, { k: id.k, runId: d.dagRunId, status: String(d.statusLabel ?? "").toLowerCase() });
  }
  return latest;
}

/**
 * Reconcile the running issues. `runs`: Map issue -> {runId, status, steps?}; `stepsOf(runId)` gives "a=succeeded,b=failed".
 * Returns the list of reconciled {issue, runId, event}.
 */
export function reconcile({ src, issues, state, runs, stepsOf = () => "", log = console.log }) {
  const done = [];
  for (const issue of issues) {
    if (!labelNames(issue).includes(LABEL.RUNNING)) continue;
    const n = issue.number;
    const r = runs.get(Number(n));
    if (!r) continue;
    const ok = FINISHED_OK.has(r.status), bad = FINISHED_BAD.has(r.status);
    if (!ok && !bad) continue; // queued, running, waiting: its own handler will act
    if (isHandled(state, n, r.runId)) continue;
    const event = ok ? "success" : "failure";
    try {
      if (ok) { moveLabel(src, n, "done"); clearCarry(state, n); }
      else finishRun(src, { issue: n, state, run: r.runId, steps: r.steps ?? stepsOf(r.runId) });
      recordHandled(state, n, r.runId, event, true);
      log(`reconciled #${n} run ${r.runId}`);
      done.push({ issue: n, runId: r.runId, event });
    } catch (e) {
      recordHandled(state, n, r.runId, event, false);
      console.error(`reconcile #${n} run ${r.runId}: ${e.message}`);
    }
  }
  return done;
}

const dagu = (args, o) => {
  const full = [...args, ...(o.daguHome ? ["--dagu-home", o.daguHome] : []), ...(o.daguConfig ? ["--config", o.daguConfig] : [])];
  const r = spawnSync(o.daguBin ?? process.env.DAGU_BIN ?? "dagu", full, { encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.error || r.status !== 0) throw new Error(`dagu ${args[0]} failed: ${r.error?.message ?? r.stderr}`);
  return r.stdout;
};

/** Cycle runs of one issue from the Dagu CLI history ({name, dagRunId, statusLabel}); local storage, no server needed. */
export function daguIssueRuns(issue, o) {
  const out = JSON.parse(dagu(["history", "cycle", "--run-id", `factory-issue-${issue}-`, "--from", "2000-01-01", "--format", "json", "--limit", "1000"], o) || "[]");
  return out.map((d) => ({ name: d.name, dagRunId: d.dagRunId, statusLabel: d.status }));
}

/** "step=status,..." of a run, parsed from `dagu status` like the cycle handlers do. */
export function daguSteps(runId, o) {
  return dagu(["status", "--run-id", runId, "cycle"], o).split("\n")
    .map((l) => /^(?:├|└)─([^ ]+)(?: \([^)]*\))? \[([a-z_]+)\]$/.exec(l)).filter(Boolean).map((m) => `${m[1]}=${m[2]}`).join(",");
}

/** Every open issue labelled factory:running, paged to exhaustion (`gh api --paginate --slurp`; PRs excluded). */
export function listRunningIssues(repo, run = (args) => spawnSync("gh", args, { encoding: "utf8", maxBuffer: 1 << 28 })) {
  const slug = repoSlug(repo);
  if (!slug) throw new Error(`cannot read the repository slug of ${repo}`);
  const r = run(["api", "--paginate", "--slurp", `repos/${slug}/issues?state=open&per_page=100&labels=${encodeURIComponent(LABEL.RUNNING)}`]);
  if (r.status !== 0) throw new Error(`gh api issues failed: ${r.stderr}`);
  return JSON.parse(r.stdout || "[]").flat().filter((i) => !i.pull_request).map((i) => ({ number: i.number, labels: i.labels ?? [] }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const { values: a } = parseArgs({ options: { "issues-file": { type: "string" }, repo: { type: "string" }, state: { type: "string" }, "dagu-home": { type: "string" }, "dagu-config": { type: "string" } } });
    if (!a.state) throw new Error("--state is required");
    let issues;
    if (a["issues-file"]) issues = JSON.parse(readFileSync(a["issues-file"], "utf8"));
    else {
      if (!a.repo) throw new Error("--repo or --issues-file is required");
      issues = listRunningIssues(a.repo);
    }
    const running = issues.filter((i) => labelNames(i).includes(LABEL.RUNNING));
    if (running.length) {
      const o = { daguHome: a["dagu-home"] ?? process.env.DAGU_HOME, daguConfig: a["dagu-config"] ?? process.env.DAGU_CONFIG };
      const runs = new Map();
      for (const i of running) {
        try {
          const r = latestRuns(daguIssueRuns(i.number, o)).get(Number(i.number));
          if (r) runs.set(Number(i.number), r);
        } catch (e) { console.error(`reconcile #${i.number}: ${e.message}`); }
      }
      const src = source({ issuesFile: a["issues-file"], repo: a.repo });
      reconcile({ src, issues: running, state: a.state, runs, stepsOf: (id) => daguSteps(id, o) });
    }
  } catch (e) { console.error(`reconcile: ${e.message}`); process.exit(30); }
}
