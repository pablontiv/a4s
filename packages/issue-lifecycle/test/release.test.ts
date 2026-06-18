import assert from "node:assert/strict";
import test from "node:test";
import { archiveName, checksumDigest, nativePlatform, parseArtifact, releaseRepository, resolveRelease, type Github } from "../src/release.ts";
const commitA = "a".repeat(40), commitB = "b".repeat(40), digest = "c".repeat(64);
function githubFixture(releases: { tag_name: string; commit: string; draft?: boolean }[], moving = commitA, annotated = false) {
  const calls: string[][] = [];
  const gh: Github = args => {
    calls.push(args);
    if (args[0] === "release") return `${digest}  ${archiveName(args[2]!.replace(/^(?:a4s-|v)/, ""), "linux-x64")}\n`;
    const route = args.find(arg => arg.startsWith("repos/"))!;
    if (route.includes("releases?")) return JSON.stringify([releases.map(release => ({ ...release, draft: release.draft ?? false, prerelease: false }))]);
    if (route.includes("releases/tags/")) return JSON.stringify({ tag_name: route.split("/").at(-1), draft: false, prerelease: false });
    if (route.includes("git/tags/")) return JSON.stringify({ object: { type: "commit", sha: moving } });
    const tag = route.split("/").at(-1)!;
    return JSON.stringify({ object: { type: tag === "v0" && annotated ? "tag" : "commit", sha: tag === "v0" ? moving : releases.find(release => release.tag_name === tag)?.commit } });
  };
  return { gh, calls };
}
test("the release source is the package's own declared repository", () => {
  assert.equal(releaseRepository(), "pablontiv/a4s");
  assert.equal(nativePlatform("linux", "x64"), "linux-x64");
  assert.equal(nativePlatform("darwin", "arm64"), "darwin-arm64");
  assert.throws(() => nativePlatform("win32", "x64"), /unavailable for platform/);
});
test("moving major dereferences once and downloads only the exact release", () => {
  const { gh, calls } = githubFixture([{ tag_name: "v0.6.0", commit: commitA }, { tag_name: "v0.7.0", commit: commitB }], commitA, true);
  assert.deepEqual(resolveRelease("a4s@v0", { gh, repository: "a4s/a4s", platform: "linux-x64" }), { version: "0.6.0", commit: commitA, digest, repository: "a4s/a4s", archive: "a4s-v0.6.0-linux-x64.tar.gz" });
  assert.equal(calls.filter(args => args.some(value => value.endsWith("git/ref/tags/v0"))).length, 1);
  assert.equal(calls.filter(args => args[0] === "release").length, 1);
  assert.equal(calls.find(args => args[0] === "release")![2], "v0.6.0");
});
test("moving major rejects zero matches and ambiguous releases, never guessing", () => {
  for (const releases of [[], [{ tag_name: "v0.6.0", commit: commitA }, { tag_name: "v0.6.1", commit: commitA }], [{ tag_name: "v0.6.0", commit: commitA, draft: true }]]) {
    const { gh, calls } = githubFixture(releases);
    assert.throws(() => resolveRelease("a4s@v0", { gh, repository: "a4s/a4s", platform: "linux-x64" }), /Ambiguous a4s ref/);
    assert.equal(calls.some(args => args[0] === "release"), false);
  }
});
test("exact releases do not read a moving ref and checksums bind the exact asset", () => {
  const { gh, calls } = githubFixture([{ tag_name: "v0.6.0", commit: commitA }]);
  assert.equal(resolveRelease("a4s@v0.6.0", { gh, repository: "a4s/a4s", platform: "linux-x64" }).commit, commitA);
  assert.equal(calls.some(args => args.some(value => value.endsWith("/v0"))), false);
  for (const value of [`${digest}  other.tar.gz\n`, `${digest.toUpperCase()}  archive\n`, `${digest} archive\n`, `${digest}  archive\nextra`]) assert.throws(() => checksumDigest(value, "archive"), /Invalid checksum asset/);
  assert.throws(() => parseArtifact(`v0.6.0@${commitA}#${digest}`), /Invalid artifact tuple/);
});
test("r<N> releases and historical semver tuples use immutable exact names", () => {
  for (const version of ["r0", "r1", "r792", "0.7.8"]) assert.deepEqual(parseArtifact(`${version}@${commitA}#${digest}`), { version, commit: commitA, digest });
  for (const version of ["r01", "r-1", "r1.0", "a4s-r1", "R1"]) assert.throws(() => parseArtifact(`${version}@${commitA}#${digest}`));
  const { gh, calls } = githubFixture([{ tag_name: "a4s-r792", commit: commitA }]);
  assert.deepEqual(resolveRelease("a4s@r792", { gh, repository: "a4s/a4s", platform: "linux-x64" }), { version: "r792", commit: commitA, digest, repository: "a4s/a4s", archive: "a4s-r792-linux-x64.tar.gz" });
  assert.equal(calls.find(args => args[0] === "release")![2], "a4s-r792");
});
