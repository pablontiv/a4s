#!/usr/bin/env node
// Host check: every model in lines.json (model and escalate_to) must be available in Pi.
// The selftest replaces models with a cheap one, so without this a wrong model id reaches production.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const linesPath = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "lines.json");
const pi = process.env.PI_BIN ?? join(process.env.HOME ?? "", "bin", "pi");
const r = spawnSync(pi, ["--list-models"], { encoding: "utf8", timeout: 120_000 });
if (r.status !== 0) { console.error(`check-models: ${pi} --list-models failed`); process.exit(1); }
const available = new Set(r.stdout.split("\n").map((l) => l.trim().split(/\s+/)).filter((c) => c.length > 1).map(([p, m]) => `${p}/${m}`));
const missing = [];
for (const [name, line] of Object.entries(JSON.parse(readFileSync(linesPath, "utf8")).lines)) {
  for (const key of ["model", "escalate_to"]) if (line[key] && !available.has(line[key])) missing.push(`${name}.${key}=${line[key]}`);
}
if (missing.length) { console.error(`check-models: not available in Pi: ${missing.join(", ")}`); process.exit(1); }
console.log("check-models: all line models available");
