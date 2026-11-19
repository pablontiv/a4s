#!/usr/bin/env node
// Station wrapper: one Dagu step runs one worker as a T3 thread.
// Control stays in Dagu. This only launches or reattaches, polls, classifies and maps to exit codes:
//   0 pass or blocked (see output `result`) · 10 worker fail/timeout · 30 infra · 40 malformed verdict
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { EXIT, OUTPUT_KEYS, isUnreachable, killThread, parseVerdict, checkVerdict, exitFor, resolveT3, threadPhase } from "./lib.mjs";

const { values: a } = parseArgs({ options: {
  line: { type: "string" }, issue: { type: "string" }, run: { type: "string", default: "local" },
  project: { type: "string" }, brief: { type: "string" }, "brief-text": { type: "string" },
  "t3-home": { type: "string" }, state: { type: "string" }, lines: { type: "string" },
  "timeout-sec": { type: "string", default: "1800" }, "budget-sec": { type: "string" },
  continue: { type: "string" }, cancel: { type: "string", default: "kill" },
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
const st = existsSync(stFile) ? JSON.parse(readFileSync(stFile, "utf8")) : { attempts: [] };
const save = () => writeFileSync(stFile, JSON.stringify(st, null, 1));

const linesPath = a.lines || join(dirname(fileURLToPath(import.meta.url)), "..", "lines.json");
const line = JSON.parse(readFileSync(linesPath, "utf8")).lines?.[a.line];
if (!line) { log("unknown line"); process.exit(EXIT.MALFORMED); }

const t3info = resolveT3(T3_HOME, process.env.T3_VERSIONS_DIR);
if (t3info.error) { log(t3info.error); out("result", "infra"); process.exit(EXIT.INFRA); }
const t3 = (args, input) => {
  const r = spawnSync(t3info.bin, [...args, "--base-dir", T3_HOME], { input, encoding: "utf8", timeout: 60_000 });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
try {
  const r = await fetch(t3info.origin, { signal: AbortSignal.timeout(3000) });
  if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
} catch (e) { log("T3 unreachable before start:", e.message); out("result", "infra"); process.exit(EXIT.INFRA); }

let cur = st.attempts.at(-1);
let threadId;
if (a.continue) {
  threadId = a.continue;
  const msg = a["brief-text"] ?? readFileSync(a.brief, "utf8");
  const r = t3(["thread", "send", "--json", threadId, "-"], msg);
  if (r.code !== 0) { log("send failed", r.stderr); const infra = isUnreachable(r.stderr + r.stdout); out("result", infra ? "infra" : "fail"); process.exit(infra ? EXIT.INFRA : EXIT.WORKER_FAIL); }
  st.attempts.push(cur = { threadId, continued: true, runId: JSON.parse(r.stdout).runId, startedAt: Date.now() }); save();
} else if (cur && !cur.outcome) {
  threadId = cur.threadId;
  log("reattaching to unfinished attempt", threadId);
} else {
  const n = st.attempts.length + 1;
  const model = n > 1 && line.escalate_to ? line.escalate_to : line.model;
  let brief = a["brief-text"] ?? readFileSync(a.brief, "utf8");
  if (a["budget-sec"]) brief += `\n\nPresupuesto estricto: ${a["budget-sec"]} segundos de reloj desde ahora. Si no puedes terminar dentro del presupuesto, detente y responde verdict "fail" con findings ["budget"].`;
  const args = ["thread", "start", "--json", "--title", `[${a.line}] #${a.issue} ${a.run}/${n}`, "--provider", line.provider, "--model", model];
  if (line.thinking) args.push("--option", `thinking=${line.thinking}`);
  args.push(a.project, "-");
  const r = t3(args, brief);
  if (r.code !== 0) { log("start failed", r.stderr); out("result", "infra"); process.exit(EXIT.INFRA); }
  const j = JSON.parse(r.stdout);
  threadId = j.threadId;
  st.attempts.push(cur = { threadId, runId: j.runId, model, startedAt: Date.now() }); save();
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

const deadline = Date.now() + Number(a["timeout-sec"]) * 1000;
const stableMs = Number(a["stable-sec"]) * 1000;
let downSince = null, stable = null, snap;
while (!stopping) {
  if (Date.now() > deadline) {
    const n = a.cancel === "kill" ? killThread(threadId) : 0;
    log(`timeout: killed=${n}`); cur.outcome = "timeout"; save();
    out("result", "timeout"); process.exit(EXIT.WORKER_FAIL);
  }
  const r = t3(["thread", "show", "--json", "--messages", "6", threadId]);
  if (r.code !== 0) {
    if (isUnreachable(r.stderr + r.stdout)) {
      downSince ??= Date.now();
      if (Date.now() - downSince > Number(a["reattach-sec"]) * 1000) { out("result", "infra"); process.exit(EXIT.INFRA); }
    } else log("show failed", r.stderr.trim());
    await sleep(3000); continue;
  }
  if (downSince) { log("reattached after", Math.round((Date.now() - downSince) / 1000), "s"); downSince = null; }
  snap = JSON.parse(r.stdout);
  const phase = threadPhase(snap.thread);
  if (phase === "busy") stable = null;
  else {
    if (stable?.phase !== phase) stable = { phase, at: Date.now() };
    if (Date.now() - stable.at >= stableMs) break;
  }
  await sleep(3000);
}

const t = snap.thread;
out("model", t.model);
if (t.worktreePath) out("worktree", t.worktreePath);
if (t.pendingRequestCount > 0) { cur.outcome = "waiting"; save(); out("result", "blocked"); out("question", "pending_request"); process.exit(EXIT.PASS); }
if (t.status !== "completed") { cur.outcome = t.status; save(); out("result", "fail"); process.exit(EXIT.WORKER_FAIL); }

const text = snap.messages.filter((m) => m.role === "assistant").at(-1)?.text ?? "";
const parsed = parseVerdict(text);
const { verdict: v, reason } = checkVerdict(parsed);
if (reason) log(reason);
if (!v) { cur.outcome = "malformed"; save(); out("result", "malformed"); log("malformed:", text.slice(-300)); process.exit(EXIT.MALFORMED); }
cur.outcome = v.verdict; save();
out("result", v.verdict); out("commit", v.commit ?? ""); out("question", v.question ?? "");
out("findings", JSON.stringify(v.findings ?? []));
process.exit(exitFor(v));
