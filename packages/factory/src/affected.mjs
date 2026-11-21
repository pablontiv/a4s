// Test what is in use plus what changes (#1120). `@a4s/factory` is the only workspace in use, so it is always tested;
// any other workspace only when a changed path lies inside it; root files that every workspace reads select all.
// Used by scripts/gate.sh when GATE_BASE is set (validate, integrate, hand-push, QA and CI).
//
// CLI: node affected.mjs --base <ref> [--root <dir>]
//   stdout: the selected workspace names, one per line, or the single line `--all` when every workspace is selected;
//   stderr: `gate: <name>: <why>` per selected workspace (or `gate: all: <why>`).
import { readFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { changedPaths } from "./changes.mjs";

export const FACTORY = "@a4s/factory";
const ROOT_FILES = new Set(["package.json", "package-lock.json", ".npmrc", ".nvmrc"]);

/** A changed path that selects every workspace (conservative): root manifests, lockfile, tsconfig*, scripts/, .github/. */
export function isRootTrigger(p) {
  if (ROOT_FILES.has(p)) return true;
  if (!p.includes("/") && p.startsWith("tsconfig")) return true;
  return p.startsWith("scripts/") || p.startsWith(".github/");
}

const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));
const depNames = (pkg) => Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies });

/** Expand the root `workspaces` (exact dirs and `dir/*` only; any other glob throws) into [{name, dir, deps}]. */
export function listWorkspaces(root) {
  const pkg = readJson(join(root, "package.json"));
  const globs = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages ?? [];
  const dirs = [];
  for (const g of globs) {
    const w = g.replace(/^\.\//, "").replace(/\/$/, "");
    if (/^[\w.@-]+(\/[\w.@-]+)*\/\*$/.test(w)) {
      const parent = w.slice(0, -2);
      if (!existsSync(join(root, parent))) continue;
      for (const e of readdirSync(join(root, parent), { withFileTypes: true }))
        if (e.isDirectory() && existsSync(join(root, parent, e.name, "package.json"))) dirs.push(`${parent}/${e.name}`);
    } else if (/^[\w.@-]+(\/[\w.@-]+)*$/.test(w)) {
      if (existsSync(join(root, w, "package.json"))) dirs.push(w);
    } else throw new Error(`unsupported workspace glob: ${g}`);
  }
  return [...new Set(dirs)].sort().map((dir) => {
    const p = readJson(join(root, dir, "package.json"));
    return { name: p.name, dir, deps: depNames(p) };
  });
}

/**
 * Pure. changedPaths: repo-relative paths (a rename lists both), or null when the base is unknown.
 * workspaces: [{name, dir, deps?}]. Returns [{name, dir, why}] in workspace order.
 */
export function affectedWorkspaces(changedPaths, workspaces) {
  const all = (why) => workspaces.map((w) => ({ name: w.name, dir: w.dir, why }));
  if (changedPaths == null) return all("base unknown");
  const trigger = changedPaths.find(isRootTrigger);
  if (trigger) return all(`root file ${trigger}`);
  const why = new Map();
  const factory = workspaces.find((w) => w.name === FACTORY);
  if (factory) why.set(factory.name, "in use");
  // the longest workspace dir containing the path owns it (packages/synagent/core before packages/synagent)
  const byLength = [...workspaces].sort((a, b) => b.dir.length - a.dir.length);
  for (const p of changedPaths) {
    const w = byLength.find((x) => p.startsWith(`${x.dir}/`));
    if (w && !why.has(w.name)) why.set(w.name, `changed ${p}`);
  }
  // no workspace depends on another today; if one ever does, its dependents are tested too
  for (let grew = true; grew;) {
    grew = false;
    for (const w of workspaces) {
      if (why.has(w.name)) continue;
      const dep = (w.deps ?? []).find((d) => why.has(d));
      if (dep) { why.set(w.name, `depends on ${dep}`); grew = true; }
    }
  }
  return workspaces.filter((w) => why.has(w.name)).map((w) => ({ name: w.name, dir: w.dir, why: why.get(w.name) }));
}

/** CLI result: { names: [...] | null (all workspaces), lines: [stderr explanation] }. */
export function selectForGate(root, base) {
  let workspaces;
  try { workspaces = listWorkspaces(root); } catch (e) { return { names: null, lines: [`gate: all: ${e.message}`] }; }
  const sel = affectedWorkspaces(changedPaths(root, base), workspaces);
  const reasons = [...new Set(sel.map((s) => s.why))];
  const all = sel.length === workspaces.length;
  if (all && reasons.length === 1 && sel.length > 1) return { names: null, lines: [`gate: all: ${reasons[0]}`] };
  return { names: all ? null : sel.map((s) => s.name), lines: sel.map((s) => `gate: ${s.name}: ${s.why}`) };
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const { names, lines } = selectForGate(arg("--root") ?? process.cwd(), arg("--base"));
  for (const l of lines) process.stderr.write(`${l}\n`);
  process.stdout.write(names ? names.map((n) => `${n}\n`).join("") : "--all\n");
}
