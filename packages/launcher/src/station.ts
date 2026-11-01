import { existsSync, lstatSync, readdirSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { inspectArtifact, ensureArtifact, assertCachedArtifactPresent, artifactLock, type CachedArtifact } from "./artifact-cache.ts";
import { assertIdentityContracts, assertReadCoverage, formatSupport } from "./artifact-support.ts";
import { artifactToken, github, releaseRepository, resolveRelease, sameArtifact, type ArtifactTuple, type ResolvedRelease } from "./release.ts";
import { activatedFormats, assertLauncher, commitStateLocked, readJsonFile, readStateLocked, stationRoot, stationTransaction, tupleFromJson, readStationState, type PersistedFormats, type StateDependencies, type StationState } from "./station-state.ts";
import { readLeases, recheckLeases, type BuildLease, type LeaseDependencies } from "./lease.ts";
import { inventoryStation, captureInventoryInputs, recheckInventory, type BuildReference, type InventoryDependencies, type StationInventory } from "./station-inventory.ts";
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
function mergeInventory(formats: PersistedFormats, inventory: StationInventory): PersistedFormats {
  return Object.fromEntries(SHARED_FORMATS.map(name => [name, [...new Set([...formats[name], ...(inventory.formats[name] ?? [])])].sort((a, b) => a - b)])) as PersistedFormats;
}
/** Live-reader checks never execute the reader: a broken current must not disable rollback. */
function readerSupport(home: string, tuple: ArtifactTuple): ArtifactSupport {
  const declared = readJsonFile(join(stationRoot(home), tuple.version, "identity.json"));
  const record = tupleFromJson(readJsonFile(join(stationRoot(home), tuple.version, "artifact.json")));
  if (!sameArtifact(tuple, record) || !isRecord(declared) || declared.version !== tuple.version || declared.commit !== tuple.commit) throw new Error(`Live reader identity mismatch: ${artifactToken(tuple)}`);
  assertIdentityContracts(declared, !tuple.version.startsWith("r"));
  return formatSupport(declared.support);
}
function liveReferences(inventory: StationInventory, leases: BuildLease[]): BuildReference[] {
  return [...inventory.references, ...leases.map(lease => ({ artifact: lease.artifact,
    holder: `${lease.kind} lease holder pid=${lease.pid} generation=${lease.generation} ${lease.holder}${lease.kind === "plugin" ? "; restart OMP" : ""}` }))];
}
function assertReaders(home: string, support: ArtifactSupport, formats: PersistedFormats, references: BuildReference[]): void {
  assertReadCoverage(support, formats);
  const checked = new Set<string>();
  for (const reference of references) {
    const token = artifactToken(reference.artifact);
    if (checked.has(token)) continue;
    checked.add(token);
    try { assertReadCoverage(readerSupport(home, reference.artifact), {}, support); }
    catch (error) { throw new Error(`Blocking reader ${reference.holder} build=${reference.artifact.version}: ${error instanceof Error ? error.message : String(error)}`); }
  }
}
function changedDecision(operation: string, error: unknown): Error {
  return Object.assign(new Error(`Station inventory inputs changed during ${operation} preparation; retry: ${error instanceof Error ? error.message : String(error)}`), { code: "ESTALE", cause: error });
}
function snapshotStation(home: string, dependencies: StationDependencies): Promise<StationState> {
  return stationTransaction(home, async () => readStateLocked(home, dependencies), dependencies);
}
function recheckStation(home: string, snapshot: StationState, operation: string, dependencies: StationDependencies): StationState {
  const state = readStateLocked(home, dependencies);
  if (!isDeepStrictEqual(state, snapshot)) throw new Error(`Station changed during ${operation} preparation; retry`);
  return state;
}
export async function initializeStation(home: string, current: ArtifactTuple, dependencies: StationDependencies = {}): Promise<StationState> {
  current = tupleFromJson(current);
  const cached = await (dependencies.inspect ?? inspectArtifact)(home, current);
  if (!sameArtifact(cached.record, current)) throw new Error("Initialization verification returned a different tuple");
  assertLauncher(cached.identity);
  await stationTransaction(home, async () => {
    if (existsSync(join(stationRoot(home), "state.json"))) throw new Error("Station already initialized; state is never reseeded");
  }, dependencies);
  const inputs = await captureInventoryInputs(home, dependencies);
  const inventory = await (dependencies.inventory ? dependencies.inventory(home) : inventoryStation(home, dependencies, false, false, { receiptCache: inputs.receiptCache }));
  const support = formatSupport(cached.identity.support);
  const preparedFormats = Object.fromEntries(SHARED_FORMATS.map(name => [name, [...new Set([...(inventory.formats[name] ?? []), support[name].write])].sort((a, b) => a - b)])) as PersistedFormats;
  assertReadCoverage(support, preparedFormats);
  const leases = readLeases(home, dependencies);
  return stationTransaction(home, async () => {
    if (existsSync(join(stationRoot(home), "state.json"))) throw new Error("Station already initialized; state is never reseeded");
    const decision = await recheckInventory(home, inputs, inventory, "initialization", dependencies, { includeRuns: false });
    const formats = mergeInventory(preparedFormats, decision);
    try { assertReaders(home, support, formats, liveReferences(decision, recheckLeases(home, leases).live)); }
    catch (error) { throw changedDecision("initialization", error); }
    assertCachedArtifactPresent(home, cached);
    decision.checkDeadline();
    const state: StationState = { schema: 1, generation: 0, current, previous: current, rejected: [], formats };
    commitStateLocked(home, state, dependencies);
    return state;
  }, dependencies);
}
export async function promote(home: string, dependencies: StationDependencies = {}): Promise<PromotionReport> {
  const snapshot = await snapshotStation(home, dependencies);
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
    // Preparation may overlap ordinary observer activity. Only the final
    // decision, re-derived from current readers and schemas, authorizes commit.
    const inputs = await captureInventoryInputs(home, dependencies);
    const inventory = await (dependencies.inventory ? dependencies.inventory(home) : inventoryStation(home, dependencies, true, false, { receiptCache: inputs.receiptCache }));
    const leases = readLeases(home, dependencies), formats = mergeInventory(snapshot.formats, inventory);
    const support = formatSupport(cached.identity.support);
    try {
      assertReaders(home, support, formats, [...liveReferences(inventory, leases.live), { artifact: snapshot.current, holder: "post-promotion previous" }]);
    } catch (error) {
      skipped.push({ version: candidate.version, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const result = await stationTransaction(home, async () => {
      const state = recheckStation(home, snapshot, "promotion", dependencies);
      const decision = await recheckInventory(home, inputs, inventory, "promotion", dependencies);
      const currentFormats = mergeInventory(formats, decision);
      try { assertReaders(home, support, currentFormats, [...liveReferences(decision, recheckLeases(home, leases).live), { artifact: state.current, holder: "post-promotion previous" }]); }
      catch (error) { throw changedDecision("promotion", error); }
      try { assertCachedArtifactPresent(home, cached); }
      catch (error) { return error instanceof Error ? error.message : String(error); }
      decision.checkDeadline();
      // Commit errors must not be mistaken for a skipped candidate.
      const next: StationState = { ...state, current: { version: release.version, commit: release.commit, digest: release.digest }, previous: state.current,
        generation: state.generation + 1, formats: activatedFormats(currentFormats, support) };
      commitStateLocked(home, next, dependencies);
      return { current: next.current, promoted: true, skipped };
    }, dependencies);
    if (typeof result !== "string") return result;
    skipped.push({ version: candidate.version, reason: result });
  }
  return { current: (await readStationState(home)).current, promoted: false, skipped };
}
/** Stable-launcher-owned operation: never imports or executes the current payload. */
export async function rollback(home: string, dependencies: StationDependencies = {}): Promise<StationState> {
  const snapshot = await snapshotStation(home, dependencies);
  const target = snapshot.previous;
  const cached = await (dependencies.inspect ?? restoreArtifact)(home, target);
  assertLauncher(cached.identity);
  const inputs = await captureInventoryInputs(home, dependencies);
  const inventory = await (dependencies.inventory ? dependencies.inventory(home) : inventoryStation(home, dependencies, false, false, { receiptCache: inputs.receiptCache }));
  const formats = mergeInventory(snapshot.formats, inventory), support = formatSupport(cached.identity.support);
  const leases = readLeases(home, dependencies);
  assertReaders(home, support, formats, liveReferences(inventory, leases.live));
  return stationTransaction(home, async () => {
    const state = recheckStation(home, snapshot, "rollback", dependencies);
    const decision = await recheckInventory(home, inputs, inventory, "rollback", dependencies, { includeRuns: false });
    const currentFormats = mergeInventory(formats, decision);
    try { assertReaders(home, support, currentFormats, liveReferences(decision, recheckLeases(home, leases).live)); }
    catch (error) { throw changedDecision("rollback", error); }
    if (!sameArtifact(cached.record, target)) throw new Error("Rollback verification returned a different tuple");
    assertCachedArtifactPresent(home, cached);
    if (sameArtifact(state.current, target)) return state;
    decision.checkDeadline();
    const next: StationState = { ...state, current: target, previous: target, rejected: [...new Set([...state.rejected, state.current.version])], generation: state.generation + 1, formats: currentFormats };
    commitStateLocked(home, next, dependencies);
    return next;
  }, dependencies);
}
export interface GcReport { removed: string[]; retained: Array<{ version: string; holders: string[] }> }
export async function gc(home: string, dependencies: StationDependencies = {}): Promise<GcReport> {
  const state = await snapshotStation(home, dependencies);
  const inputs = await captureInventoryInputs(home, dependencies);
  const inventory = await (dependencies.inventory ? dependencies.inventory(home) : inventoryStation(home, dependencies, true, true, { receiptCache: inputs.receiptCache }));
  const leases = readLeases(home, dependencies), references = liveReferences(inventory, leases.live);
  const keep = new Map<string, string[]>(), identities = new Map<string, string>();
  const retain = (tuple: ArtifactTuple, holder: string) => {
    const token = artifactToken(tupleFromJson(tuple)), prior = identities.get(tuple.version);
    if (prior && prior !== token) throw new Error(`Conflicting retained build ${tuple.version}`);
    identities.set(tuple.version, token);
    const holders = keep.get(tuple.version) ?? []; holders.push(holder); keep.set(tuple.version, holders);
  };
  retain(state.current, "current"); retain(state.previous, "previous");
  for (const reference of references) retain(reference.artifact, reference.holder);
  const entries: Array<{ version: string; path: string; record: unknown }> = [];
  for (const version of readdirSync(stationRoot(home))) {
    const path = join(stationRoot(home), version);
    // A crash after detaching an unreferenced build may leave only its trash
    // name. It can never be selected or leased and needs no station lock.
    if (/^\.gc-(?:r(?:0|[1-9]\d*)|\d+\.\d+\.\d+)-[a-f0-9-]{36}$/.test(version)) {
      if (!lstatSync(path).isDirectory()) throw new Error(`GC trash must be a real directory: ${version}`);
      rmSync(path, { recursive: true }); continue;
    }
    if (!/^(?:r(?:0|[1-9]\d*)|\d+\.\d+\.\d+)$/.test(version)) continue;
    if (!lstatSync(path).isDirectory()) throw new Error(`Cache build must be a real directory: ${version}`);
    const record = readJsonFile(join(path, "artifact.json")), tuple = tupleFromJson(record);
    if (tuple.version !== version) throw new Error(`Cache build identity mismatch: ${version}`);
    if (identities.has(version) && identities.get(version) !== artifactToken(tuple)) throw new Error(`Retained cache identity mismatch: ${version}`);
    entries.push({ version, path, record });
  }
  entries.sort((a, b) => releaseOrdinal(a.version) > releaseOrdinal(b.version) ? -1 : releaseOrdinal(a.version) < releaseOrdinal(b.version) ? 1 : a.version.localeCompare(b.version));
  for (const entry of entries.slice(0, 10)) {
    const holders = keep.get(entry.version) ?? []; holders.push("keep-10 highest IDs"); keep.set(entry.version, holders);
  }
  const removed: string[] = [];
  for (const entry of entries) if (!keep.has(entry.version)) {
    const trash = join(stationRoot(home), `.gc-${entry.version}-${randomUUID()}`);
    let detached = false;
    try {
      // Lock order matches preparation: artifact first, then a short state
      // decision. Recursive deletion happens only after releasing .state.lock.
      await (dependencies.withFileLock ?? withFileLockAsync)(artifactLock(home, tupleFromJson(entry.record)), async () => {
        detached = await stationTransaction(home, async () => {
          recheckStation(home, state, "GC", dependencies);
          const decision = await recheckInventory(home, inputs, inventory, "GC", dependencies, { conservativeGc: true });
          for (const reference of liveReferences(decision, recheckLeases(home, leases).live)) retain(reference.artifact, reference.holder);
          if (keep.has(entry.version)) return false;
          if (!lstatSync(entry.path).isDirectory() || !isDeepStrictEqual(readJsonFile(join(entry.path, "artifact.json")), entry.record)) throw new Error(`Cache build changed during GC preparation: ${entry.version}`);
          decision.checkDeadline();
          renameSync(entry.path, trash);
          return true;
        }, dependencies);
        if (detached) rmSync(trash, { recursive: true });
      }, { timeoutMs: 0 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ETIMEDOUT") throw error;
      keep.set(entry.version, [`artifact lock busy: ${error instanceof Error ? error.message : String(error)}`]);
      continue;
    }
    if (detached) removed.push(entry.version);
  }
  await stationTransaction(home, async () => {
    recheckStation(home, state, "GC", dependencies);
    const decision = await recheckInventory(home, inputs, inventory, "GC", dependencies, { conservativeGc: true });
    const { dead } = recheckLeases(home, leases);
    decision.checkDeadline();
    for (const lease of dead) rmSync(join(stationRoot(home), "leases", `${lease.id}.json`), { force: true });
    for (const path of decision.expiredBindings) rmSync(path, { force: true });
  }, dependencies);
  return { removed, retained: [...keep].map(([version, holders]) => ({ version, holders })) };
}
