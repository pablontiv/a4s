import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { withFileLockAsync } from "./file-lock.ts";
import { SHARED_FORMATS, LAUNCHER_PROTOCOL, STATE_SCHEMAS, type ArtifactSupport, type SharedFormat } from "./contracts.ts";
import { artifactToken, parseArtifact, type ArtifactTuple } from "./release.ts";
import { isRecord } from "./type-guard.ts";
import { reconcileResources } from "./station-resources.ts";
import { stationCacheRoot } from "./station-paths.ts";
export type PersistedFormats = Record<SharedFormat, number[]>;
export interface StationState {
  schema: 1; generation: number; current: ArtifactTuple; previous: ArtifactTuple;
  rejected: string[]; formats: PersistedFormats;
}
export interface StateDependencies {
  withFileLock?: typeof withFileLockAsync;
  fault?: (point: "before-rename" | "after-rename") => void;
  env?: NodeJS.ProcessEnv;
  reportResourceConflict?: (message: string) => void;
}
export function stationRoot(home: string): string { return stationCacheRoot(home); }
export function realDirectory(path: string): void {
  try {
    if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) throw new Error(`Station runtime directory must not contain symlinks: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    realDirectory(dirname(path));
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) throw new Error(`Station runtime directory must not contain symlinks: ${path}`);
  }
}
export function readJsonFile(path: string): unknown {
  if (!lstatSync(path).isFile()) throw new Error(`Station runtime file must be regular: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}
export function validateState(value: unknown): StationState {
  if (!isRecord(value) || !STATE_SCHEMAS.includes(Number(value.schema))) throw new Error("Unknown station state schema; reinstall a4s-launch");
  if (value.schema !== 1 || !Number.isSafeInteger(value.generation) || (value.generation as number) < 0 ||
      !Array.isArray(value.rejected) || value.rejected.some(id => typeof id !== "string" || !/^(?:r(?:0|[1-9]\d*)|\d+\.\d+\.\d+)$/.test(id)) ||
      new Set(value.rejected).size !== value.rejected.length || !isRecord(value.formats)) throw new Error("Invalid station state");
  for (const key of ["current", "previous"]) {
    const tuple = value[key];
    if (!isRecord(tuple)) throw new Error(`Invalid station ${key}`);
    parseArtifact(`${tuple.version}@${tuple.commit}#${tuple.digest}`);
  }
  if (Object.keys(value.formats).sort().join() !== [...SHARED_FORMATS].sort().join()) throw new Error("Invalid persisted format keys");
  for (const name of SHARED_FORMATS) {
    const versions = value.formats[name];
    if (!Array.isArray(versions) || !versions.length || versions.some(v => !Number.isSafeInteger(v) || v < 1) || new Set(versions).size !== versions.length) throw new Error(`Invalid persisted formats: ${name}`);
  }
  return value as unknown as StationState;
}
/** Call only while holding .state.lock. All selectors share this transaction. */
export function readStateLocked(home: string, dependencies: StateDependencies = {}): StationState {
  const state = validateState(readJsonFile(join(stationRoot(home), "state.json")));
  refreshResourcePointer(home, state, dependencies);
  return state;
}
/** Derived native resource discovery root, never station or service configuration. */
function refreshResourcePointer(home: string, state: StationState, dependencies: StateDependencies): void {
  const root = stationRoot(home);
  const target = join(root, "current");
  let correct = false;
  try {
    if (!lstatSync(target).isSymbolicLink()) throw new Error("Current resource pointer must be a symlink");
    correct = readlinkSync(target) === state.current.version;
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!correct) {
    const temporary = join(root, `.resources-${randomUUID()}`);
    try {
      symlinkSync(state.current.version, temporary, "dir");
      renameSync(temporary, target);
    } finally { rmSync(temporary, { force: true }); }
  }
  realDirectory(join(root, "loader"));
  reconcileResources(root, dependencies);
}
export function writeJsonDurable(path: string, value: unknown, fault?: StateDependencies["fault"]): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); }
    finally { closeSync(fd); }
    fault?.("before-rename");
    renameSync(temporary, path); // The sole state commit point.
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
    fault?.("after-rename");
  } finally { rmSync(temporary, { force: true }); }
}
export function commitStateLocked(home: string, state: StationState, dependencies: StateDependencies = {}): void {
  validateState(state);
  writeJsonDurable(join(stationRoot(home), "state.json"), state, dependencies.fault);
  refreshResourcePointer(home, state, dependencies);
}
export async function stationTransaction<T>(home: string, body: () => Promise<T>, dependencies: StateDependencies = {}): Promise<T> {
  const root = stationRoot(home); realDirectory(root);
  const lock = join(root, ".state.lock");
  try { if (!lstatSync(lock).isFile()) throw new Error("Station lock must be a regular file"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return (dependencies.withFileLock ?? withFileLockAsync)(lock, body);
}
/** Lease and tick records are immutable. Directory change times also detect a
 * reader that was published and released entirely during slow inventory work. */
export function referenceStamp(home: string): string {
  return ["leases", "ticks"].map(name => {
    const path = join(stationRoot(home), name);
    const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (!stat) return "missing";
    if (!stat.isDirectory() || realpathSync(path) !== path) throw new Error(`Station runtime directory must not contain symlinks: ${path}`);
    return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`;
  }).join("/");
}
/** Atomic rename publishes a complete envelope; advisory readers need no lock or repair. */
export async function readStationState(home: string): Promise<StationState> {
  const root = stationRoot(home);
  let directory = root, stat = lstatSync(directory, { throwIfNoEntry: false });
  while (!stat) { directory = dirname(directory); stat = lstatSync(directory, { throwIfNoEntry: false }); }
  if (!stat.isDirectory() || realpathSync(directory) !== directory) throw new Error(`Station runtime directory must not contain symlinks: ${root}`);
  return validateState(readJsonFile(join(root, "state.json")));
}
export function activatedFormats(formats: PersistedFormats, support: ArtifactSupport): PersistedFormats {
  return Object.fromEntries(SHARED_FORMATS.map(name => [name, [...new Set([...formats[name], support[name].write])].sort((a, b) => a - b)])) as PersistedFormats;
}
export function assertLauncher(identity: unknown): void {
  if (!isRecord(identity)) throw new Error("launcher reinstall required; reinstall a4s-launch");
  // Pre-launcher SemVer receipts retain the original a4s-run/1 handoff contract.
  const legacy = typeof identity.version === "string" && /^\d+\.\d+\.\d+$/.test(identity.version) &&
    isRecord(identity.support) && "receiptSchemas" in identity.support;
  const protocol = legacy && identity.requiredLauncherProtocol === undefined ? 1 : identity.requiredLauncherProtocol;
  if (!Number.isSafeInteger(protocol) || Number(protocol) < 1 || Number(protocol) > LAUNCHER_PROTOCOL) throw new Error("launcher reinstall required; reinstall a4s-launch");
}
export function tupleFromJson(value: unknown): ArtifactTuple {
  if (!isRecord(value)) throw new Error("Missing station artifact tuple");
  return parseArtifact(artifactToken(value as unknown as ArtifactTuple));
}
