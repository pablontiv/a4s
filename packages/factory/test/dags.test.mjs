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
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, readdirSync as ls } from "node:fs";
import { tmpdir } from "node:os";

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
  const step = (id, issue, extra = {}) => {
    const out = join(root, `out-${issue}-${id}`);
    const r = spawnSync("bash", ["-c", body(id)], { encoding: "utf8", env: {
      PATH: process.env.PATH, HOME: process.env.HOME, PRIMARY: primary, FACTORY, T3_HOME: join(root, "t3"),
      STATE: join(root, "state"), ISSUE: String(issue), BASE: "main", BRIEF_FILE: join(root, "brief.md"),
      GATE: "true", PUSH: "true", DAG_RUN_ID: `run-${issue}`, DAGU_OUTPUT_FILE: out, ...extra } });
    return r;
  };
  const wt = (issue) => join(primary, ".workspace", "worktrees", `issue-${issue}`);
  const gitdir = (issue, p) => sh(wt(issue), "rev-parse", "--git-path", p).trim();
  const rebasing = (issue) => { const d = (p) => existsSync(resolve(wt(issue), gitdir(issue, p))); return d("rebase-merge") || d("rebase-apply"); };
  return { root, primary, step, wt, rebasing };
}
const ok = (r) => assert.equal(r.status, 0, r.stderr + r.stdout);

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
  ok(f.step("validate", 1)); ok(f.step("integrate", 1));
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
  ok(f.step("validate", 4)); ok(f.step("integrate", 4));
  ok(f.step("prepare", 3));
  assert.equal(sh(f.wt(3), "diff", "main", "--name-only").trim(), "a.txt");
  ok(f.step("validate", 3)); ok(f.step("integrate", 3));
  assert.equal(sh(f.primary, "show", "main:b.txt"), "D\n");
  assert.equal(sh(f.primary, "show", "main:a.txt"), "C\n");
});

test("prepare: a worktree left in the middle of a rebase is aborted", () => {
  const f = fixture();
  ok(f.step("prepare", 5)); ok(f.step("prepare", 6));
  writeFileSync(join(f.wt(5), "a.txt"), "X\n"); writeFileSync(join(f.wt(6), "a.txt"), "Y\n");
  ok(f.step("validate", 5)); ok(f.step("integrate", 5));
  sh(f.wt(6), "add", "-A"); sh(f.wt(6), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "w");
  assert.throws(() => sh(f.wt(6), "rebase", "main"));
  assert.equal(f.rebasing(6), true);
  ok(f.step("prepare", 6));
  assert.equal(f.rebasing(6), false);
});
