import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { inspectArtifact, ensureArtifact, artifactLock, type CachedArtifact } from "./artifact-cache.ts";
import { assertIdentityContracts, assertReadCoverage, formatSupport } from "./artifact-support.ts";
import { artifactToken, github, releaseRepository, resolveRelease, sameArtifact, type ArtifactTuple, type ResolvedRelease } from "./release.ts";
import { activatedFormats, assertLauncher, commitStateLocked, readJsonFile, readStateLocked, stationRoot, stationTransaction, tupleFromJson, type PersistedFormats, type StateDependencies, type StationState } from "./station-state.ts";
import { readLeasesLocked, type LeaseDependencies } from "./lease.ts";
import { inventoryStation, type BuildReference, type InventoryDependencies, type StationInventory } from "./station-inventory.ts";
import { withFileLockAsync } from "./file-lock.ts";
import { isRecord } from "./type-guard.ts";
import { SHARED_FORMATS, type ArtifactSupport } from "./contracts.ts";
import { restoreArtifact } from "./select.ts";

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
/** Live-reader checks never execute the reader: a broken current must not disable rollback. */
function readerSupport(home: string, tuple: ArtifactTuple): ArtifactSupport {
  const declared = readJsonFile(join(stationRoot(home), tuple.version, "identity.json"));
  const record = tupleFromJson(readJsonFile(join(stationRoot(home), tuple.version, "artifact.json")));
  if (!sameArtifact(tuple, record) || !isRecord(declared) || declared.version !== tuple.version || declared.commit !== tuple.commit) throw new Error(`Live reader identity mismatch: ${artifactToken(tuple)}`);
  assertIdentityContracts(declared, !tuple.version.startsWith("r"));
  return formatSupport(declared.support);
}
function liveReferences(home: string, inventory: StationInventory, dependencies: StationDependencies): { references: BuildReference[]; dead: string[] } {
  const leases = readLeasesLocked(home, dependencies);
  return { references: [...inventory.references, ...leases.live.map(lease => ({ artifact: lease.artifact,
    holder: `${lease.kind} lease holder pid=${lease.pid} generation=${lease.generation} ${lease.holder}${lease.kind === "plugin" ? "; restart OMP" : ""}` }))], dead: leases.dead };
}
export async function initializeStation(home: string, current: ArtifactTuple, dependencies: StationDependencies = {}): Promise<StationState> {
  return stationTransaction(home, async () => {
    current = tupleFromJson(current);
    if (existsSync(join(stationRoot(home), "state.json"))) throw new Error("Station already initialized; state is never reseeded");
    const cached = await (dependencies.inspect ?? inspectArtifact)(home, current);
    assertLauncher(cached.identity);
    const inventory = await (dependencies.inventory ? dependencies.inventory(home) : inventoryStation(home, dependencies, false));
    const support = formatSupport(cached.identity.support);
    const formats = Object.fromEntries(SHARED_FORMATS.map(name => [name, [...new Set([...(inventory.formats[name] ?? []), support[name].write])].sort((a, b) => a - b)])) as PersistedFormats;
    assertReadCoverage(support, formats);
    const state: StationState = { schema: 1, generation: 0, current, previous: current, rejected: [], formats };
    commitStateLocked(home, state, dependencies.fault);
    return state;
  }, dependencies);
}
export async function promote(home: string, dependencies: StationDependencies = {}): Promise<PromotionReport> {
  return stationTransaction(home, async () => {
    const state = readStateLocked(home);
    const inventory = await (dependencies.inventory ? dependencies.inventory(home) : inventoryStation(home, dependencies));
    const { references } = liveReferences(home, inventory, dependencies);
    // Post-promotion previous is old current, not the displaced previous.
    references.push({ artifact: state.current, holder: "post-promotion previous" });
    const readers = references.map(reference => ({ ...reference, support: readerSupport(home, reference.artifact) }));
    const formats = mergeInventory(state, inventory);
    let floor = releaseOrdinal(state.current.version);
    for (const rejected of state.rejected) if (releaseOrdinal(rejected) > floor) floor = releaseOrdinal(rejected);
    const releases = await (dependencies.releases ?? publishedReleases)();
    const candidates = releases.filter(release => releaseOrdinal(release.version) > floor && !state.rejected.includes(release.version)).sort((a, b) => releaseOrdinal(a.version) > releaseOrdinal(b.version) ? -1 : releaseOrdinal(a.version) < releaseOrdinal(b.version) ? 1 : 0);
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
        const support = formatSupport(cached.identity.support);
        assertReadCoverage(support, formats);
        for (const reader of readers) {
          try { assertReadCoverage(reader.support, {}, support); }
          catch (error) { throw new Error(`Blocking reader ${reader.holder} build=${reader.artifact.version}: ${error instanceof Error ? error.message : String(error)}`); }
        }
      } catch (error) {
        skipped.push({ version: candidate.version, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }
      // No exception after this point may be mistaken for a skipped candidate.
      const next: StationState = { ...state, current: { version: release.version, commit: release.commit, digest: release.digest }, previous: state.current,
        generation: state.generation + 1, formats: activatedFormats(formats, formatSupport(cached.identity.support)) };
      commitStateLocked(home, next, dependencies.fault);
      return { current: next.current, promoted: true, skipped };
    }
    return { current: state.current, promoted: false, skipped };
  }, dependencies);
}
/** Stable-launcher-owned operation: never imports or executes the current payload. */
export async function rollback(home: string, dependencies: StationDependencies = {}): Promise<StationState> {
  return stationTransaction(home, async () => {
    const state = readStateLocked(home);
    const target = state.previous;
    const cached = await (dependencies.inspect ?? restoreArtifact)(home, target);
    assertLauncher(cached.identity);
    const inventory = await (dependencies.inventory ? dependencies.inventory(home) : inventoryStation(home, dependencies, false));
    const formats = mergeInventory(state, inventory);
    assertReadCoverage(formatSupport(cached.identity.support), formats);
    if (sameArtifact(state.current, target)) return state;
    const next: StationState = { ...state, current: target, previous: target, rejected: [...new Set([...state.rejected, state.current.version])], generation: state.generation + 1, formats };
    commitStateLocked(home, next, dependencies.fault);
    return next;
  }, dependencies);
}
export interface GcReport { removed: string[]; retained: Array<{ version: string; holders: string[] }> }
export async function gc(home: string, dependencies: StationDependencies = {}): Promise<GcReport> {
  return stationTransaction(home, async () => {
    const state = readStateLocked(home);
    const inventory = await (dependencies.inventory ? dependencies.inventory(home) : inventoryStation(home, dependencies));
    const { references, dead } = liveReferences(home, inventory, dependencies);
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
    // All reads and probes finish before the first deletion. Admissions take the
    // same state lock before their per-artifact lock, closing reference races.
    const removed: string[] = [];
    for (const entry of entries) if (!keep.has(entry.version)) {
      await (dependencies.withFileLock ?? withFileLockAsync)(artifactLock(home, { version: entry.version, commit: "0".repeat(40), digest: "0".repeat(64) }), async () => { rmSync(entry.path, { recursive: true }); });
      removed.push(entry.version);
    }
    for (const path of [...dead, ...inventory.expiredBindings]) rmSync(path);
    return { removed, retained: [...keep].map(([version, holders]) => ({ version, holders })) };
  }, dependencies);
}
