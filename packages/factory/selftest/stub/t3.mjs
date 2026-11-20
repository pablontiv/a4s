#!/usr/bin/env node
// Deterministic stand-in for the `t3` CLI (selftest:stub). No model, no T3 server.
// Each line answers from fixture verdicts: <fixture>/verdicts.json = {"<issue>": {"impl": {writes, verdict}, "qa": {verdict}}}.
// `writes` ({path: content}) is applied to the project directory when an impl thread starts (the stub "does the work").
// Config next to this file: t3-config.json = {"fixture": "<dir>"}.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const { fixture } = JSON.parse(readFileSync(join(HERE, "t3-config.json"), "utf8"));
const threads = join(fixture, "threads");
mkdirSync(threads, { recursive: true });
const raw = process.argv.slice(2);
appendFileSync(join(fixture, "t3-calls.jsonl"), JSON.stringify({ argv: raw, cwd: process.cwd() }) + "\n");
const argv = raw.filter((a, i) => a !== "--base-dir" && raw[i - 1] !== "--base-dir");
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const stdin = () => { try { return readFileSync(0, "utf8"); } catch { return ""; } };
const file = (id) => join(threads, `${id}.json`);
const load = (id) => JSON.parse(readFileSync(file(id), "utf8"));
const save = (t) => writeFileSync(file(t.threadId), JSON.stringify(t));
const verdicts = () => JSON.parse(readFileSync(join(fixture, "verdicts.json"), "utf8"));
const out = (o) => console.log(JSON.stringify(o));
const assistant = (t) => (t.verdict ? `Done.\n${JSON.stringify(t.verdict)}` : "ok");

const [group, cmd] = argv;
if (group === "project") {
  process.exit(0);
}
if (group === "thread" && cmd === "start") {
  const title = flag("--title") ?? "";
  const m = /^\[(\w+)\] #([^ ]+) /.exec(title);
  const proj = argv[argv.lastIndexOf("-") - 1];
  stdin();
  const id = `thr-${readdirSync(threads).length + 1}`;
  const t = { threadId: id, title, model: flag("--model") ?? "stub", line: m?.[1] ?? null, issue: m?.[2] ?? null, project: proj, status: "completed", n: 1 };
  if (m) {
    const spec = verdicts()[t.issue]?.[t.line];
    if (!spec) { console.error(`stub t3: no fixture verdict for ${t.line} of ${t.issue}`); process.exit(3); }
    for (const [p, c] of Object.entries(spec.writes ?? {})) { mkdirSync(dirname(join(proj, p)), { recursive: true }); writeFileSync(join(proj, p), c); }
    t.verdict = spec.verdict;
  }
  save(t);
  out({ threadId: id, runId: `${id}-run-1` });
  process.exit(0);
}
if (group === "thread" && cmd === "send") {
  const id = argv.filter((a) => !a.startsWith("--")).at(-2);
  stdin();
  const t = load(id); t.n += 1; save(t);
  out({ threadId: id, runId: `${id}-run-${t.n}` });
  process.exit(0);
}
if (group === "thread" && cmd === "show") {
  const id = argv.filter((a) => !a.startsWith("--") && a !== "6" && a !== "50").at(-1);
  if (!existsSync(file(id))) { console.error("thread not found"); process.exit(1); }
  const t = load(id);
  out({ thread: { threadId: id, title: t.title, model: t.model, status: t.status, pendingRequestCount: 0, activeRunId: null, pendingBackgroundTasks: [], itemCount: t.n * 2, runCount: t.n }, messages: [{ role: "assistant", text: assistant(t) }] });
  process.exit(0);
}
if (group === "thread" && cmd === "list") {
  console.log(JSON.stringify(readdirSync(threads).map((f) => JSON.parse(readFileSync(join(threads, f), "utf8"))).map((t) => ({ threadId: t.threadId, title: t.title }))));
  process.exit(0);
}
console.error(`stub t3: unsupported command ${argv.join(" ")}`);
process.exit(2);
