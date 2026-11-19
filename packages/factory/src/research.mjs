#!/usr/bin/env node
// Operator-guided research: `research.mjs start "<topic>" [--primary P] [--t3-home H] [--state S]`.
// Opens a top-level thread (visible in the T3 sidebar) of line `research` in the T3 project of PRIMARY and
// records it in $STATE/research/<slug>.json; the same topic reuses its thread.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return d; } };

const normTopic = (topic) => String(topic).normalize("NFC").trim().replace(/\s+/g, " ");

/** Readable prefix + hash of the normalized topic: distinct topics never share a file. */
export function slugify(topic) {
  const t = normTopic(topic);
  const s = t.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50).replace(/-+$/, "");
  return `${s || "topic"}-${createHash("sha256").update(t).digest("hex").slice(0, 10)}`;
}

export function main(argv, env = process.env) {
  const { values: a, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    primary: { type: "string", default: env.PRIMARY ?? env.A4S_PRIMARY ?? "" },
    "t3-home": { type: "string", default: env.T3_HOME ?? env.A4S_T3_HOME ?? "" },
    state: { type: "string", default: env.STATE ?? env.A4S_STATE ?? "" },
    lines: { type: "string", default: join(HERE, "..", "lines.json") },
  } });
  const [cmd, ...rest] = positionals;
  const topic = normTopic(rest.join(" "));
  if (cmd !== "start" || !topic) { console.error('usage: research.mjs start "<topic>"'); return 2; }
  for (const k of ["primary", "t3-home", "state"]) if (!a[k]) { console.error(`missing --${k}`); return 30; }
  const line = readJson(a.lines, {}).lines?.research;
  if (!line) { console.error("no research line in lines.json"); return 30; }

  const file = join(a.state, "research", `${slugify(topic)}.json`);
  const known = readJson(file, null);
  if (known?.threadId && known.topic === topic) { console.log(JSON.stringify({ ...known, reused: true })); return 0; }

  const t3cli = env.RESEARCH_T3CLI ?? join(HERE, "t3cli.mjs");
  const t3 = (args, input) => {
    const r = spawnSync("node", [t3cli, ...args], { input, encoding: "utf8", timeout: 90_000, env: { ...env, T3_HOME: a["t3-home"] } });
    return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  t3(["project", "add", "--title", "A4S", a.primary]);
  // top-level thread: `thread start` (never a delegated child), so it shows in the sidebar
  const args = ["thread", "start", "--json", "--title", `[research] ${topic}`, "--provider", line.provider, "--model", line.model];
  if (line.thinking) args.push("--option", `thinking=${line.thinking}`);
  args.push(a.primary, "-");
  const r = t3(args, `Tema de investigación: ${topic}\n\nEl operador guía este hilo. Espera sus indicaciones.`);
  let id;
  try { id = JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))).threadId; } catch { /* handled below */ }
  if (r.code !== 0 || !id) { console.error("research thread creation failed:", r.stderr.trim().slice(-300)); return 30; }
  const rec = { topic, slug: slugify(topic), threadId: id, provider: line.provider, model: line.model, createdAt: new Date().toISOString() };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(rec, null, 1));
  console.log(JSON.stringify({ ...rec, reused: false }));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
