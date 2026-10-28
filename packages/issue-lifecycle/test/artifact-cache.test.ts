import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cachePath, ensureArtifact, inspectArtifact } from "../src/artifact-cache.ts";
import { artifactDependencies, artifactEntries, makeInProcessArchive, writeInProcessArchive } from "./fixtures/compiled-artifact.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "a4s-cache-unit-"));
  const home = join(root, "dagu-home"), releases = join(root, "releases");
  mkdirSync(home);
  const release = makeInProcessArchive(releases);
  const calls: string[][] = [];
  const dependencies = artifactDependencies(releases, calls);
  return { root, home, releases, release, calls, dependencies, dispose() { rmSync(root, { recursive: true, force: true }); } };
}
test("cache publication serializes races, reuses only a matching winner, and rejects conflicts", async () => {
  const f = fixture();
  try {
    const [first, matching] = await Promise.all([ensureArtifact(f.home, f.release, f.dependencies), ensureArtifact(f.home, f.release, f.dependencies)]);
    assert.equal(first.directory, matching.directory);
    assert.equal(first.record.verifiedAt, matching.record.verifiedAt);
    const record = readFileSync(join(first.directory, "artifact.json"), "utf8");
    assert.deepEqual(Object.keys(JSON.parse(record)).sort(), ["commit", "digest", "verifiedAt", "version"]);
    assert.equal(existsSync(join(first.directory, "verified-archive.tar.gz")), true);
    const conflict = { ...f.release, commit: "b".repeat(40), digest: "c".repeat(64) };
    const race = await Promise.allSettled([ensureArtifact(f.home, f.release, f.dependencies), ensureArtifact(f.home, conflict, f.dependencies)]);
    assert.equal(race[0]!.status, "fulfilled");
    assert.equal(race[1]!.status, "rejected");
    assert.match(String((race[1] as PromiseRejectedResult).reason), /Conflicting artifact cache entry/);
    assert.equal(readFileSync(join(first.directory, "artifact.json"), "utf8"), record);
    assert.equal(f.calls.filter(args => args.includes(f.release.archive)).length, 1);
  } finally { f.dispose(); }
});
test("archive corruption fails before publication without trusting a downloaded checksum twice", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.releases, f.release.archive), "corrupt archive");
    await assert.rejects(ensureArtifact(f.home, f.release, f.dependencies), /SHA-256 mismatch/);
    assert.equal(existsSync(cachePath(f.home, f.release)), false);
  } finally { f.dispose(); }
});
test("existing entries fail closed on metadata, missing content, or modified payload and never reseal", async () => {
  for (const mutation of ["metadata", "missing", "payload", "evidence", "symlink"] as const) {
    const f = fixture();
    try {
      const cached = await ensureArtifact(f.home, f.release, f.dependencies);
      const metadata = readFileSync(join(cached.directory, "artifact.json"), "utf8");
      if (mutation === "metadata") rmSync(join(cached.directory, "artifact.json"));
      if (mutation === "missing") rmSync(join(cached.directory, "skills", "issue-execution", "poc.yaml"));
      if (mutation === "payload") writeFileSync(join(cached.directory, "skills", "issue-execution", "feature.yaml"), "modified payload\n");
      if (mutation === "evidence") writeFileSync(join(cached.directory, "verified-archive.tar.gz"), "not a verified archive");
      if (mutation === "symlink") { const path = join(cached.directory, "identity.json"); rmSync(path); symlinkSync("package.json", path); }
      await assert.rejects(ensureArtifact(f.home, f.release, f.dependencies));
      if (mutation !== "metadata") assert.equal(readFileSync(join(cached.directory, "artifact.json"), "utf8"), metadata);
      else assert.equal(existsSync(join(cached.directory, "artifact.json")), false);
    } finally { f.dispose(); }
  }
});
test("a competing first publisher cannot replace the winning tuple", async () => {
  const f = fixture();
  try {
    const conflict = { ...f.release, commit: "b".repeat(40) };
    const results = await Promise.allSettled([ensureArtifact(f.home, f.release, f.dependencies), ensureArtifact(f.home, conflict, f.dependencies)]);
    assert.equal(results[0]!.status, "fulfilled");
    assert.equal(results[1]!.status, "rejected");
    assert.match(String((results[1] as PromiseRejectedResult).reason), /Conflicting artifact/);
    assert.equal((await inspectArtifact(f.home, f.release, f.dependencies)).record.commit, f.release.commit);
  } finally { f.dispose(); }
});
test("extraction rejects traversal paths and links even with a correct archive checksum", async () => {
  for (const link of [false, true]) {
    const f = fixture();
    try {
      const release = writeInProcessArchive(f.releases, [{ name: link ? "payload" : "../escape", content: link ? "" : "escape", type: link ? "2" : "0" }]);
      await assert.rejects(ensureArtifact(f.home, release, f.dependencies), link ? /Unsupported tar entry type/ : /Unsafe archive path/);
      assert.equal(existsSync(cachePath(f.home, release)), false);
      assert.equal(existsSync(join(f.home, "cache", "a4s", "escape")), false);
    } finally { f.dispose(); }
  }
});
test("publication rejects executable and declared identity disagreement before sealing", async () => {
  const f = fixture();
  try {
    const entries = artifactEntries(f.release.version, f.release.commit);
    const declared = entries.find(entry => entry.name === "identity.json")!;
    declared.content = JSON.stringify({ ...JSON.parse(String(declared.content)), commit: "b".repeat(40) });
    const release = writeInProcessArchive(f.releases, entries);
    await assert.rejects(ensureArtifact(f.home, release, f.dependencies), /embedded identity mismatch/);
    assert.equal(existsSync(cachePath(f.home, release)), false);
  } finally { f.dispose(); }
});
