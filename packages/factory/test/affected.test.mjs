// #1120: test what is in use (@a4s/factory) plus what changes; the scoped gate; the local-identity guard.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { affectedWorkspaces, isRootTrigger, listWorkspaces, selectForGate } from "../src/affected.mjs";
import { changedPaths } from "../src/changes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..", "..");
const WS = [
  { name: "@a4s/context-expert", dir: "packages/context-expert" },
  { name: "@a4s/factory", dir: "packages/factory" },
  { name: "@a4s/omp-dagu", dir: "packages/omp-dagu" },
  { name: "@a4s/synagent-bus", dir: "packages/synagent/bus" },
  { name: "@a4s/synagent", dir: "packages/synagent/core" },
];
const names = (sel) => sel.map((s) => s.name).sort();
const git = (cwd, ...a) => { const r = spawnSync("git", a, { cwd, encoding: "utf8" }); assert.equal(r.status, 0, `git ${a.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };

test("factory-only change selects the factory only, because it is in use", () => {
  const sel = affectedWorkspaces(["packages/factory/src/lib.mjs"], WS);
  assert.deepEqual(sel, [{ name: "@a4s/factory", dir: "packages/factory", why: "in use" }]);
  assert.deepEqual(names(affectedWorkspaces([], WS)), ["@a4s/factory"]);
  assert.deepEqual(names(affectedWorkspaces(["docs/glossary.md", "README.md", "agents/x.md", "skills/y/SKILL.md"], WS)), ["@a4s/factory"]);
});

test("a change in packages/synagent selects synagent plus the factory (longest dir wins)", () => {
  const sel = affectedWorkspaces(["packages/synagent/core/src/x.ts"], WS);
  assert.deepEqual(names(sel), ["@a4s/factory", "@a4s/synagent"]);
  assert.equal(sel.find((s) => s.name === "@a4s/synagent").why, "changed packages/synagent/core/src/x.ts");
  // a dir that is a prefix of another name is not a match
  assert.deepEqual(names(affectedWorkspaces(["packages/omp-dagu-extra/x"], WS)), ["@a4s/factory"]);
});

test("root files select every workspace", () => {
  for (const p of ["package.json", "package-lock.json", ".npmrc", ".nvmrc", "tsconfig.base.json", "scripts/x.sh", ".github/workflows/ci.yml"]) {
    assert.ok(isRootTrigger(p), p);
    const sel = affectedWorkspaces(["packages/factory/a", p], WS);
    assert.equal(sel.length, WS.length, p);
    assert.ok(sel.every((s) => s.why === `root file ${p}`), p);
  }
  for (const p of ["packages/factory/package.json", "packages/x/tsconfig.json", "docs/scripts/x"]) assert.ok(!isRootTrigger(p), p);
});

test("a rename from one package to another selects both (plus the factory)", () => {
  assert.deepEqual(names(affectedWorkspaces(["packages/omp-dagu/a.ts", "packages/context-expert/a.ts"], WS)),
    ["@a4s/context-expert", "@a4s/factory", "@a4s/omp-dagu"]);
});

test("unknown base selects every workspace", () => {
  const sel = affectedWorkspaces(null, WS);
  assert.equal(sel.length, WS.length);
  assert.ok(sel.every((s) => s.why === "base unknown"));
});

test("dependents of a changed workspace are selected too", () => {
  const ws = [...WS, { name: "@a4s/uses-bus", dir: "packages/uses-bus", deps: ["@a4s/synagent-bus"] }];
  const sel = affectedWorkspaces(["packages/synagent/bus/x"], ws);
  assert.deepEqual(names(sel), ["@a4s/factory", "@a4s/synagent-bus", "@a4s/uses-bus"]);
  assert.equal(sel.find((s) => s.name === "@a4s/uses-bus").why, "depends on @a4s/synagent-bus");
});

test("listWorkspaces expands dir/* and exact dirs of the repository and throws on other globs", () => {
  const ws = listWorkspaces(REPO);
  const dirs = ws.map((w) => w.dir);
  for (const d of ["packages/factory", "packages/synagent/core", "packages/synagent/bus"]) assert.ok(dirs.includes(d), d);
  assert.ok(!dirs.includes("packages/synagent"), "packages/synagent has no package.json");
  assert.equal(ws.find((w) => w.dir === "packages/synagent/core").name, "@a4s/synagent");
  const root = mkdtempSync(join(tmpdir(), "affected-glob-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/**"] }));
  assert.throws(() => listWorkspaces(root), /unsupported workspace glob/);
  assert.deepEqual(selectForGate(root, "HEAD"), { names: null, lines: ["gate: all: unsupported workspace glob: packages/**"] });
});

/** a git repo with fake workspaces and copies of scripts/gate.sh and the factory's affected.mjs + changes.mjs */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "affected-gate-"));
  git(root, "init", "-q", "-b", "main");
  for (const [k, v] of [["user.name", "t"], ["user.email", "t@t"], ["commit.gpgsign", "false"]]) git(root, "config", k, v);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "r", workspaces: ["packages/*", "packages/synagent/*"] }));
  for (const [dir, name] of [["packages/factory", "@a4s/factory"], ["packages/omp-dagu", "@a4s/omp-dagu"], ["packages/synagent/core", "@a4s/synagent"], ["packages/context-expert", "@a4s/context-expert"]]) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "package.json"), JSON.stringify({ name }));
    writeFileSync(join(root, dir, "a.txt"), "a\n");
  }
  mkdirSync(join(root, "scripts"));
  copyFileSync(join(REPO, "scripts", "gate.sh"), join(root, "scripts", "gate.sh"));
  mkdirSync(join(root, "packages", "factory", "src"));
  for (const f of ["affected.mjs", "changes.mjs"]) copyFileSync(join(REPO, "packages", "factory", "src", f), join(root, "packages", "factory", "src", f));
  git(root, "add", "-A"); git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "issue");
  return root;
}
// the caller's GATE_BASE (factory-gate.sh exports it) must not leak into the fixture
const { GATE_BASE: _ignored, ...cleanEnv } = process.env;
const gate = (root, env = {}) => spawnSync("bash", ["scripts/gate.sh"], { cwd: root, encoding: "utf8",
  env: { ...cleanEnv, GATE_DRY_RUN: "1", ...env } });

test("gate fixture: a candidate touching only packages/factory runs no other workspace's commands", () => {
  const root = fixture();
  writeFileSync(join(root, "packages", "factory", "a.txt"), "changed\n");
  const r = gate(root, { GATE_BASE: "main" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "gate-dry-run: npm ci\ngate-dry-run: npm test --workspace @a4s/factory --if-present\n"
    + "gate-dry-run: npm run typecheck --workspace @a4s/factory --if-present\n");
  assert.match(r.stderr, /^gate: @a4s\/factory: in use$/m);
  assert.match(r.stderr, /^gate: workspaces: @a4s\/factory$/m);
});

test("gate fixture: committed and untracked changes in another workspace select it, with why", () => {
  const root = fixture();
  writeFileSync(join(root, "packages", "omp-dagu", "a.txt"), "c\n"); git(root, "commit", "-qam", "c");
  writeFileSync(join(root, "packages", "synagent", "core", "new.txt"), "u\n");
  assert.deepEqual(changedPaths(root, "main"), ["packages/omp-dagu/a.txt", "packages/synagent/core/new.txt"]);
  const r = gate(root, { GATE_BASE: "main" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^gate: @a4s\/omp-dagu: changed packages\/omp-dagu\/a.txt$/m);
  assert.match(r.stderr, /^gate: @a4s\/synagent: changed packages\/synagent\/core\/new.txt$/m);
  assert.match(r.stdout, /npm test --workspace @a4s\/omp-dagu/);
  assert.match(r.stdout, /npm test --workspace @a4s\/synagent /);
  assert.doesNotMatch(r.stdout, /context-expert/);
});

test("gate fixture: a rename across workspaces counts by both paths", () => {
  const root = fixture();
  git(root, "mv", "packages/omp-dagu/a.txt", "packages/synagent/core/b.txt"); git(root, "commit", "-qm", "mv");
  assert.deepEqual(changedPaths(root, "main"), ["packages/omp-dagu/a.txt", "packages/synagent/core/b.txt"]);
});

test("gate fixture: root files, an unknown base and no GATE_BASE run the full gate", () => {
  const full = "gate-dry-run: npm ci\ngate-dry-run: npm test\ngate-dry-run: npm run typecheck\n";
  const root = fixture();
  for (const env of [{}, { GATE_BASE: "nope" }, { GATE_BASE: "0000000000000000000000000000000000000000" }]) {
    const r = gate(root, env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, full, JSON.stringify(env));
  }
  assert.match(gate(root, { GATE_BASE: "nope" }).stderr, /^gate: all: base unknown$/m);
  writeFileSync(join(root, "package.json"), readFileSync(join(root, "package.json"), "utf8") + "\n");
  const r = gate(root, { GATE_BASE: "main" });
  assert.equal(r.stdout, full);
  assert.match(r.stderr, /^gate: all: root file package.json$/m);
});

test("factory-gate.sh scopes the gate to BASE and runs the identity guard first", () => {
  const fg = readFileSync(join(REPO, "scripts", "factory-gate.sh"), "utf8");
  assert.match(fg, /^export GATE_BASE=\$\{GATE_BASE:-\$\{BASE:-main\}\}$/m);
  assert.ok(fg.indexOf("check-identity.sh") < fg.indexOf("scripts/gate.sh"));
  const ci = readFileSync(join(REPO, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(ci, /^ {2}validate:$/m);
  assert.equal((ci.slice(ci.indexOf("\njobs:")).match(/^ {2}[\w-]+:$/gm) || []).length, 1, "one job only");
  assert.match(ci, /fetch-depth: 0/);
  assert.match(ci, /GATE_BASE: \$\{\{ github\.event_name == 'pull_request' && format\('origin\/\{0\}', github\.base_ref\) \|\| github\.event\.before \}\}/);
});

const GUARD = join(REPO, "packages", "factory", "src", "check-identity.sh");
test("identity guard: fails with a clear message when the primary checkout has a local user.name/user.email", () => {
  const root = mkdtempSync(join(tmpdir(), "identity-"));
  const primary = join(root, "primary"), wt = join(root, "wt");
  git(root, "init", "-q", "-b", "main", primary);
  git(primary, "-c", "user.name=x", "-c", "user.email=x@x", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "base");
  git(primary, "worktree", "add", "-q", "-b", "hand/x", wt);
  const env = { ...process.env };
  delete env.A4S_PRIMARY;
  const guard = (cwd) => spawnSync("bash", [GUARD], { cwd, encoding: "utf8", env });
  assert.equal(guard(wt).status, 0, guard(wt).stderr);
  git(primary, "config", "--local", "user.name", "Reconcile Test");
  for (const cwd of [wt, primary]) {
    const r = guard(cwd);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /the primary checkout .*primary has a local git identity \(user\.name="Reconcile Test"\)/);
  }
  git(primary, "config", "--local", "user.email", "t@t");
  assert.match(guard(wt).stderr, /user\.name="Reconcile Test" user\.email="t@t"/);
  git(primary, "config", "--local", "--unset", "user.name"); git(primary, "config", "--local", "--unset", "user.email");
  assert.equal(guard(wt).status, 0);
});
