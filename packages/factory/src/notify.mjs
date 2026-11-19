#!/usr/bin/env node
// Notify the operator's T3 thread about a factory run: `success`, `failure` or `wait`.
// Called by the `handler_on` handlers of dags/cycle.yaml. It never fails a run: every problem is logged
// and the exit code is 0. One message per run and event ($STATE/<issue>/notified.json).
// Target thread: --inbox (param INBOX_THREAD / A4S_INBOX_THREAD), else the factory's own inbox
// ($STATE/inbox.json), which is created on first use in the T3 project of PRIMARY (line `inbox`).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const INBOX_TITLE = "Bandeja de la fábrica";
const HERE = dirname(fileURLToPath(import.meta.url));
const NOT_STEPS = /^(on|handler)/i;

/** Parse "a=succeeded,b=failed" into [{id,status}] (handler steps `onX` are dropped). */
export function parseSteps(text) {
  return String(text ?? "").split(/[,\s]+/).filter(Boolean).map((p) => {
    const i = p.indexOf("=");
    return i < 0 ? null : { id: p.slice(0, i), status: p.slice(i + 1) };
  }).filter((s) => s && s.id && !(NOT_STEPS.test(s.id) && /^on[A-Z]/.test(s.id)));
}

/** First failed step, or null. */
export function failedStep(steps) {
  return steps.find((s) => /^(failed|error|aborted|canceled|cancelled|rejected)$/.test(s.status))?.id ?? null;
}

/** Issue URL from the origin remote URL, or null. */
export function issueUrl(remote, issue) {
  const m = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(String(remote ?? "").trim());
  return m ? `https://github.com/${m[1]}/issues/${issue}` : null;
}

/** The message sent to the thread. */
export function formatMessage({ event, run, issue, steps, url }) {
  const failed = failedStep(steps);
  const lines = [
    `[Fábrica] Run ${run} · issue #${issue} · evento: ${event}`,
    `Paso fallido: ${failed ?? "ninguno"}`,
    `Issue: ${url ?? "(sin URL)"}`,
    `Pasos: ${steps.length ? steps.map((s) => `${s.id}=${s.status}`).join(", ") : "(sin datos)"}`,
  ];
  return lines.join("\n");
}

const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return d; } };
const writeJson = (f, v) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(v, null, 1)); };

/** True when this run/event was already notified. */
export const alreadyNotified = (st, run, event) => !!st[`${run}:${event}`];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run `fn` holding an exclusive lock (atomic mkdir; a lock older than `staleMs` is broken). Returns null if not acquired. */
export async function withLock(dir, fn, { waitMs = 150_000, staleMs = 180_000 } = {}) {
  mkdirSync(dirname(dir), { recursive: true });
  const until = Date.now() + waitMs;
  for (;;) {
    try { mkdirSync(dir); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - statSync(dir).mtimeMs > staleMs) rmSync(dir, { recursive: true, force: true }); } catch { /* released meanwhile */ }
      if (Date.now() > until) return null;
      await sleep(100);
    }
  }
  try { return await fn(); } finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function main(argv, env = process.env) {
  const { values: a } = parseArgs({ args: argv, options: {
    event: { type: "string" }, run: { type: "string" }, issue: { type: "string" }, steps: { type: "string", default: "" },
    inbox: { type: "string", default: "" }, primary: { type: "string" }, "t3-home": { type: "string" },
    state: { type: "string" }, factory: { type: "string", default: HERE },
  } });
  const log = (...m) => console.error(`[notify ${a.event} #${a.issue}]`, ...m);
  for (const k of ["event", "run", "issue", "primary", "t3-home", "state"]) {
    if (!a[k]) { log(`missing --${k}; not notifying`); return 0; }
  }
  const t3cli = env.NOTIFY_T3CLI ?? join(HERE, "t3cli.mjs");
  const t3 = (args, input) => {
    const r = spawnSync("node", [t3cli, ...args], { input, encoding: "utf8", timeout: 90_000, env: { ...env, T3_HOME: a["t3-home"] } });
    return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const notifiedFile = join(a.state, String(a.issue), "notified.json");
  // the check/send/record sequence of one issue is exclusive: concurrent identical notifications send once
  const r = await withLock(join(a.state, String(a.issue), "notify.lock"), () => deliver(a, env, log, t3, notifiedFile));
  if (r === null) log("lock not acquired; not notifying");
  return 0;
}

async function deliver(a, env, log, t3, notifiedFile) {
  const done = readJson(notifiedFile, {});
  if (alreadyNotified(done, a.run, a.event)) { log("already notified"); return 0; }

  const remote = spawnSync("git", ["-C", a.primary, "remote", "get-url", "origin"], { encoding: "utf8" }).stdout;
  const steps = parseSteps(a.steps);
  const text = formatMessage({ event: a.event, run: a.run, issue: a.issue, steps, url: issueUrl(remote, a.issue) });

  const inboxFile = join(a.state, "inbox.json");
  let threadId = a.inbox.trim();
  let created = false;
  if (!threadId) {
    // inbox discovery/creation is exclusive across issues; state is re-read under the lock
    const r = await withLock(join(a.state, "inbox.lock"), async () => {
      let id = readJson(inboxFile, {}).threadId ?? "";
      if (id) return { id, created: false };
      // never two inboxes: adopt an existing one (lost inbox.json) before creating
      t3(["project", "add", "--title", "A4S", a.primary]);
      const l = t3(["thread", "list", "--json", "--project", a.primary]);
      try {
        const found = JSON.parse(l.stdout.slice(l.stdout.indexOf("[")))
          .filter((t) => t.title === INBOX_TITLE).at(-1);
        if (found) id = found.threadId;
      } catch { /* none listed */ }
      let made = false;
      if (!id) {
        const line = readJson(join(a.factory, "..", "lines.json"), {}).lines?.inbox;
        if (!line) { log("no inbox line in lines.json; not notifying"); return null; }
        const args = ["thread", "start", "--json", "--title", INBOX_TITLE, "--provider", line.provider, "--model", line.model];
        if (line.thinking) args.push("--option", `thinking=${line.thinking}`);
        args.push(a.primary, "-");
        // the first notification is the thread's first message
        const r = t3(args, text);
        if (r.code !== 0) { log("inbox creation failed:", r.stderr.trim().slice(-300)); return null; }
        try { id = JSON.parse(r.stdout).threadId; } catch { log("inbox creation: unreadable answer"); return null; }
        made = true;
      }
      writeJson(inboxFile, { threadId: id, title: INBOX_TITLE, createdAt: new Date().toISOString() });
      log("inbox", made ? "created" : "adopted", id);
      return { id, created: made };
    });
    if (!r) { log("no inbox available; not notifying"); return 0; }
    threadId = r.id; created = r.created;
  }
  if (!threadId) { log("no thread configured; not notifying"); return 0; }
  if (!created) {
    const r = t3(["thread", "send", "--json", threadId, "-"], text);
    if (r.code !== 0) { log("send failed:", r.stderr.trim().slice(-300)); return 0; }
  }
  done[`${a.run}:${a.event}`] = { thread: threadId, at: new Date().toISOString() };
  writeJson(notifiedFile, done);
  log("notified", threadId);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error("[notify] error:", e?.message ?? e); process.exit(0); });
}
