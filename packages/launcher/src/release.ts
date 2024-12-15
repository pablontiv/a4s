import { execFileSync } from "node:child_process";
import { RELEASE_REPOSITORY } from "./contracts.ts";
import { isRecord } from "./type-guard.ts";

export interface ArtifactTuple { version: string; commit: string; digest: string }
export interface ResolvedRelease extends ArtifactTuple { repository: string; archive: string }
const VERSION = /^(?:r(0|[1-9]\d*)|(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))$/;
export function parseArtifact(value: unknown): ArtifactTuple {
  if (typeof value !== "string") throw new Error("Artifact requires <version>@<commit>#<digest>");
  const match = /^([^@]+)@([a-f0-9]{40})#([a-f0-9]{64})$/.exec(value);
  if (!match || !VERSION.test(match[1]!)) throw new Error(`Invalid artifact tuple ${JSON.stringify(value)}`);
  return { version: match[1]!, commit: match[2]!, digest: match[3]! };
}
export function artifactToken(tuple: ArtifactTuple): string { return `${tuple.version}@${tuple.commit}#${tuple.digest}`; }
export function sameArtifact(left: ArtifactTuple, right: ArtifactTuple): boolean { return artifactToken(left) === artifactToken(right); }
export function releaseRepository(): string { return RELEASE_REPOSITORY; }
export function nativePlatform(platform = process.platform, arch = process.arch): string {
  const name = `${platform}-${arch}`;
  if (name !== "linux-x64" && name !== "darwin-arm64") throw new Error(`a4s release unavailable for platform ${name}`);
  return name;
}
export function releaseTag(version: string): string {
  if (!VERSION.test(version)) throw new Error(`Invalid artifact ID ${JSON.stringify(version)}`);
  return version.startsWith("r") ? `a4s-${version}` : `v${version}`;
}
export function archiveName(version: string, platform = nativePlatform()): string { return `a4s-${version.startsWith("r") ? version : `v${version}`}-${platform}.tar.gz`; }
export type Github = (args: string[]) => string;
export const github: Github = args => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
function api(gh: Github, path: string): unknown { return JSON.parse(gh(["api", path])); }
function tagCommit(repository: string, tag: string, gh: Github): string {
  let ref = api(gh, `repos/${repository}/git/ref/tags/${tag}`);
  const seen = new Set<string>();
  for (;;) {
    const object = isRecord(ref) ? ref.object : undefined;
    if (!isRecord(object) || typeof object.sha !== "string" || !/^[a-f0-9]{40}$/.test(object.sha)) throw new Error(`Invalid release tag identity ${tag}`);
    if (object.type === "commit") return object.sha;
    if (object.type !== "tag" || seen.has(object.sha)) throw new Error(`Invalid or cyclic annotated release tag ${tag}`);
    seen.add(object.sha);
    ref = api(gh, `repos/${repository}/git/tags/${object.sha}`);
  }
}
function exactRelease(value: unknown, tag: string): void {
  if (!isRecord(value) || value.tag_name !== tag || value.draft !== false || value.prerelease !== false) throw new Error(`Unavailable immutable a4s release ${tag}`);
}
export function checksumDigest(text: string, archive: string): string {
  const fields = /^([a-f0-9]{64}) {2}([^\r\n]+)\n?$/.exec(text);
  if (!fields || fields[2] !== archive) throw new Error(`Invalid checksum asset for ${archive}`);
  return fields[1]!;
}
/** Resolve only an immutable build ID, including retained historical SemVer IDs. */
export function resolveRelease(version: string, options: { gh?: Github; repository?: string; platform?: string } = {}): ResolvedRelease {
  const tag = releaseTag(version);
  const gh = options.gh ?? github;
  const repository = options.repository ?? releaseRepository();
  const platform = options.platform ?? nativePlatform();
  exactRelease(api(gh, `repos/${repository}/releases/tags/${tag}`), tag);
  const commit = tagCommit(repository, tag, gh);
  const archive = archiveName(version, platform);
  const digest = checksumDigest(gh(["release", "download", tag, "--repo", repository, "--pattern", `${archive}.sha256`, "--output", "-"]), archive);
  return { version, commit, digest, repository, archive };
}
