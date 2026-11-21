// What a candidate changes (#1120): the paths that differ between the merge base with `base` and the working tree
// of `dir` (committed and uncommitted changes, renames by both paths, untracked files not ignored by Git).
import { spawnSync } from "node:child_process";

const git = (dir, ...args) => {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return r.status === 0 ? r.stdout : null;
};
const lines = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean);

/** Changed paths of `dir` against the merge base with `base`, or null when the base is unknown (unset, all-zero, missing). */
export function changedPaths(dir, base) {
  if (!base || /^0+$/.test(base)) return null;
  if (git(dir, "rev-parse", "--verify", "--quiet", `${base}^{commit}`) === null) return null;
  const mb = git(dir, "merge-base", "HEAD", base);
  if (mb === null) return null;
  const diff = git(dir, "diff", "--name-only", "--no-renames", mb.trim());
  const untracked = git(dir, "ls-files", "--full-name", "--others", "--exclude-standard");
  if (diff === null || untracked === null) return null;
  return [...new Set([...lines(diff), ...lines(untracked)])].sort();
}
