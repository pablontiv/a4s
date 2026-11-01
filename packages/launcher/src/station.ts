import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { inspectArtifact, ensureArtifact, assertCachedArtifactPresent, artifactLock, type CachedArtifact } from "./artifact-cache.ts";
import { assertIdentityContracts, assertReadCoverage, formatSupport } from "./artifact-support.ts";
import { artifactToken, github, releaseRepository, resolveRelease, sameArtifact, type ArtifactTuple, type ResolvedRelease } from "./release.ts";
import { activatedFormats, assertLauncher, commitStateLocked, readJsonFile, readStateLocked, stationRoot, stationTransaction, tupleFromJson, type PersistedFormats, type StateDependencies, type StationState } from "./station-state.ts";
import { readLeasesLocked, type LeaseDependencies } from "./lease.ts";
import { prepareInventory, type PreparedInventory, type BuildReference, type InventoryDependencies, type StationInventory } from "./station-inventory.ts";
import { withFileLockAsync } from "./file-lock.ts";
import { isRecord } from "./type-guard.ts";
import { SHARED_FORMATS, type ArtifactSupport } from "./contracts.ts";
import { restoreArtifact } from "./select.ts";
import { probeProcess, type ProcessProbe } from "./process-identity.ts";

export interface ReleaseCandidate { version: string }
export interface StationDependencies extends StateDependencies, LeaseDependencies, InventoryDependencies {
  inspect?: (home: string, tuple: ArtifactTuple) => Promise<CachedArtifact>;
  ensure?: (home: string, release: ResolvedRelease) => Promise<CachedArtifact>;
  releases?: () => Promise<Array<ResolvedRelease | ReleaseCandidate>>;
  inventory?: (home: string) => Promise<StationInventory>;
}
export interface PromotionReport { current: ArtifactTuple; promoted: boolean; skipped: Array<{ version: string; reason: string }> }
export function releaseOrdinal(version: string): bigint {
  if (/^r(?:0|[1-9]\d*)$/.test(version)) return BigInt(version.slice(1));
  if (/^\d+\.\d+\.\d+$/.test(version)) return -1n; // Frozen pre-cutover history.
  throw new Error(`Invalid build ID ${version}`);
}
async function publishedReleases(): Promise<ReleaseCandidate[]> {
  const repository = releaseRepository();
  const pages: unknown = JSON.parse(github(["api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`]));
  if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw new Error("Invalid release inventory");
  const releases: ReleaseCandidate[] = [];
  for (const value of pages.flat()) {
    if (!isRecord(value) || typeof value.tag_name !== "string") throw new Error("Malformed release inventory");
    if (value.draft === false && value.prerelease === false && /^a4s-r(?:0|[1-9]\d*)$/.test(value.tag_name)) releases.push({ version: value.tag_name.slice(4) });
  }
  return releases;
}
function mergeInventory(state: StationState, inventory: StationInventory): PersistedFormats {
  return Object.fromEntries(SHARED_FORMATS.map(name => [name, [...new Set([...state.formats[name], ...(inventory.formats[name] ?? [])])].sort((a, b) => a - b)])) as PersistedFormats;
}
/** Verify reader declarations outside the lock, then compare their local bytes.
 * A new lease for an already cached build is not an invalidation or a retry. */
function prepareReaders(home: string): (tuple: ArtifactTuple) => ArtifactSupport {
  const readers = new Map<string, { declared: unknown; record: unknown; support: ArtifactSupport } | Error>();
  for (const version of readdirSync(stationRoot(home)).filter(name => /^(?:r(?:0|[1-9]\d*)|\d+\.\d+\.\d+)$/.test(name))) {
    try {
      const declared = readJsonFile(join(stationRoot(home), version, "identity.json"));
      const record = readJsonFile(join(stationRoot(home), version, "artifact.json"));
      const tuple = tupleFromJson(record);
      if (tuple.version !== version || !isRecord(declared) || declared.version !== version || declared.commit !== tuple.commit) throw new Error(`Live reader identity mismatch: ${version}`);
      assertIdentityContracts(declared, !version.startsWith("r"));
      readers.set(version, { declared, record, support: formatSupport(declared.support) });
    } catch (error) { readers.set(version, error instanceof Error ? error : new Error(String(error))); }
  }
  return tuple => {
    const reader = readers.get(tuple.version);
    if (reader instanceof Error) throw reader;
    if (!reader) throw new Error(`New reader build appeared during preparation: ${tuple.version}; retry`);
    if (!sameArtifact(tuple, tupleFromJson(reader.record)) ||
        !isDeepStrictEqual(reader.record, readJsonFile(join(stationRoot(home), tuple.version, "artifact.json"))) ||
        !isDeepStrictEqual(reader.declared, readJsonFile(join(stationRoot(home), tuple.version, "identity.json")))) throw new Error(`Live reader identity changed during preparation: ${artifactToken(tuple)}; retry`);
    return reader.support;
  };
}
async function prepare(home: string, dependencies: StationDependencies, includeRuns: boolean, conservativeGc = false): Promise<PreparedInventory> {
  if (!dependencies.inventory) return prepareInventory(home, dependencies, includeRuns, conservativeGc);
  // Complete-inventory injection is retained for isolated artifact fixtures.
  const inventory = await dependencies.inventory(home);
  return { readLocked: async () => inventory, checkDeadline() {} };
}
function liveReferences(home: string, inventory: StationInventory, dependencies: StationDependencies): { references: BuildReference[]; dead: string[] } {
  const leases = readLeasesLocked(home, dependencies);
  return { references: [...inventory.references, ...leases.live.map(lease => ({ artifact: lease.artifact,
    holder: `${lease.kind} lease holder pid=${lease.pid} generation=${lease.generation} ${lease.holder}${lease.kind === "plugin" ? "; restart OMP" : ""}` }))], dead: leases.dead };
}
function prepareLeaseProbes(home: string, dependencies: StationDependencies): StationDependencies {
  const probes = new Map<string, ProcessProbe>();
  readLeasesLocked(home, { ...dependencies, probe(pid, started) {
    const result = (dependencies.probe ?? probeProcess)(pid, started);
    probes.set(JSON.stringify([pid, started]), result);
    return result;
  } });
  // A new lease is conservatively alive. Previously dead process identities
  // cannot revive; newly dead identities are harmlessly retained until next GC.
  return { ...dependencies, probe: (pid, started) => probes.get(JSON.stringify([pid, started])) ?? "alive" };
}
export async function initializeStation(home: string, current: ArtifactTuple, dependencies: StationDependencies = {}): Promise<StationState> {
  current = tupleFromJson(current);
  const cached = await (dependencies.inspect ?? inspectArtifact)(home, current);
  if (!sameArtifact(cached.record, current)) throw new Error("Initialization verification returned a different tuple");
  assertLauncher(cached.identity);
  const prepared = await prepare(home, dependencies, false);
  return stationTransaction(home, async () => {
    if (existsSync(join(stationRoot(home), "state.json"))) throw new Error("Station already initialized; state is never reseeded");
    assertCachedArtifactPresent(home, cached);
    const inventory = await prepared.readLocked();
    const support = formatSupport(cached.identity.support);
    const formats = Object.fromEntries(SHARED_FORMATS.map(name => [name, [...new Set([...(inventory.formats[name] ?? []), support[name].write])].sort((a, b) => a - b)])) as PersistedFormats;
    assertReadCoverage(support, formats);
    const state: StationState = { schema: 1, generation: 0, current, previous: current, rejected: [], formats };
    prepared.checkDeadline();
    commitStateLocked(home, state, dependencies);
    return state;
  }, dependencies);
}
export async function promote(home: string, dependencies: StationDependencies = {}): Promise<PromotionReport> {
  const snapshot = await stationTransaction(home, async () => readStateLocked(home, dependencies), dependencies);
  let floor = releaseOrdinal(snapshot.current.version);
  for (const rejected of snapshot.rejected) if (releaseOrdinal(rejected) > floor) floor = releaseOrdinal(rejected);
  const releases = await (dependencies.releases ?? publishedReleases)();
  const candidates = releases.filter(release => releaseOrdinal(release.version) > floor && !snapshot.rejected.includes(release.version)).sort((a, b) => releaseOrdinal(a.version) > releaseOrdinal(b.version) ? -1 : releaseOrdinal(a.version) < releaseOrdinal(b.version) ? 1 : 0);
  const ids = new Map<string, string>();
  for (const candidate of candidates) if ("commit" in candidate && "digest" in candidate) {
    const prior = ids.get(candidate.version);
    const token = artifactToken(candidate as ResolvedRelease);
    if (prior && prior !== token) throw new Error(`Conflicting release identity ${candidate.version}`);
    ids.set(candidate.version, token);
  }
  const skipped: PromotionReport["skipped"] = [];
  for (const candidate of candidates) {
    let cached: CachedArtifact;
    let release: ResolvedRelease;
    try {
      release = "commit" in candidate && "digest" in candidate ? candidate as ResolvedRelease : resolveRelease(candidate.version);
      cached = await (dependencies.ensure ?? ensureArtifact)(home, release);
      if (!sameArtifact(cached.record, release)) throw new Error("Candidate verification returned a different tuple");
      assertLauncher(cached.identity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ETIMEDOUT") throw error;
      skipped.push({ version: candidate.version, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const prepared = await prepare(home, dependencies, true);
    const readerSupport = prepareReaders(home);
    const leaseDependencies = prepareLeaseProbes(home, dependencies);
    const result = await stationTransaction(home, async () => {
      const state = readStateLocked(home, dependencies);
      if (!isDeepStrictEqual(state, snapshot)) throw new Error("Station changed during promotion preparation; retry");
      const inventory = await prepared.readLocked();
      const { references } = liveReferences(home, inventory, leaseDependencies);
      references.push({ artifact: state.current, holder: "post-promotion previous" });
      const readers = new Map<string, { support: ArtifactSupport; holders: string[] }>();
      for (const reference of references) {
        const key = artifactToken(reference.artifact), reader = readers.get(key);
        if (reader) reader.holders.push(`${reference.holder} build=${reference.artifact.version}`);
        else readers.set(key, { support: readerSupport(reference.artifact), holders: [`${reference.holder} build=${reference.artifact.version}`] });
      }
      const formats = mergeInventory(state, inventory);
      const support = formatSupport(cached.identity.support);
      try {
        assertCachedArtifactPresent(home, cached);
        assertReadCoverage(support, formats);
        for (const reader of readers.values()) {
          try { assertReadCoverage(reader.support, {}, support); }
          catch (error) { throw new Error(`Blocking reader ${reader.holders.join(", ")}: ${error instanceof Error ? error.message : String(error)}`); }
        }
      } catch (error) { return error instanceof Error ? error.message : String(error); }
      // Commit errors must not be mistaken for a skipped candidate.
      const next: StationState = { ...state, current: { version: release.version, commit: release.commit, digest: release.digest }, previous: state.current,
        generation: state.generation + 1, formats: activatedFormats(formats, support) };
      prepared.checkDeadline();
      commitStateLocked(home, next, dependencies);
      return { current: next.current, promoted: true, skipped };
    }, dependencies);
    if (typeof result !== "string") return result;
    skipped.push({ version: candidate.version, reason: result });
  }
  return stationTransaction(home, async () => {
    const state = readStateLocked(home, dependencies);
    return { current: state.current, promoted: false, skipped };
  }, dependencies);
}
/** Stable-launcher-owned operation: never imports or executes the current payload. */
export async function rollback(home: string, dependencies: StationDependencies = {}): Promise<StationState> {
  const snapshot = await stationTransaction(home, async () => readStateLocked(home, dependencies), dependencies);
  const target = snapshot.previous;
  const cached = await (dependencies.inspect ?? restoreArtifact)(home, target);
  assertLauncher(cached.identity);
  const prepared = await prepare(home, dependencies, false);
  return stationTransaction(home, async () => {
    const state = readStateLocked(home, dependencies);
    if (!isDeepStrictEqual(state, snapshot)) throw new Error("Station changed during rollback preparation; retry");
    if (!sameArtifact(cached.record, target)) throw new Error("Rollback verification returned a different tuple");
    assertCachedArtifactPresent(home, cached);
    const inventory = await prepared.readLocked();
    const formats = mergeInventory(state, inventory);
    assertReadCoverage(formatSupport(cached.identity.support), formats);
    if (sameArtifact(state.current, target)) return state;
    const next: StationState = { ...state, current: target, previous: target, rejected: [...new Set([...state.rejected, state.current.version])], generation: state.generation + 1, formats };
    prepared.checkDeadline();
    commitStateLocked(home, next, dependencies);
    return next;
  }, dependencies);
}
export interface GcReport { removed: string[]; retained: Array<{ version: string; holders: string[] }> }
export async function gc(home: string, dependencies: StationDependencies = {}): Promise<GcReport> {
  const prepared = await prepare(home, dependencies, true, true);
  const leaseDependencies = prepareLeaseProbes(home, dependencies);
  const plan = async () => {
    const state = readStateLocked(home, dependencies);
    const inventory = await prepared.readLocked();
    const { references, dead } = liveReferences(home, inventory, leaseDependencies);
    const keep = new Map<string, string[]>();
    const identities = new Map<string, string>();
    const retain = (tuple: ArtifactTuple, holder: string) => {
      const token = artifactToken(tupleFromJson(tuple)), prior = identities.get(tuple.version);
      if (prior && prior !== token) throw new Error(`Conflicting retained build ${tuple.version}`);
      identities.set(tuple.version, token);
      const holders = keep.get(tuple.version) ?? []; holders.push(holder); keep.set(tuple.version, holders);
    };
    retain(state.current, "current"); retain(state.previous, "previous");
    for (const reference of references) retain(reference.artifact, reference.holder);
    const entries: Array<{ version: string; path: string }> = [];
    for (const version of readdirSync(stationRoot(home))) {
      prepared.checkDeadline();
      if (!/^(?:r(?:0|[1-9]\d*)|\d+\.\d+\.\d+)$/.test(version)) continue;
      const path = join(stationRoot(home), version);
      if (!lstatSync(path).isDirectory()) throw new Error(`Cache build must be a real directory: ${version}`);
      const record = tupleFromJson(readJsonFile(join(path, "artifact.json")));
      if (record.version !== version) throw new Error(`Cache build identity mismatch: ${version}`);
      if (identities.has(version) && identities.get(version) !== artifactToken(record)) throw new Error(`Retained cache identity mismatch: ${version}`);
      entries.push({ version, path });
    }
    entries.sort((a, b) => releaseOrdinal(a.version) > releaseOrdinal(b.version) ? -1 : releaseOrdinal(a.version) < releaseOrdinal(b.version) ? 1 : a.version.localeCompare(b.version));
    for (const entry of entries.slice(0, 10)) {
      const holders = keep.get(entry.version) ?? []; holders.push("keep-10 highest IDs"); keep.set(entry.version, holders);
    }
    prepared.checkDeadline();
    return { entries, keep, dead, expired: inventory.expiredBindings };
  };
  const initial = await stationTransaction(home, plan, dependencies);
  const keep = initial.keep, removed: string[] = [];
  for (const entry of initial.entries) if (!keep.has(entry.version)) {
    try {
      // Match admission's state-then-artifact order, never waiting for a busy
      // publisher. Only the fresh local decision and atomic detach hold locks.
      const trash = await stationTransaction(home, () =>
        (dependencies.withFileLock ?? withFileLockAsync)(artifactLock(home, { version: entry.version, commit: "0".repeat(40), digest: "0".repeat(64) }), async () => {
          const current = await plan();
          const holders = current.keep.get(entry.version);
          if (holders) { keep.set(entry.version, holders); return undefined; }
          if (!current.entries.some(candidate => candidate.version === entry.version)) return undefined;
          prepared.checkDeadline();
          const path = `${entry.path}.gc-${randomUUID()}`;
          renameSync(entry.path, path);
          return path;
        }, { timeoutMs: 0 }), dependencies);
      if (trash) { rmSync(trash, { recursive: true }); removed.push(entry.version); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ETIMEDOUT") throw error;
      keep.set(entry.version, [`artifact lock busy: ${error instanceof Error ? error.message : String(error)}`]);
    }
  }
  await stationTransaction(home, async () => {
    const current = await plan();
    for (const path of [...current.dead, ...current.expired]) rmSync(path);
  }, dependencies);
  return { removed, retained: [...keep].map(([version, holders]) => ({ version, holders })) };
}
