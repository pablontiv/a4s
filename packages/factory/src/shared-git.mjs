// Shared Git state guard: a station must not change the repository state shared by every run.
// `fingerprint` and `violations` are pure functions over a snapshot; `collectSnapshot` is the only part that touches Git.
// Protected: common .git/config and config.worktree files, .git/hooks/, .git/info/, refs outside the issue's own branch
// (factory/issue-* branches are out of scope; refs/remotes may only move under another run's integration lease), and the primary
// checkout's `git status --porcelain` (untracked included, .workspace/worktrees/ excluded). objects/ and packs are never read.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { current as leaseCurrent } from "./lease.mjs";
import { dirname, join, resolve } from "node:path";

/**
 * Snapshot shape (`hooks`/`info` map every file of the tree, recursive, to "mode:hash"; `lease` = {gen, holder: run|null}): {config: string, configWorktree: {path: text}, hooks: {name: hash}, info: {name: hash},
 *   refs: {refname: sha}, primaryBranch: "refs/heads/main"|null, primaryStatus: string[], ownBranch: "refs/heads/..."|null}.
 */
const OTHER_RUN = /^refs\/heads\/factory\/issue-/;
// Not station-controlled: other runs' own branches. refs/remotes/ is NOT exempt by name:
// it may only move while another run holds the integration lease (see `violations`).
// Every factory/issue-* branch is exempt (concurrent runs create, move and delete them legitimately; each run protects its own
// through its integration window and verify_close).
// Only the T3 server's checkpoint refs (refs/t3/orchestration-v2/checkpoints/<thread>/ordinal/<n>) are authorised; any other refs/t3/* ref is protected.
const T3_CHECKPOINT = /^refs\/t3\/orchestration-v2\/checkpoints\/[^/]+\/ordinal\/\d+$/;
const IGNORED_REF = (r) => T3_CHECKPOINT.test(r) || OTHER_RUN.test(r);

/** Canonical map item-key -> value of everything protected, minus the issue's own branch and other runs' refs. */
export function fingerprint(snap) {
  const fp = {};
  fp[".git/config"] = snap.config ?? "";
  for (const [p, v] of Object.entries(snap.configWorktree ?? {})) fp[`config.worktree:${p}`] = v;
  for (const [n, v] of Object.entries(snap.hooks ?? {})) fp[`.git/hooks/${n}`] = v;
  for (const [n, v] of Object.entries(snap.info ?? {})) fp[`.git/info/${n}`] = v;
  for (const [r, v] of Object.entries(snap.refs ?? {})) if (r !== snap.ownBranch && !IGNORED_REF(r)) fp[`ref:${r}`] = v;
  fp["primary:status"] = [...(snap.primaryStatus ?? [])].sort().join("\n");
  return fp;
}

const lines = (t) => String(t ?? "").split("\n").filter(Boolean);
const clip = (s) => (s.length > 120 ? `${s.slice(0, 117)}...` : s);

/**
 * Differences between two fingerprints, as human-readable items ([] = no violation).
 * `integrating` = another run held the integration lease during the call: only then may the primary branch fast-forward
 * (`isFastForward(oldSha, newSha)`) and refs/remotes/ move (that run's merge and push). Any other ref move is a violation.
 */
export function violations(before, after, { primaryBranch = null, isFastForward = () => false, integrating = false } = {}) {
  const items = [];
  for (const k of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const b = before[k], a = after[k];
    if (b === a) continue;
    if (k.startsWith("ref:")) {
      if (integrating && k === `ref:${primaryBranch}` && b && a && isFastForward(b, a)) continue;
      if (integrating && k.startsWith("ref:refs/remotes/")) continue;
      items.push(`${k.slice(4)}: ${b ? b.slice(0, 12) : "(absent)"} -> ${a ? a.slice(0, 12) : "(deleted)"}`);
    } else if (k === "primary:status") {
      const bl = lines(b), al = lines(a);
      const add = al.filter((l) => !bl.includes(l)).map((l) => `+${l}`), del = bl.filter((l) => !al.includes(l)).map((l) => `-${l}`);
      items.push(`primary checkout status changed: ${clip([...add, ...del].join("; "))}`);
    } else if (k === ".git/config" || k.startsWith("config.worktree:")) {
      const bl = lines(b), al = lines(a);
      const d = [...al.filter((l) => !bl.includes(l)).map((l) => `+${l.trim()}`), ...bl.filter((l) => !al.includes(l)).map((l) => `-${l.trim()}`)];
      items.push(`${k} changed${d.length ? `: ${clip(d.join("; "))}` : ""}`);
    } else items.push(`${k}: ${b === undefined ? "added" : a === undefined ? "removed" : "changed"}`);
  }
  return items;
}

/** Compare two snapshots (pure). */
export function compareSnapshots(before, after, isFastForward, { ownRun = "" } = {}) {
  const other = (l) => !!l?.holder && !(ownRun && ownRun.startsWith(l.holder));
  const integrating = other(before.lease) || other(after.lease) || (after.lease?.gen ?? 0) > (before.lease?.gen ?? 0);
  return violations(fingerprint(before), fingerprint(after), { primaryBranch: before.primaryBranch ?? after.primaryBranch, isFastForward, integrating });
}

// ---- collector: every failure throws (the guard fails closed) ----
const git = (args, cwd) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} -> ${r.status}: ${(r.stderr ?? "").trim()}`);
  return r.stdout;
};
const gitMaybe = (args, cwd) => { try { return git(args, cwd); } catch { return null; } };
/** Every file under `d` (recursive) -> "type+mode:hash"; symlinks by target. A missing directory is empty. */
function tree(d, rel = "", o = {}) {
  let names;
  try { names = readdirSync(join(d, rel)); } catch (e) { if (e.code === "ENOENT") return o; throw e; }
  for (const n of names) {
    const r = rel ? `${rel}/${n}` : n, f = join(d, r), st = lstatSync(f), mode = (st.mode & 0o7777).toString(8);
    if (st.isDirectory()) { o[`${r}/`] = `dir:${mode}`; tree(d, r, o); }
    else if (st.isSymbolicLink()) o[r] = `link:${readlinkSync(f)}`;
    else o[r] = `file:${mode}:${createHash("sha256").update(readFileSync(f)).digest("hex")}`;
  }
  return o;
}
const text = (f) => { try { return readFileSync(f, "utf8"); } catch (e) { if (e.code === "ENOENT") return ""; throw e; } };

/**
 * Read the shared state as seen from `worktree` (a linked worktree of the repository).
 * Returns null only when `worktree` is not inside a Git repository at all; any other failure throws.
 */
export function collectSnapshot(worktree, { state } = {}) {
  const rp = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: worktree, encoding: "utf8" });
  // only a genuine "not a git repository" is null; any other failure (corrupt config, unreadable dir, no git) throws: fail closed
  if (rp.error) throw rp.error;
  if (rp.status !== 0) {
    if (/not a git repository/i.test(rp.stderr ?? "")) return null;
    throw new Error(`git rev-parse --git-common-dir -> ${rp.status}: ${(rp.stderr ?? "").trim()}`);
  }
  const common = rp.stdout.trim();
  if (!common) throw new Error("git rev-parse --git-common-dir returned nothing");
  const gitDir = git(["rev-parse", "--path-format=absolute", "--git-dir"], worktree).trim();
  const primary = dirname(common);
  const refs = {};
  for (const l of lines(git(["--git-dir", common, "for-each-ref", "--format=%(refname) %(objectname)"], worktree))) {
    const i = l.indexOf(" "); refs[l.slice(0, i)] = l.slice(i + 1);
  }
  const ownBranch = gitMaybe(["symbolic-ref", "-q", "HEAD"], worktree)?.trim() ?? null;
  const primaryHead = text(join(common, "HEAD")).trim();
  const primaryBranch = primaryHead.startsWith("ref: ") ? primaryHead.slice(5) : null;
  const configWorktree = {};
  const cws = [join(common, "config.worktree"), join(gitDir, "config.worktree")];
  const wtDir = join(common, "worktrees");
  for (const n of existsSync(wtDir) ? readdirSync(wtDir) : []) cws.push(join(wtDir, n, "config.worktree"));
  for (const f of cws) if (existsSync(f)) configWorktree[f] = text(f);
  // --git-dir + --work-tree on the command line override a hijacked core.worktree: we look at the real primary
  const status = git(["--git-dir", common, "--work-tree", primary, "status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude).workspace/worktrees"], primary);
  let lease = { gen: 0, holder: null };
  if (state) { const c = leaseCurrent(state); lease = { gen: c.gen, holder: c.gen && !c.released ? (c.rec?.run ?? "?") : null }; }
  return {
    config: text(join(common, "config")), configWorktree, hooks: tree(join(common, "hooks")), info: tree(join(common, "info")),
    refs, primaryBranch, ownBranch, primaryStatus: lines(status), common: resolve(common), lease,
  };
}

/** True when `oldSha` is an ancestor of `newSha` in the repository of `snap`. */
export const gitIsFastForward = (snap) => (o, n) =>
  spawnSync("git", ["--git-dir", snap.common, "merge-base", "--is-ancestor", o, n]).status === 0;
