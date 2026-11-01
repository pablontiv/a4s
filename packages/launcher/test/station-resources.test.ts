import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test, { type TestContext } from "node:test";
import type { CachedArtifact } from "../src/artifact-cache.ts";
import { ARTIFACT_PROTOCOLS, DISPATCH_PROTOCOL, registrationHash, type ArtifactIdentity, type ArtifactSupport } from "../src/contracts.ts";
import type { ResolvedRelease } from "../src/release.ts";
import { initializeStation, promote, rollback, type StationDependencies } from "../src/station.ts";
import { readStateLocked, readStationState, stationRoot, stationTransaction, type StationState } from "../src/station-state.ts";

const shippedSkills = ["issue-execution", "repository-discovery", "backlog-breakdown", "refine", "sprint-planning", "sprint-review", "sprint-retrospective"];
const skillText = (version: string, name: string) => `---\nname: ${name}\ndescription: Resource discovery fixture\n---\n${version} ${name}\n`;

/** Real resource trees with injected acquisition, not a compiled artifact whose layout is fixed. */
function resourceFixture(t: TestContext): ResourceFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a4s-resources-")));
  const home = join(root, "dagu station"), userHome = join(root, "user home"), cache = stationRoot(home);
  const skills = join(userHome, ".agents", "skills"), loader = join(cache, "loader"), current = join(cache, "current");
  const artifacts = new Map<string, CachedArtifact>(), conflicts: string[] = [];
  let locked = false;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(userHome);
  const inspect: NonNullable<StationDependencies["inspect"]> = async (actualHome, tuple) => {
    assert.equal(actualHome, home);
    const cached = artifacts.get(tuple.version);
    assert.ok(cached, `Missing fixture artifact ${tuple.version}`);
    return cached;
  };
  const dependencies: StationDependencies = {
    env: { HOME: userHome, DAGU_HOME: home },
    async withFileLock(path, body) {
      assert.equal(path, join(cache, ".state.lock"));
      assert.equal(locked, false);
      locked = true;
      try { return await body(); } finally { locked = false; }
    },
    inspect,
    ensure: inspect,
    inventory: async () => ({ formats: {}, references: [], expiredBindings: [] }),
    releases: async () => [],
    reportResourceConflict(message) {
      assert.ok(locked, "resource conflict callbacks run while the station state lock is held");
      const state = JSON.parse(readFileSync(join(cache, "state.json"), "utf8")) as StationState;
      assert.equal(readlinkSync(current), state.current.version, "durable state and current are updated before resource reconciliation");
      conflicts.push(message);
    },
  };
  function release(version: string, names: readonly string[]): ResolvedRelease {
    const id = Number(version.slice(1)).toString(16);
    const tuple: ResolvedRelease = { version, commit: id.padStart(40, "0"), digest: id.padStart(64, "0"), repository: "pablontiv/a4s", archive: `a4s-${version}.tar.gz` };
    const directory = join(cache, version);
    const format = { read: [1], write: 1 };
    const support: ArtifactSupport = { receipt: format, roleJobStore: format, roleJobPayload: format, config: format, runState: format, prCheckpoint: format };
    const manifest = { schema: 1, loaderHelperApi: 1, extensions: [], commands: [], tools: [] };
    const identity: ArtifactIdentity = { version, commit: tuple.commit, support, requiredLauncherProtocol: 1, requiredLoaderProtocol: 1,
      dispatch: DISPATCH_PROTOCOL, protocols: ARTIFACT_PROTOCOLS, registrationManifest: manifest, registrationManifestHash: registrationHash(manifest) };
    mkdirSync(join(directory, "agents"), { recursive: true });
    writeFileSync(join(directory, "agents", "plan-reviewer.md"), `${version} plan reviewer\n`);
    mkdirSync(join(directory, "skills"));
    for (const name of names) {
      mkdirSync(join(directory, "skills", name));
      writeFileSync(join(directory, "skills", name, "SKILL.md"), skillText(version, name));
    }
    const record = { version, commit: tuple.commit, digest: tuple.digest, verifiedAt: "2026-10-29T00:00:00Z" };
    writeFileSync(join(directory, "identity.json"), JSON.stringify(identity));
    writeFileSync(join(directory, "artifact.json"), JSON.stringify(record));
    artifacts.set(version, { directory, executable: join(directory, "a4s"), executableDigest: "f".repeat(64), identity, record });
    return tuple;
  }
  return { root, home, userHome, cache, skills, loader, current, dependencies, conflicts, release };
}

interface ResourceFixture {
  root: string; home: string; userHome: string; cache: string; skills: string; loader: string; current: string;
  dependencies: StationDependencies;
  conflicts: string[];
  release(version: string, names: readonly string[]): ResolvedRelease;
}
function assertMissing(path: string): void { assert.throws(() => lstatSync(path), { code: "ENOENT" }); }
function assertPublished(f: ResourceFixture, version: string, names: readonly string[]): void {
  for (const name of names) {
    const link = join(f.skills, name);
    assert.equal(readlinkSync(link), join(f.current, "skills", name));
    assert.equal(realpathSync(link), join(f.cache, version, "skills", name));
    assert.equal(readFileSync(join(link, "SKILL.md"), "utf8"), skillText(version, name));
  }
  assert.equal(readlinkSync(join(f.loader, "agents")), "../current/agents");
  assert.equal(realpathSync(join(f.loader, "agents")), join(f.cache, version, "agents"));
  assert.equal(readFileSync(join(f.loader, "agents", "plan-reviewer.md"), "utf8"), `${version} plan reviewer\n`);
  assertMissing(join(f.loader, "skills"));
}

test("initialization exposes every conventional release skill in HOME, not DAGU_HOME or loader metadata", async t => {
  const f = resourceFixture(t), current = f.release("r1", shippedSkills);
  mkdirSync(join(f.cache, current.version, "skills", "not-a-skill"));
  writeFileSync(join(f.cache, current.version, "skills", "README.txt"), "not a skill directory\n");
  mkdirSync(join(f.cache, current.version, "skills", "not-a-skill", "nested"));
  writeFileSync(join(f.cache, current.version, "skills", "not-a-skill", "nested", "SKILL.md"), "not an immediate skill\n");
  const initialized = await initializeStation(f.home, current, f.dependencies);
  assert.equal(initialized.current.version, "r1");
  assert.deepEqual(readdirSync(f.skills).sort(), [...shippedSkills].sort());
  assertPublished(f, "r1", shippedSkills);
  assertMissing(join(f.home, ".agents"));
  assertMissing(join(f.userHome, ".dagu"));
  assertMissing(join(f.userHome, ".omp"));
  assert.deepEqual(f.conflicts, []);
});

test("independent HOME and DAGU_HOME pairs never publish into another station", async t => {
  const first = resourceFixture(t), second = resourceFixture(t);
  const old = first.release("r1", ["workflow"]), next = first.release("r2", ["workflow", "future-workflow"]);
  const other = second.release("r10", ["workflow"]);
  await initializeStation(first.home, old, first.dependencies);
  await initializeStation(second.home, other, second.dependencies);
  await promote(first.home, { ...first.dependencies, releases: async () => [next] });
  assertPublished(first, "r2", ["workflow", "future-workflow"]);
  assertPublished(second, "r10", ["workflow"]);
  assertMissing(join(second.skills, "future-workflow"));
  assert.equal(readlinkSync(second.current), "r10");
});

test("activation and rollback retain literal current links, prune only owned dropped skills and preserve humanizer", async t => {
  const f = resourceFixture(t), old = f.release("r1", ["shared", "dropped"]), next = f.release("r2", ["shared", "added"]);
  const humanizer = join(f.skills, "humanizer");
  mkdirSync(humanizer, { recursive: true });
  writeFileSync(join(humanizer, "SKILL.md"), "user-owned humanizer\n");
  const foreign = join(f.root, "user-skills"); mkdirSync(foreign);
  const preserved: Record<string, string> = {
    "foreign-live": foreign,
    "foreign-dangling": join(f.root, "missing"),
    "revision-pinned": join(f.cache, "r1", "skills", "dropped"),
    "not-owned-prefix": `${join(f.current, "skills")}-other/skill`,
    "escaped-target": `${join(f.current, "skills")}/../outside/skill`,
  };
  for (const [name, target] of Object.entries(preserved)) symlinkSync(target, join(f.skills, name));
  writeFileSync(join(f.skills, "user-file"), "user file\n");
  await initializeStation(f.home, old, f.dependencies);
  assertPublished(f, "r1", ["shared", "dropped"]);
  const sharedTarget = readlinkSync(join(f.skills, "shared")), agentsTarget = readlinkSync(join(f.loader, "agents"));
  symlinkSync(`${relative(f.skills, join(f.current, "skills"))}/../skills/obsolete`, join(f.skills, "stale-owned"));
  assert.equal((await promote(f.home, { ...f.dependencies, releases: async () => [next] })).promoted, true);
  assertPublished(f, "r2", ["shared", "added"]);
  assertMissing(join(f.skills, "dropped"));
  assertMissing(join(f.skills, "stale-owned"));
  assert.equal(readlinkSync(join(f.skills, "shared")), sharedTarget);
  assert.equal(readlinkSync(join(f.loader, "agents")), agentsTarget);
  assert.equal((await rollback(f.home, f.dependencies)).current.version, "r1");
  assertPublished(f, "r1", ["shared", "dropped"]);
  assertMissing(join(f.skills, "added"));
  assert.equal(readlinkSync(join(f.skills, "shared")), sharedTarget);
  assert.equal(readlinkSync(join(f.loader, "agents")), agentsTarget);
  assert.equal(readFileSync(join(humanizer, "SKILL.md"), "utf8"), "user-owned humanizer\n");
  assert.equal(readFileSync(join(f.skills, "user-file"), "utf8"), "user file\n");
  for (const [name, target] of Object.entries(preserved)) assert.equal(readlinkSync(join(f.skills, name)), target);
  assert.deepEqual(f.conflicts, []);
});

const conflictKinds = ["directory", "file", "foreign symlink", "dangling symlink"] as const;
function userConflict(f: ResourceFixture, path: string, kind: typeof conflictKinds[number], foreignTarget = join(f.root, "foreign-resource")): () => void {
  if (kind === "directory") {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "SKILL.md"), "user-owned directory\n");
    return () => {
      assert.equal(lstatSync(path).isDirectory(), true);
      assert.equal(readFileSync(join(path, "SKILL.md"), "utf8"), "user-owned directory\n");
    };
  }
  mkdirSync(dirname(path), { recursive: true });
  if (kind === "file") {
    writeFileSync(path, "user-owned file\n");
    return () => {
      assert.equal(lstatSync(path).isFile(), true);
      assert.equal(readFileSync(path, "utf8"), "user-owned file\n");
    };
  }
  const target = kind === "foreign symlink" ? foreignTarget : join(f.root, "missing-resource");
  if (kind === "foreign symlink") mkdirSync(target, { recursive: true });
  symlinkSync(target, path);
  return () => assert.equal(readlinkSync(path), target);
}

for (const kind of conflictKinds) {
  test(`same-name user ${kind} is reported under lock without blocking init, promotion or rollback`, async t => {
    const f = resourceFixture(t), old = f.release("r1", ["reserved", "shared"]), next = f.release("r2", ["reserved", "shared", "added"]);
    const path = join(f.skills, "reserved"), assertPreserved = userConflict(f, path, kind, join(f.cache, "r1", "skills", "reserved"));
    await initializeStation(f.home, old, f.dependencies);
    assertPreserved();
    assertPublished(f, "r1", ["shared"]);
    assert.ok(f.conflicts.some(message => message.includes(path)), "init reports the exact conflicting path");
    f.conflicts.length = 0;
    assert.equal((await promote(f.home, { ...f.dependencies, releases: async () => [next] })).promoted, true);
    assertPreserved();
    assertPublished(f, "r2", ["shared", "added"]);
    assert.ok(f.conflicts.some(message => message.includes(path)), "promotion reports the exact conflicting path");
    f.conflicts.length = 0;
    assert.equal((await rollback(f.home, f.dependencies)).current.version, "r1");
    assertPreserved();
    assertPublished(f, "r1", ["shared"]);
    assert.ok(f.conflicts.some(message => message.includes(path)), "rollback reports the exact conflicting path");
  });

  test(`nonowned loader agents ${kind} is reported and never replaced`, async t => {
    const f = resourceFixture(t), old = f.release("r1", ["shared"]), next = f.release("r2", ["shared"]);
    const path = join(f.loader, "agents"), assertPreserved = userConflict(f, path, kind, join(f.cache, "r1", "agents"));
    await initializeStation(f.home, old, f.dependencies);
    assertPreserved();
    assert.ok(f.conflicts.some(message => message.includes(path)));
    f.conflicts.length = 0;
    assert.equal((await promote(f.home, { ...f.dependencies, releases: async () => [next] })).promoted, true);
    assertPreserved();
    assert.ok(f.conflicts.some(message => message.includes(path)));
    f.conflicts.length = 0;
    assert.equal((await rollback(f.home, f.dependencies)).current.version, "r1");
    assertPreserved();
    assert.ok(f.conflicts.some(message => message.includes(path)));
    assert.equal(readFileSync(join(f.skills, "shared", "SKILL.md"), "utf8"), skillText("r1", "shared"));
    assertMissing(join(f.loader, "skills"));
  });
}

test("resource conflicts default to stderr diagnostics without failing initialization", async t => {
  const f = resourceFixture(t), current = f.release("r1", ["reserved"]);
  const path = join(f.skills, "reserved"), assertPreserved = userConflict(f, path, "directory");
  const messages: string[] = [];
  t.mock.method(console, "error", (...values: unknown[]) => { messages.push(values.map(String).join(" ")); });
  const { reportResourceConflict: _, ...dependencies } = f.dependencies;
  assert.equal((await initializeStation(f.home, current, dependencies)).current.version, "r1");
  assertPreserved();
  assert.ok(messages.some(message => message.includes(path)));
});

test("locked resource repair reconciles an already-correct current pointer, then fixes a wrong pointer", async t => {
  const f = resourceFixture(t), current = f.release("r1", ["first", "second"]);
  await initializeStation(f.home, current, f.dependencies);
  const stateBytes = readFileSync(join(f.cache, "state.json"), "utf8");
  rmSync(join(f.skills, "first"));
  rmSync(join(f.skills, "second"));
  symlinkSync(join(f.current, "skills", "wrong-skill"), join(f.skills, "second"));
  symlinkSync(join(f.current, "skills", "removed"), join(f.skills, "stale-owned"));
  rmSync(join(f.loader, "agents"));
  symlinkSync("../current/./agents", join(f.loader, "agents"));
  assert.equal(readlinkSync(f.current), "r1");
  assert.equal((await stationTransaction(f.home, async () => readStateLocked(f.home, f.dependencies), f.dependencies)).current.version, "r1");
  assertPublished(f, "r1", ["first", "second"]);
  assertMissing(join(f.skills, "stale-owned"));
  rmSync(f.current);
  symlinkSync("r999", f.current);
  rmSync(join(f.skills, "first"));
  rmSync(join(f.loader, "agents"));
  assert.equal((await stationTransaction(f.home, async () => readStateLocked(f.home, f.dependencies), f.dependencies)).current.version, "r1");
  assert.equal(readlinkSync(f.current), "r1");
  assertPublished(f, "r1", ["first", "second"]);
  assert.equal(readFileSync(join(f.cache, "state.json"), "utf8"), stateBytes, "resource repair never rewrites station selection");
  assert.deepEqual(f.conflicts, []);
});

for (const missing of ["skills", "active cache"] as const) {
  test(`missing ${missing} does not prune existing links, block envelope reads or disable rollback`, async t => {
    const f = resourceFixture(t), old = f.release("r1", ["shared", "old-only"]), next = f.release("r2", ["shared", "new-only"]);
    await initializeStation(f.home, old, f.dependencies);
    await promote(f.home, { ...f.dependencies, releases: async () => [next] });
    const before = readdirSync(f.skills).map(name => ({ name, target: readlinkSync(join(f.skills, name)) }));
    rmSync(missing === "skills" ? join(f.cache, "r2", "skills") : join(f.cache, "r2"), { recursive: true });
    symlinkSync(join(f.current, "skills", "not-yet-restored"), join(f.skills, "retain-until-restored"));
    rmSync(join(f.loader, "agents"));
    assert.equal((await readStationState(f.home)).current.version, "r2");
    await stationTransaction(f.home, async () => readStateLocked(f.home, f.dependencies), f.dependencies);
    for (const { name, target } of before) assert.equal(readlinkSync(join(f.skills, name)), target);
    assert.equal(readlinkSync(join(f.skills, "retain-until-restored")), join(f.current, "skills", "not-yet-restored"));
    assert.equal(readlinkSync(join(f.loader, "agents")), "../current/agents");
    assertMissing(join(f.loader, "skills"));
    assert.equal((await rollback(f.home, f.dependencies)).current.version, "r1");
    assertPublished(f, "r1", ["shared", "old-only"]);
    assertMissing(join(f.skills, "new-only"));
    assertMissing(join(f.skills, "retain-until-restored"));
  });
}
