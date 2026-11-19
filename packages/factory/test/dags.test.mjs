import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
