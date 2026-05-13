import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { withFileLockAsync } from "./file-lock.ts";
import { SHARED_FORMATS, LAUNCHER_PROTOCOL, STATE_SCHEMAS, type ArtifactSupport, type SharedFormat } from "./contracts.ts";
import { artifactToken, parseArtifact, type ArtifactTuple } from "./release.ts";
import { isRecord } from "./type-guard.ts";
export type PersistedFormats = Record<SharedFormat, number[]>;
export interface StationState {
  schema: 1; generation: number; current: ArtifactTuple; previous: ArtifactTuple;
  rejected: string[]; formats: PersistedFormats;
}
export interface StateDependencies {
  withFileLock?: typeof withFileLockAsync;
  fault?: (point: "before-rename" | "after-rename") => void;
}
export function stationRoot(home: string): string { return join(resolve(home), "cache", "a4s"); }
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
export function readStateLocked(home: string): StationState { return validateState(readJsonFile(join(stationRoot(home), "state.json"))); }
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
export function commitStateLocked(home: string, state: StationState, fault?: StateDependencies["fault"]): void {
  validateState(state);
  writeJsonDurable(join(stationRoot(home), "state.json"), state, fault);
}
export async function stationTransaction<T>(home: string, body: () => Promise<T>, dependencies: StateDependencies = {}): Promise<T> {
  const root = stationRoot(home); realDirectory(root);
  const lock = join(root, ".state.lock");
  try { if (!lstatSync(lock).isFile()) throw new Error("Station lock must be a regular file"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return (dependencies.withFileLock ?? withFileLockAsync)(lock, body);
}
export async function readStationState(home: string, dependencies: StateDependencies = {}): Promise<StationState> {
  return stationTransaction(home, async () => readStateLocked(home), dependencies);
}
export function activatedFormats(formats: PersistedFormats, support: ArtifactSupport): PersistedFormats {
  return Object.fromEntries(SHARED_FORMATS.map(name => [name, [...new Set([...formats[name], support[name].write])].sort((a, b) => a - b)])) as PersistedFormats;
}
export function assertLauncher(identity: unknown): void {
  if (!isRecord(identity) || !Number.isSafeInteger(identity.requiredLauncherProtocol) || Number(identity.requiredLauncherProtocol) < 1 || Number(identity.requiredLauncherProtocol) > LAUNCHER_PROTOCOL) throw new Error("launcher reinstall required; reinstall a4s-launch");
}
export function tupleFromJson(value: unknown): ArtifactTuple {
  if (!isRecord(value)) throw new Error("Missing station artifact tuple");
  return parseArtifact(artifactToken(value as unknown as ArtifactTuple));
}
