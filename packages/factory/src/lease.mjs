#!/usr/bin/env node
// Integration lease: at any moment only one factory run integrates, waits for CI and (if red) reverts.
//   lease.mjs acquire --state S --run R [--issue-state D] [--dag NAME] [--timeout-min N] [--poll-ms N]
//   lease.mjs release --state S --run R        (only the owner releases; anything else is a logged no-op, exit 0)
//   lease.mjs holder  --state S                (prints the holder record as JSON, or nothing when free)
//
// The lease lives in the directory `$STATE/integrate.lease/` as a sequence of generations:
//   g<N>           = {run, dag, takenAt}   the owner of generation N (written to a private file, then hard-linked:
//                                          exactly one contender creates a given N; EEXIST = someone else did)
//   g<N>.released  = {by, reason, at}      generation N is over (hard-linked too: created once, never replaced)
// The lease is held by the highest generation when it has no `.released` marker, else it is free.
// Nothing is ever renamed or deleted to release or reclaim: a release (by the owner) or a reclaim (of a dead owner)
// only adds the marker of the exact generation it checked, so it can never touch a newer owner's lease and a live
// lease is never exposed as free. The highest generation file is never deleted (old ones are garbage-collected),
// so a stale contender linking an old number always sees a higher one and backs off. Rules: CONTRACTS.md.
import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const leaseDir = (state) => join(state, "integrate.lease");
export const waitFile = (issueState) => join(issueState, "lease-wait.json");

const genFile = (state, n) => join(leaseDir(state), `g${n}`);
const markFile = (state, n) => join(leaseDir(state), `g${n}.released`);
const tmpName = (state) => join(leaseDir(state), `.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`);
const rm = (f) => { try { unlinkSync(f); } catch { /* gone */ } };
const exists = (f) => { try { readFileSync(f); return true; } catch { return false; } };

/** Creates `target` with `data` atomically and only if it does not exist. true = created, false = it existed. */
function createOnce(state, target, data) {
  mkdirSync(leaseDir(state), { recursive: true });
  const tmp = tmpName(state);
  writeFileSync(tmp, JSON.stringify(data) + "\n");
  try { linkSync(tmp, target); return true; } catch (e) { if (e.code === "EEXIST") return false; throw e; } finally { rm(tmp); }
}

/** The highest generation: {gen, rec, released} ({gen:0} when there is none). rec = {corrupt:true} when unparsable. */
export function current(state) {
  for (let i = 0; i < 20; i++) {
    let names;
    try { names = readdirSync(leaseDir(state)); } catch (e) { if (e.code === "ENOENT") return { gen: 0 }; throw e; }
    const gen = Math.max(0, ...names.map((n) => /^g(\d+)$/.exec(n)).filter(Boolean).map((m) => Number(m[1])));
    if (gen === 0) return { gen: 0 };
    let text;
    try { text = readFileSync(genFile(state, gen), "utf8"); } catch (e) { if (e.code === "ENOENT") continue; throw e; } // collected meanwhile: list again
    let rec;
    try { rec = JSON.parse(text); if (!rec || typeof rec.run !== "string" || !rec.run) rec = { corrupt: true }; } catch { rec = { corrupt: true }; }
    return { gen, rec, released: exists(markFile(state, gen)) };
  }
  throw new Error("integration lease directory keeps changing");
}

/** The holder {run, dag, takenAt} (or {corrupt:true}), null when the lease is free. */
export function readLease(state) {
  const c = current(state);
  return c.gen === 0 || c.released ? null : c.rec;
}

/** Old generations (below `keep - 1`) are history: removed best-effort. The highest one is never removed. */
function collect(state, keep) {
  let names = [];
  try { names = readdirSync(leaseDir(state)); } catch { return; }
  for (const n of names) {
    const m = /^g(\d+)(\.released)?$/.exec(n);
    if (m && Number(m[1]) < keep - 1) rm(join(leaseDir(state), n));
  }
}

/** Atomic take. {ok:true, owner} when this run holds it (also when it already did); {ok:false, owner} when another does. */
export function takeLease(state, run, { now = Date.now(), dag = "" } = {}) {
  for (;;) {
    const c = current(state);
    if (c.gen > 0 && !c.released) return { ok: c.rec.run === run, owner: c.rec };
    const gen = c.gen + 1;
    const rec = { run, dag, takenAt: new Date(now).toISOString() };
    if (!createOnce(state, genFile(state, gen), rec)) continue; // another contender got this generation
    const after = current(state);
    if (after.gen !== gen) { rm(genFile(state, gen)); continue; } // a stale number: a newer generation exists
    collect(state, gen);
    return { ok: true, owner: rec };
  }
}

/** Release by the owner only. {released:true} | {released:false, reason:"not-held"|"other-owner", owner}. */
export function releaseLease(state, run, { now = Date.now() } = {}) {
  const c = current(state);
  if (c.gen === 0 || c.released) return { released: false, reason: "not-held" };
  if (c.rec.run !== run) return { released: false, reason: "other-owner", owner: c.rec };
  // marks exactly the generation this run owns: a newer owner's generation is never affected
  if (!createOnce(state, markFile(state, c.gen), { by: run, reason: "release", at: new Date(now).toISOString() })) return { released: false, reason: "not-held" };
  return { released: true };
}

/**
 * Reclaims a lease whose owner is dead (`isAlive(owner) -> boolean`; a corrupt record counts as dead). Logs the reclaim.
 * Returns the reclaimed owner or null. Only the generation that was checked is marked, so a newer live lease is never
 * touched; among several reclaimers exactly one creates the marker.
 */
export function reclaimDead(state, isAlive, log = () => {}, { by = "", now = Date.now() } = {}) {
  const c = current(state);
  if (c.gen === 0 || c.released) return null;
  if (!c.rec.corrupt && isAlive(c.rec)) return null;
  if (!createOnce(state, markFile(state, c.gen), { by, reason: c.rec.corrupt ? "corrupt record" : `owner run ${c.rec.run} is not queued or running`, at: new Date(now).toISOString() })) return null;
  log(c.rec.corrupt ? `reclaimed a corrupt integration lease (generation ${c.gen})` : `reclaimed the integration lease of dead run ${c.rec.run} (taken ${c.rec.takenAt})`);
  return c.rec;
}

// ---- time spent waiting: $ISSUE_STATE/lease-wait.json = {waitedMs, waits:[{from, to, ms, open?}]} ----
// A wait in progress is written as soon as it starts (`open: true`) and its `to` is refreshed on every poll, so the
// breaker sees it while it lasts; it is closed when the lease is taken or the wait ends in any other way.
const readWaits = (issueState) => {
  try { const v = JSON.parse(readFileSync(waitFile(issueState), "utf8")); if (Array.isArray(v?.waits)) return v.waits; } catch { /* new */ }
  return [];
};
const writeWaits = (issueState, waits) => {
  mkdirSync(issueState, { recursive: true });
  const tmp = `${waitFile(issueState)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ waitedMs: waits.reduce((a, w) => a + (Number.isFinite(w.ms) ? w.ms : 0), 0), waits }, null, 1) + "\n");
  renameSync(tmp, waitFile(issueState)); // readers never see a missing or partial file
};

/** Starts or refreshes (`open`) the wait that began at `fromMs`, or closes it. Returns the file content. */
export function noteWait(issueState, fromMs, toMs, { open = false } = {}) {
  const from = new Date(fromMs).toISOString();
  const entry = { from, to: new Date(toMs).toISOString(), ms: Math.max(0, toMs - fromMs), ...(open ? { open: true } : {}) };
  const waits = readWaits(issueState);
  if (waits.length && waits.at(-1).from === from && waits.at(-1).open) waits[waits.length - 1] = entry; else waits.push(entry);
  writeWaits(issueState, waits);
  return { waitedMs: waits.reduce((a, w) => a + w.ms, 0), waits };
}

/** Adds a finished wait. */
export const recordWait = (issueState, fromMs, toMs) => { const w = readWaits(issueState); w.push({ from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), ms: Math.max(0, toMs - fromMs) }); writeWaits(issueState, w); return { waitedMs: w.reduce((a, x) => a + x.ms, 0), waits: w }; };

/** An open wait refreshed within this long is taken as still going on up to `now`. */
export const OPEN_WAIT_FRESH_MS = 60_000;

/**
 * Waited milliseconds recorded for an issue that fall inside [fromMs, toMs] (0 when absent or invalid). Only the overlap
 * counts, so a wait before a step started never stretches that step's allowance. A wait still in progress (open and
 * refreshed recently) counts up to `toMs`.
 */
export function waitedWithin(issueState, fromMs, toMs) {
  let ms = 0;
  for (const w of readWaits(issueState)) {
    let end = Date.parse(w?.to);
    if (w?.open && Number.isFinite(end) && toMs - end <= OPEN_WAIT_FRESH_MS) end = Math.max(end, toMs);
    const a = Math.max(Date.parse(w?.from), fromMs), b = Math.min(end, toMs);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) ms += b - a;
  }
  return ms;
}

/** Waited milliseconds recorded for an issue (0 when absent or invalid). */
export function waitedMs(issueState) {
  try { const v = JSON.parse(readFileSync(waitFile(issueState), "utf8")); return Number.isFinite(v?.waitedMs) && v.waitedMs > 0 ? v.waitedMs : 0; } catch { return 0; }
}

/**
 * Waits until this run holds the lease. Injected: isAlive, sleep, now, log. Returns {waitedMs}.
 * No deadline by default: a dead holder is reclaimed, a live one ends within its own step limits, so contention alone
 * never fails the step. A wait is recorded in `issueState` from its start (refreshed on every poll) and logged.
 */
export async function acquire({ state, run, dag = "", issueState, isAlive, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, log = () => {}, pollMs = 2000, timeoutMs = Infinity }) {
  const start = now();
  let waiting = false;
  const note = (open) => { if (issueState) noteWait(issueState, start, now(), { open }); };
  try {
    for (;;) {
      const t = takeLease(state, run, { now: now(), dag });
      if (t.ok) break;
      if (reclaimDead(state, isAlive, log, { by: run, now: now() })) continue;
      if (!waiting) { waiting = true; log(`waiting for the integration lease held by ${t.owner?.run ?? "?"} (since ${t.owner?.takenAt ?? "?"})`); }
      note(true);
      if (now() - start > timeoutMs) throw new Error(`timed out after ${Math.round((now() - start) / 1000)}s waiting for the integration lease held by ${t.owner?.run}`);
      await sleep(pollMs);
    }
  } finally {
    if (waiting) note(false);
  }
  const waited = waiting ? now() - start : 0;
  log(`integration lease taken by ${run}${waiting ? ` after waiting ${waited} ms` : ""}`);
  return { waitedMs: waited };
}

const DEAD = /^(Succeeded|Failed|Cancelled|Canceled|Aborted|Rejected|Partially Succeeded)\b/i;
/** Whether a run is still queued or running in Dagu: `dagu status --run-id R DAG`. Unknown answers count as alive (never steal). */
export function daguIsAlive(owner, { dagu = process.env.DAGU_EXECUTABLE || "dagu", env = process.env, spawn = spawnSync } = {}) {
  // the same store as the run's own Dagu (it exports DAGU_HOME and DAGU_CONFIG to its steps): never "not found" by looking elsewhere
  const where = [...(env.DAGU_HOME ? ["--dagu-home", env.DAGU_HOME] : []), ...(env.DAGU_CONFIG ? ["--config", env.DAGU_CONFIG] : [])];
  const r = spawn(dagu, ["status", ...where, "--run-id", owner.run, owner.dag || env.DAG_NAME || "cycle"], { encoding: "utf8", env });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0) return !/dag-run ID not found|run data for dag-run/i.test(out);
  const first = out.split("\n").find((l) => /^[A-Za-z][A-Za-z ]*? - \d{4}-/.test(l) || /^Result:/.test(l)) ?? "";
  const word = first.replace(/^Result:\s*/, "");
  return !DEAD.test(word);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    const { values: a } = parseArgs({ args: rest, options: {
      state: { type: "string" }, run: { type: "string" }, "issue-state": { type: "string" }, dag: { type: "string" },
      "timeout-min": { type: "string" }, "poll-ms": { type: "string" },
    } });
    const state = a.state || process.env.STATE || process.env.A4S_STATE;
    const run = a.run || process.env.DAG_RUN_ID;
    if (!state) throw new Error("--state is required");
    const log = (m) => console.error(`[lease] ${m}`);
    const dag = a.dag || process.env.DAG_NAME || "";
    if (cmd === "holder") {
      const h = readLease(state);
      if (h) console.log(JSON.stringify(h));
    } else if (!run) throw new Error("--run is required");
    else if (cmd === "acquire") {
      await acquire({ state, run, dag, issueState: a["issue-state"], isAlive: (o) => daguIsAlive(o), log,
        pollMs: Number(a["poll-ms"]) || Number(process.env.LEASE_POLL_MS) || 2000,
        timeoutMs: Number(a["timeout-min"]) > 0 ? Number(a["timeout-min"]) * 60_000 : Infinity });
    } else if (cmd === "release") {
      const r = releaseLease(state, run);
      log(r.released ? `integration lease released by ${run}` : `release by ${run}: nothing to do (${r.reason}${r.owner ? `, held by ${r.owner.run}` : ""})`);
    } else throw new Error(`unknown command ${cmd}`);
  } catch (e) { console.error(`lease: ${e.message}`); process.exit(30); }
}
