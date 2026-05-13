import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { identity } from "../../src/identity.ts";
import { cachePath, type ArtifactDependencies } from "../../../launcher/src/artifact-cache.ts";
import { archiveName, type ArtifactTuple, type ResolvedRelease } from "../../../launcher/src/release.ts";
import { packageDirectory, repository } from "./artifact.ts";

export interface ArchiveEntry { name: string; content: string | Buffer; type?: string }
/** Encode the same restricted ustar format consumed by production, without tar. */
export function archiveBytes(entries: ArchiveEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const { name, content, type = "0" } of entries) {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const header = Buffer.alloc(512);
    if (Buffer.byteLength(name) > 100) throw new Error(`Fixture tar name too long: ${name}`);
    header.write(name, 0, 100);
    const octal = (value: number, start: number, length: number) => header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, start, length);
    octal(0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
    octal(bytes.length, 124, 12); octal(0, 136, 12);
    header.fill(32, 148, 156); header.write(type, 156, 1); header.write("ustar\0", 257, 6); header.write("00", 263, 2);
    octal(header.reduce((sum, byte) => sum + byte, 0), 148, 8);
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
function tree(directory: string, prefix: string): ArchiveEntry[] {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const name = `${prefix}/${entry.name}`;
    return entry.isDirectory() ? tree(join(directory, entry.name), name) : [{ name, content: readFileSync(join(directory, entry.name)) }];
  });
}
export function artifactEntries(version = identity.version, commit = "a".repeat(40)): ArchiveEntry[] {
  const declared = JSON.stringify({ ...identity, version, commit });
  return [
    { name: "a4s", content: declared }, // Identity-reader fake consumes this; never executable.
    { name: "identity.json", content: declared },
    { name: "package.json", content: JSON.stringify({ name: "@a4s/issue-lifecycle", version, omp: { extensions: ["./src/status/reloadable.ts", "./src/triage/reloadable.ts"] } }) },
    ...["agents", "skills"].flatMap(name => tree(join(packageDirectory, name), name)),
    ...["dagu-gate.cjs", "gate-cache.cjs", "gate-cache-run.cjs"].map(name => ({ name: `bin/${name}`, content: readFileSync(join(packageDirectory, "bin", name)) })),
    ...["status/reloadable.ts", "status/index.ts", "triage/reloadable.ts", "triage/native.ts"].map(name => ({ name: `src/${name}`, content: "export {};\n" })),
  ];
}
export function writeInProcessArchive(directory: string, entries: ArchiveEntry[], version = "0.6.0", commit = "a".repeat(40)): ResolvedRelease {
  mkdirSync(directory, { recursive: true });
  const archive = archiveName(version);
  const bytes = archiveBytes(entries);
  const digest = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(join(directory, archive), bytes);
  writeFileSync(join(directory, `${archive}.sha256`), `${digest}  ${archive}\n`);
  return { version, commit, digest, archive, repository };
}
export function makeInProcessArchive(directory: string, version = "0.6.0", commit = "a".repeat(40)): ResolvedRelease {
  return writeInProcessArchive(directory, artifactEntries(version, commit), version, commit);
}
export const inProcessIdentity = (executable: string): unknown => JSON.parse(readFileSync(executable, "utf8"));
/** A keyed Promise mutex models publishers while leaving cache IO/validation real. */
export function artifactDependencies(releases: string, calls: string[][] = []): ArtifactDependencies {
  const locks = new Map<string, Promise<unknown>>();
  return {
    github(args) { calls.push(args); return readFileSync(join(releases, args[args.indexOf("--pattern") + 1]!), "utf8"); },
    download(args) { calls.push(args); copyFileSync(join(releases, args[args.indexOf("--pattern") + 1]!), args[args.indexOf("--output") + 1]!); },
    executableIdentity: inProcessIdentity,
    async withFileLock<T>(path: string, body: () => Promise<T>): Promise<T> {
      const previous = locks.get(path) ?? Promise.resolve();
      const current = previous.catch(() => {}).then(body);
      locks.set(path, current);
      try { return await current; } finally { if (locks.get(path) === current) locks.delete(path); }
    },
  };
}
/** Receipt-only cache fixture; inspect with { executableIdentity: inProcessIdentity }. */
export function inProcessArtifact(home: string, version = identity.version, commit = "a".repeat(40)): ArtifactTuple {
  const directory = cachePath(home, { version, commit, digest: "0".repeat(64) });
  const record = join(directory, "artifact.json");
  try { return JSON.parse(readFileSync(record, "utf8")) as ArtifactTuple; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const entries = artifactEntries(version, commit);
  const bytes = archiveBytes(entries);
  const tuple = { version, commit, digest: createHash("sha256").update(bytes).digest("hex") };
  for (const { name, content } of entries) { const path = join(directory, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
  writeFileSync(join(directory, "verified-archive.tar.gz"), bytes);
  writeFileSync(record, JSON.stringify({ ...tuple, verifiedAt: new Date().toISOString() }));
  return tuple;
}
