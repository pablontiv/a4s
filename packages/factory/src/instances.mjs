#!/usr/bin/env node
// Build T3 `providerInstances` entries from lines.json (one Pi instance per line), and install them
// into the operator's T3 settings (VS7). Prompts live in the repo; nothing is hand-edited in T3.
//
//   node src/instances.mjs install [--settings FILE] [--pi BIN] [--prompts-root DIR] [--lines FILE] [--dry-run]
//   node src/instances.mjs check   [--settings FILE] [--pi BIN] [--prompts-root DIR] [--lines FILE]
//
// install merges only the providerInstances keys lines.json defines (other instances and settings are
// untouched), writes settings.json.bak-<timestamp> first and replaces the file atomically (tmp + rename).
// check exits 1 and prints the differences when the settings drift from lines.json.
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PI = "/home/pones/bin/pi";

// promptsRoot: directory the relative `prompt` paths are resolved against (default: the dir of lines.json).
export function instancesFromLines(linesPath, piBinary, promptsRoot) {
  const doc = JSON.parse(readFileSync(linesPath, "utf8"));
  const base = promptsRoot ? resolve(promptsRoot) : dirname(resolve(linesPath));
  const out = {};
  for (const [name, line] of Object.entries(doc.lines)) {
    const inst = line.instance ?? {};
    const args = [...(doc.isolation ?? [])];
    if (inst.tools?.length) args.push("--tools", inst.tools.join(","));
    if (inst.prompt) args.push("--append-system-prompt", resolve(base, inst.prompt));
    out[line.provider] = {
      driver: "pi",
      enabled: true,
      ...(inst.displayName ? { displayName: inst.displayName } : {}),
      ...(inst.accentColor ? { accentColor: inst.accentColor } : {}),
      environment: [{ name: "A4S_LINE", value: name }],
      config: { binaryPath: piBinary, launchArgs: args.join(" ") },
    };
  }
  return out;
}

// Flatten an instance to "path = json" leaves so differences are readable one field at a time.
function leaves(v, prefix = "", out = {}) {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) leaves(x, prefix ? `${prefix}.${k}` : k, out);
  } else out[prefix] = JSON.stringify(v);
  return out;
}

// Differences between the wanted instances and the current providerInstances, as printable lines.
export function diffInstances(current, wanted) {
  const lines = [];
  for (const [key, want] of Object.entries(wanted)) {
    const have = current?.[key];
    if (!have) { lines.push(`+ ${key} (new)`); for (const [p, v] of Object.entries(leaves(want))) lines.push(`    + ${p} = ${v}`); continue; }
    const a = leaves(have), b = leaves(want), out = [];
    for (const p of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (a[p] === b[p]) continue;
      if (p in a) out.push(`    - ${p} = ${a[p]}`);
      if (p in b) out.push(`    + ${p} = ${b[p]}`);
    }
    if (out.length) lines.push(`~ ${key}`, ...out);
  }
  return lines;
}

// Pure merge: settings with the lines' instances replaced; every other key kept as is.
export function mergeSettings(settings, wanted) {
  return { ...settings, providerInstances: { ...(settings.providerInstances ?? {}), ...wanted } };
}

// The primary checkout: the main worktree of the repo this file lives in.
export function primaryCheckout(from = HERE) {
  const out = execFileSync("git", ["-C", from, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  return out.split("\n").find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
}

export function plan({ settingsPath, linesPath, piBinary, promptsRoot }) {
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const pi = piBinary ?? settings.providerInstances?.["pi-impl"]?.config?.binaryPath ?? DEFAULT_PI;
  const wanted = instancesFromLines(linesPath, pi, promptsRoot);
  return { settings, wanted, diff: diffInstances(settings.providerInstances, wanted) };
}

export function install(opts, now = new Date()) {
  const p = plan(opts);
  if (opts.dryRun || !p.diff.length) return { ...p, written: false };
  const backup = `${opts.settingsPath}.bak-${now.toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(opts.settingsPath, backup);
  const tmp = `${opts.settingsPath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(mergeSettings(p.settings, p.wanted), null, 2) + "\n");
  renameSync(tmp, opts.settingsPath);
  return { ...p, written: true, backup };
}

function main(argv) {
  const { values: a, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      settings: { type: "string", default: join(homedir(), ".t3", "userdata", "settings.json") },
      pi: { type: "string" },
      "prompts-root": { type: "string" },
      lines: { type: "string", default: join(HERE, "..", "lines.json") },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const cmd = positionals[0];
  if (cmd !== "install" && cmd !== "check") {
    console.error("usage: instances.mjs install|check [--settings FILE] [--pi BIN] [--prompts-root DIR] [--lines FILE] [--dry-run]");
    return 2;
  }
  // --prompts-root is the factory package dir holding prompts/ (default: packages/factory of the primary checkout)
  const promptsRoot = a["prompts-root"] ?? join(primaryCheckout(), "packages", "factory");
  const opts = { settingsPath: a.settings, linesPath: a.lines, piBinary: a.pi, promptsRoot, dryRun: a["dry-run"] };
  if (cmd === "check") {
    const { diff } = plan(opts);
    if (!diff.length) { console.log(`check: ${a.settings} matches ${a.lines} (prompts under ${promptsRoot})`); return 0; }
    console.log(`check: ${a.settings} drifts from ${a.lines}:`);
    for (const l of diff) console.log(l);
    return 1;
  }
  const r = install(opts);
  if (!r.diff.length) { console.log(`install: ${a.settings} already matches ${a.lines}; nothing written`); return 0; }
  console.log(`install${opts.dryRun ? " (dry run, nothing written)" : ""}: ${a.settings} (prompts under ${promptsRoot})`);
  for (const l of r.diff) console.log(l);
  if (r.written) console.log(`backup: ${r.backup}\nwritten: ${a.settings}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
