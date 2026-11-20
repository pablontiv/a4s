#!/usr/bin/env node
// Circuit breaker core: the factory stops admitting when continuing would make things worse.
//   breaker.mjs check [--state S] [--snapshot F] [--primary P] [--t3-home H] [--factory F] [--inbox T] [--cycle cycle.yaml]
//       evaluates, updates $STATE/breaker.json, notifies once when it opens. Exit 0 closed, 40 open.
//   breaker.mjs reset [--state S] [--by NAME]   the operator closes it explicitly (records who/when).
// --state defaults to $STATE, then $A4S_STATE. --snapshot F: a JSON snapshot instead of live data (fixtures).
// Rules: CONTRACTS.md, "Circuit breaker contract". `evaluate` is pure.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { STATION_TIMEOUT_SEC, resolveT3, validateState } from "./lib.mjs";
import { waitedWithin } from "./lease.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const VERSION = 1;
export const EXIT_OPEN = 40;
export const UNREACHABLE_MIN = 30;
export const CI_TIMEOUT_MIN = 30;
export const MAX_RUNS = 3;
export const SERVICES = Object.freeze(["dagu", "t3"]);
const MIN = 60_000;
const DATE_MAX = 8.64e15;
const ISO_8601 = /^[+-]?\d{4,6}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/;
/**
 * The one total time helper: finite epoch-ms or null. Only ISO-8601 strings and finite numbers within the JS Date
 * range (+-8.64e15) are accepted; booleans, other types, unparsable strings and out-of-range numbers give null. Never throws.
 */
export function toTime(v) {
  if (typeof v === "number") return Number.isFinite(v) && Math.abs(v) <= DATE_MAX ? v : null;
  if (typeof v !== "string" || !ISO_8601.test(v.trim())) return null;
  const t = Date.parse(v.trim());
  return Number.isFinite(t) && Math.abs(t) <= DATE_MAX ? t : null;
}
const ms = toTime;
const iso = (v) => new Date(toTime(v) ?? 0).toISOString();

/**
 * Conditions: one function per kind, (snapshot, now) -> [{kind, detail, since}]. Later issues add entries here.
 * `clears(snapshot)` says when a reason of that kind may clear by itself; kinds without it never clear by themselves.
 */
export const CONDITIONS = {
  unreachable: {
    detect(snapshot, state, now) {
      const out = [];
      const prior = (state?.reasons ?? []).find((r) => r.kind === "unreachable");
      for (const name of SERVICES) {
        const svc = snapshot?.services?.[name];
        if (svc && svc.reachable === true) continue; // a missing entry counts as unreachable
        // down since the last time it was seen reachable; unknown: since the breaker first noticed, else now
        const since = ms(svc?.lastReachableAt) ?? ms(prior?.since) ?? now;
        if ((now - since) / MIN > UNREACHABLE_MIN) {
          out.push({ kind: "unreachable", detail: `${name} unreachable for more than ${UNREACHABLE_MIN} min`, since: iso(since) });
        }
      }
      return out;
    },
    clears: (snapshot) => SERVICES.every((n) => snapshot?.services?.[n]?.reachable === true),
  },
  // CI of the current main commit. No `clears`: only `reset` closes it. Absent snapshot.ci = not collected.
  ci: {
    detect(snapshot, state, now) {
      const ci = snapshot?.ci;
      if (!ci) return [];
      const limit = (Number(ci.timeoutMin) > 0 ? Number(ci.timeoutMin) : CI_TIMEOUT_MIN) * MIN;
      if (ci.lookupFailed) {
        const since = ms(ci.failingSince) ?? now;
        return now - since > limit ? [{ kind: "ci", detail: `CI lookup of main keeps failing for more than ${limit / MIN} min (${ci.error ?? "unknown"})`, since: iso(since) }] : [];
      }
      const short = String(ci.sha).slice(0, 12);
      const at = ms(ci.commitTime);
      if (at === null) return [{ kind: "ci", detail: `CI snapshot has an invalid commitTime: ${JSON.stringify(ci.commitTime) ?? "undefined"}`, since: iso(now) }];
      if (ci.status === "failure") return [{ kind: "ci", detail: `CI of current main ${short} is failing`, since: iso(at) }];
      if ((ci.status === "none" || ci.status === "pending") && now - at > limit) {
        return [{ kind: "ci", detail: `no finished CI for current main ${short} ${limit / MIN} min after the commit (${ci.status})`, since: iso(at + limit) }];
      }
      return []; // success, or in progress / not yet started under the timeout
    },
  },
  // Run limits: more than MAX_RUNS runs of one issue, a step running past its safety cap, a `stuck`/`timeout` outcome not followed by a pass in the same step.
  // No `clears`: only `reset` closes it; what happened before the last reset (resetAt) no longer counts.
  limits: {
    detect(snapshot, state, now) {
      const l = snapshot?.limits;
      if (!l) return [];
      const after = ms(state?.resetAt) ?? -Infinity;
      const live = (t) => { const x = ms(t); return x === null || !(x <= after); };
      const bad = (what, field, v) => ({ kind: "limits", detail: `${what}: invalid ${field} ${JSON.stringify(v) ?? "undefined"}`, since: iso(now) });
      const maxRuns = Number.isFinite(l.maxRuns) ? l.maxRuns : MAX_RUNS;
      const out = [];
      for (const r of Array.isArray(l.runs) ? l.runs : []) {
        const t = ms(r?.at);
        if (t === null) { out.push(bad(`issue #${r?.issue}`, "at", r?.at)); continue; }
        if (r.runs > maxRuns && live(t)) out.push({ kind: "limits", detail: `issue #${r.issue}: ${r.runs} runs (limit ${maxRuns}) in attempts.json`, since: iso(t) });
      }
      const steps = Array.isArray(l.steps) ? l.steps : [];
      for (const s of steps) {
        const at = ms(s?.startedAt);
        if (at === null) { out.push(bad(`issue #${s?.issue} step ${s?.step}`, "startedAt", s?.startedAt)); continue; }
        if (!live(at)) continue;
        const bad_ = s.outcome === "timeout" || s.outcome === "stuck";
        // an escalation that later passes in the same step does not keep the breaker open
        const recovered = bad_ && stepRecovered(steps, s.issue, s.step, at);
        // time spent waiting for the integration lease ($ISSUE_STATE/lease-wait.json) is not step time
        const waited = Number.isFinite(s.waitedMs) && s.waitedMs > 0 ? s.waitedMs : 0;
        if (bad_ && !recovered) out.push({ kind: "limits", issue: s.issue, step: s.step, attemptAt: at, detail: `issue #${s.issue} step ${s.step}: attempt started ${iso(at)} ended with outcome ${s.outcome}${s.outcome === "timeout" ? ` (safety cap ${s.timeoutSec}s)` : " (no activity)"}`, since: iso(at) });
        else if (s.outcome === undefined && now - at - waited > s.timeoutSec * 1000) out.push({ kind: "limits", issue: s.issue, step: s.step, attemptAt: at, detail: `issue #${s.issue} step ${s.step}: attempt started ${iso(at)} still running past its safety cap of ${s.timeoutSec}s`, since: iso(at + waited + s.timeoutSec * 1000) });
      }
      for (const p of Array.isArray(l.problems) ? l.problems : []) {
        if (live(p?.at)) out.push({ kind: "limits", detail: `issue #${p?.issue} step ${p?.step}: ${p?.error}`, since: iso(p?.at ?? now) });
      }
      return out;
    },
  },
};

/** A later attempt of the same issue and step passed: its earlier stuck/timeout no longer counts. */
const stepRecovered = (steps, issue, step, at) => steps.some((n) => n?.issue === issue && n?.step === step && n.outcome === "pass" && (ms(n.startedAt) ?? -Infinity) > at);

const GREEN = new Set(["success", "skipped", "neutral"]);

/**
 * CI of the CURRENT main commit. Sources are injected: `git(args[]) -> stdout` and `gh(args[]) -> stdout`, both
 * throwing on failure. Returns the snapshot's `ci`:
 *   {lookupFailed:true, error, timeoutMin}                         fetch/gh/parse failed: never a pass
 *   {sha, commitTime, status: "success"|"failure"|"pending"|"none", timeoutMin}
 * Only runs whose headSha equals the current SHA count; CI of any other commit is ignored.
 * A failed `git fetch` is a lookup failure: a stale origin/main is not proof of health.
 */
export function collectCi({ git, gh, branch = "main", remote = "origin", env = {} }) {
  const timeoutMin = Number(env.CI_TIMEOUT_MIN) > 0 ? Number(env.CI_TIMEOUT_MIN) : CI_TIMEOUT_MIN;
  const fail = (what, e) => ({ lookupFailed: true, error: `${what}: ${String(e?.message ?? e).split("\n")[0]}`, timeoutMin });
  let sha, commitTime;
  try { git(["fetch", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]); } catch (e) { return fail("git fetch failed", e); }
  try {
    sha = String(git(["rev-parse", "--verify", "FETCH_HEAD^{commit}"])).trim();
    commitTime = String(git(["show", "-s", "--format=%cI", sha])).trim();
    if (!/^[0-9a-f]{7,64}$/i.test(sha) || toTime(commitTime) === null) throw new Error("unexpected git output");
  } catch (e) { return fail("cannot resolve main commit", e); }
  let runs;
  try {
    runs = JSON.parse(String(gh(["run", "list", "--commit", sha, "--limit", "100", "--json", "headSha,status,conclusion"])));
    if (!Array.isArray(runs)) throw new Error("unexpected gh output");
  } catch (e) { return fail("GitHub lookup failed", e); }
  runs = runs.filter((r) => r && String(r.headSha).toLowerCase() === sha.toLowerCase());
  let status = "success";
  if (runs.length === 0) status = "none";
  else if (runs.some((r) => r.status === "completed" && !GREEN.has(r.conclusion))) status = "failure";
  else if (runs.some((r) => r.status !== "completed")) status = "pending";
  return { sha, commitTime, status, timeoutMin };
}

/**
 * Per-line step timeouts configured in the cycle DAG: for each step running `station.mjs --line X`, its
 * `--timeout-sec N` (or `timeoutSec:` / `timeout_sec:` key; the station default when absent). Returns the sorted distinct values per line:
 * several values mean several steps of one line with different timeouts, which an attempt cannot be told apart from (see collectLimits).
 */
export function cycleTimeouts(text) {
  const out = {};
  for (const block of String(text).split(/^\s*- id:/m).slice(1)) {
    const line = block.match(/station\.mjs["']?\s+--line\s+(\w+)/)?.[1];
    if (!line) continue;
    const sec = Number(block.match(/--timeout-sec[ =]+["']?(\d+)/)?.[1] ?? block.match(/\btimeout_?[sS]ec:\s*(\d+)/)?.[1]);
    const v = sec > 0 ? sec : STATION_TIMEOUT_SEC; // a step without an explicit value runs with the station default
    out[line] = [...new Set([...(out[line] ?? []), v])].sort((x, y) => x - y);
  }
  return out;
}

/**
 * Snapshot `limits` from the station files in `state` and the cycle's configured timeouts (never a fixed value):
 *   {maxRuns, runs: [{issue, runs, at}], steps: [{issue, step, startedAt, timeoutSec, outcome?, waitedMs}], problems: [{issue, step, error, at}]}
 * Only `<line>.json` counts: files archived by admission (`impl.json.<ts>`) are history, never counted twice.
 * Timeout of an attempt: its own recorded `timeoutSec`, else the cycle's `--timeout-sec` for the line, else the station default.
 * When the line's steps have different timeouts and the attempt did not record its own, the step is ambiguous: the largest
 * timeout is applied, and an in-flight attempt older than the smallest but not the largest is a problem (reason), never silently closed.
 * An unreadable/corrupt/invalid attempt file, or a state/cycle that cannot be read, is a problem (a reason), not ignored.
 */
export function collectLimits({ state, cycleFile = join(HERE, "..", "dags", "cycle.yaml"), now: now0 = Date.now() }) {
  const now = toTime(now0) ?? Date.now();
  const limits = { maxRuns: MAX_RUNS, runs: [], steps: [], problems: [] };
  const problem = (issue, step, error, at = now) => limits.problems.push({ issue, step, error, at: iso(at) });
  let timeouts = {};
  try { timeouts = cycleTimeouts(readFileSync(cycleFile, "utf8")); } catch (e) { problem("-", "cycle", `cannot read cycle file ${cycleFile}: ${e.code ?? e.message}`); }
  let dirs;
  try { dirs = readdirSync(state, { withFileTypes: true }).filter((d) => d.isDirectory() && /^\d+$/.test(d.name)).map((d) => d.name); } catch (e) {
    if (e.code !== "ENOENT") problem("-", "state", `cannot list state ${state}: ${e.code ?? e.message}`);
    return limits;
  }
  const mtime = (f) => { try { return statSync(f).mtimeMs; } catch { return now; } };
  const load = (issue, step, file, validate) => {
    let text;
    try { text = readFileSync(file, "utf8"); } catch (e) {
      if (e.code === "ENOENT") return { missing: true };
      problem(issue, step, `${file} unreadable: ${e.code ?? e.message}`); return null;
    }
    let at = now; try { at = statSync(file).mtimeMs; } catch { /* keep now */ }
    try { return { value: validate(JSON.parse(text)) }; } catch (e) { problem(issue, step, `${file} is corrupt: ${e.message}`, at); return null; }
  };
  for (const issue of dirs) {
    const dir = join(state, issue);
    const stations = ["impl", "qa"].map((line) => [line, load(issue, line, join(dir, `${line}.json`), validateState)]);
    const af = load(issue, "attempts", join(dir, "attempts.json"), (v) => {
      if (!v || typeof v !== "object" || Array.isArray(v) || !Number.isInteger(v.streak) || v.streak < 0) throw new Error("streak must be a non-negative integer");
      for (const k of ["lastAt", "resetAt"]) if (v[k] !== undefined && toTime(v[k]) === null) throw new Error(`${k} is not a valid timestamp: ${JSON.stringify(v[k])}`);
      return v;
    });
    if (af?.missing) { if (stations.some(([, r]) => r && !r.missing)) problem(issue, "attempts", `${join(dir, "attempts.json")} is missing: run count unknown`); }
    else if (af) limits.runs.push({ issue, runs: af.value.streak, at: toTime(af.value.lastAt) ?? toTime(af.value.resetAt) ?? now });
    for (const [line, r] of stations) {
      if (!r || r.missing) continue;
      for (const [i, at] of r.value.attempts.entries()) {
        const started = toTime(at?.startedAt);
        if (started === null) {
          // any startedAt that toTime rejects (absent included) is corruption, whatever the outcome
          problem(issue, line, `${join(dir, `${line}.json`)}: attempt ${i + 1} has invalid field startedAt: ${JSON.stringify(at?.startedAt) ?? "undefined"}`, mtime(join(dir, `${line}.json`)));
          continue;
        }
        const last = i === r.value.attempts.length - 1;
        if (at.outcome === undefined && !last) continue; // superseded without outcome: not in flight
        const set = at.timeoutSec > 0 ? [at.timeoutSec] : timeouts[line] ?? [STATION_TIMEOUT_SEC];
        const timeoutSec = set.at(-1);
        if (at.outcome === undefined && set.length > 1 && now - started > set[0] * 1000 && now - started <= timeoutSec * 1000) {
          problem(issue, line, `attempt started ${iso(started)} is in flight past ${set[0]}s but the cycle configures several timeouts for this line (${set.join("/")}s) and the attempt did not record which applies`, started);
        }
        limits.steps.push({ issue, step: line, startedAt: iso(started), timeoutSec, outcome: at.outcome, waitedMs: waitedWithin(dir, started, now) });
      }
    }
  }
  return limits;
}

/**
 * Timestamps in the tracking files ($STATE/reachability.json `lastReachableAt`, $STATE/ci-tracking.json `failingSince`):
 * a present but invalid one is a `limits` corruption reason naming file and field (the trackers then rewrite the file).
 */
export function trackingProblems(stateDir, now) {
  const out = [];
  const bad = (file, field, v) => out.push({ issue: "-", step: "tracking", error: `${file}: invalid field ${field}: ${JSON.stringify(v) ?? "undefined"}`, at: iso(now) });
  const rf = join(stateDir, "reachability.json");
  const reach = readJson(rf, {});
  for (const name of SERVICES) {
    const v = reach?.[name]?.lastReachableAt;
    if (v !== undefined && toTime(v) === null) bad(rf, `${name}.lastReachableAt`, v);
  }
  const cf = join(stateDir, "ci-tracking.json");
  const v = readJson(cf, {})?.failingSince;
  if (v !== undefined && toTime(v) === null) bad(cf, "failingSince", v);
  return out;
}

/** Live sources: git and gh run in `cwd` (the primary checkout). */
export function liveSources(cwd) {
  const run = (cmd) => (args) => {
    const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 60_000 });
    if (r.error || r.status !== 0) throw new Error(r.error?.message ?? (r.stderr || `${cmd} exit ${r.status}`));
    return r.stdout;
  };
  return { git: run("git"), gh: run("gh") };
}

/** Remembers since when lookups fail ($STATE/ci-tracking.json); cleared by a successful lookup. */
export function trackCi(stateDir, ci, now) {
  if (!ci) return ci;
  const f = join(stateDir, "ci-tracking.json");
  const mem0 = readJson(f, {}); const mem = mem0 && typeof mem0 === "object" && !Array.isArray(mem0) ? mem0 : {};
  if (!ci.lookupFailed) { writeJson(f, {}); return ci; }
  const failingSince = [ci.failingSince, mem?.failingSince].find((x) => toTime(x) !== null) ?? iso(now);
  writeJson(f, { failingSince });
  return { ...ci, failingSince };
}

/**
 * Pure. `state` is the stored breaker state (or {invalid:true} when the file was corrupt/unknown version).
 * Returns {open, reasons: [{kind, detail, since}]}. Reasons already in `state` are kept unless their condition
 * clears by itself (unreachable: only when both Dagu and T3 are reachable); everything else needs `reset`.
 */
export function evaluate(snapshot, state, now = Date.now()) {
  const t = toTime(now) ?? Date.now();
  const reasons = [];
  if (state?.invalid) reasons.push({ kind: "state-invalid", detail: state.detail ?? "breaker state is corrupt or has an unknown version", since: iso(t) });
  for (const r of state?.open ? state.reasons ?? [] : []) {
    if (CONDITIONS[r.kind]?.clears?.(snapshot)) continue;
    // a persisted stuck/timeout reason clears when its step later passed (unrelated reasons stay)
    if (r.kind === "limits" && r.step !== undefined && Array.isArray(snapshot?.limits?.steps) && stepRecovered(snapshot.limits.steps, r.issue, r.step, ms(r.attemptAt) ?? Infinity)) continue;
    reasons.push(r);
  }
  for (const [kind, c] of Object.entries(CONDITIONS)) {
    for (const r of c.detect(snapshot, state, t)) if (!reasons.some((x) => x.kind === kind && x.detail === r.detail)) reasons.push(r);
  }
  return { open: reasons.length > 0, reasons };
}

const writeJson = (f, v) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(v, null, 1)); };
export const breakerFile = (state) => join(state, "breaker.json");

const validTime = (v) => typeof v === "string" && toTime(v) !== null;
const nullOr = (f) => (v) => v === null || v === undefined || f(v);
const validReason = (r) => !!r && typeof r === "object" && typeof r.kind === "string" && r.kind !== "" && typeof r.detail === "string" && validTime(r.since);

/** Complete schema check of a parsed state; returns an error text or null. */
export function stateError(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return "not an object";
  if (s.version !== VERSION) return "unknown version";
  if (typeof s.open !== "boolean") return "open is not a boolean";
  if (!Array.isArray(s.reasons) || !s.reasons.every(validReason)) return "invalid reasons";
  if (s.open && (s.reasons.length === 0 || !validTime(s.since))) return "open without reasons or valid since";
  if (!s.open && (s.reasons.length > 0 || (s.since !== null && s.since !== undefined))) return "closed with reasons or since";
  for (const k of ["resetBy", "resetAt"]) if (!(k in s)) return `missing required field ${k}`;
  if (!nullOr(validTime)(s.resetAt) || !nullOr((v) => typeof v === "string")(s.resetBy) || !nullOr(validTime)(s.notifiedAt)) return "invalid resetBy/resetAt/notifiedAt";
  return null;
}

/** Stored state; a missing file is closed, a corrupt/unknown-version/inconsistent one is {invalid:true} (fail closed). */
export function readState(stateDir) {
  let text;
  try { text = readFileSync(breakerFile(stateDir), "utf8"); } catch (e) {
    if (e.code === "ENOENT") return { version: VERSION, open: false, reasons: [], since: null, resetBy: null, resetAt: null };
    return { invalid: true, detail: `breaker.json unreadable: ${e.code ?? e.message}` };
  }
  let s;
  try { s = JSON.parse(text); } catch { return { invalid: true, detail: "breaker.json is not valid JSON" }; }
  const err = stateError(s);
  return err ? { invalid: true, detail: `breaker.json is invalid: ${err}` } : s;
}

export const resetCommand = (state) => `node packages/factory/src/breaker.mjs reset --state ${state}`;

export function formatNotice(reasons, state) {
  return [
    "[Fábrica] Circuit breaker ABIERTO: no se admite nada.",
    ...reasons.map((r) => `- ${r.kind}: ${r.detail} (desde ${r.since})`),
    `Para cerrarlo (tras tratar la causa): ${resetCommand(state)}`,
  ].join("\n");
}

/** The operator closes the breaker; records who and when. */
export function reset(stateDir, by, now = new Date().toISOString()) {
  writeJson(breakerFile(stateDir), { version: VERSION, open: false, reasons: [], since: null, resetBy: by, resetAt: now });
  return now;
}

const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return d; } };

/**
 * Fills `lastReachableAt` of every service that is not reachable, from $STATE/reachability.json: the first time a
 * service is seen unreachable (or missing) is remembered across checks, so a continuously missing service ages.
 */
export function trackServices(stateDir, snapshot, now) {
  const f = join(stateDir, "reachability.json");
  const mem0 = readJson(f, {}); const mem = mem0 && typeof mem0 === "object" && !Array.isArray(mem0) ? mem0 : {};
  const services = { ...(snapshot?.services ?? {}) };
  for (const name of SERVICES) {
    const svc = services[name];
    if (svc?.reachable === true) { mem[name] = { lastReachableAt: iso(now) }; continue; }
    const last = [svc?.lastReachableAt, mem?.[name]?.lastReachableAt].find((x) => toTime(x) !== null) ?? iso(now);
    mem[name] = { lastReachableAt: last };
    services[name] = { ...svc, reachable: false, lastReachableAt: last };
  }
  writeJson(f, mem);
  return { ...snapshot, services };
}

/** Live reachability of Dagu and T3 (not pure). */
/** Configured Dagu endpoint: A4S_DAGU_URL, DAGU_HOST/DAGU_PORT, then host/port of the Dagu config file, then 127.0.0.1:8080. */
export function daguUrl(env, home = env.DAGU_HOME, config = env.DAGU_CONFIG) {
  if (env.A4S_DAGU_URL) return env.A4S_DAGU_URL.replace(/\/$/, "");
  let host, port;
  const files = [config, home && join(home, "config.yaml"), env.HOME && join(env.HOME, ".config", "dagu", "config.yaml")].filter(Boolean);
  for (const f of files) {
    let t;
    try { t = readFileSync(f, "utf8"); } catch { continue; }
    host = t.match(/^host:\s*["']?([^\s"'#]+)/m)?.[1];
    port = t.match(/^port:\s*["']?(\d+)/m)?.[1];
    break;
  }
  host = env.DAGU_HOST || host;
  port = env.DAGU_PORT || port;
  if (!host || host === "0.0.0.0" || host === "::") host = "127.0.0.1";
  return `http://${host}:${port || 8080}`;
}

export async function probeServices({ t3Home, env, daguHome, daguConfig }) {
  const probes = {
    dagu: () => fetch(`${daguUrl(env, daguHome ?? env.DAGU_HOME, daguConfig ?? env.DAGU_CONFIG)}/api/v1/dags`, { signal: AbortSignal.timeout(3000) }).then((r) => r.status < 500),
    t3: async () => {
      if (!t3Home) return false;
      const t3 = resolveT3(t3Home, env.T3_VERSIONS_DIR);
      if (t3.error) return false;
      return (await fetch(t3.origin, { signal: AbortSignal.timeout(3000) })).status < 500;
    },
  };
  const out = {};
  for (const [name, p] of Object.entries(probes)) {
    let reachable = false;
    try { reachable = await p(); } catch { reachable = false; }
    out[name] = { reachable };
  }
  return out;
}

/** Evaluate, persist and notify (once per opening). Returns the stored state. */
export async function check(o, env = process.env) {
  const prev = readState(o.state);
  const now = o.now ?? Date.now();
  const raw = o.snapshot ? readJson(o.snapshot, {}) : { services: await probeServices({ t3Home: o.t3Home, env, daguHome: o.daguHome, daguConfig: o.daguConfig }) };
  if (!o.snapshot) raw.ci = collectCi({ ...liveSources(o.primary || process.cwd()), env });
  if (!raw.limits) raw.limits = collectLimits({ state: o.state, cycleFile: o.cycle, now });
  raw.limits = { ...raw.limits, problems: [...(raw.limits?.problems ?? []), ...trackingProblems(o.state, now)] };
  const snap = { ...trackServices(o.state, raw, now), ci: trackCi(o.state, raw.ci, now), limits: raw.limits };
  const { open, reasons } = evaluate(snap, prev, now);
  const wasOpen = prev.invalid ? false : prev.open;
  const keep = prev.invalid ? { resetBy: null, resetAt: null } : prev;
  const next = open
    ? { ...keep, version: VERSION, open: true, reasons, since: wasOpen ? prev.since : iso(now), notifiedAt: wasOpen ? prev.notifiedAt ?? null : null }
    : { ...keep, version: VERSION, open: false, reasons: [], since: null, notifiedAt: null };
  if (next.open && !next.notifiedAt) {
    const run = `breaker-${next.since}`;
    spawnSync("node", [join(o.factory ?? HERE, "notify.mjs"), "--event", "breaker", "--run", run, "--issue", "breaker",
      "--text", formatNotice(reasons, o.state), "--inbox", o.inbox ?? "", "--primary", o.primary ?? "", "--t3-home", o.t3Home ?? "",
      "--state", o.state, "--factory", o.factory ?? HERE], { encoding: "utf8", env, stdio: ["ignore", "inherit", "inherit"] });
    if (readJson(join(o.state, "breaker", "notified.json"), {})[`${run}:breaker`]) next.notifiedAt = new Date().toISOString();
  }
  writeJson(breakerFile(o.state), next);
  return next;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const [cmd, ...rest] = process.argv.slice(2);
    const { values: a } = parseArgs({ args: rest, options: {
      state: { type: "string" }, snapshot: { type: "string" }, primary: { type: "string" }, "t3-home": { type: "string" },
      factory: { type: "string" }, "dagu-home": { type: "string" }, "dagu-config": { type: "string" }, inbox: { type: "string" }, by: { type: "string" }, cycle: { type: "string" },
    } });
    const state = a.state || process.env.STATE || process.env.A4S_STATE;
    if (!state) throw new Error("--state (or $STATE / $A4S_STATE) is required");
    if (cmd === "check") {
      const b = await check({ state, snapshot: a.snapshot, primary: a.primary, t3Home: a["t3-home"], factory: a.factory, inbox: a.inbox, daguHome: a["dagu-home"], daguConfig: a["dagu-config"], cycle: a.cycle });
      if (b.open) {
        console.log(`breaker OPEN since ${b.since}: nothing is admitted`);
        for (const r of b.reasons) console.log(`- ${r.kind}: ${r.detail} (since ${r.since})`);
        process.exit(EXIT_OPEN);
      }
      console.log("breaker closed");
    } else if (cmd === "reset") {
      const by = a.by || process.env.USER || userInfo().username;
      console.log(`breaker closed by ${by} at ${reset(state, by)}`);
    } else throw new Error(`unknown command ${cmd}`);
  } catch (e) { console.error(`breaker: ${e.message}`); process.exit(30); }
}
