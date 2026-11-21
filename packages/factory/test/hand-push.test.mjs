// scripts/hand-push.sh (#1118): a hand fix goes to the trunk through the integration window.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { leaseDir, readLease, takeLease, releaseLease } from "../src/lease.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "..", "..", "scripts", "hand-push.sh");
const LEASE = join(here, "..", "src", "lease.mjs");
const git = (cwd, ...a) => { const r = spawnSync("git", a, { cwd, encoding: "utf8" }); assert.equal(r.status, 0, `git ${a.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };

/** bare remote + primary clone on main + a hand-fix worktree with one commit */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hand-push-"));
  const remote = join(root, "remote.git"), primary = join(root, "primary"), wt = join(root, "wt"), state = join(root, "state");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "clone", "-q", remote, primary);
  for (const [k, v] of [["user.name", "t"], ["user.email", "t@t"], ["commit.gpgsign", "false"]]) git(primary, "config", k, v);
  git(primary, "checkout", "-q", "-b", "main");
  writeFileSync(join(primary, "a.txt"), "a\n");
  git(primary, "add", "-A"); git(primary, "commit", "-q", "-m", "base"); git(primary, "push", "-q", "origin", "main");
  git(primary, "worktree", "add", "-q", "-b", "hand/x", wt);
  writeFileSync(join(wt, "b.txt"), "fix\n");
  git(wt, "add", "-A"); git(wt, "commit", "-q", "-m", "hand fix");
  return { root, remote, primary, wt, state };
}
const run = (f, cwd, env = {}) => spawnSync("bash", [SCRIPT, "x"], { cwd, encoding: "utf8",
  env: { ...process.env, A4S_PRIMARY: f.primary, A4S_STATE: f.state, A4S_LEASE_JS: LEASE, GATE: "true", HAND_PUSH_SKIP_CI: "1", ...env } });

test("hand-push: takes the manual lease, pushes the rebased fix, fast-forwards the primary, releases the lease", () => {
  const f = fixture();
  // the trunk moved meanwhile: the fix is rebased onto it
  const other = mkdtempSync(join(tmpdir(), "hand-push-o-"));
  git(other, "clone", "-q", f.remote, "c"); const c = join(other, "c");
  for (const [k, v] of [["user.name", "t"], ["user.email", "t@t"], ["commit.gpgsign", "false"]]) git(c, "config", k, v);
  writeFileSync(join(c, "c.txt"), "c\n"); git(c, "add", "-A"); git(c, "commit", "-q", "-m", "moved"); git(c, "push", "-q", "origin", "main");
  const gateLog = join(f.root, "gate.log");
  const r = run(f, f.wt, { GATE: `node ${LEASE} holder --state ${f.state} > ${gateLog}` });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const held = JSON.parse(readFileSync(gateLog, "utf8")); // the gate ran inside the window, as a manual holder
  assert.deepEqual([held.run, held.manual], ["hand-x", true]);
  assert.equal(readLease(f.state), null);
  const tip = git(f.remote, "rev-parse", "main");
  assert.equal(git(f.remote, "log", "-1", "--format=%s", "main"), "hand fix");
  assert.equal(git(f.remote, "log", "-1", "--format=%s", "main~1"), "moved");
  assert.equal(git(f.primary, "rev-parse", "HEAD"), tip);
  assert.match(r.stdout, new RegExp(`pushed ${tip}`));
});

test("hand-push: a failing gate pushes nothing and still releases the lease", () => {
  const f = fixture();
  const before = git(f.remote, "rev-parse", "main");
  const r = run(f, f.wt, { GATE: "false" });
  assert.notEqual(r.status, 0);
  assert.equal(git(f.remote, "rev-parse", "main"), before);
  assert.equal(readLease(f.state), null);
  assert.ok(readdirSync(leaseDir(f.state)).some((n) => n.endsWith(".released")));
});

test("hand-push: waits while a run holds the lease; refuses the primary checkout and a dirty worktree", () => {
  const f = fixture();
  takeLease(f.state, "run-live", { dag: "cycle" });
  // the live run is not a Dagu run here: the CLI asks Dagu, which does not know it -> reclaimed. Stub Dagu as "running".
  const bin = join(f.root, "bin"); spawnSync("mkdir", [bin]);
  writeFileSync(join(bin, "dagu"), "#!/bin/sh\necho 'Running - 2026-11-20T00:00:00Z'\n", { mode: 0o755 });
  const p = spawnSync("bash", ["-c", `timeout 3 bash ${SCRIPT} x; echo rc=$?`], { cwd: f.wt, encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, A4S_PRIMARY: f.primary, A4S_STATE: f.state, A4S_LEASE_JS: LEASE, GATE: "true", HAND_PUSH_SKIP_CI: "1", LEASE_POLL_MS: "50" } });
  assert.match(p.stdout, /rc=124/); // still waiting when killed
  assert.match(p.stderr, /waiting for the integration lease held by run-live/);
  assert.equal(readLease(f.state).run, "run-live");
  releaseLease(f.state, "run-live");
  assert.equal(run(f, f.primary).status, 2);
  writeFileSync(join(f.wt, "dirty.txt"), "x\n");
  assert.equal(run(f, f.wt).status, 2);
});
