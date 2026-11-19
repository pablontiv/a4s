// Classification of the CI runs of a commit (used by the `ci` step of dags/cycle.yaml).
// Only a real red (failure/timed_out, or no verdict before the timeout) reverts a commit.
import { fileURLToPath } from "node:url";
import { writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export const DEFAULT_WORKFLOWS = ["CI"];
const RED = new Set(["failure", "timed_out", "startup_failure"]);
const SOFT = new Set(["skipped", "neutral"]);

/** Parse a workflow list ("CI, Lint"; empty = default). */
export const parseWorkflows = (s) => {
  const l = String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return l.length ? l : DEFAULT_WORKFLOWS;
};

/**
 * Pure. runs: [{workflowName, status, conclusion, url, createdAt}] of ONE sha.
 * Returns {state: success|red|running|cancelled|skipped, conclusion, workflow, url}.
 * Only counted workflows matter; a counted workflow without a run yet is `running`.
 * With timedOut, a missing/running result is red (conclusion "timeout"); a cancelled one stays red too
 * (no later commit gave a verdict in time).
 */
export function classify(runs, { workflows = DEFAULT_WORKFLOWS, timedOut = false } = {}) {
  const per = workflows.map((w) => {
    const mine = (runs ?? []).filter((r) => r.workflowName === w)
      .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
    return { workflow: w, run: mine[0] };
  });
  const view = ({ workflow, run }) => ({ workflow, conclusion: run?.conclusion || run?.status || "none", url: run?.url ?? "" });
  const done = per.filter((p) => p.run?.status === "completed");
  const red = done.find((p) => RED.has(p.run.conclusion));
  if (red) return { state: "red", ...view(red) };
  const pending = per.find((p) => !p.run || p.run.status !== "completed");
  if (pending) return timedOut ? { state: "red", ...view(pending), conclusion: "timeout" } : { state: "running", ...view(pending), cancelled: done.some((p) => p.run.conclusion === "cancelled") };
  const canc = done.find((p) => p.run.conclusion === "cancelled");
  if (canc) return timedOut ? { state: "red", ...view(canc), conclusion: "timeout" } : { state: "cancelled", ...view(canc) };
  const unknown = done.find((p) => p.run.conclusion !== "success" && !SOFT.has(p.run.conclusion));
  if (unknown) return { state: "red", ...view(unknown) };
  const ok = done.find((p) => p.run.conclusion === "success");
  if (ok) return { state: "success", ...view(ok) };
  return { state: "skipped", ...view(done[0]) };
}

/**
 * The CI decision flow for a pushed SHA. Sources are injected:
 *   runs(sha) -> runs of that commit; tip() -> current origin/BASE sha; contains(sha, tip) -> tip contains sha;
 *   now() -> ms; sleep(ms) -> Promise.
 * A cancelled run falls back to the later commit that contains the SHA BEFORE any timeout conversion;
 * only when the (possibly substituted) target has no verdict at the deadline is it red (timeout).
 * Returns {state, conclusion, workflow, url, target}; only state "red" reverts.
 */
export async function waitForCi({ sha, runs, tip, contains, now, sleep, deadline, workflows = DEFAULT_WORKFLOWS, pollMs = 20000 }) {
  for (;;) {
    let target = sha;
    let c = classify(await runs(target), { workflows });
    if (c.state === "cancelled" || (c.state === "running" && c.cancelled)) {
      const t = await tip();
      if (t && t !== sha && (await contains(sha, t))) { target = t; c = classify(await runs(target), { workflows }); }
    }
    if (c.state !== "running" && c.state !== "cancelled") return { ...c, target };
    if (now() >= deadline) return { ...classify(await runs(target), { workflows, timedOut: true }), target };
    await sleep(pollMs);
  }
}

/** Final decision of the step for the classification: revert only on red. */
export const shouldRevert = (c) => c.state === "red";

// CLI: ci.mjs classify --workflows CI [--timed-out] < runs.json   -> prints JSON
//      ci.mjs failure --file F --run R --conclusion C --workflow W --url U --sha S
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await (async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = {};
  for (let i = 0; i < rest.length; i++) { const k = rest[i].replace(/^--/, ""); o[k] = rest[i + 1]?.startsWith("--") || rest[i + 1] === undefined ? true : rest[++i]; }
  if (cmd === "classify") {
    let runs = [];
    try { runs = JSON.parse(readFileSync(0, "utf8") || "[]"); } catch { runs = []; }
    console.log(JSON.stringify(classify(runs, { workflows: parseWorkflows(o.workflows === true ? "" : o.workflows), timedOut: o["timed-out"] === true })));
  } else if (cmd === "wait") {
    // ci.mjs wait --primary P --origin URL --sha S --base B --workflows W --timeout-min N -> prints JSON
    const sh = (bin, args) => spawnSync(bin, args, { encoding: "utf8" });
    const git = (...a) => sh("git", ["-C", o.primary, ...a]);
    const r = await waitForCi({
      sha: o.sha, workflows: parseWorkflows(o.workflows === true ? "" : o.workflows),
      deadline: Date.now() + Number(o["timeout-min"] || 30) * 60000,
      now: Date.now, sleep: (ms) => new Promise((f) => setTimeout(f, ms)),
      runs: (sha) => { const g = sh("gh", ["run", "list", "-R", o.origin, "--commit", sha, "--json", "status,conclusion,workflowName,url,createdAt"]); try { return g.status === 0 ? JSON.parse(g.stdout) : []; } catch { return []; } },
      tip: () => { git("fetch", "-q", "origin", o.base); const t = git("rev-parse", `origin/${o.base}`); return t.status === 0 ? t.stdout.trim() : ""; },
      contains: (sha, tip) => git("merge-base", "--is-ancestor", sha, tip).status === 0,
    });
    console.log(JSON.stringify(r));
  } else if (cmd === "failure") {
    writeFileSync(o.file, JSON.stringify({ run: o.run, step: "ci", findings: [`ci: ${o.workflow} was '${o.conclusion}' for ${o.sha}${o.url ? ` (${o.url})` : ""}`] }) + "\n");
  } else { console.error("ci: unknown command"); process.exit(2); }
})();
