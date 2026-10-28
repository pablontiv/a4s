import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync, chmodSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { createGunzip } from "node:zlib";
import { isDeepStrictEqual } from "node:util";
import { withFileLockAsync } from "./file-lock.ts";
import { artifactToken, archiveName, checksumDigest, github, parseArtifact, sameArtifact, type ArtifactTuple, type ResolvedRelease } from "./release.ts";
import { identity, type ArtifactIdentity } from "./identity.ts";
import { isRecord } from "./type-guard.ts";

const EVIDENCE = "verified-archive.tar.gz";
const RECORD = "artifact.json";
export interface ArtifactRecord extends ArtifactTuple { verifiedAt: string }
export interface CachedArtifact { directory: string; executable: string; executableDigest: string; identity: ArtifactIdentity; record: ArtifactRecord }
export interface ArtifactDependencies {
  github?: (args: string[]) => string;
  download?: (args: string[]) => void;
  executableIdentity?: (executable: string) => unknown;
  withFileLock?: typeof withFileLockAsync;
}
export function cachePath(home: string, tuple: ArtifactTuple): string {
  parseArtifact(artifactToken(tuple));
  return join(resolve(home), "cache", "a4s", tuple.version);
}
export function artifactLock(home: string, tuple: ArtifactTuple): string { return `${cachePath(home, tuple)}.lock`; }
export async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function regular(path: string): void {
  if (!lstatSync(path).isFile()) throw new Error(`Artifact payload must be a regular file: ${path}`);
}
function json(path: string): unknown { regular(path); return JSON.parse(readFileSync(path, "utf8")); }

/** The release format is deliberately ustar, with only regular files/directories.
 * No links, extended headers or special files can redirect extraction. Headers
 * and payload are streamed; the executable is never buffered in memory. */
async function archiveFiles(archive: string, directory: string, extract: boolean): Promise<{ files: Set<string>; executableDigest: string }> {
  const stream = createReadStream(archive).pipe(createGunzip());
  const iterator = stream[Symbol.asyncIterator]();
  let chunk: Buffer = Buffer.alloc(0);
  let offset = 0;
  async function consume(size: number, output?: (bytes: Buffer) => void): Promise<void> {
    while (size > 0) {
      if (offset === chunk.length) {
        const next = await iterator.next();
        if (next.done) throw new Error(`Truncated release archive ${archive}`);
        chunk = next.value as Buffer;
        offset = 0;
      }
      const count = Math.min(size, chunk.length - offset);
      output?.(chunk.subarray(offset, offset + count));
      offset += count;
      size -= count;
    }
  }
  const names = new Set<string>();
  const files = new Set<string>();
  const header = Buffer.alloc(512);
  let executableDigest = "";
  try {
    for (;;) {
      let copied = 0;
      await consume(512, bytes => { bytes.copy(header, copied); copied += bytes.length; });
      if (header.every(byte => byte === 0)) {
        await consume(512, bytes => { if (bytes.some(byte => byte !== 0)) throw new Error("Invalid tar terminator"); });
        // Tar permits further all-zero record padding, never a second archive.
        if (chunk.subarray(offset).some(byte => byte !== 0)) throw new Error("Unexpected data after tar terminator");
        for await (const bytes of { [Symbol.asyncIterator]: () => iterator }) if ((bytes as Buffer).some(byte => byte !== 0)) throw new Error("Unexpected data after tar terminator");
        break;
      }
      const field = (start: number, size: number) => header.subarray(start, start + size).toString("utf8").replace(/\0.*$/s, "");
      const octal = (start: number, size: number) => {
        const value = field(start, size).trim();
        if (!/^[0-7]+$/.test(value)) throw new Error("Invalid tar numeric header");
        const number = Number.parseInt(value, 8);
        if (!Number.isSafeInteger(number)) throw new Error("Tar header exceeds safe integer range");
        return number;
      };
      let sum = 0;
      for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 32 : header[index]!;
      if (sum !== octal(148, 8) || field(257, 5) !== "ustar") throw new Error("Invalid release tar header/checksum");
      const prefix = field(345, 155);
      const raw = `${prefix ? `${prefix}/` : ""}${field(0, 100)}`;
      const name = raw.replace(/\/$/, "");
      if (!name || raw.startsWith("/") || raw.includes("\\") || name.split("/").some(part => !part || part === "." || part === "..") || /[\x00-\x1f\x7f]/.test(name)) throw new Error(`Unsafe archive path ${JSON.stringify(raw)}`);
      const path = resolve(directory, name);
      if (!path.startsWith(`${directory}${sep}`) || names.has(name) || name === RECORD || name === EVIDENCE) throw new Error(`Invalid or reserved archive path ${name}`);
      names.add(name);
      const type = field(156, 1);
      const size = octal(124, 12);
      if (type === "5") {
        if (size !== 0) throw new Error(`Nonempty tar directory ${name}`);
        if (extract) mkdirSync(path, { recursive: true, mode: 0o755 });
        else if (!lstatSync(path).isDirectory()) throw new Error(`Missing artifact directory ${name}`);
        continue;
      }
      if (type !== "0" && type !== "") throw new Error(`Unsupported tar entry type for ${name}; only regular files and directories are allowed`);
      files.add(name);
      const expected = !extract || name === "a4s" ? createHash("sha256") : undefined;
      let fd: number | undefined;
      if (extract) { mkdirSync(dirname(path), { recursive: true }); fd = openSync(path, "wx", 0o600); }
      else regular(path);
      try {
        await consume(size, bytes => {
          expected?.update(bytes);
          if (fd !== undefined) {
            let written = 0;
            while (written < bytes.length) written += writeSync(fd, bytes, written);
          }
        });
      } finally { if (fd !== undefined) closeSync(fd); }
      if (extract) chmodSync(path, name === "a4s" ? 0o755 : 0o644);
      const digest = expected?.digest("hex");
      if (!extract && await fileDigest(path) !== digest) throw new Error(`Modified artifact payload ${name}`);
      if (name === "a4s") executableDigest = digest!;
      await consume((512 - size % 512) % 512);
    }
  } finally { stream.destroy(); }
  return { files, executableDigest };
}
const REQUIRED = ["a4s", "identity.json", "package.json", "bin/dagu-gate.cjs", "bin/gate-cache.cjs", "bin/gate-cache-run.cjs",
  "src/status/reloadable.ts", "src/status/index.ts", "src/triage/reloadable.ts", "src/triage/native.ts", "agents/plan-reviewer.md", "agents/triage-reviewer.md",
  ...["feature", "poc", "discovery", "planning", "reconcile"].map(name => `skills/issue-execution/${name}.yaml`),
  ...["backlog-breakdown", "issue-execution", "refine", "repository-discovery", "sprint-planning", "sprint-retrospective", "sprint-review"].map(name => `skills/${name}/SKILL.md`),
  "skills/repository-discovery/CONTRACT.md", "skills/repository-discovery/METHOD.md",
  ...["0-cobertura-funcional", "1-limites-de-confianza", "2-integridad-y-ciclo-de-vida-de-datos", "3-resiliencia-y-concurrencia", "4-cadena-de-suministro-y-publicacion"].map(name => `skills/repository-discovery/lenses/${name}.md`)];
function layout(directory: string, files: Set<string>, tuple: ArtifactTuple, dependencies: ArtifactDependencies): ArtifactIdentity {
  for (const path of REQUIRED) if (!files.has(path)) throw new Error(`Incomplete a4s artifact: missing ${path}`);
  const declared = json(join(directory, "identity.json"));
  const executable = dependencies.executableIdentity
    ? dependencies.executableIdentity(join(directory, "a4s"))
    : JSON.parse(execFileSync(join(directory, "a4s"), ["version"], { encoding: "utf8", timeout: 30000 }));
  if (!isDeepStrictEqual(declared, executable) || !isRecord(declared) || declared.version !== tuple.version || declared.commit !== tuple.commit || !isRecord(declared.support) || "digest" in declared) throw new Error(`Artifact embedded identity mismatch: expected ${artifactToken(tuple)}`);
  const manifest = json(join(directory, "package.json"));
  if (!isRecord(manifest) || manifest.name !== "@a4s/issue-lifecycle" || manifest.version !== tuple.version) throw new Error("Artifact package manifest identity mismatch");
  if (!isRecord(manifest.omp) || !Array.isArray(manifest.omp.extensions) ||
      !isDeepStrictEqual(manifest.omp.extensions, ["./src/status/reloadable.ts", "./src/triage/reloadable.ts"]) ||
      manifest.omp.extensions.some(path => typeof path !== "string" || !files.has(path.slice(2)))) throw new Error("Artifact OMP extension metadata does not name the shipped extension entries");
  const support = declared.support;
  if (support.dispatch !== identity.support.dispatch) throw new Error(`Unsupported artifact dispatch boundary: required ${identity.support.dispatch}; declared=${JSON.stringify(support.dispatch) ?? "missing"}`);
  if (!Array.isArray(support.configSchemas) || !support.configSchemas.includes(1) || !isRecord(support.receiptSchemas) || !Array.isArray(support.receiptSchemas.read) || !support.receiptSchemas.read.includes(2) || support.receiptSchemas.write !== 2 || !Array.isArray(support.roleJobStores) || !support.roleJobStores.includes(1) || !isDeepStrictEqual(support.protocols, identity.support.protocols)) throw new Error("Artifact declares unsupported config/receipt/protocol/job-store contracts");
  return declared as unknown as ArtifactIdentity;
}
function entryFiles(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) return entryFiles(join(directory, entry.name), `${name}/`);
    if (!entry.isFile()) throw new Error(`Nonregular artifact payload ${name}`);
    return [name];
  });
}
/** Re-derive payload evidence from the retained, checksum-verified archive, never
 * from a newly generated manifest of the current extracted files. */
export async function inspectArtifact(home: string, tuple: ArtifactTuple, dependencies: ArtifactDependencies = {}): Promise<CachedArtifact> {
  const directory = cachePath(home, tuple);
  if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) throw new Error(`Artifact cache must be a real directory: ${directory}`);
  const record = json(join(directory, RECORD));
  if (!isRecord(record) || Object.keys(record).sort().join(",") !== "commit,digest,verifiedAt,version" || typeof record.verifiedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(record.verifiedAt) || !Number.isFinite(Date.parse(record.verifiedAt))) throw new Error(`Missing or malformed artifact metadata: ${directory}`);
  const observed = parseArtifact(`${record.version}@${record.commit}#${record.digest}`);
  if (!sameArtifact(observed, tuple)) throw new Error(`Conflicting artifact cache entry: expected ${artifactToken(tuple)}, observed ${artifactToken(observed)}`);
  const archive = join(directory, EVIDENCE);
  regular(archive);
  if (await fileDigest(archive) !== tuple.digest) throw new Error(`Modified verified archive for ${artifactToken(tuple)}`);
  const { files, executableDigest } = await archiveFiles(archive, directory, false);
  for (const name of entryFiles(directory)) if (name !== RECORD && name !== EVIDENCE && !files.has(name)) throw new Error(`Unexpected artifact payload ${name}`);
  const declared = layout(directory, files, tuple, dependencies);
  return { directory, executable: join(directory, "a4s"), executableDigest, identity: declared, record: record as unknown as ArtifactRecord };
}
export async function ensureArtifact(home: string, release: ResolvedRelease, dependencies: ArtifactDependencies = {}): Promise<CachedArtifact> {
  return (dependencies.withFileLock ?? withFileLockAsync)(artifactLock(home, release), async () => {
    const directory = cachePath(home, release);
    if (existsSync(directory) || (() => { try { lstatSync(directory); return true; } catch { return false; } })()) return inspectArtifact(home, release, dependencies);
    mkdirSync(dirname(directory), { recursive: true });
    const stage = mkdtempSync(join(dirname(directory), `.${release.version}-`));
    try {
      const archive = archiveName(release.version);
      if (release.archive !== archive) throw new Error("Resolved archive does not match the native platform");
      const checksum = (dependencies.github ?? github)(["release", "download", `v${release.version}`, "--repo", release.repository, "--pattern", `${archive}.sha256`, "--output", "-"]);
      if (checksumDigest(checksum, archive) !== release.digest) throw new Error("Exact release checksum changed after resolution");
      const downloaded = join(stage, archive);
      const downloadArgs = ["release", "download", `v${release.version}`, "--repo", release.repository, "--pattern", archive, "--output", downloaded];
      if (dependencies.download) dependencies.download(downloadArgs);
      else execFileSync("gh", downloadArgs, { stdio: ["ignore", "pipe", "pipe"] });
      regular(downloaded);
      if (await fileDigest(downloaded) !== release.digest) throw new Error(`Archive SHA-256 mismatch: ${archive}`);
      renameSync(downloaded, join(stage, EVIDENCE));
      const { files, executableDigest } = await archiveFiles(join(stage, EVIDENCE), stage, true);
      const declared = layout(stage, files, release, dependencies);
      const record: ArtifactRecord = { version: release.version, commit: release.commit, digest: release.digest, verifiedAt: new Date().toISOString() };
      writeFileSync(join(stage, RECORD), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      renameSync(stage, directory);
      return { directory, executable: join(directory, "a4s"), executableDigest, identity: declared, record };
    } finally { rmSync(stage, { recursive: true, force: true }); }
  });
}
