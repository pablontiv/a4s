import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OUTPUT_KEYS } from "../src/lib.mjs";

const DAGS = join(dirname(fileURLToPath(import.meta.url)), "..", "dags");

const FORBIDDEN = ["LINES", "COLUMNS", "HOME", "PATH", "SHELL", "PWD", "USER", "DAGU_HOME", "DAGU_CONFIG"];
const ENV_VARS = ["PRIMARY", "FACTORY", "T3_HOME", "STATE", "WT", "ISSUE_STATE"];

const stripComments = (t) => t.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

/** Split a DAG text into header (before `steps:`) and steps (text blocks per `  - ` item). */
export function parseDag(text) {
  const lines = stripComments(text).split("\n");
  const at = lines.findIndex((l) => /^steps:\s*$/.test(l));
  const head = (at < 0 ? lines : lines.slice(0, at)).join("\n");
  const steps = [];
  if (at >= 0) {
    let cur = null;
    for (const l of lines.slice(at + 1)) {
      if (/^\S/.test(l)) break;
      if (/^ {0,2}- /.test(l)) { cur = []; steps.push(cur); }
      if (cur) cur.push(l);
    }
  }
  return { head, steps: steps.map((s) => parseStep(s.join("\n"))) };
}

function parseStep(text) {
  const id = /^\s*-\s+id:\s*(\S+)/m.exec(text)?.[1] ?? null;
  const runAt = text.search(/^\s+run:/m);
  const run = runAt < 0 ? "" : text.slice(runAt);
  const outputs = [];
  const om = /^(\s+)outputs:\s*\n((?:\1\s+.*\n?|\s*\n)*)/m.exec(text);
  if (om) for (const m of om[2].matchAll(/name:\s*([A-Za-z_]\w*)|^\s*-\s+([A-Za-z_]\w*)\s*$/gm)) outputs.push(m[1] ?? m[2]);
  return { id, text, run, outputs };
}

export function paramNames(dag) {
  const m = /^params:\s*\n((?:[ \t]+.*\n?|\n)*)/m.exec(dag.head + "\n");
  return m ? [...m[1].matchAll(/^\s*-\s+name:\s*(\S+)/gm)].map((x) => x[1]) : [];
}

// each check returns a list of problem strings (empty = ok)
export function checkShell(dag) {
  return /^shell:\s*bash\s*$/m.test(dag.head) ? [] : ["DAG does not declare `shell: bash`"];
}
export function checkParams(dag) {
  return paramNames(dag)
    .filter((n) => FORBIDDEN.includes(n) || n.startsWith("DAGU_"))
    .map((n) => `forbidden param name ${n}`);
}
export function checkCycleEnv(dag) {
  const re = new RegExp(`\\$\\{?(${ENV_VARS.join("|")})\\b`);
  return dag.steps
    .filter((s) => re.test(s.run) && !/^\s*(\.|source)\s+\S*src\/cycle-env\.sh/m.test(s.run))
    .map((s) => `step ${s.id} uses cycle variables without sourcing src/cycle-env.sh`);
}
export function checkStationOutputs(dag) {
  const out = [];
  for (const s of dag.steps) {
    if (!/src\/station\.mjs/.test(s.run)) continue;
    for (const k of OUTPUT_KEYS) if (!s.outputs.includes(k)) out.push(`step ${s.id} does not declare output ${k}`);
  }
  return out;
}
export function checkOutputRefs(dag) {
  const out = [];
  const byId = new Map(dag.steps.map((s) => [s.id, s]));
  const full = dag.steps.map((s) => s.text).join("\n");
  for (const m of full.matchAll(/\$\{steps\.([\w-]+)\.outputs\.(\w+)\}/g)) {
    const s = byId.get(m[1]);
    if (!s) out.push(`reference to unknown step ${m[1]}`);
    else if (!s.outputs.includes(m[2])) out.push(`step ${m[1]} does not declare output ${m[2]}`);
  }
  return out;
}
export function checkNoHumanTask(dag) {
  return /\bhuman\.task\b/.test(dag.head + dag.steps.map((s) => s.text).join("\n"))
    ? ["cycle.yaml has a human.task step"] : [];
}

const files = readdirSync(DAGS).filter((f) => f.endsWith(".yaml"));
test("dags directory has DAGs", () => assert.ok(files.length > 0));

for (const f of files) {
  const dag = parseDag(readFileSync(join(DAGS, f), "utf8"));
  const checks = { checkShell, checkParams, checkCycleEnv, checkStationOutputs, checkOutputRefs };
  if (f === "cycle.yaml") checks.checkNoHumanTask = checkNoHumanTask;
  for (const [name, fn] of Object.entries(checks)) {
    test(`${f}: ${name}`, () => assert.deepEqual(fn(dag), []));
  }
}

// negative cases: fixtures that break each rule
const dagOf = (head, ...steps) => parseDag(`${head}\nsteps:\n${steps.join("\n")}\n`);
const GOOD = "type: graph\nshell: bash\nparams:\n  - name: ISSUE\n    default: \"\"";

test("fixture: sanity, a good DAG passes every check", () => {
  const d = dagOf(GOOD,
    `  - id: a\n    run: |\n      . "$FACTORY/src/cycle-env.sh"\n      echo $WT\n    outputs:\n      - {name: x}`,
    `  - id: b\n    env:\n      - V: \${steps.a.outputs.x}\n    run: echo`);
  for (const fn of [checkShell, checkParams, checkCycleEnv, checkStationOutputs, checkOutputRefs, checkNoHumanTask])
    assert.deepEqual(fn(d), []);
});
test("fixture: missing shell: bash fails", () => {
  assert.equal(checkShell(dagOf("type: graph", "  - id: a\n    run: echo")).length, 1);
  assert.equal(checkShell(dagOf("type: graph\nshell: sh", "  - id: a\n    run: echo")).length, 1);
});
test("fixture: forbidden param names fail", () => {
  for (const n of [...FORBIDDEN, "DAGU_FOO"]) {
    const d = dagOf(`${GOOD}\n  - name: ${n}\n    default: x`, "  - id: a\n    run: echo");
    assert.deepEqual(checkParams(d), [`forbidden param name ${n}`]);
  }
});
test("fixture: cycle variable without sourcing cycle-env.sh fails", () => {
  for (const v of ENV_VARS) {
    const d = dagOf(GOOD, `  - id: a\n    run: |\n      echo "$${v}"`);
    assert.equal(checkCycleEnv(d).length, 1, v);
  }
  // sourcing in another step does not count
  const d = dagOf(GOOD,
    `  - id: a\n    run: |\n      . "$FACTORY/src/cycle-env.sh"`,
    `  - id: b\n    run: |\n      echo $PRIMARY`);
  assert.equal(checkCycleEnv(d).length, 1);
});
test("fixture: station step with missing outputs fails", () => {
  const d = dagOf(GOOD, `  - id: s\n    run: node src/station.mjs\n    outputs:\n      - {name: result}`);
  assert.equal(checkStationOutputs(d).length, OUTPUT_KEYS.length - 1);
});
test("fixture: bad output references fail", () => {
  const d = dagOf(GOOD,
    `  - id: a\n    outputs:\n      - {name: x}\n    run: echo`,
    `  - id: b\n    env:\n      - P: \${steps.a.outputs.nope}\n      - Q: \${steps.ghost.outputs.x}\n    run: echo`);
  assert.equal(checkOutputRefs(d).length, 2);
});
test("fixture: human.task step fails", () => {
  assert.equal(checkNoHumanTask(dagOf(GOOD, "  - id: h\n    type: human.task")).length, 1);
});

// notifications (VS2): cycle.yaml declares the three handlers and each runs notify.mjs
test("cycle.yaml: handler_on success, failure and wait run src/notify.mjs", () => {
  const text = stripComments(readFileSync(join(DAGS, "cycle.yaml"), "utf8"));
  const at = text.search(/^handler_on:\s*$/m);
  assert.ok(at >= 0, "handler_on missing");
  const block = text.slice(at);
  for (const ev of ["success", "failure", "wait"]) {
    const m = new RegExp(`^  ${ev}:\\s*\\n((?:    .*\\n?)+)`, "m").exec(block);
    assert.ok(m, `handler ${ev} missing`);
    assert.match(m[1], /node "\$FACTORY\/src\/notify\.mjs"/);
    assert.match(m[1], new RegExp(`--event ${ev}\\b`));
    for (const f of ["--run", "--issue", "--steps"]) assert.ok(m[1].includes(f), `${ev}: ${f}`);
    assert.match(m[1], /^\s*\. "\$\{FACTORY:-\$\{A4S_FACTORY:-\}\}\/src\/cycle-env\.sh"/m);
  }
});

// ---- executable tests: the real prepare/validate/integrate bodies on a fixture repository ----
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, readdirSync as ls } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const FACTORY = join(DAGS, "..");
const cycle = parseDag(readFileSync(join(DAGS, "cycle.yaml"), "utf8"));
const body = (id) => {
  const run = cycle.steps.find((s) => s.id === id).run;
  return run.replace(/^\s*run:\s*\|\s*\n/, "").split("\n").map((l) => l.replace(/^ {6}/, "")).join("\n");
};
const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dags-wt-"));
  const origin = join(root, "origin.git");
  const primary = join(root, "primary");
  sh(root, "init", "-q", "--bare", "-b", "main", origin);
  sh(root, "clone", "-q", origin, primary);
  sh(primary, "config", "user.email", "t@t"); sh(primary, "config", "user.name", "t");
  writeFileSync(join(primary, "a.txt"), "a1\n"); writeFileSync(join(primary, "b.txt"), "b1\n");
  sh(primary, "add", "-A"); sh(primary, "commit", "-q", "-m", "init"); sh(primary, "push", "-q", "origin", "HEAD:main");
  sh(primary, "branch", "-q", "--set-upstream-to=origin/main", "main");
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "brief.md"), "# title\n\nbody\n");
  // stubs: `dagu status` answers from $stub/status-<run> (default Running); `gh run list` answers a CI verdict after CI_DELAY s
  const stub = join(root, "stub"); mkdirSync(stub);
  writeFileSync(join(stub, "dagu"), '#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = --run-id ] && run=$2; shift; done\ns=Running; [ -f "$STUB/status-$run" ] && s=$(cat "$STUB/status-$run")\necho "$s - 2026-11-19T00:00:00.000Z"\n', { mode: 0o755 });
  writeFileSync(join(stub, "gh"), '#!/bin/sh\necho "$@" >> "$STUB/gh.log"\nif [ "$1 $2" = "run list" ]; then sleep "${CI_DELAY:-0}"; echo "[{\\"workflowName\\":\\"CI\\",\\"status\\":\\"completed\\",\\"conclusion\\":\\"${STUB_CI:-success}\\",\\"url\\":\\"u\\",\\"createdAt\\":\\"2026\\"}]"; fi\nexit 0\n', { mode: 0o755 });
  const stepEnv = (id, issue, extra = {}) => ({
    PATH: `${stub}:${process.env.PATH}`, HOME: process.env.HOME, PRIMARY: primary, FACTORY, T3_HOME: join(root, "t3"),
    STATE: join(root, "state"), ISSUE: String(issue), BASE: "main", BRIEF_FILE: join(root, "brief.md"), STUB: stub, DAGU_EXECUTABLE: join(stub, "dagu"),
    DAG_NAME: "cycle", LEASE_POLL_MS: "50", CI_TIMEOUT_MIN: "30", CI_WORKFLOWS: "CI", GATE: "true", PUSH: "true", DAG_RUN_ID: `run-${issue}`, DAGU_OUTPUT_FILE: join(root, `out-${issue}-${id}`), ...extra });
  // stdin ignored: with a socket as stdin some bashes (NixOS) source /etc/bashrc, which resets PATH
  const step = (id, issue, extra = {}) => spawnSync("bash", ["-c", body(id)], { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"], env: stepEnv(id, issue, extra) });
  // async step with timestamps; `merged_sha` of integrate is fed to ci like Dagu does
  const astep = (id, issue, extra = {}) => new Promise((res) => {
    const env = stepEnv(id, issue, extra);
    if (id === "ci") env.SHA = readFileSync(join(root, `out-${issue}-integrate`), "utf8").match(/merged_sha=(\w+)/)[1];
    const startedAt = Date.now(); let err = "";
    const p = spawn("bash", ["-c", body(id)], { env, stdio: ["ignore", "ignore", "pipe"] });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (status) => res({ status, stderr: err, startedAt, endedAt: Date.now() }));
  });
  const wt = (issue) => join(primary, ".workspace", "worktrees", `issue-${issue}`);
  const gitdir = (issue, p) => sh(wt(issue), "rev-parse", "--git-path", p).trim();
  const rebasing = (issue) => { const d = (p) => existsSync(resolve(wt(issue), gitdir(issue, p))); return d("rebase-merge") || d("rebase-apply"); };
  // the run that integrated is over (its ci step is not exercised): Dagu would no longer report it running
  const finish = (issue) => writeFileSync(join(stub, `status-run-${issue}`), "Succeeded");
  return { root, primary, step, astep, wt, rebasing, finish };
}
// the message is always a string, also when the step timed out or could not be spawned (null stdout/stderr)
const ok = (r) => assert.equal(r.status, 0, `status ${r.status} signal ${r.signal ?? "none"}${r.error ? ` error ${r.error.message}` : ""}\n${r.stderr ?? ""}${r.stdout ?? ""}`);

test("ok(): a timed-out or unspawnable step fails with an AssertionError that says why, never ERR_INVALID_ARG_TYPE", () => {
  const r = { status: null, signal: "SIGTERM", error: new Error("spawnSync bash ETIMEDOUT"), stdout: null, stderr: null };
  assert.throws(() => ok(r), (e) => e instanceof assert.AssertionError && /status null signal SIGTERM error spawnSync bash ETIMEDOUT/.test(e.message));
});

test("validate: a factory change without a selftest receipt fails before the gate, with the finding", () => {
  const f = fixture();
  ok(f.step("prepare", 5));
  mkdirSync(join(f.wt(5), "packages", "factory"), { recursive: true });
  writeFileSync(join(f.wt(5), "packages", "factory", "x.mjs"), "1\n");
  const marker = join(f.root, "gate-ran");
  const r = f.step("validate", 5, { GATE: `touch ${marker}` });
  assert.notEqual(r.status, 0);
  assert.equal(existsSync(marker), false);
  const sf = JSON.parse(readFileSync(join(f.root, "state", "5", "step-failure.json"), "utf8"));
  assert.deepEqual([sf.run, sf.step], ["run-5", "validate"]);
  assert.match(sf.findings[0], /^selftest not run on this code: receipt missing/);
  // a change outside packages/factory/ needs no receipt
  ok(f.step("prepare", 6));
  writeFileSync(join(f.wt(6), "a.txt"), "Z\n");
  ok(f.step("validate", 6, { GATE: `touch ${marker}` }));
  assert.equal(existsSync(marker), true);
});

test("integrate: a rebase conflict aborts the rebase, keeps the changes and fails with rebase-conflict", () => {
  const f = fixture();
  ok(f.step("prepare", 1)); ok(f.step("prepare", 2));
  writeFileSync(join(f.wt(1), "a.txt"), "A\n"); writeFileSync(join(f.wt(2), "a.txt"), "B\n");
  ok(f.step("validate", 1)); ok(f.step("integrate", 1)); f.finish(1);
  ok(f.step("validate", 2));
  const r = f.step("integrate", 2);
  assert.notEqual(r.status, 0);
  assert.equal(f.rebasing(2), false);
  assert.equal(readFileSync(join(f.wt(2), "a.txt"), "utf8"), "B\n");
  const sf = JSON.parse(readFileSync(join(f.root, "state", "2", "step-failure.json"), "utf8"));
  assert.match(sf.findings[0], /^rebase-conflict: a\.txt/);
  assert.equal(sh(f.primary, "show", "main:a.txt"), "A\n");
  ok(f.step("prepare", 2));
  assert.equal(f.rebasing(2), false);
  assert.equal(sh(f.wt(2), "status", "--porcelain").includes("a.txt"), false); // conflicting edit does not apply: reset on main
  assert.ok(ls(join(f.root, "state", "2")).some((n) => n.endsWith(".patch")));
  assert.match(readFileSync(join(f.root, "state", "2", "brief.md"), "utf8"), /carry-\d+\.patch/);
});

test("prepare: a reused worktree keeps only the issue's changes on the current base", () => {
  const f = fixture();
  ok(f.step("prepare", 3));
  writeFileSync(join(f.wt(3), "a.txt"), "C\n");
  ok(f.step("prepare", 4));
  writeFileSync(join(f.wt(4), "b.txt"), "D\n");
  ok(f.step("validate", 4)); ok(f.step("integrate", 4)); f.finish(4);
  ok(f.step("prepare", 3));
  assert.equal(sh(f.wt(3), "diff", "main", "--name-only").trim(), "a.txt");
  ok(f.step("validate", 3)); ok(f.step("integrate", 3)); f.finish(3);
  assert.equal(sh(f.primary, "show", "main:b.txt"), "D\n");
  assert.equal(sh(f.primary, "show", "main:a.txt"), "C\n");
});

test("prepare: a worktree left in the middle of a rebase is aborted", () => {
  const f = fixture();
  ok(f.step("prepare", 5)); ok(f.step("prepare", 6));
  writeFileSync(join(f.wt(5), "a.txt"), "X\n"); writeFileSync(join(f.wt(6), "a.txt"), "Y\n");
  ok(f.step("validate", 5)); ok(f.step("integrate", 5)); f.finish(5);
  sh(f.wt(6), "add", "-A"); sh(f.wt(6), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "w");
  assert.throws(() => sh(f.wt(6), "rebase", "main"));
  assert.equal(f.rebasing(6), true);
  ok(f.step("prepare", 6));
  assert.equal(f.rebasing(6), false);
});

// ---- exclusive integration window ----
import { readLease } from "../src/lease.mjs";
const holder = (f) => readLease(join(f.root, "state"));
const chain = async (f, issue, extra = {}) => ({ lease: await f.astep("integration_lease", issue, extra), integrate: await f.astep("integrate", issue, extra), ci: await f.astep("ci", issue, extra) });
const ciOf = (r) => ({ ...r, ok: r.lease.status === 0 && r.integrate.status === 0 && r.ci.status === 0 });

test("lease: two runs reaching integrate together land one after the other, the second after the first's ci", async () => {
  const f = fixture();
  ok(f.step("prepare", 11)); ok(f.step("prepare", 12));
  writeFileSync(join(f.wt(11), "a.txt"), "A\n"); writeFileSync(join(f.wt(12), "b.txt"), "B\n");
  ok(f.step("validate", 11)); ok(f.step("validate", 12));
  const env = { CI_DELAY: "1.5" };
  const [r1, r2] = (await Promise.all([chain(f, 11, env), chain(f, 12, env)])).map(ciOf);
  for (const r of [r1, r2]) assert.equal(r.ok, true, JSON.stringify(r));
  for (const r of [r1, r2]) assert.doesNotMatch(r.integrate.stderr, /ff-only|index\.lock|rejected|Not possible to fast-forward/i);
  sh(f.primary, "fetch", "-q", "origin");
  assert.equal(sh(f.primary, "show", "origin/main:a.txt"), "A\n");
  assert.equal(sh(f.primary, "show", "origin/main:b.txt"), "B\n");
  assert.equal(sh(f.primary, "rev-parse", "main").trim(), sh(f.primary, "rev-parse", "origin/main").trim());
  assert.equal(sh(f.primary, "rev-list", "--count", "main").trim(), "3");
  assert.equal(holder(f), null);
  // one of them waited: its integrate got the lease only after the other one's ci ended
  const [first, second] = r1.integrate.endedAt <= r2.integrate.endedAt ? [r1, r2] : [r2, r1];
  const waiter = second === r1 ? 11 : 12;
  const w = JSON.parse(readFileSync(join(f.root, "state", String(waiter), "lease-wait.json"), "utf8"));
  assert.ok(w.waitedMs >= 1000, JSON.stringify(w));
  assert.ok(Date.parse(w.waits.at(-1).to) >= first.ci.endedAt - 300, "second lease taken before the first ci ended");
  assert.ok(second.integrate.startedAt >= first.ci.endedAt - 300, "second integrate started before the first ci ended");
});

test("lease: a run killed while holding it does not block the next one, which reclaims it", () => {
  const f = fixture();
  ok(f.step("prepare", 13)); ok(f.step("prepare", 14));
  writeFileSync(join(f.wt(13), "a.txt"), "A\n"); writeFileSync(join(f.wt(14), "b.txt"), "B\n");
  ok(f.step("validate", 13)); ok(f.step("validate", 14));
  ok(f.step("integrate", 13)); // holds the lease; its ci never runs: the run was killed
  assert.equal(holder(f).run, "run-13");
  writeFileSync(join(f.root, "stub", "status-run-13"), "Cancelled");
  const r = f.step("integrate", 14);
  ok(r);
  assert.match(r.stderr, /reclaimed .*run-13/);
  assert.equal(holder(f).run, "run-14");
  ok(f.step("ci", 14, { SHA: readFileSync(join(f.root, "out-14-integrate"), "utf8").match(/merged_sha=(\w+)/)[1] }));
  assert.equal(holder(f), null);
  assert.equal(sh(f.primary, "show", "main:b.txt"), "B\n");
});

test("lease: a live holder blocks prepare and integrate (no PRIMARY use) until released", async () => {
  const f = fixture();
  ok(f.step("prepare", 15));
  writeFileSync(join(f.wt(15), "a.txt"), "A\n"); ok(f.step("validate", 15));
  const { takeLease, releaseLease } = await import("../src/lease.mjs");
  takeLease(join(f.root, "state"), "run-holder");
  const p = f.astep("prepare", 16);
  const i = f.astep("integrate", 15);
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(existsSync(f.wt(16)), false);
  assert.equal(sh(f.primary, "rev-list", "--count", "main").trim(), "1");
  releaseLease(join(f.root, "state"), "run-holder");
  // integrate keeps the lease until its ci ends; prepare may be queued behind it, so end the window with ci
  const ri = await i;
  assert.equal(ri.status, 0, ri.stderr);
  ok(f.step("ci", 15, { SHA: readFileSync(join(f.root, "out-15-integrate"), "utf8").match(/merged_sha=(\w+)/)[1] }));
  const rp = await p;
  assert.equal(rp.status, 0, rp.stderr);
  assert.equal(existsSync(f.wt(16)), true);
  assert.ok(JSON.parse(readFileSync(join(f.root, "state", "16", "lease-wait.json"), "utf8")).waitedMs >= 500);
});

test("ci: red reverts the run's own commit while it is the tip, releasing the lease", async () => {
  const f = fixture();
  ok(f.step("prepare", 17)); writeFileSync(join(f.wt(17), "a.txt"), "A\n"); ok(f.step("validate", 17));
  const r = await chain(f, 17, { STUB_CI: "failure" });
  assert.equal(r.integrate.status, 0); assert.notEqual(r.ci.status, 0);
  sh(f.primary, "fetch", "-q", "origin");
  assert.equal(sh(f.primary, "show", "origin/main:a.txt"), "a1\n");
  assert.equal(holder(f), null);
});

test("ci: red when the commit is no longer the tip of main fails as infra, without reverting", async () => {
  const f = fixture();
  ok(f.step("prepare", 18)); writeFileSync(join(f.wt(18), "a.txt"), "A\n"); ok(f.step("validate", 18));
  const i = await f.astep("integrate", 18);
  assert.equal(i.status, 0, i.stderr);
  // a manual push lands on main meanwhile
  writeFileSync(join(f.primary, "b.txt"), "manual\n"); sh(f.primary, "commit", "-qam", "manual"); sh(f.primary, "push", "-q", "origin", "main");
  // the inbox is notified: a stub t3cli records what it is asked to send
  const t3stub = join(f.root, "stub", "t3cli.mjs");
  writeFileSync(t3stub, 'import { appendFileSync, readFileSync } from "node:fs";\nappendFileSync(process.env.STUB + "/t3.log", JSON.stringify({ args: process.argv.slice(2), text: readFileSync(0, "utf8") }) + "\\n");\n');
  const c = await f.astep("ci", 18, { STUB_CI: "failure", INBOX_THREAD: "inbox-1", NOTIFY_T3CLI: t3stub, SHA: readFileSync(join(f.root, "out-18-integrate"), "utf8").match(/merged_sha=(\w+)/)[1] });
  assert.notEqual(c.status, 0);
  const sent = readFileSync(join(f.root, "stub", "t3.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].args.slice(0, 4), ["thread", "send", "--json", "inbox-1"]);
  assert.match(sent[0].text, /NO se revirtió: .*no longer the tip/);
  assert.ok(JSON.parse(readFileSync(join(f.root, "state", "18", "notified.json"), "utf8"))["run-18:infra"]);
  const sf = JSON.parse(readFileSync(join(f.root, "state", "18", "step-failure.json"), "utf8"));
  assert.equal(sf.step, "ci"); assert.match(sf.findings[0], /^infra: .*no longer the tip/);
  sh(f.primary, "fetch", "-q", "origin");
  assert.equal(sh(f.primary, "show", "origin/main:a.txt"), "A\n");
  assert.equal(holder(f), null);
});

test("ci: red when the remote tip cannot be read fails as infra and notifies, without reverting", async () => {
  const f = fixture();
  ok(f.step("prepare", 21)); writeFileSync(join(f.wt(21), "a.txt"), "A\n"); ok(f.step("validate", 21));
  const i = await f.astep("integrate", 21);
  assert.equal(i.status, 0, i.stderr);
  const sha = readFileSync(join(f.root, "out-21-integrate"), "utf8").match(/merged_sha=(\w+)/)[1];
  // origin advances (another clone pushes), then becomes unreachable: the local tracking ref still says our commit is the tip
  const origin = sh(f.primary, "remote", "get-url", "origin").trim();
  const other = join(f.root, "other"); execFileSync("git", ["clone", "-q", origin, other]);
  writeFileSync(join(other, "c.txt"), "c\n"); sh(other, "add", "c.txt");
  sh(other, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "elsewhere"); sh(other, "push", "-q", "origin", "main");
  assert.equal(sh(f.primary, "rev-parse", "origin/main").trim(), sha);
  renameSync(origin, `${origin}.gone`);
  const t3stub = join(f.root, "stub", "t3cli.mjs");
  writeFileSync(t3stub, 'import { appendFileSync, readFileSync } from "node:fs";\nappendFileSync(process.env.STUB + "/t3.log", JSON.stringify({ args: process.argv.slice(2), text: readFileSync(0, "utf8") }) + "\\n");\n');
  const c = await f.astep("ci", 21, { STUB_CI: "failure", INBOX_THREAD: "inbox-1", NOTIFY_T3CLI: t3stub, SHA: sha });
  assert.notEqual(c.status, 0);
  const sf = JSON.parse(readFileSync(join(f.root, "state", "21", "step-failure.json"), "utf8"));
  assert.match(sf.findings[0], /^infra: .*cannot verify the current tip of the remote trunk/);
  assert.equal(sh(f.primary, "rev-parse", "HEAD").trim(), sha); // nothing reverted locally either
  const sent = readFileSync(join(f.root, "stub", "t3.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(sent.length, 1); assert.match(sent[0].text, /NO se revirtió: cannot verify/);
  assert.equal(holder(f), null);
  renameSync(`${origin}.gone`, origin); sh(f.primary, "fetch", "-q", "origin");
  assert.equal(sh(f.primary, "show", "origin/main:a.txt"), "A\n");
});

test("findExecutable: PATH lookup without a shell (startup files that print cannot pollute it)", () => {
  const d = mkdtempSync(join(tmpdir(), "which-"));
  mkdirSync(join(d, "a")); mkdirSync(join(d, "b")); mkdirSync(join(d, "c", "tool"), { recursive: true });
  writeFileSync(join(d, "a", "tool"), "x"); // not executable
  writeFileSync(join(d, "b", "tool"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(findExecutable("tool", `${join(d, "c")}:${join(d, "a")}:${join(d, "b")}`), join(d, "b", "tool"));
  assert.equal(findExecutable("tool", join(d, "a")), "");
  if (DAGU) assert.ok(statSync(DAGU).isFile() && !/\s/.test(DAGU), DAGU);
});

test("integrate: a failing integrate releases the lease at once", () => {
  const f = fixture();
  ok(f.step("prepare", 19)); ok(f.step("prepare", 20));
  writeFileSync(join(f.wt(19), "a.txt"), "A\n"); writeFileSync(join(f.wt(20), "a.txt"), "B\n");
  ok(f.step("validate", 19)); ok(f.step("validate", 20));
  ok(f.step("integrate", 19)); ok(f.step("ci", 19, { SHA: readFileSync(join(f.root, "out-19-integrate"), "utf8").match(/merged_sha=(\w+)/)[1] }));
  assert.notEqual(f.step("integrate", 20).status, 0); // rebase conflict
  assert.equal(holder(f), null);
});

test("cycle.yaml: failure, abort and success handlers release the lease; prepare and integrate take it", () => {
  const text = stripComments(readFileSync(join(DAGS, "cycle.yaml"), "utf8"));
  for (const h of ["success", "failure", "abort"]) {
    const m = new RegExp(`^  ${h}:\\s*\\n((?:    .*\\n?)+)`, "m").exec(text.slice(text.search(/^handler_on:/m)));
    assert.ok(m, h); assert.match(m[1], /lease\.mjs" release/);
  }
  for (const id of ["prepare", "integrate"]) assert.match(cycle.steps.find((s) => s.id === id).run, /lease acquire/);
  // the wait is a step of its own, so integrate starts (in Dagu's step times) only once the window is this run's
  const wait = cycle.steps.find((s) => s.id === "integration_lease");
  assert.match(wait.run, /lease\.mjs" acquire .*--issue-state/);
  assert.match(readFileSync(join(DAGS, "cycle.yaml"), "utf8"), /- id: integration_lease\n    depends: validate\n[\s\S]*- id: integrate\n    depends: integration_lease\n/);
  assert.match(cycle.steps.find((s) => s.id === "ci").run, /lease\.mjs" release/);
  const integ = cycle.steps.find((s) => s.id === "integrate").run;
  assert.ok(integ.indexOf("lease acquire") < integ.indexOf("merge-base"));
});

// ---- the same window under real Dagu: integrate and ci are separate step processes of one DAG run ----
// A DAG made of the literal `integration_lease`, `integrate` and `ci` steps (and the abort handler) of cycle.yaml, run by Dagu on the fixture.
// The executable is looked up on PATH here, never through a shell (a shell's startup files may print to stdout).
import { accessSync, constants as fsc, renameSync, statSync } from "node:fs";
export function findExecutable(name, path = process.env.PATH ?? "") {
  for (const dir of path.split(":").filter(Boolean)) {
    const p = join(dir, name);
    try { accessSync(p, fsc.X_OK); if (statSync(p).isFile()) return p; } catch { /* not here */ }
  }
  return "";
}
const DAGU = findExecutable("dagu");
/** Every file under `dir` (recursive), [] when it does not exist. */
const walk = (dir) => { try { return ls(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath ?? e.path, e.name)); } catch { return []; } };
/** Polls `cond` every 100 ms until true; fails with `what` and `detail()` after `timeoutMs`. */
async function waitFor(cond, what, timeoutMs, detail = () => "") {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (cond()) return; await new Promise((r) => setTimeout(r, 100)); }
  assert.fail(`timed out after ${timeoutMs} ms waiting for ${what}\n${detail()}`);
}
function daguFixture() {
  const f = fixture();
  const home = join(f.root, "dagu"); mkdirSync(join(home, "dags"), { recursive: true });
  const text = readFileSync(join(DAGS, "cycle.yaml"), "utf8");
  const steps = text.slice(text.indexOf("  - id: integration_lease\n"), text.indexOf("  # Idempotent: safe to re-run after a partial close")).replace("    depends: validate\n", "");
  const abort = /^  abort:\n(?: {4}.*\n|\s*\n)+/m.exec(text)[0];
  const env = { PATH: `${join(f.root, "stub")}:${process.env.PATH}`, HOME: process.env.HOME, PRIMARY: f.primary, FACTORY, T3_HOME: join(f.root, "t3"),
    STATE: join(f.root, "state"), BASE: "main", GATE: "true", PUSH: "true", STUB: join(f.root, "stub"), DAGU_EXECUTABLE: DAGU, DAGU_HOME: home,
    LEASE_POLL_MS: "100", CI_TIMEOUT_MIN: "30", CI_WORKFLOWS: "CI", CI_DELAY: "2" };
  // a DAG name unique to this fixture: Dagu derives each run's control socket from the DAG name and run id only
  // (an abstract `/tmp/@dagu_<dag>_<hash>.sock`, not under DAGU_HOME), so two test processes on the same host
  // (parallel gates, the repeat script) using one fixed name collide with "already running" and fail at random
  const dag = `integ_${randomBytes(4).toString("hex")}`;
  writeFileSync(join(home, "dags", `${dag}.yaml`), [
    "type: graph", "shell: bash", "max_active_runs: 5", "params:", "  - name: ISSUE", "    required: true", "  - name: CI_DELAY", '    default: "2"',
    "env:", ...Object.entries(env).filter(([k]) => k !== "CI_DELAY").map(([k, v]) => `  - ${k}: ${JSON.stringify(v)}`),
    "steps:", steps.trimEnd(), "handler_on:", abort.trimEnd(), ""].join("\n"));
  const denv = { ...process.env, DAGU_HOME: home };
  const start = (issue, extra = []) => spawn(DAGU, ["start", "--run-id", `run-${issue}`, dag, "--", `ISSUE=${issue}`, ...extra], { env: denv, stdio: "ignore", detached: true });
  // resolves also when the process already exited before the call (no lost `exit` event)
  const done = (p) => new Promise((r) => { if (p.exitCode !== null || p.signalCode !== null) r(p.exitCode); else p.once("exit", (code) => r(code)); });
  // step times as Dagu records them (its status store, last line of the run's status.jsonl)
  const status = (issue) => {
    const find = walk(join(home, "data")).find((p) => p.includes(`_run-${issue}/`) && p.endsWith("/status.jsonl"));
    const last = JSON.parse(readFileSync(find, "utf8").trim().split("\n").at(-1));
    return Object.fromEntries(last.nodes.map((n) => [n.step.id ?? n.step.name, { start: Date.parse(n.startedAt), end: Date.parse(n.finishedAt), status: n.status }]));
  };
  const rawWord = (issue) => (spawnSync(DAGU, ["status", "--run-id", `run-${issue}`, dag], { encoding: "utf8", env: denv }).stdout ?? "").match(/^(\w[\w ]*?) - \d{4}-/m)?.[1];
  /** Last `n` lines of every log of the run. */
  const tail = (issue, n = 40) => walk(join(home, "logs")).filter((p) => p.includes(`run-${issue}`)).map((p) => `--- ${p}\n${readFileSync(p, "utf8").split("\n").slice(-n).join("\n")}`).join("\n");
  /** Always a string: the run's status word, its step statuses and the tail of its logs. */
  const word = (issue) => {
    let steps;
    try { steps = Object.entries(status(issue)).map(([k, v]) => `${k}=${v.status}`).join(" "); } catch (e) { steps = `no step statuses (${e.message})`; }
    return `run-${issue} status ${rawWord(issue) ?? "unknown"}; steps: ${steps}\n${tail(issue)}`;
  };
  const state = (issue) => rawWord(issue) ?? "unknown";
  return { ...f, start, done, status, word, state, home, dag };
}

test("dagu fixture: word() and state() are always strings, also for a run Dagu never saw (assert messages never undefined)", { skip: !DAGU && "dagu not installed" }, () => {
  const f = daguFixture();
  const w = f.word(999);
  assert.equal(typeof w, "string", "word() must return a string");
  assert.match(w, /run-999 status unknown; steps: no step statuses/);
  assert.equal(f.state(999), "unknown");
});

test("dagu fixture: each fixture has its own DAG name, so equal run ids in parallel test processes do not share a Dagu socket", { skip: !DAGU && "dagu not installed" }, () => {
  const [a, b] = [daguFixture(), daguFixture()];
  assert.notEqual(a.dag, b.dag, "two fixtures got the same DAG name");
  for (const f of [a, b]) assert.ok(existsSync(join(f.home, "dags", `${f.dag}.yaml`)), `missing ${f.dag}.yaml`);
});

test("dagu: two runs reach integrate at the same moment; both land on main, the second integrate starts after the first ci ends", { skip: !DAGU && "dagu not installed", timeout: 180_000 }, async () => {
  const f = daguFixture();
  ok(f.step("prepare", 31)); ok(f.step("prepare", 32));
  writeFileSync(join(f.wt(31), "a.txt"), "A\n"); writeFileSync(join(f.wt(32), "b.txt"), "B\n");
  ok(f.step("validate", 31)); ok(f.step("validate", 32));
  const codes = await Promise.all([f.done(f.start(31)), f.done(f.start(32))]);
  assert.deepEqual(codes, [0, 0], `${f.word(31)} / ${f.word(32)}`);
  assert.equal(f.state(31), "Succeeded", f.word(31)); assert.equal(f.state(32), "Succeeded", f.word(32));
  sh(f.primary, "fetch", "-q", "origin");
  assert.equal(sh(f.primary, "show", "origin/main:a.txt"), "A\n");
  assert.equal(sh(f.primary, "show", "origin/main:b.txt"), "B\n");
  assert.equal(sh(f.primary, "rev-list", "--count", "origin/main").trim(), "3");
  assert.equal(holder(f), null);
  const logs = walk(join(f.home, "logs")).filter((p) => /\.(err|out|log)$/.test(p)).map((p) => readFileSync(p, "utf8")).join("\n");
  assert.match(logs, /waiting for the integration lease held by run-3[12]/);
  assert.doesNotMatch(logs, /ff-only|index\.lock|rejected|Not possible to fast-forward/i);
  const [s1, s2] = [f.status(31), f.status(32)];
  const [first, second, waiter] = s1.integrate.end <= s2.integrate.end ? [s1, s2, 32] : [s2, s1, 31];
  // the second run's integrate step began together with the first, but only got past the lease once the first ci ended
  const w = JSON.parse(readFileSync(join(f.root, "state", String(waiter), "lease-wait.json"), "utf8"));
  assert.ok(Date.parse(w.waits.at(-1).to) >= first.ci.end, `lease taken ${w.waits.at(-1).to}, first ci ended ${new Date(first.ci.end).toISOString()}`);
  // Dagu's own step times: the second run's integrate starts only after the first run's ci ended
  assert.ok(second.integrate.start >= first.ci.end, `second integrate started ${new Date(second.integrate.start).toISOString()}, first ci ended ${new Date(first.ci.end).toISOString()}`);
  assert.ok(second.integration_lease.start < first.ci.end, "the second run did not reach the lease while the first was integrating");
  assert.ok(second.ci.start >= first.ci.end);
});

test("dagu: a run killed while holding the lease does not block the next one, which reclaims it and integrates", { skip: !DAGU && "dagu not installed", timeout: 300_000 }, async () => {
  const f = daguFixture();
  ok(f.step("prepare", 33)); ok(f.step("prepare", 34));
  writeFileSync(join(f.wt(33), "a.txt"), "A\n"); writeFileSync(join(f.wt(34), "b.txt"), "B\n");
  ok(f.step("validate", 33)); ok(f.step("validate", 34));
  // run 33 integrates and sits in ci (slow CI); then the whole run is SIGKILLed: no trap, no handler releases the lease
  const p = f.start(33, ["CI_DELAY=600"]);
  const ghLog = () => (existsSync(join(f.root, "stub", "gh.log")) ? readFileSync(join(f.root, "stub", "gh.log"), "utf8") : "");
  // observable state, not sleeps: run 33 holds the lease and is inside ci (the gh stub logged `run list`)
  await waitFor(() => holder(f)?.run === "run-33" && ghLog().includes("run list"), "run-33 holding the lease and inside ci", 60_000, () => `lease ${JSON.stringify(holder(f))}\ngh.log: ${ghLog()}\n${f.word(33)}`);
  process.kill(-p.pid, "SIGKILL");
  await f.done(p); // the Dagu process is gone
  assert.equal(holder(f)?.run, "run-33", "the lease file is gone after the kill, expected it still held by the dead run"); // still held by the dead run
  const p34 = f.start(34);
  let timer; // cleared below: a pending timer would keep the test process alive for its full length
  const code = await Promise.race([f.done(p34), new Promise((r) => { timer = setTimeout(() => r("timeout"), 200_000); })]);
  clearTimeout(timer);
  if (code === "timeout") process.kill(-p34.pid, "SIGKILL");
  assert.equal(code, 0, `second run ended with ${code}\n${f.word(34)}\nlease: ${JSON.stringify(holder(f))}`);
  const err = walk(join(f.home, "logs")).filter((p) => p.includes("run-34")).map((p) => readFileSync(p, "utf8")).join("\n");
  assert.match(err, /reclaimed the integration lease of dead run run-33/);
  assert.equal(holder(f), null);
  sh(f.primary, "fetch", "-q", "origin");
  assert.equal(sh(f.primary, "show", "origin/main:b.txt"), "B\n");
  assert.equal(sh(f.primary, "show", "origin/main:a.txt"), "A\n"); // run 33's commit had been pushed before the kill
});
