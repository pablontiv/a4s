import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { identity } from "../../src/identity.ts";
import { archiveName, type ResolvedRelease } from "../../../launcher/src/release.ts";
import { cachePath } from "../../../launcher/src/artifact-cache.ts";

export const packageDirectory = fileURLToPath(new URL("../../", import.meta.url));
export const repository = "pablontiv/a4s";
export function makeArchive(directory: string, version = "0.6.0", commit = "a".repeat(40)): ResolvedRelease {
  mkdirSync(directory, { recursive: true });
  const stage = mkdtempSync(join(tmpdir(), "a4s-fixture-stage-"));
  try {
    const declared = { ...identity, version, commit };
    writeFileSync(join(stage, "identity.json"), JSON.stringify(declared));
    writeFileSync(join(stage, "a4s"), `#!/bin/sh\n[ "$1" = version ] || exit 91\nprintf '%s\\n' '${JSON.stringify(declared)}'\n`);
    chmodSync(join(stage, "a4s"), 0o755);
    writeFileSync(join(stage, "package.json"), JSON.stringify({ name: "@a4s/issue-lifecycle", version, repository: { type: "git", url: `git+https://github.com/${repository}.git` },
      omp: { extensions: ["./src/status/reloadable.ts", "./src/triage/reloadable.ts"] } }));
    for (const entry of ["agents", "skills"]) cpSync(join(packageDirectory, entry), join(stage, entry), { recursive: true });
    mkdirSync(join(stage, "bin"));
    for (const entry of ["gate-cache.cjs", "dagu-gate.cjs", "gate-cache-run.cjs"]) copyFileSync(join(packageDirectory, "bin", entry), join(stage, "bin", entry));
    for (const entry of ["status/reloadable.ts", "status/index.ts", "triage/reloadable.ts", "triage/native.ts"]) {
      const path = join(stage, "src", entry);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "export {};\n");
    }
    writeFileSync(join(stage, "role-runner.ts"), "export {};\n");
    const archive = archiveName(version);
    const path = join(directory, archive);
    execFileSync("tar", ["--format=ustar", "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-czf", path, "-C", stage, ...readdirSync(stage).sort()]);
    const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
    writeFileSync(`${path}.sha256`, `${digest}  ${archive}\n`);
    return { version, commit, digest, archive, repository };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
/** Tests author a complete previously-verified entry, never a production reseal. */
export function fixtureArtifact(home: string) {
  const version = identity.version;
  const commit = "a".repeat(40);
  const directory = cachePath(home, { version, commit, digest: "0".repeat(64) });
  const record = join(directory, "artifact.json");
  if (existsSync(record)) return JSON.parse(readFileSync(record, "utf8")) as { version: string; commit: string; digest: string; verifiedAt: string };
  const temporary = mkdtempSync(join(tmpdir(), "a4s-fixture-release-"));
  try {
    const release = makeArchive(temporary, version, commit);
    mkdirSync(directory, { recursive: true });
    execFileSync("tar", ["-xzf", join(temporary, release.archive), "-C", directory]);
    copyFileSync(join(temporary, release.archive), join(directory, "verified-archive.tar.gz"));
    const metadata = { version, commit, digest: release.digest, verifiedAt: new Date().toISOString() };
    writeFileSync(record, JSON.stringify(metadata));
    return metadata;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
export interface ReleaseDirectory { repository: string; moving: Record<string, string>; releases: { tag_name: string; commit: string; draft?: boolean; prerelease?: boolean }[]; moveAfterResolution?: { tag: string; commit: string } }
export function writeReleaseDirectory(directory: string, value: ReleaseDirectory): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "fixture.json"), JSON.stringify(value));
}
export function installGithubFixture(directory: string): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "gh");
  copyFileSync(fileURLToPath(new URL("./release-gh.mjs", import.meta.url)), path);
  chmodSync(path, 0o755);
  return directory;
}
