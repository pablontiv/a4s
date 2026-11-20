#!/usr/bin/env node
// Host check: every Pi package a line requires (instance.packages in lines.json, e.g. pi-web-search) must be installed
// in the operator's Pi (settings.json `packages`). Without it a line silently loses its tool in production.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Names required by the lines that are missing from `installed` (entries like "npm:name", "npm:name@1", or objects with `source`). */
export function missingPackages(lines, installed) {
  const have = new Set(installed.map((e) => String(typeof e === "string" ? e : e?.source ?? "").replace(/^npm:/, "").replace(/(?<=.)@[^/@]*$/, "")));
  const missing = [];
  for (const [name, line] of Object.entries(lines)) for (const p of line.instance?.packages ?? []) if (!have.has(p)) missing.push(`${name}: ${p}`);
  return missing;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const linesPath = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "lines.json");
  const settings = process.env.PI_SETTINGS ?? join(process.env.HOME ?? "", ".pi", "agent", "settings.json");
  if (!existsSync(settings)) { console.error(`check-packages: ${settings} not found: install the Pi packages the lines require`); process.exit(1); }
  const installed = JSON.parse(readFileSync(settings, "utf8")).packages ?? [];
  const missing = missingPackages(JSON.parse(readFileSync(linesPath, "utf8")).lines, installed);
  if (missing.length) { console.error(`check-packages: Pi package not installed in ${settings}: ${missing.join(", ")}. Install it with \`pi install npm:<package>\`.`); process.exit(1); }
  console.log("check-packages: all required Pi packages installed");
}
