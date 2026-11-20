import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint, violations, compareSnapshots, collectSnapshot, gitIsFastForward } from "../src/shared-git.mjs";

const base = () => ({
  config: "[core]\n\tbare = false\n", configWorktree: {}, hooks: { "pre-commit": "h1" }, info: { exclude: "e1" },
  refs: { "refs/heads/main": "aaa111", "refs/heads/factory/issue-5": "bbb222", "refs/heads/feature-x": "ccc333" },
  primaryBranch: "refs/heads/main", ownBranch: "refs/heads/factory/issue-5", primaryStatus: [],
});
const cmp = (patch, ff = () => false, opts) => compareSnapshots(base(), { ...base(), ...patch }, ff, opts);

test("identical snapshots: no violation", () => assert.deepEqual(cmp({}), []));
test("core.worktree set in the common config", () => {
  const v = cmp({ config: "[core]\n\tbare = false\n\tworktree = /tmp/scratch\n" });
  assert.equal(v.length, 1); assert.match(v[0], /\.git\/config changed.*\+worktree = \/tmp\/scratch/);
});
test("config.worktree file appears", () => assert.match(cmp({ configWorktree: { "/r/.git/config.worktree": "[core]\n\tworktree = /x\n" } })[0], /config\.worktree/));
test("a hook is added", () => assert.deepEqual(cmp({ hooks: { "pre-commit": "h1", "post-merge": "h2" } }), [".git/hooks/post-merge: added"]));
test("a hook is changed or an info file removed", () => {
  assert.deepEqual(cmp({ hooks: { "pre-commit": "h9" } }), [".git/hooks/pre-commit: changed"]);
  assert.deepEqual(cmp({ info: {} }), [".git/info/exclude: removed"]);
});
test("another branch's ref moved", () => {
  const v = cmp({ refs: { ...base().refs, "refs/heads/feature-x": "ddd444" } });
  assert.equal(v.length, 1); assert.match(v[0], /refs\/heads\/feature-x: ccc333 -> ddd444/);
});
test("another branch deleted or created", () => {
  const { "refs/heads/feature-x": _, ...rest } = base().refs;
  assert.match(cmp({ refs: rest })[0], /feature-x.*\(deleted\)/);
  assert.match(cmp({ refs: { ...base().refs, "refs/heads/new": "eee555" } })[0], /new: \(absent\)/);
});
test("a new untracked file in the primary", () => {
  const v = cmp({ primaryStatus: ["?? stray.txt"] });
  assert.equal(v.length, 1); assert.match(v[0], /primary checkout status changed: \+\?\? stray\.txt/);
});
const moved = { refs: { ...base().refs, "refs/heads/main": "fff666" } };
const ffOk = (o, n) => o === "aaa111" && n === "fff666";
test("fast-forward of main is not a violation only while another run holds the lease", () => {
  assert.deepEqual(cmp({ ...moved, lease: { gen: 3, holder: "run-9" } }, ffOk, { ownRun: "run-5-qa1" }), []);
  assert.deepEqual(compareSnapshots({ ...base(), lease: { gen: 3, holder: null } }, { ...base(), ...moved, lease: { gen: 4, holder: null } }, ffOk, { ownRun: "run-5" }), [], "lease taken and released inside the call");
  assert.equal(cmp(moved, ffOk, { ownRun: "run-5" }).length, 1, "no lease activity: a station moved main");
  assert.equal(compareSnapshots({ ...base(), lease: { gen: 3, holder: "run-5" } }, { ...base(), ...moved, lease: { gen: 3, holder: "run-5" } }, ffOk, { ownRun: "run-5-qa1" }).length, 1, "the lease of the station's own run does not authorize it");
  assert.equal(cmp({ ...moved, lease: { gen: 3, holder: "run-9" } }, () => false, { ownRun: "run-5" }).length, 1, "a non fast-forward move is a violation even then");
});
test("remote-tracking refs move only under another run's lease", () => {
  const refs = { ...base().refs, "refs/remotes/origin/main": "x2" };
  assert.match(cmp({ refs })[0], /refs\/remotes\/origin\/main/);
  assert.deepEqual(cmp({ refs, lease: { gen: 1, holder: "run-9" } }, () => false, { ownRun: "run-5" }), []);
});
test("nested hook file, mode change and another worktree's config.worktree are violations", () => {
  assert.deepEqual(cmp({ hooks: { "pre-commit": "h1", "sub/": "dir:755", "sub/x": "file:644:h" } }), [".git/hooks/sub/: added", ".git/hooks/sub/x: added"]);
  assert.deepEqual(cmp({ hooks: { "pre-commit": "file:755:h1" } }), [".git/hooks/pre-commit: changed"]);
  assert.match(cmp({ configWorktree: { "/r/.git/worktrees/issue-9/config.worktree": "[core]\n\tworktree = /x\n" } })[0], /issue-9\/config\.worktree/);
});
test("the issue's own branch moving is not a violation", () => assert.deepEqual(cmp({ refs: { ...base().refs, "refs/heads/factory/issue-5": "zzz999" } }), []));
test("other issues' factory branches and T3 server checkpoint refs do not count (out of scope)", () => {
  const refs = { ...base().refs, "refs/heads/factory/issue-9": "x1", "refs/t3/orchestration-v2/checkpoints/abc/ordinal/0": "x3" };
  assert.deepEqual(cmp({ refs }), []);
  const b = { ...base(), refs };
  assert.deepEqual(compareSnapshots(b, { ...b, refs: { ...refs, "refs/heads/factory/issue-9": "x2" } }, () => false), []);
});
test("an arbitrary refs/t3/* ref moving is a violation; only server checkpoint refs are authorised", () => {
  const refs = { ...base().refs, "refs/t3/arbitrary": "x9" };
  assert.match(cmp({ refs })[0], /refs\/t3\/arbitrary/);
  const b = { ...base(), refs };
  assert.match(compareSnapshots(b, { ...b, refs: { ...refs, "refs/t3/arbitrary": "x8" } }, () => false)[0], /refs\/t3\/arbitrary/);
});
test("fingerprint is pure and ignores key order", () => {
  const s = base(); const before = JSON.stringify(s);
  assert.deepEqual(fingerprint(s), fingerprint({ ...s, refs: Object.fromEntries(Object.entries(s.refs).reverse()) }));
  assert.equal(JSON.stringify(s), before);
  assert.deepEqual(violations(fingerprint(s), fingerprint(s)), []);
});

test("collector on a real repository: core.worktree, hook, untracked and ff", () => {
  const sh = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" });
  const prim = mkdtempSync(join(tmpdir(), "sg-"));
  sh(prim, "init", "-q", "-b", "main"); sh(prim, "config", "user.email", "a@b"); sh(prim, "config", "user.name", "t");
  writeFileSync(join(prim, "f"), "1"); sh(prim, "add", "."); sh(prim, "commit", "-qm", "one");
  const wt = join(prim, ".workspace", "worktrees", "issue-5");
  sh(prim, "worktree", "add", "-q", "-b", "factory/issue-5", wt, "main");
  const b = collectSnapshot(wt, { state: join(prim, "st") });
  assert.deepEqual(compareSnapshots(b, collectSnapshot(wt, { state: join(prim, "st") }), gitIsFastForward(b)), []);
  // own worktree and branch activity, and a scratch dir in .workspace/worktrees, are not violations
  writeFileSync(join(wt, "new"), "x"); sh(wt, "add", "."); sh(wt, "commit", "-qm", "own");
  mkdirSync(join(prim, ".workspace", "worktrees", "issue-6"), { recursive: true }); writeFileSync(join(prim, ".workspace", "worktrees", "issue-6", "f"), "y");
  assert.deepEqual(compareSnapshots(b, collectSnapshot(wt, { state: join(prim, "st") }), gitIsFastForward(b)), []);
  sh(prim, "branch", "-f", "side", "main");
  sh(prim, "config", "core.worktree", "/tmp/elsewhere");
  const v = compareSnapshots(b, collectSnapshot(wt, { state: join(prim, "st") }), gitIsFastForward(b));
  assert.ok(v.some((i) => /core|worktree = \/tmp\/elsewhere/.test(i)), v.join("\n"));
  assert.ok(v.some((i) => /refs\/heads\/side/.test(i)));
  sh(prim, "config", "--unset", "core.worktree");
  mkdirSync(join(prim, ".git", "hooks"), { recursive: true }); writeFileSync(join(prim, ".git", "hooks", "pre-push"), "#!/bin/sh\n");
  writeFileSync(join(prim, "stray"), "s");
  const v2 = compareSnapshots(b, collectSnapshot(wt, { state: join(prim, "st") }), gitIsFastForward(b));
  assert.ok(v2.some((i) => /hooks\/pre-push: added/.test(i)) && v2.some((i) => /\?\? stray/.test(i)), v2.join("\n"));
});

test("collector: nested hooks and every linked worktree's config.worktree are read; failures throw", () => {
  const sh = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" });
  const prim = mkdtempSync(join(tmpdir(), "sg2-"));
  sh(prim, "init", "-q", "-b", "main"); sh(prim, "-c", "user.email=a@b", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i");
  const w1 = join(prim, ".workspace", "worktrees", "issue-1"), w2 = join(prim, ".workspace", "worktrees", "issue-2");
  sh(prim, "worktree", "add", "-q", "-b", "factory/issue-1", w1); sh(prim, "worktree", "add", "-q", "-b", "factory/issue-2", w2);
  const b = collectSnapshot(w1);
  mkdirSync(join(prim, ".git", "hooks", "d"), { recursive: true }); writeFileSync(join(prim, ".git", "hooks", "d", "x"), "x");
  writeFileSync(join(prim, ".git", "worktrees", "issue-2", "config.worktree"), "[core]\n\tworktree = /x\n");
  const v = compareSnapshots(b, collectSnapshot(w1), gitIsFastForward(b));
  assert.ok(v.some((i) => /hooks\/d\/x: added/.test(i)) && v.some((i) => /issue-2\/config\.worktree/.test(i)), v.join("\n"));
  writeFileSync(join(prim, ".git", "HEAD"), "garbage\n");
  assert.throws(() => collectSnapshot(w1), /not a git repository/, "an unreadable repository throws: the station treats it as a violation");
  assert.equal(collectSnapshot(tmpdir()), null);
});
