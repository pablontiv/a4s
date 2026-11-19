// Selftest receipt: proof that the full selftest passed on exactly the current code of a worktree.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RECEIPT_NAME = ".selftest-receipt.json";
const FACTORY_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the receipt lives: SELFTEST_RECEIPT_FILE (tests) or next to the factory the selftest runs from. */
export const receiptPath = (factoryDir = FACTORY_DIR) => process.env.SELFTEST_RECEIPT_FILE ?? join(factoryDir, RECEIPT_NAME);

const git = (cwd, args) => {
  const r = spawnSync("git", args, { cwd, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} -> ${r.status}: ${r.stderr}`);
  return r.stdout;
};
/** Repository-relative path of the receipt: the only path excluded from snapshot and hash. */
export const RECEIPT_REL = `packages/factory/${RECEIPT_NAME}`;
const isReceipt = (p) => p === RECEIPT_REL;

/**
 * I/O: every change against HEAD as `{path, kind, content}` (kind: modified | deleted | added | untracked).
 * `--no-renames` reports a rename as a deletion of the source plus an addition of the destination.
 * The receipt is excluded.
 */
export function snapshotTree(dir) {
  const top = git(dir, ["rev-parse", "--show-toplevel"]).toString().trim();
  const parts = git(top, ["diff", "HEAD", "--no-renames", "--name-status", "-z"]).toString().split("\0");
  const entries = new Map();
  const read = (path) => {
    const abs = join(top, path);
    try {
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) return Buffer.from(`symlink:${readlinkSync(abs)}`);
      if (st.isFile()) return readFileSync(abs);
      return Buffer.from("<not a file>");
    } catch { return null; }
  };
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i][0], path = parts[i + 1];
    if (isReceipt(path)) continue;
    const kind = status === "D" ? "deleted" : status === "A" ? "added" : "modified";
    // a file removed from the index but still on disk (git rm --cached) keeps its current content
    entries.set(path, { path, kind, content: read(path) });
  }
  for (const path of git(top, ["ls-files", "-o", "--exclude-standard", "-z"]).toString().split("\0")) {
    if (path && !isReceipt(path) && !entries.has(path)) entries.set(path, { path, kind: "untracked", content: read(path) });
  }
  return [...entries.values()];
}

/** Pure: sha256 of a snapshot; independent of the order of entries. */
export function treeHash(snapshot) {
  const h = createHash("sha256");
  const sorted = [...snapshot].filter((e) => !isReceipt(e.path)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const { path, kind, content } of sorted) {
    const c = content == null ? null : Buffer.from(content);
    h.update(`${JSON.stringify([path, kind, c ? c.length : -1])}\n`);
    if (c) h.update(c);
    h.update("\n");
  }
  return h.digest("hex");
}

/**
 * Start of a selftest: remove the old receipt FIRST, then hash the tree.
 * `enabled` false (SELFTEST_NO_RECEIPT=1) touches nothing. Returns the start hash (or null).
 */
export function beginReceipt({ dir, enabled = true, file = receiptPath() }) {
  if (!enabled) return null;
  rmSync(file, { force: true });
  return treeHash(snapshotTree(dir));
}

/**
 * End of a selftest: on pass and an unchanged tree write the receipt. Returns `{written, reason?}`.
 * Never leaves a receipt behind unless it is written here.
 */
export function endReceipt({ dir, enabled = true, file = receiptPath(), passed, startHash, startedAt, model, now = () => new Date() }) {
  if (!enabled) return { written: false, reason: "disabled" };
  rmSync(file, { force: true });
  if (!passed) return { written: false, reason: "selftest failed" };
  if (startHash == null) return { written: false, reason: "no start hash" };
  const end = treeHash(snapshotTree(dir));
  if (end !== startHash) return { written: false, reason: "the tree changed during the selftest" };
  writeFileSync(file, JSON.stringify({ version: 1, treeHash: end, startedAt, finishedAt: now().toISOString(), model }) + "\n");
  return { written: true };
}
