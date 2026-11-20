#!/usr/bin/env node
// Station wrapper: one Dagu step runs one worker as a T3 thread.
// Control stays in Dagu. This only launches or reattaches, polls, classifies and maps to exit codes:
//   0 pass or blocked (see output `result`) · 10 worker fail/stuck/timeout · 30 infra · 40 malformed verdict · 143 cancelled
// Every attempt ends in one outcome (OUTCOMES); the next attempt follows POLICY (see CONTRACTS.md).
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadLimits, activitySig, EXIT, OUTCOME_EXIT, OUTPUT_KEYS, outcomeForStatus, isUnreachable, killThread, parseVerdict, checkVerdict, exitFor, resolveT3, validateState, planNext, threadPhase } from "./lib.mjs";

const { values: a } = parseArgs({ options: {
  line: { type: "string" }, issue: { type: "string" }, run: { type: "string", default: "local" },
  project: { type: "string" }, brief: { type: "string" }, "brief-text": { type: "string" },
  "t3-home": { type: "string" }, state: { type: "string" }, lines: { type: "string" },
  "stall-sec": { type: "string" }, "max-sec": { type: "string" }, limits: { type: "string" }, "poll-sec": { type: "string", default: "3" },
  "budget-sec": { type: "string" },
  continue: { type: "string" }, answer: { type: "string" }, cancel: { type: "string", default: "kill" },
  "reattach-sec": { type: "string", default: "300" }, "stable-sec": { type: "string", default: "12" },
} });
for (const k of ["line", "issue", "project", "t3-home", "state"]) {
  if (!a[k]) { console.error(`missing --${k}`); process.exit(EXIT.MALFORMED); }
}

const log = (...m) => console.error(`[station ${a.line} #${a.issue}]`, ...m);
const written = new Set();
const out = (k, v) => {
  written.add(k);
  const value = String(v ?? "").replace(/\n/g, " ");
  if (process.env.DAGU_OUTPUT_FILE) appendFileSync(process.env.DAGU_OUTPUT_FILE, `${k}=${value}\n`);
  console.log(`${k}=${value}`);
};
process.on("exit", () => { for (const k of OUTPUT_KEYS) if (!written.has(k)) out(k, ""); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T3_HOME = a["t3-home"];

const stDir = join(a.state, String(a.issue)); mkdirSync(stDir, { recursive: true });
const stFile = join(stDir, `${a.line}.json`);
let st;
try { st = validateState(existsSync(stFile) ? JSON.parse(readFileSync(stFile, "utf8")) : { attempts: [] }); }
catch (e) { console.error(`[station ${a.line} #${a.issue}] ${stFile}: ${e.message}`); process.exit(EXIT.MALFORMED); }
const save = () => writeFileSync(stFile, JSON.stringify(st, null, 1));
/** Persist the outcome of the attempt in flight (if any) and exit with its code. */
const finish = (attempt, outcome) => {
  if (attempt && attempt.outcome === undefined) { attempt.outcome = outcome; save(); }
  out("result", outcome); process.exit(OUTCOME_EXIT[outcome]);
};
// Producing steps have no fixed deadline: `stuck` after STALL_SEC without activity, `timeout` at the MAX_SEC safety cap.
const lim = loadLimits(a.limits || join(dirname(fileURLToPath(import.meta.url)), "..", "limits.json"));
const stallSec = Number(a["stall-sec"]) > 0 ? Number(a["stall-sec"]) : lim.stallSec;
const maxSec = Number(a["max-sec"]) > 0 ? Number(a["max-sec"]) : lim.maxSec;
const timeoutSec = maxSec; // recorded on the attempt: what the breaker judges an in-flight attempt by
const pollMs = Math.max(50, Number(a["poll-sec"]) * 1000);
const tryJSON = (text) => { try { return JSON.parse(text); } catch { return undefined; } };

const linesPath = a.lines || join(dirname(fileURLToPath(import.meta.url)), "..", "lines.json");
const line = JSON.parse(readFileSync(linesPath, "utf8")).lines?.[a.line];
if (!line) { log("unknown line"); process.exit(EXIT.MALFORMED); }

// Stored stop/await outcomes are replayed before any T3 access: they need no server.
const plan = planNext(line, st, { answer: a.answer });
let cur = st.attempts.at(-1);
let threadId;
if (!a.continue && (plan.kind === "stop" || plan.kind === "await")) {
  const p = plan.attempt;
  out("result", p.outcome); out("thread_id", p.threadId); out("model", p.model);
  out("commit", p.commit); out("question", p.question); out("findings", JSON.stringify(p.findings ?? []));
  log(`previous outcome ${p.outcome}: ${plan.kind === "stop" ? "nothing to do" : "awaiting an answer on its own thread"}`);
  process.exit(EXIT.PASS);
}
// A preflight infra failure finalizes the attempt left in flight by an earlier run as `infra`
// (the next run reattaches to its thread, see POLICY).
let t3info;
try { t3info = resolveT3(T3_HOME, process.env.T3_VERSIONS_DIR); } catch (e) { t3info = { error: `server-runtime.json: ${e.message}` }; }
if (t3info.error) { log(t3info.error); finish(st.attempts.at(-1), "infra"); }
const t3 = (args, input) => {
  const r = spawnSync(t3info.bin, [...args, "--base-dir", T3_HOME], { input, encoding: "utf8", timeout: 60_000 });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
try {
  const r = await fetch(t3info.origin, { signal: AbortSignal.timeout(3000) });
  if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
} catch (e) { log("T3 unreachable before start:", e.message); finish(st.attempts.at(-1), "infra"); }

if (a.continue || plan.kind === "resume") {
  threadId = a.continue ?? plan.threadId;
  const msg = a.answer ?? a["brief-text"] ?? readFileSync(a.brief, "utf8");
  const r = t3(["thread", "send", "--json", threadId, "-"], msg);
  if (r.code !== 0) { log("send failed", r.stderr); const infra = isUnreachable(r.stderr + r.stdout); st.attempts.push({ threadId, continued: true, startedAt: Date.now(), timeoutSec, outcome: infra ? "infra" : "fail" }); save(); out("result", infra ? "infra" : "fail"); process.exit(infra ? EXIT.INFRA : EXIT.WORKER_FAIL); }
  st.attempts.push(cur = { threadId, continued: true, runId: tryJSON(r.stdout)?.runId, startedAt: Date.now(), timeoutSec }); save();
  if (!cur.runId) { log("send: malformed CLI output", r.stdout.slice(0, 300)); finish(cur, "infra"); }
} else if (plan.kind === "reattach") {
  threadId = plan.threadId;
  // the clocks survive a reattach: startedAt and last activity come from the persisted attempt, never reset
  if (cur.outcome) st.attempts.push(cur = { threadId, model: plan.model, reattached: true, startedAt: cur.startedAt ?? Date.now(), lastActivityAt: cur.lastActivityAt, activitySig: cur.activitySig, timeoutSec });
  else cur.timeoutSec = timeoutSec;
  save();
  log("reattaching to thread", threadId);
} else {
  const n = st.attempts.length + 1;
  const model = plan.model;
  let brief = a["brief-text"] ?? readFileSync(a.brief, "utf8");
  if (a["budget-sec"]) brief += `\n\nPresupuesto estricto: ${a["budget-sec"]} segundos de reloj desde ahora. Si no puedes terminar dentro del presupuesto, detente y responde verdict "fail" con findings ["budget"].`;
  const args = ["thread", "start", "--json", "--title", `[${a.line}] #${a.issue} ${a.run}/${n}`, "--provider", line.provider, "--model", model];
  if (line.thinking) args.push("--option", `thinking=${line.thinking}`);
  args.push(a.project, "-");
  const r = t3(args, brief);
  const j = r.code === 0 ? tryJSON(r.stdout) : undefined;
  if (!j?.threadId) {
    log(r.code !== 0 ? `start failed ${r.stderr}` : `start: malformed CLI output ${r.stdout.slice(0, 300)}`);
    st.attempts.push(cur = { model, startedAt: Date.now(), timeoutSec }); finish(cur, "infra");
  }
  threadId = j.threadId;
  st.attempts.push(cur = { threadId, runId: j.runId, model, startedAt: Date.now(), timeoutSec }); save();
  log("started", threadId, model);
}
out("thread_id", threadId);

let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
  const n = a.cancel === "kill" ? killThread(threadId) : 0;
  log(`SIGTERM: cancel=${a.cancel} killed=${n}`);
  cur.outcome = "cancelled"; save();
  process.exit(143);
});

const stableMs = Number(a["stable-sec"]) * 1000;
let downSince = null, stable = null, snap;
while (!stopping) {
  const stopThread = (outcome) => {
    const n = a.cancel === "kill" ? killThread(threadId) : 0;
    log(`${outcome}: killed=${n}`); cur.outcome = outcome; save();
    out("result", outcome); process.exit(EXIT.WORKER_FAIL);
  };
  const r = t3(["thread", "show", "--json", "--messages", "6", threadId]);
  if (r.code !== 0) {
    if (isUnreachable(r.stderr + r.stdout)) {
      downSince ??= Date.now();
      if (Date.now() - downSince > Number(a["reattach-sec"]) * 1000) { cur.outcome = "infra"; save(); out("result", "infra"); process.exit(EXIT.INFRA); }
    } else log("show failed", r.stderr.trim());
    await sleep(pollMs); continue;
  }
  if (downSince) { log("reattached after", Math.round((Date.now() - downSince) / 1000), "s"); downSince = null; }
  snap = tryJSON(r.stdout);
  if (!snap?.thread) { log("show: malformed CLI output", r.stdout.slice(0, 300)); finish(cur, "infra"); }
  const sig = activitySig(snap);
  if (sig !== cur.activitySig) { cur.activitySig = sig; cur.lastActivityAt = Date.now(); save(); }
  const phase = threadPhase(snap.thread);
  if (phase === "busy") {
    stable = null;
    // only a thread that is still working can be stuck or capped: an idle one is classified below
    if (Date.now() - cur.startedAt > maxSec * 1000) { log(`safety cap ${maxSec}s reached`); stopThread("timeout"); }
    if (Date.now() - (cur.lastActivityAt ?? cur.startedAt) > stallSec * 1000) { log(`no activity for ${stallSec}s`); stopThread("stuck"); }
  }
  else {
    if (stable?.phase !== phase) stable = { phase, at: Date.now() };
    if (Date.now() - stable.at >= stableMs) break;
  }
  await sleep(pollMs);
}

const t = snap.thread;
out("model", t.model);
if (t.worktreePath) out("worktree", t.worktreePath);
if (t.pendingRequestCount > 0) { cur.outcome = "blocked"; cur.threadId = threadId; cur.question = "pending_request"; save(); out("result", "blocked"); out("question", "pending_request"); process.exit(EXIT.PASS); }
if (t.status !== "completed") { log("thread status", t.status); finish(cur, outcomeForStatus(t.status)); }

const text = (snap.messages ?? []).filter((m) => m.role === "assistant").at(-1)?.text ?? "";
const parsed = parseVerdict(text);
const { verdict: v, reason } = checkVerdict(parsed);
if (reason) log(reason);
if (!v) { cur.outcome = "malformed"; save(); out("result", "malformed"); log("malformed:", text.slice(-300)); process.exit(EXIT.MALFORMED); }
cur.outcome = v.verdict; cur.threadId = threadId; cur.model = t.model ?? cur.model;
cur.commit = v.commit ?? ""; cur.findings = v.findings ?? [];
if (v.verdict === "blocked") cur.question = v.question ?? "";
save();
out("result", v.verdict); out("commit", v.commit ?? ""); out("question", v.question ?? "");
out("findings", JSON.stringify(v.findings ?? []));
process.exit(exitFor(v));
