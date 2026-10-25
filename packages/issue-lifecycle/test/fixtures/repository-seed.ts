import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

/**
 * Commit time shared by a seed and a fresh build of the same family so their
 * refs identify the same commit. Copies must not depend on wall-clock time.
 */
export const SEED_COMMIT_DATE = "2020-01-01T00:00:00Z";

const seeds = new Map<string, string>();

/**
 * Build one immutable repository seed per fixture family per process, then
 * return a private copy. The copy rewrites absolute paths recorded in git
 * config, linked-worktree metadata, and ownership records. Git object stores
 * and index files stay byte-for-byte: objects are content-addressed, and the
 * index checksum plus its length-prefixed untracked-cache location must not
 * be patched in place. A stale index location is ignored by git.
 */
export function copyRepositorySeed(family: string, prefix: string, build: (root: string) => void): string {
  let seed = seeds.get(family);
  if (!seed) {
    const created = realpathSync(mkdtempSync(join(tmpdir(), seedDirectoryName(family))));
    try {
      build(created);
    } catch (error) {
      rmSync(created, { recursive: true, force: true });
      throw error;
    }
    seed = created;
    seeds.set(family, seed);
  }
  const copy = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  if (copy.includes(seed) || seed.includes(copy)) throw new Error("seed and copy paths overlap");
  rmSync(copy, { recursive: true });
  cpSync(seed, copy, { recursive: true, verbatimSymlinks: true });
  rewriteSeedPaths(copy, seed);
  return realpathSync(copy);
}

/**
 * A copied index still records the seed's stat cache and untracked-cache
 * location. Refresh it in place so a later read-only git command does not
 * rewrite index bytes while it notices the copy.
 */
export function settleCopiedRepository(directories: readonly string[]): void {
  for (const directory of directories) {
    const refresh = spawnSync("git", ["-C", directory, "update-index", "--refresh"], { encoding: "utf8" });
    if (refresh.status !== 0) {
      throw new Error(`copied repository index refresh failed in ${directory}: ${refresh.stdout}${refresh.stderr}`);
    }
    const status = spawnSync("git", ["-C", directory, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" });
    if (status.status !== 0 || status.stdout !== "") {
      throw new Error(`copied repository is dirty in ${directory}: ${status.stdout}${status.stderr}`);
    }
  }
}

function seedDirectoryName(family: string): string {
  const safe = family.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `a4s-seed-${safe || "fixture"}-`;
}

function isGitMetadata(directory: string): boolean {
  const base = directory.slice(directory.lastIndexOf(sep) + 1);
  return base === ".git" || base === "remote.git"
    || directory.includes(`${sep}.git${sep}`)
    || directory.includes(`${sep}remote.git${sep}`);
}

function rewriteSeedPaths(root: string, seed: string): void {
  const seedBytes = Buffer.from(seed);
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === "objects" && isGitMetadata(directory)) continue;
        pending.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === "index" && isGitMetadata(directory)) continue;
      const body = readFileSync(path);
      if (!body.includes(seedBytes)) continue;
      if (body.includes(0)) throw new Error(`immutable seed path is embedded in binary file ${path}`);
      writeFileSync(path, body.toString("utf8").split(seed).join(root));
    }
  }
}

function normalizeText(text: string, pairs: ReadonlyArray<readonly [string, string]>): string {
  let out = text;
  for (const [from, to] of [...pairs].sort((left, right) => right[0].length - left[0].length)) {
    out = out.split(from).join(to);
  }
  return out;
}

function gitText(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

/** Refs, config, worktree metadata, and ownership, with absolute roots substituted. */
export function normalizedFixtureSnapshot(repo: {
  root: string;
  primary: string;
  worktree: string;
  remote: string;
  ownership: readonly string[];
}, tokens: ReadonlyArray<readonly [string, string]> = []): string {
  const chunks = [
    "primary-show-ref\n" + gitText(repo.primary, ["show-ref", "--head"]),
    "remote-show-ref\n" + gitText(repo.remote, ["show-ref", "--head"]),
    "primary-config\n" + gitText(repo.primary, ["config", "--list", "--local"]),
    "remote-config\n" + gitText(repo.remote, ["config", "--list", "--local"]),
    "worktrees\n" + gitText(repo.primary, ["worktree", "list", "--porcelain"]),
    "worktree-head\n" + gitText(repo.worktree, ["rev-parse", "HEAD"]),
    "worktree-tree\n" + gitText(repo.worktree, ["rev-parse", "HEAD^{tree}"]),
    "worktree-status\n" + gitText(repo.worktree, ["status", "--porcelain=v1", "--untracked-files=all"]),
    "worktree-gitfile\n" + readFileSync(join(repo.worktree, ".git"), "utf8"),
    "exclude\n" + readFileSync(join(repo.primary, ".git", "info", "exclude"), "utf8"),
  ];
  const worktrees = join(repo.primary, ".git", "worktrees");
  for (const name of readdirSync(worktrees).sort()) {
    for (const file of ["commondir", "gitdir", "HEAD"]) {
      chunks.push(`meta ${name}/${file}\n` + readFileSync(join(worktrees, name, file), "utf8"));
    }
  }
  for (const file of [...repo.ownership].sort()) chunks.push(`own ${file}\n` + readFileSync(file, "utf8"));
  return normalizeText(chunks.join("\n"), [[repo.root, "$ROOT"], ...tokens]);
}
