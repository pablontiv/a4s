import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pathsFromNameStatus, readActiveProtection } from "../src/integration-protection.ts";

const cli = fileURLToPath(new URL("../bin/dagu-feature-protect.ts", import.meta.url));
const featureYaml = fileURLToPath(new URL("../skills/issue-execution/feature.yaml", import.meta.url));
const skill = fileURLToPath(new URL("../skills/issue-execution/SKILL.md", import.meta.url));
const protectedPath = "packages/issue-lifecycle/skills/issue-execution/SKILL.md";
const disjointPath = "packages/issue-lifecycle/skills/issue-execution/feature.yaml";
const addedPath = "packages/issue-lifecycle/skills/issue-execution/notes.txt";

const bin = mkdtempSync(join(tmpdir(), "a4s-integration-bin-"));
symlinkSync(fileURLToPath(new URL("../bin/dagu-gate.cjs", import.meta.url)), join(bin, "dagu-gate"));
symlinkSync(cli, join(bin, "dagu-feature-protect"));

function git(cwd: string, ...args: string[]): string {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).stdout.trim();
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

interface Lane {
  issue: string;
  run: string;
  branch: string;
  worktree: string;
  state: string;
  sha: string;
}

function repository(): { root: string; primary: string } {
  const root = mkdtempSync(join(tmpdir(), "a4s-integration-"));
  const primary = join(root, "primary");
  mkdirSync(primary);
  runGit(primary, ["init", "-b", "main"]);
  runGit(primary, ["config", "user.name", "Integration Test"]);
  runGit(primary, ["config", "user.email", "integration@example.com"]);
  writeFileSync(join(primary, "README.txt"), "base\n");
  runGit(primary, ["add", "."]);
  runGit(primary, ["commit", "-m", "base"]);
  return { root, primary };
}

function lane(primary: string, issue: string, files: Record<string, string>): Lane {
  const branch = `dagu/issue-${issue}`;
  const worktree = join(primary, ".workspace", "worktrees", `issue-${issue}`);
  runGit(primary, ["worktree", "add", "-b", branch, worktree, "main"]);
  for (const [path, content] of Object.entries(files)) {
    const target = join(worktree, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  runGit(worktree, ["add", "."]);
  runGit(worktree, ["commit", "-m", `feat: issue ${issue}`]);
  const run = `feature-${issue}`;
  const state = join(primary, ".git", "dagu-feature", "runs", run);
  mkdirSync(state, { recursive: true });
  const sha = git(worktree, "rev-parse", "HEAD");
  writeFileSync(join(state, "candidate.json"), `${JSON.stringify({
    sha, base: git(worktree, "rev-parse", "HEAD^"), iteration: 3,
    tree: git(worktree, "rev-parse", "HEAD^{tree}"), message: `feat: issue ${issue}`,
  })}\n`);
  return { issue, run, branch, worktree, state, sha };
}

function environment(primary: string, entry: Lane, gate = "true"): NodeJS.ProcessEnv {
  return {
    ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, PRIMARY: primary, WORKTREE: entry.worktree,
    BRANCH: entry.branch, RUN: entry.run, ISSUE: entry.issue, BASE_BRANCH: "main", GATE: gate,
    OMP_SESSION_ID: "owner-session", A4S_INTEGRATION_POLL_SEC: "0.05",
  };
}

function protect(primary: string, entry: Lane, decision: string) {
  return spawnSync(cli, ["protect", "--decision", decision], { encoding: "utf8", env: environment(primary, entry) });
}

function invoke(primary: string, entry: Lane, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(cli, args, { encoding: "utf8", env: { ...environment(primary, entry), ...env } });
}

function candidateText(entry: Lane): string {
  return readFileSync(join(entry.state, "candidate.json"), "utf8");
}

function extract(id: string): string {
  const lines = readFileSync(featureYaml, "utf8").split("\n");
  const marker = lines.indexOf(`  - id: ${id}`);
  assert.notEqual(marker, -1, id);
  const run = lines.indexOf("    run: |", marker);
  assert.notEqual(run, -1, id);
  let end = run + 1;
  while (end < lines.length && (lines[end]!.startsWith("      ") || lines[end] === "")) end += 1;
  return lines.slice(run + 1, end).map(line => line.slice(6)).join("\n");
}

function stop(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null || child.signalCode) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}

async function waitFor(read: () => string, pattern: RegExp): Promise<string> {
  const deadline = Date.now() + 10_000;
  let text = "";
  while (Date.now() < deadline) {
    text = read();
    if (pattern.test(text)) return text;
    await delay(20);
  }
  throw new Error(`missing ${pattern}: ${text}`);
}

test("changed-path status keeps both sides of a rename", () => {
  assert.deepEqual(pathsFromNameStatus("M\tkeep.txt\nR100\told.md\tnew.md\n"), ["keep.txt", "new.md", "old.md"]);
});

test("protection is created only by an explicit decision and refuses a second active candidate", () => {
  const { root, primary } = repository();
  try {
    const protectedLane = lane(primary, "290", { [protectedPath]: "protected\n" });
    const other = lane(primary, "548", { [protectedPath]: "conflict\n" });
    const refused = protect(primary, protectedLane, "   ");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /explicit operator decision/);
    assert.equal(existsSync(join(primary, ".git", "dagu-feature", "integration-protection.json")), false);
    const created = protect(primary, protectedLane, "Until #290 merges, hold conflicting candidates");
    assert.equal(created.status, 0, created.stderr);
    const record = JSON.parse(invoke(primary, protectedLane, ["status"]).stdout);
    assert.equal(record.status, "active");
    assert.equal(record.protectedRun, "feature-290");
    assert.equal(record.issue, "290");
    assert.deepEqual(record.paths, [protectedPath]);
    assert.equal(record.candidateSha, protectedLane.sha);
    assert.equal(record.decision, "Until #290 merges, hold conflicting candidates");
    assert.equal(record.provenance.command, "dagu-feature-protect protect");
    assert.equal(record.provenance.sessionId, "owner-session");
    assert.equal(record.held.length, 0);
    const second = protect(primary, other, "protect the other run");
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /protected_run=feature-290/);
    assert.equal(JSON.parse(invoke(primary, protectedLane, ["status"]).stdout).protectedRun, "feature-290");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("capture refresh widens the protected paths and a removed path lets the old conflict proceed", () => {
  const { root, primary } = repository();
  try {
    const protectedLane = lane(primary, "290", { [protectedPath]: "protected\n" });
    const notes = lane(primary, "600", { [addedPath]: "notes\n" });
    assert.equal(protect(primary, protectedLane, "protect #290").status, 0);
    assert.equal(invoke(primary, notes, ["admit", "--checkpoint", "gate"]).status, 0);
    const target = join(protectedLane.worktree, addedPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "added\n");
    runGit(protectedLane.worktree, ["add", "."]);
    runGit(protectedLane.worktree, ["commit", "-m", "feat: refresh paths"]);
    const sha = git(protectedLane.worktree, "rev-parse", "HEAD");
    const candidate = JSON.parse(candidateText(protectedLane));
    candidate.sha = sha;
    candidate.tree = git(protectedLane.worktree, "rev-parse", "HEAD^{tree}");
    writeFileSync(join(protectedLane.state, "candidate.json"), `${JSON.stringify(candidate)}\n`);
    assert.equal(invoke(primary, protectedLane, ["refresh"]).status, 0, invoke(primary, protectedLane, ["refresh"]).stderr);
    assert.deepEqual(JSON.parse(invoke(primary, protectedLane, ["status"]).stdout).paths, [protectedPath, addedPath]);
    const held = invoke(primary, notes, ["admit", "--checkpoint", "push"]);
    assert.equal(held.status, 86, held.stderr);
    assert.match(held.stderr, /checkpoint=integration_hold/);
    assert.match(held.stderr, /protected_run=feature-290/);
    const beforeRename = sha;
    runGit(protectedLane.worktree, ["mv", protectedPath, protectedPath.replace(/SKILL\.md$/, "SKILL-renamed.md")]);
    runGit(protectedLane.worktree, ["commit", "-m", "refactor: rename skill"]);
    const renamed = git(protectedLane.worktree, "rev-parse", "HEAD");
    candidate.base = beforeRename;
    candidate.sha = renamed;
    candidate.tree = git(protectedLane.worktree, "rev-parse", "HEAD^{tree}");
    writeFileSync(join(protectedLane.state, "candidate.json"), `${JSON.stringify(candidate)}\n`);
    assert.equal(invoke(primary, protectedLane, ["refresh"]).status, 0);
    const paths = JSON.parse(invoke(primary, protectedLane, ["status"]).stdout).paths as string[];
    assert.ok(paths.includes(protectedPath));
    assert.ok(paths.includes(protectedPath.replace(/SKILL\.md$/, "SKILL-renamed.md")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("operator release and abort release a held run without changing its candidate", () => {
  const { root, primary } = repository();
  try {
    const protectedLane = lane(primary, "290", { [protectedPath]: "protected\n" });
    const conflicting = lane(primary, "548", { [protectedPath]: "conflict\n" });
    const before = candidateText(conflicting);
    assert.equal(protect(primary, protectedLane, "protect #290").status, 0);
    assert.equal(invoke(primary, conflicting, ["admit", "--checkpoint", "auto_merge"]).status, 86);
    const released = spawnSync(cli, ["release", "--decision", "operator release"], {
      encoding: "utf8", env: { ...environment(primary, conflicting), RUN: "" },
    });
    assert.equal(released.status, 0, released.stderr);
    assert.match(released.stderr, /reason=operator/);
    assert.equal(invoke(primary, conflicting, ["admit", "--checkpoint", "gate"]).status, 0);
    assert.equal(candidateText(conflicting), before);
    assert.equal(protect(primary, protectedLane, "protect #290 again").status, 0);
    assert.equal(invoke(primary, conflicting, ["admit", "--checkpoint", "gate"]).status, 86);
    const aborted = invoke(primary, protectedLane, ["release-auto", "--reason", "abort"]);
    assert.equal(aborted.status, 0, aborted.stderr);
    assert.match(aborted.stderr, /reason=abort/);
    assert.equal(invoke(primary, conflicting, ["status"]).stdout, "integration protection: none\n");
    assert.equal(invoke(primary, conflicting, ["admit", "--checkpoint", "gate"]).status, 0);
    assert.equal(candidateText(conflicting), before);
    assert.equal(JSON.parse(candidateText(conflicting)).iteration, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("admission inside an already held gate lock does not take the lock again", async () => {
  const { root, primary } = repository();
  const entry = lane(primary, "290", { [protectedPath]: "protected\n" });
  mkdirSync(join(primary, ".git", "dagu-feature"), { recursive: true });
  let locked = "";
  const holder = spawn("python3", ["-c", `
import fcntl, os, sys, time
fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX)
sys.stdout.write("locked\\n"); sys.stdout.flush()
time.sleep(30)
`, join(primary, ".git", "dagu-feature", "gate.lock")], { stdio: ["ignore", "pipe", "pipe"] });
  assert.ok(holder.stdout);
  holder.stdout.on("data", chunk => { locked += chunk; });
  try {
    const deadline = Date.now() + 5_000;
    while (!locked.includes("locked\n")) {
      if (Date.now() > deadline || holder.exitCode !== null) throw new Error(locked || "lock helper exited");
      await delay(20);
    }
    const admitted = invoke(primary, entry, ["admit", "--checkpoint", "gate", "--held-lock"]);
    assert.equal(admitted.status, 0, admitted.stderr);
  } finally {
    holder.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("a conflicting gate waits, a disjoint gate passes, and restart keeps the candidate until protected termination", { timeout: 30_000 }, async () => {
  const { root, primary } = repository();
  const children: ChildProcess[] = [];
  try {
    const protectedLane = lane(primary, "290", { [protectedPath]: "protected\n" });
    const conflicting = lane(primary, "548", { [protectedPath]: "conflict\n" });
    const disjoint = lane(primary, "555", { [disjointPath]: "disjoint\n" });
    const before = candidateText(conflicting);
    assert.equal(protect(primary, protectedLane, "Until #290 merges, hold conflicting candidates").status, 0);
    const protectedMarker = join(root, "protected-gated");
    const disjointMarker = join(root, "disjoint-gated");
    const conflictingMarker = join(root, "conflicting-gated");
    const script = extract("gate");
    const start = (entry: Lane, marker: string) => {
      let stderr = "";
      const child = spawn("bash", ["-c", script], {
        env: environment(primary, entry, `touch ${JSON.stringify(marker)}`),
        detached: true, stdio: ["ignore", "pipe", "pipe"],
      });
      assert.ok(child.stderr);
      child.stderr.on("data", chunk => { stderr += chunk; });
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", code => resolve(code));
      });
      children.push(child);
      return { stderr: () => stderr, exited };
    };
    const waiting = start(conflicting, conflictingMarker);
    const checkpoint = /integration protection: checkpoint=integration_hold stage=gate run=feature-548 issue=548 protected_run=feature-290 protected_issue=290 paths=.*SKILL\.md/;
    assert.match(await waitFor(waiting.stderr, checkpoint), checkpoint);
    assert.equal(existsSync(conflictingMarker), false);
    const protectedGate = spawnSync("bash", ["-c", script], {
      encoding: "utf8", env: environment(primary, protectedLane, `touch ${JSON.stringify(protectedMarker)}`),
    });
    assert.equal(protectedGate.status, 0, protectedGate.stderr);
    assert.equal(existsSync(protectedMarker), true);
    const disjointGate = spawnSync("bash", ["-c", script], {
      encoding: "utf8", env: environment(primary, disjoint, `touch ${JSON.stringify(disjointMarker)}`),
    });
    assert.equal(disjointGate.status, 0, disjointGate.stderr);
    assert.equal(existsSync(disjointMarker), true);
    assert.equal(existsSync(conflictingMarker), false);
    const active = readActiveProtection(primary);
    assert.deepEqual(active?.held, ["feature-548"]);
    assert.equal(candidateText(conflicting), before);
    stop(children.pop()!);
    assert.equal(candidateText(conflicting), before);
    const restarted = invoke(primary, conflicting, ["admit", "--checkpoint", "gate"]);
    assert.equal(restarted.status, 86, restarted.stderr);
    assert.equal(JSON.parse(candidateText(conflicting)).iteration, 3);
    const resumed = start(conflicting, conflictingMarker);
    assert.match(await waitFor(resumed.stderr, checkpoint), checkpoint);
    const terminated = invoke(primary, protectedLane, ["release-auto", "--reason", "terminal"]);
    assert.equal(terminated.status, 0, terminated.stderr);
    assert.equal(await resumed.exited, 0);
    assert.equal(existsSync(conflictingMarker), true);
    assert.equal(candidateText(conflicting), before);
    assert.equal(git(conflicting.worktree, "rev-parse", "HEAD"), conflicting.sha);
    assert.equal(readActiveProtection(primary), undefined);
  } finally {
    for (const child of children) stop(child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("feature hooks name protection, refresh and release", () => {
  const source = readFileSync(featureYaml, "utf8");
  for (const id of ["gate", "push", "auto_merge"]) {
    const parsed = spawnSync("bash", ["-n"], { input: extract(id), encoding: "utf8" });
    assert.equal(parsed.status, 0, `${id}: ${parsed.stderr}`);
  }
  assert.match(source, /dagu-feature-protect admit --checkpoint gate --held-lock/);
  assert.match(source, /dagu-feature-protect admit --checkpoint push/);
  assert.match(source, /dagu-feature-protect admit --checkpoint auto_merge/);
  assert.match(source, /dagu-feature-protect refresh/);
  assert.match(source, /dagu-feature-protect release-auto --reason close_gate/);
  assert.match(source, /dagu-feature-protect release-auto --reason terminal/);
  const documented = readFileSync(skill, "utf8");
  assert.match(documented, /dagu-feature-protect protect --decision/);
  assert.match(documented, /dagu-feature-protect release --decision/);
  assert.match(documented, /integration_hold/);
});
