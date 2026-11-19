#!/usr/bin/env node
// Circuit breaker core: the factory stops admitting when continuing would make things worse.
//   breaker.mjs check [--state S] [--snapshot F] [--primary P] [--t3-home H] [--factory F] [--inbox T]
//       evaluates, updates $STATE/breaker.json, notifies once when it opens. Exit 0 closed, 40 open.
//   breaker.mjs reset [--state S] [--by NAME]   the operator closes it explicitly (records who/when).
// --state defaults to $STATE, then $A4S_STATE. --snapshot F: a JSON snapshot instead of live data (fixtures).
// Rules: CONTRACTS.md, "Circuit breaker contract". `evaluate` is pure.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolveT3 } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const VERSION = 1;
export const EXIT_OPEN = 40;
export const UNREACHABLE_MIN = 30;
export const CI_TIMEOUT_MIN = 30;
export const SERVICES = Object.freeze(["dagu", "t3"]);
const MIN = 60_000;
const ms = (v) => (typeof v === "number" ? v : Date.parse(v));
const iso = (v) => new Date(ms(v)).toISOString();

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
        const since = svc?.lastReachableAt ? ms(svc.lastReachableAt) : prior ? ms(prior.since) : now;
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
        const since = ci.failingSince ? ms(ci.failingSince) : now;
        return now - since > limit ? [{ kind: "ci", detail: `CI lookup of main keeps failing for more than ${limit / MIN} min (${ci.error ?? "unknown"})`, since: iso(since) }] : [];
      }
      const short = String(ci.sha).slice(0, 12);
      const at = ms(ci.commitTime);
      if (ci.status === "failure") return [{ kind: "ci", detail: `CI of current main ${short} is failing`, since: iso(at) }];
      if ((ci.status === "none" || ci.status === "pending") && now - at > limit) {
        return [{ kind: "ci", detail: `no finished CI for current main ${short} ${limit / MIN} min after the commit (${ci.status})`, since: iso(at + limit) }];
      }
      return []; // success, or in progress / not yet started under the timeout
    },
  },
};

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
    if (!/^[0-9a-f]{7,64}$/i.test(sha) || Number.isNaN(Date.parse(commitTime))) throw new Error("unexpected git output");
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
  const mem = readJson(f, {});
  if (!ci.lookupFailed) { writeJson(f, {}); return ci; }
  const failingSince = ci.failingSince ?? mem.failingSince ?? iso(now);
  writeJson(f, { failingSince });
  return { ...ci, failingSince };
}

/**
 * Pure. `state` is the stored breaker state (or {invalid:true} when the file was corrupt/unknown version).
 * Returns {open, reasons: [{kind, detail, since}]}. Reasons already in `state` are kept unless their condition
 * clears by itself (unreachable: only when both Dagu and T3 are reachable); everything else needs `reset`.
 */
export function evaluate(snapshot, state, now = Date.now()) {
  const t = ms(now);
  const reasons = [];
  if (state?.invalid) reasons.push({ kind: "state-invalid", detail: state.detail ?? "breaker state is corrupt or has an unknown version", since: iso(t) });
  for (const r of state?.open ? state.reasons ?? [] : []) {
    if (CONDITIONS[r.kind]?.clears?.(snapshot)) continue;
    reasons.push(r);
  }
  for (const [kind, c] of Object.entries(CONDITIONS)) {
    for (const r of c.detect(snapshot, state, t)) if (!reasons.some((x) => x.kind === kind && x.detail === r.detail)) reasons.push(r);
  }
  return { open: reasons.length > 0, reasons };
}

const writeJson = (f, v) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(v, null, 1)); };
export const breakerFile = (state) => join(state, "breaker.json");

const validTime = (v) => typeof v === "string" && v !== "" && !Number.isNaN(Date.parse(v));
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
  const mem = readJson(f, {});
  const services = { ...(snapshot?.services ?? {}) };
  for (const name of SERVICES) {
    const svc = services[name];
    if (svc?.reachable === true) { mem[name] = { lastReachableAt: iso(now) }; continue; }
    const last = svc?.lastReachableAt ?? mem[name]?.lastReachableAt ?? iso(now);
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
  const snap = { ...trackServices(o.state, raw, now), ci: trackCi(o.state, raw.ci, now) };
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
      factory: { type: "string" }, "dagu-home": { type: "string" }, "dagu-config": { type: "string" }, inbox: { type: "string" }, by: { type: "string" },
    } });
    const state = a.state || process.env.STATE || process.env.A4S_STATE;
    if (!state) throw new Error("--state (or $STATE / $A4S_STATE) is required");
    if (cmd === "check") {
      const b = await check({ state, snapshot: a.snapshot, primary: a.primary, t3Home: a["t3-home"], factory: a.factory, inbox: a.inbox, daguHome: a["dagu-home"], daguConfig: a["dagu-config"] });
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
