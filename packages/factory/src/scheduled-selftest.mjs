#!/usr/bin/env node
// Scheduled full selftest of `main` (dags/selftest.yaml): detects environment drift (T3, Pi, Dagu, model, credentials)
// even when no issue is running. Rules: CONTRACTS.md, "Scheduled selftest contract". `decide` is pure.
//   scheduled-selftest.mjs run --state S --primary P --t3-home H [--factory F] [--inbox T] [--base origin/main]
//     [--cmd "npm run selftest"] [--dagu-home H] [--dagu-config C] [--busy yes|no] [--keep-history N]
// Exit: 0 pass or skipped, 1 selftest red (recorded and notified), 30 internal error.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
export const VERSION = 1;
export const MAX_HISTORY = 365;
export const historyFile = (state) => join(state, "selftest", "history.json");

/** Entries that say something about the code/environment: skipped runs say nothing. */
const judged = (runs) => runs.filter((r) => r?.result === "pass" || r?.result === "fail");

/**
 * Pure decision. `runs` = history entries before this one; `current` = {result: pass|fail}; `busy` = a factory cycle run is queued/running.
 * Returns {action: skip|none|notify|recover, openBreaker}.
 * skip: busy (nothing runs). notify: red now. recover: green after a red. openBreaker: red now and the previous judged run was red too.
 */
export function decide({ runs = [], current, busy = false }) {
  if (busy) return { action: "skip", openBreaker: false };
  const prev = judged(runs).at(-1);
  if (current?.result === "fail") return { action: "notify", openBreaker: prev?.result === "fail" };
  if (current?.result === "pass") return { action: prev?.result === "fail" ? "recover" : "none", openBreaker: false };
  throw new Error(`decide: unknown result ${JSON.stringify(current?.result)}`);
}

/** Versions that differ between the last passing run and now: [{name, from, to}]. No earlier pass: []. */
export function changedVersions(runs, versions) {
  const lastPass = runs.filter((r) => r?.result === "pass").at(-1);
  if (!lastPass) return [];
  return Object.keys({ ...lastPass.versions, ...versions })
    .filter((k) => (lastPass.versions?.[k] ?? "unknown") !== (versions?.[k] ?? "unknown"))
    .map((k) => ({ name: k, from: lastPass.versions?.[k] ?? "unknown", to: versions?.[k] ?? "unknown" }));
}

/** The failing checks from the selftest output: lines that say FAIL/not ok/Error, else its last lines. */
export function failingChecks(output, max = 12) {
  const lines = String(output ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const hit = lines.filter((l) => /\b(FAIL|FAILED)\b|^not ok\b|\bError\b/.test(l));
  return [...new Set(hit.length ? hit : lines.slice(-5))].slice(-max).map((l) => l.slice(0, 300));
}

export function formatNotice({ event, entry, changed, checks }) {
  if (event === "recover") return `[Fábrica] El selftest programado de main vuelve a pasar (main ${entry.sha.slice(0, 12)}, ${entry.date}).`;
  return [
    `[Fábrica] El selftest programado de main FALLA (main ${entry.sha.slice(0, 12)}, ${entry.date}).`,
    `Comprobaciones fallidas: ${checks.length ? checks.join(" | ") : "(sin detalle)"}`,
    `Versiones: ${Object.entries(entry.versions).map(([k, v]) => `${k}=${v}`).join(", ")}`,
    `Cambiadas desde el último pase: ${changed.length ? changed.map((c) => `${c.name} ${c.from} -> ${c.to}`).join(", ") : "ninguna (o sin pase previo)"}`,
  ].join("\n");
}

export function readHistory(state) {
  try {
    const h = JSON.parse(readFileSync(historyFile(state), "utf8"));
    if (h?.version === VERSION && Array.isArray(h.runs)) return h;
  } catch { /* missing or corrupt: start over */ }
  return { version: VERSION, runs: [] };
}
export function appendHistory(state, entry, keep = MAX_HISTORY) {
  const h = readHistory(state);
  h.runs = [...h.runs, entry].slice(-keep);
  const f = historyFile(state);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(`${f}.tmp`, JSON.stringify(h, null, 1));
  renameSync(`${f}.tmp`, f);
  return h;
}

const first = (cmd, args, env) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", env, timeout: 20_000 });
  return r.status === 0 ? (`${r.stdout}${r.stderr}`.match(/\d+\.\d+[\w.+-]*/)?.[0] ?? "unknown") : null;
};
/** T3, Pi and Dagu versions as seen now ("unknown" when not readable). */
export function collectVersions(env = process.env) {
  let t3 = "unknown";
  try { t3 = JSON.parse(readFileSync(join(homedir(), ".t3", "userdata", "server-runtime.json"), "utf8")).serverVersion ?? "unknown"; } catch { /* keep */ }
  return {
    t3,
    pi: first(env.PI_BIN ?? join(homedir(), "bin", "pi"), ["--version"], env) ?? "unknown",
    dagu: first(env.FACTORY_DAGU_BIN ?? "dagu", ["version"], env) ?? first(env.FACTORY_DAGU_BIN ?? "dagu", ["--version"], env) ?? "unknown",
  };
}

const git = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8" });

/** Runs `cmd` on a fresh temporary worktree of `base`; always removes it. Returns {sha, pass, output}. */
export function runOnFreshMain({ primary, base, cmd, env, install = true, timeoutMs = 45 * 60_000 }) {
  const remote = base.includes("/") ? base.split("/")[0] : null;
  if (remote) { const f = git(primary, ["fetch", "-q", remote, base.slice(remote.length + 1)]); if (f.status !== 0) throw new Error(`git fetch failed: ${f.stderr}`); }
  const sha = git(primary, ["rev-parse", `${base}^{commit}`]).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`cannot resolve ${base}`);
  const dir = mkdtempSync(join(tmpdir(), "factory-scheduled-selftest-"));
  const wt = join(dir, "main");
  try {
    const add = git(primary, ["worktree", "add", "--detach", wt, sha]);
    if (add.status !== 0) throw new Error(`git worktree add failed: ${add.stderr}`);
    const run = (args) => spawnSync("bash", ["-c", args], { cwd: wt, encoding: "utf8", env, timeout: timeoutMs, maxBuffer: 1 << 28 });
    let r = install ? run("npm ci --no-audit --no-fund") : { status: 0, stdout: "", stderr: "" };
    if (r.status !== 0) return { sha, pass: false, output: `FAIL npm ci\n${r.stdout ?? ""}${r.stderr ?? ""}` };
    r = run(cmd);
    return { sha, pass: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\nError: ${r.error.message}` : ""}` };
  } finally {
    git(primary, ["worktree", "remove", "--force", wt]);
    rmSync(dir, { recursive: true, force: true });
    git(primary, ["worktree", "prune"]);
  }
}

function notify(o, event, run, text, env) {
  spawnSync("node", [join(HERE, "notify.mjs"), "--event", event, "--run", run, "--issue", "selftest", "--text", text,
    "--inbox", o.inbox ?? "", "--primary", o.primary, "--t3-home", o.t3Home, "--state", o.state, "--factory", o.factory ?? HERE],
  { encoding: "utf8", env, stdio: ["ignore", "inherit", "inherit"] });
}

/** Whole run (I/O); returns the stored entry. `o.busy` (boolean) and `o.versions` are injectable. */
export async function run(o, env = process.env) {
  const now = o.now ?? new Date();
  let busy = o.busy;
  let busyError = null;
  if (busy === undefined) {
    try {
      let n;
      if (o.inFlight) n = (await o.inFlight()).length;
      else {
        const { daguInFlight } = await import("./next.mjs");
        const { daguUrl } = await import("./breaker.mjs");
        n = (await daguInFlight({ url: daguUrl(env, o.daguHome ?? env.DAGU_HOME, o.daguConfig ?? env.DAGU_CONFIG) })).length;
      }
      busy = n > 0;
    } catch (e) {
      // fail closed: occupancy unknown means a cycle may be running, so nothing runs
      busy = true;
      busyError = e?.cause?.code ? `${e.message} (${e.cause.code})` : String(e?.message ?? e);
      console.error(`selftest: cannot read Dagu runs (${busyError}); skipping`);
    }
  }
  const versions = o.versions ?? collectVersions(env);
  const prior = readHistory(o.state).runs;
  if (decide({ runs: prior, current: { result: "pass" }, busy }).action === "skip") {
    const entry = { date: now.toISOString(), sha: null, durationMs: 0, result: "skipped", versions, ...(busyError ? { error: `cannot read Dagu runs: ${busyError}` } : {}) };
    appendHistory(o.state, entry);
    console.log(`selftest: ${busyError ? "cannot determine whether a factory cycle run is active" : "a factory cycle run is queued or running"}; skipped`);
    return entry;
  }
  const t0 = Date.now();
  let res;
  try { res = runOnFreshMain({ primary: o.primary, base: o.base ?? "origin/main", cmd: o.cmd ?? "npm run selftest", env, install: o.install ?? true }); }
  catch (e) { res = { sha: "0".repeat(40), pass: false, output: `Error: ${e.message}` }; }
  const entry = { date: now.toISOString(), sha: res.sha, durationMs: Date.now() - t0, result: res.pass ? "pass" : "fail", versions };
  const checks = res.pass ? [] : failingChecks(res.output);
  if (!res.pass) entry.failing = checks;
  const d = decide({ runs: prior, current: entry });
  appendHistory(o.state, entry);
  const runId = `selftest-${entry.date}`;
  if (d.action === "notify") notify(o, "selftest-red", runId, formatNotice({ event: "notify", entry, changed: changedVersions(prior, versions), checks }), env);
  if (d.action === "recover") notify(o, "selftest-green", runId, formatNotice({ event: "recover", entry }), env);
  if (d.openBreaker) {
    // the breaker's `selftest-red` condition reads the history just written; opening notifies once (breaker.mjs)
    const { check } = await import("./breaker.mjs");
    await check({ state: o.state, primary: o.primary, t3Home: o.t3Home, factory: o.factory ?? HERE, inbox: o.inbox, daguHome: o.daguHome, daguConfig: o.daguConfig }, env);
  }
  console.log(`selftest: ${entry.result} on ${entry.sha?.slice(0, 12)} (${d.action}${d.openBreaker ? ", breaker" : ""})`);
  return entry;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const [cmd, ...rest] = process.argv.slice(2);
    if (cmd !== "run") throw new Error(`unknown command ${cmd}`);
    const { values: a } = parseArgs({ args: rest, options: {
      state: { type: "string" }, primary: { type: "string" }, "t3-home": { type: "string" }, factory: { type: "string" }, inbox: { type: "string" },
      base: { type: "string" }, cmd: { type: "string" }, "dagu-home": { type: "string" }, "dagu-config": { type: "string" },
    } });
    const state = a.state || process.env.STATE || process.env.A4S_STATE;
    if (!state || !a.primary || !a["t3-home"]) throw new Error("--state, --primary and --t3-home are required");
    const e = await run({ state, primary: a.primary, t3Home: a["t3-home"], factory: a.factory, inbox: a.inbox, base: a.base, cmd: a.cmd, daguHome: a["dagu-home"], daguConfig: a["dagu-config"] });
    process.exit(e.result === "fail" ? 1 : 0);
  } catch (e) { console.error(`selftest: ${e.message}`); process.exit(30); }
}
