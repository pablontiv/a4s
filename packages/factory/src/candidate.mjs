// Candidate guard for the QA line: QA works in the issue worktree with full rights, but must not change the candidate.
// The candidate is what Git would commit: tracked files (content and mode; tracked wins over ignored) and untracked files
// that are NOT ignored (paths and contents). Ignored paths (node_modules/, caches, receipt, build output) are excluded.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

const gitZ = (args, cwd) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} -> ${r.status}: ${(r.stderr ?? "").trim()}`);
  return r.stdout.split("\0").filter(Boolean);
};

function describe(f) {
  let st;
  try { st = lstatSync(f); } catch (e) { if (e.code === "ENOENT") return "absent"; throw e; }
  if (st.isSymbolicLink()) return `link:${readlinkSync(f)}`; // never followed: a link to outside the worktree is compared by target text
  if (st.isDirectory()) return "dir"; // nested repository / submodule: not descended
  const mode = st.mode & 0o111 ? "x" : "-";
  return `file:${mode}:${createHash("sha256").update(readFileSync(f)).digest("hex")}`;
}

/** path -> description of every tracked file and every untracked, non-ignored file. Throws on any Git failure (fail closed). */
export function collectCandidate(worktree) {
  const out = Object.create(null);
  for (const p of gitZ(["ls-files", "-z"], worktree)) out[p] = describe(join(worktree, p));
  for (const p of gitZ(["ls-files", "-o", "--exclude-standard", "-z"], worktree)) out[p] = describe(join(worktree, p));
  return out;
}

/** Changed paths between two candidates, as readable items ([] = unchanged). */
export function compareCandidates(before, after) {
  const items = [];
  for (const p of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const b = before[p], a = after[p];
    if (b === a) continue;
    items.push(`${p}: ${b === undefined || b === "absent" ? "added" : a === undefined || a === "absent" ? "deleted" : "changed"}`);
  }
  return items;
}
