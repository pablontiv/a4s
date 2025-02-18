import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { aggregateMatrix, assertStationUnchanged, CASES, fixtureEnvironment, fixtureIdentities, isolatedRoot, parseArguments, runAcceptance, stationSnapshot } from "./native/station-acceptance.mjs";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "a4s-native-coordinator-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "real"), out = join(root, "evidence");
  mkdirSync(join(home, "cache/a4s/r20"), { recursive: true }); mkdirSync(out);
  const path = join(home, "cache/a4s/state.json");
  const state = { schema: 1, generation: 4, current: { version: "r20", commit: "a".repeat(40), digest: "b".repeat(64) }, previous: { version: "r19" }, rejected: ["r18"], formats: { config: [1, 2], receipt: [1] } };
  writeFileSync(path, `${JSON.stringify(state)}\n`);
  writeFileSync(join(home, "cache/a4s/r20/published"), "immutable");
  return { root, home, out, path, state };
}

test("native arguments are exact, phase-qualified and fail closed", () => {
  assert.deepEqual(parseArguments(["--phase", "pre-bun", "--base", "r20"]), { base: "r20", phase: "pre-bun" });
  assert.deepEqual(parseArguments(["--base", "r0", "--phase", "post-bun"]), { base: "r0", phase: "post-bun" });
  for (const args of [[], ["--base", "r01", "--phase", "pre-bun"], ["--base", "r2", "--phase", "other"], ["--base", "r2", "--phase", "pre-bun", "--base", "r3"], ["--base", "r2", "--phase", "pre-bun", "extra"], ["--base", "v1", "--phase", "pre-bun"]]) assert.throws(() => parseArguments(args));
});

test("fixture IDs are distinct ordered integers without Number precision loss", () => {
  assert.deepEqual(fixtureIdentities("r20"), { a: "r20", b: "r21", nonStarting: "r22", skillsOnly: "r23", agentOnly: "r24" });
  const ids = Object.values(fixtureIdentities("r9007199254740993"));
  assert.equal(new Set(ids).size, 5);
  for (let i = 1; i < ids.length; i++) assert.equal(BigInt(ids[i]!.slice(1)), BigInt(ids[i - 1]!.slice(1)) + 1n);
  assert.throws(() => fixtureIdentities("r01"));
});

test("matrix requires every case exactly once, evidence, and no failed row", () => {
  const rows = CASES.map((name: string) => ({ case: name, status: "pass", evidence: [`${name}/receipt.json`] }));
  assert.equal(aggregateMatrix(rows).passed, true);
  assert.equal(aggregateMatrix(rows.slice(1)).passed, false);
  assert.equal(aggregateMatrix([...rows, rows[0]!]).passed, false);
  assert.equal(aggregateMatrix(rows.map((row, i) => i === 1 ? { ...row, status: "fail" } : row)).passed, false);
  assert.equal(aggregateMatrix(rows.map((row, i) => i === 1 ? { ...row, evidence: [] } : row)).passed, false);
});

test("real station integrity compares raw bytes as well as rejected and formats", t => {
  const f = fixture(t), before = stationSnapshot(f.home);
  assert.doesNotThrow(() => assertStationUnchanged(before, stationSnapshot(f.home)));
  for (const changed of [JSON.stringify(f.state), JSON.stringify({ ...f.state, rejected: [] }), JSON.stringify({ ...f.state, formats: { config: [2] } })]) {
    writeFileSync(f.path, changed);
    assert.throws(() => assertStationUnchanged(before, stationSnapshot(f.home)));
  }
});

test("coordinator confines writable fixture state and removes it after all rows", async t => {
  const f = fixture(t), before = readFileSync(f.path);
  const roots: string[] = [];
  const execute = Object.fromEntries(CASES.map((name: string) => [name, async (c: { root: string; home: string; out: string }, evidence: string[]) => {
    assert.ok(c.home.startsWith(c.root)); assert.notEqual(c.home, f.home);
    mkdirSync(c.home, { recursive: true }); writeFileSync(join(c.home, "state.json"), name);
    writeFileSync(join(c.out, `${name}.log`), "observed"); evidence.push(`${name}.log`);
  }]));
  const prepare = async (c: { root: string }) => { roots.push(c.root); return async () => {}; };
  for (const phase of ["pre-bun", "post-bun"]) {
    const matrix = await runAcceptance({ base: "r20", phase, home: f.home, out: f.out }, { ...execute, prepare });
    assert.equal(matrix.passed, true);
  }
  assert.notEqual(roots[0], roots[1]);
  assert.deepEqual(readFileSync(f.path), before);
  assert.equal(readFileSync(join(f.home, "cache/a4s/r20/published"), "utf8"), "immutable");
  assert.equal(readdirSync(f.out).some(name => name.startsWith("isolated-")), false);
});

test("failing row does not omit subsequent cases and setup failure records all cases", async t => {
  const f = fixture(t);
  const execute = Object.fromEntries(CASES.map((name: string) => [name, async (_c: unknown, evidence: string[]) => { evidence.push("observed.log"); if (name === "r4") throw new Error("row failed"); }]));
  const matrix = await runAcceptance({ base: "r20", phase: "pre-bun", home: f.home, out: f.out }, { ...execute, prepare: async () => async () => {} });
  assert.equal(matrix.passed, false); assert.equal(matrix.rows.length, 4);
  assert.equal(matrix.rows.find(row => row.case === "r4")!.status, "fail");
  assert.equal(matrix.rows.at(-1)!.status, "pass");
  const failed = await runAcceptance({ base: "r20", phase: "post-bun", home: f.home, out: f.out }, { prepare: async () => { throw new Error("setup failed"); } });
  assert.equal(failed.passed, false); assert.equal(failed.rows.length, 4);
  assert.ok(failed.rows.every((row: { status: string; evidence: string[] }) => row.status === "fail" && row.evidence.length > 0));
});

test("evidence roots cannot overlap real cache, including through symlinks", t => {
  const f = fixture(t);
  assert.throws(() => isolatedRoot(join(f.home, "cache/a4s"), f.home));
  assert.throws(() => isolatedRoot(f.root, f.home));
  const link = join(f.root, "cache-link"); symlinkSync(join(f.home, "cache/a4s"), link);
  assert.throws(() => isolatedRoot(link, f.home));
});

test("fixture child environments cannot inherit real station write targets or binding", t => {
  const f = fixture(t), before = readFileSync(f.path);
  const home = join(f.out, "isolated", "dagu");
  const env = fixtureEnvironment({ path: "/service/bin", home: "/service/home", agentDir: "/service/agent" }, home, {
    DAGU_HOME: f.home, DAGU_CONFIG: join(f.home, "config.yaml"), DAGU_DAGS_DIR: join(f.home, "dags"),
    DAGU_OUTPUT_FILE: f.path, DAG_RUN_ID: "real-run", DAG_PUSHBACK_ITERATION: "9", RUN: "real-run", PRIMARY: f.home,
    A4S_BIN: "/real/a4s", A4S_ARTIFACT: "real", OMP_SESSION_ID: "real-owner", PI_TOOL_BRIDGE_PORT: "1234", KEEP: "yes",
    OMP_PROFILE: "work", PI_PROFILE: "ignored", PI_CONFIG_DIR: ".custom-omp",
  }, 12345);
  assert.equal(env.DAGU_HOME, home);
  assert.equal(env.DAGU_URL, "http://127.0.0.1:12345");
  assert.equal(env.PATH, "/service/bin");
  assert.equal(env.PI_CODING_AGENT_DIR, "/service/agent");
  assert.equal(env.KEEP, "yes");
  assert.deepEqual([env.OMP_PROFILE, env.PI_PROFILE, env.PI_CONFIG_DIR], ["work", "ignored", ".custom-omp"]);
  for (const key of ["DAGU_CONFIG", "DAGU_DAGS_DIR", "DAGU_OUTPUT_FILE", "DAG_RUN_ID", "DAG_PUSHBACK_ITERATION", "RUN", "PRIMARY", "A4S_BIN", "A4S_ARTIFACT", "OMP_SESSION_ID", "PI_TOOL_BRIDGE_PORT"]) assert.equal(env[key], undefined, key);
  assert.deepEqual(readFileSync(f.path), before);
});
