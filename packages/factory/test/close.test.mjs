import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FACTORY = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (cwd, ...a) => {
  const r = spawnSync("git", ["-c", "user.email=t@a4s", "-c", "user.name=t", ...a], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

// fixture: origin (bare) + primary + an integrated issue worktree/branch + a gh stub
function fixture({ push }) {
  const root = mkdtempSync(join(tmpdir(), "close-test-"));
  const origin = join(root, "origin.git"), primary = join(root, "primary"), state = join(root, "state"), bin = join(root, "bin");
  mkdirSync(bin); mkdirSync(state);
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, primary);
  git(primary, "checkout", "-q", "-B", "main");
  writeFileSync(join(primary, "a"), "1\n");
  git(primary, "add", "-A"); git(primary, "commit", "-qm", "init"); git(primary, "push", "-q", "origin", "main");
  const wt = join(primary, ".workspace", "worktrees", "issue-9");
  git(primary, "worktree", "add", "-q", "-B", "factory/issue-9", wt, "main");
  writeFileSync(join(wt, "b"), "2\n");
  git(wt, "add", "-A"); git(wt, "commit", "-qm", "work");
  git(primary, "merge", "-q", "--ff-only", "factory/issue-9");
  if (push) git(primary, "push", "-q", "origin", "main");
  const sha = git(primary, "rev-parse", "HEAD");
  // gh stub: `issue view` prints the state kept in a file; `issue close` records state and the comment
  const ghState = join(root, "gh-state"), ghLog = join(root, "gh-log");
  writeFileSync(ghState, "OPEN\n"); writeFileSync(ghLog, "");
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash\nif [ "$2" = view ]; then cat "${ghState}"; elif [ "$2" = close ]; then echo CLOSED > "${ghState}"; echo comment >> "${ghLog}"; fi\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const env = (extra = {}) => ({ PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, ISSUE: "9", PRIMARY: primary, FACTORY,
    T3_HOME: join(root, "t3"), STATE: state, BASE: "main", PUSH: String(push), CLOSE_ISSUE: "true", SHA: sha, DAG_RUN_ID: "run-1", ...extra });
  const run = (script, extra) => spawnSync("bash", [join(FACTORY, "src", script)], { env: env(extra), encoding: "utf8" });
  return { root, primary, state, wt, sha, ghLog, run, ghState };
}

test("close twice: second run succeeds and does not comment again", () => {
  const f = fixture({ push: true });
  const a = f.run("close.sh");
  assert.equal(a.status, 0, a.stderr);
  const b = f.run("close.sh");
  assert.equal(b.status, 0, b.stderr);
  assert.equal(readFileSync(f.ghLog, "utf8").trim().split("\n").length, 1);
  assert.ok(!existsSync(f.wt));
  const d = JSON.parse(readFileSync(join(f.state, "9", "done.json"), "utf8"));
  assert.deepEqual([d.run_id, d.commit, typeof d.timestamp], ["run-1", f.sha, "string"]);
  const v = f.run("verify-close.sh");
  assert.equal(v.status, 0, v.stdout + v.stderr);
});

test("close after a partial close (worktree already removed) succeeds", () => {
  const f = fixture({ push: true });
  git(f.primary, "worktree", "remove", "--force", f.wt);
  assert.equal(f.run("close.sh").status, 0);
});

test("verify_close fails before close and names each failing check", () => {
  const f = fixture({ push: true });
  const v = f.run("verify-close.sh");
  assert.notEqual(v.status, 0);
  for (const c of ["issue_closed", "worktree_removed", "branch_removed", "done_json"]) assert.match(v.stdout, new RegExp(`${c}\\s+FAIL`));
  assert.match(v.stdout, /origin_has_commit\s+ok/);
});

test("verify_close fails when the commit is not on origin", () => {
  const f = fixture({ push: false });
  f.run("close.sh", { PUSH: "false" });
  const v = f.run("verify-close.sh", { PUSH: "true" });
  assert.notEqual(v.status, 0);
  assert.match(v.stdout, /origin_has_commit\s+FAIL/);
});

test("PUSH=false CLOSE_ISSUE=false: remote and issue checks are skipped", () => {
  const f = fixture({ push: false });
  assert.equal(f.run("close.sh", { PUSH: "false", CLOSE_ISSUE: "false" }).status, 0);
  const v = f.run("verify-close.sh", { PUSH: "false", CLOSE_ISSUE: "false" });
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.match(v.stdout, /origin_has_commit\s+skipped/);
  assert.match(v.stdout, /issue_closed\s+skipped/);
  assert.match(v.stdout, /primary_equals_origin\s+skipped/);
});
