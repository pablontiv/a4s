import { spawn, spawnSync, type SpawnOptions, type SpawnSyncOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Replaced by the release build, never inferred from the process name or PATH.
declare const A4S_COMPILED: boolean;
declare const A4S_RELEASE_EXTENSION: boolean;
const releaseExtension = typeof A4S_RELEASE_EXTENSION !== "undefined" && A4S_RELEASE_EXTENSION;
export const compiled = typeof A4S_COMPILED !== "undefined" && A4S_COMPILED;
function sourcePackageRoot(): string {
  let root = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = join(root, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "@a4s/issue-lifecycle") return root;
    const parent = dirname(root);
    if (parent === root) throw new Error("a4s package root not found");
    root = parent;
  }
}
export const packageRoot = compiled ? dirname(process.execPath) : sourcePackageRoot();
export function readPackageManifest(): { name: string; version: string } {
  return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
}

const sources = {
  gate: "bin/dagu-gate.cjs",
  "pr-body": "bin/dagu-pr-body.mjs",
  codeql: "bin/dagu-codeql.ts",
  "poc-scope": "bin/dagu-poc-scope.ts",
  protect: "bin/dagu-feature-protect.ts",
  "role-jobs": "bin/dagu-role-jobs.ts",
  admit: "bin/dagu-feature-bundle.ts",
  enqueue: "bin/dagu-feature-bundle.ts",
  queue: "bin/dagu-feature-bundle.ts",
  observe: "bin/dagu-feature-bundle.ts",
  escalation: "src/cli.ts",
  "stale-recovery": "bin/dagu-stale-recovery.ts",
  prioritize: "bin/dagu-feature-prioritize.ts",
  reconcile: "src/cli.ts",
  planning: "src/cli.ts",
  "heavy-slot": "src/cli.ts",
} as const;
export type Subcommand = keyof typeof sources;

/** One command boundary for ordinary, detached and shell-rendered engine children. */
export function engineCommand(command: Subcommand, args: readonly string[] = []): { file: string; args: string[] } {
  if (compiled || releaseExtension) return { file: compiled ? process.execPath : join(packageRoot, "a4s"), args: [command, ...args] };
  const entry = sources[command];
  const prefix = command === "queue" ? ["readiness"] : entry === "src/cli.ts" || entry === "bin/dagu-feature-bundle.ts" ? [command] : [];
  const loader = entry.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : [];
  return { file: process.versions.bun ? "node" : process.execPath, args: [...loader, join(packageRoot, entry), ...prefix, ...args] };
}
export function spawnEngine(command: Subcommand, args: readonly string[], options: SpawnOptions) {
  const child = engineCommand(command, args);
  return spawn(child.file, child.args, options);
}
export function spawnEngineSync(command: Subcommand, args: readonly string[], options: SpawnSyncOptions) {
  const child = engineCommand(command, args);
  return spawnSync(child.file, child.args, options);
}

/** Gate preloads must always execute in a real Node process, never Bun's executable. */
export function runGate(args: string[]): void {
  const result = spawnSync("node", [join(packageRoot, "bin/dagu-gate.cjs"), ...args], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
