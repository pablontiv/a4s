import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * Durable feature/PoC binding. Dagu expands it from the scheduler environment.
 * Enqueue and spec recovery resolve it from host env/config; renders do not
 * store a machine path.
 *
 * Order:
 * 1. `$DAGU_HOME/primaries/<workspace>` when the render's `workspace=` label
 *    names an existing one-line absolute path (multi-checkout schedulers).
 * 2. `A4S_PRIMARY` in the process environment (the station checkout).
 * 3. `$DAGU_HOME/a4s-primary`, one absolute path (`DAGU_HOME` defaults to `~/.dagu`).
 *
 * A recorded absolute path stays that checkout. The resolved path is the main
 * checkout; worktrees stay `$PRIMARY/.workspace/worktrees/...`.
 */
export const HOST_PRIMARY_REFERENCE = "${A4S_PRIMARY}";

const WORKSPACE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function workspaceLabel(text: string): string | undefined {
  const label = /^  - workspace=(\S+)\s*$/m.exec(text)?.[1];
  return label && WORKSPACE.test(label) ? label : undefined;
}

function stationHome(env: NodeJS.ProcessEnv): string {
  return env.DAGU_HOME || join(homedir(), ".dagu");
}

function readPathFile(file: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const line = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (!line || line !== line.trim() || !isAbsolute(line) || line.includes("$")) {
    throw new Error(`${file} must contain one absolute path`);
  }
  return line;
}

export function resolveHostPrimary(options: { workspace?: string | undefined; env?: NodeJS.ProcessEnv | undefined } = {}): string {
  const env = options.env ?? process.env;
  const home = stationHome(env);
  if (options.workspace !== undefined) {
    if (!WORKSPACE.test(options.workspace)) throw new Error("workspace label is not a single path segment");
    const specific = readPathFile(join(home, "primaries", options.workspace));
    if (specific) return specific;
  }
  const fromEnv = env.A4S_PRIMARY;
  if (fromEnv !== undefined && fromEnv !== "") {
    if (!isAbsolute(fromEnv) || fromEnv !== fromEnv.trim() || fromEnv.includes("$")) {
      throw new Error("A4S_PRIMARY must be an absolute main-checkout path");
    }
    return fromEnv;
  }
  const shared = readPathFile(join(home, "a4s-primary"));
  if (shared) return shared;
  throw new Error("PRIMARY host binding is unset: set A4S_PRIMARY or write $DAGU_HOME/a4s-primary or $DAGU_HOME/primaries/<workspace>");
}

/** Absolute recorded paths stay. The host reference resolves from env/config. */
export function resolvePrimaryBinding(value: string, options: { workspace?: string | undefined; env?: NodeJS.ProcessEnv | undefined } = {}): string {
  if (value === HOST_PRIMARY_REFERENCE) return resolveHostPrimary(options);
  if (isAbsolute(value) && !value.includes("$") && !value.includes("\n") && value === value.trim()) return value;
  throw new Error("PRIMARY binding must be an absolute path or ${A4S_PRIMARY}");
}

export function primaryFromSpec(spec: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const literal = /^  - PRIMARY: (.+)$/m.exec(spec)?.[1];
  if (!literal) return undefined;
  const value: unknown = JSON.parse(literal);
  if (typeof value !== "string") return undefined;
  if (value === HOST_PRIMARY_REFERENCE) return resolveHostPrimary({ workspace: workspaceLabel(spec), env });
  return value;
}

/** Admitted feature/PoC snapshots record the resolved checkout. Legacy absolute bindings stay byte-for-byte. */
export function bindSnapshotPrimary(snapshot: string, primary: string): string {
  const match = /^  - PRIMARY: (.+)$/m.exec(snapshot);
  if (!match?.[1]) throw new Error("feature/poc render has no PRIMARY binding");
  const current: unknown = JSON.parse(match[1]);
  if (current !== HOST_PRIMARY_REFERENCE) return snapshot;
  return snapshot.replace(/^  - PRIMARY: .+$/m, `  - PRIMARY: ${JSON.stringify(primary)}`);
}
