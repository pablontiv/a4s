import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { canonicalJson, EXIT_CODES, writeAtomicJson } from "@a4s/launcher/runtime";
import { main } from "../src/cli.ts";
import { runtimeHelper } from "./fixtures/artifact.ts";

const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL(import.meta.resolve("@a4s/launcher/runtime")), "utf8");
function instrumentedWriter(overrides: Partial<typeof fs>): typeof writeAtomicJson {
  const module = { exports: {} as { writeAtomicJson: typeof writeAtomicJson } };
  runInNewContext(source, { module, require: (name: string) => name === "node:fs" ? { ...fs, ...overrides } : require(name) });
  return module.exports.writeAtomicJson;
}
function fixture(t: { after(fn: () => void): void }): string {
  const root = fs.mkdtempSync(join(tmpdir(), "a4s-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("canonical JSON sorts every object while preserving array order and existing digest bytes", () => {
  const value = { z: [null, true, { z: "quoted\"\n", a: 1 }], a: { b: 2, a: -0 } };
  assert.equal(canonicalJson(value), '{"a":{"a":0,"b":2},"z":[null,true,{"a":1,"z":"quoted\\\"\\n"}]}');
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  for (const value of [null, false, 123, "text"]) assert.equal(canonicalJson(value), JSON.stringify(value));
});

test("pretty canonical JSON shares the same key ordering without changing compact digest bytes", () => {
  const value = { z: [null, true, { z: "quoted\"\n", a: 1 }], a: { b: 2, a: -0 }, empty: [] };
  assert.equal(canonicalJson(value, true), JSON.stringify({ a: { a: 0, b: 2 }, empty: [], z: [null, true, { a: 1, z: "quoted\"\n" }] }, null, 2));
  assert.deepEqual(JSON.parse(canonicalJson(value, true)), JSON.parse(canonicalJson(value)));
  assert.equal(canonicalJson({ "2": true, "10": false }), '{"10":false,"2":true}');
  assert.equal(canonicalJson({}, true), "{}");
  assert.equal(canonicalJson([], true), "[]");
});

test("atomic JSON syncs the private file before rename and the directory afterwards", t => {
  const root = fixture(t), path = join(root, "nested", "record.json"), events: string[] = [];
  const writer = instrumentedWriter({
    fsyncSync(fd) { events.push(fs.fstatSync(fd).isDirectory() ? "directory-sync" : "file-sync"); fs.fsyncSync(fd); },
    renameSync(from, to) { events.push("rename"); fs.renameSync(from, to); },
  });
  writer(path, { before: true });
  assert.deepEqual(events, ["file-sync", "rename", "directory-sync"]);
  assert.equal(fs.readFileSync(path, "utf8"), '{\n  "before": true\n}\n');
  assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  assert.equal(fs.statSync(join(root, "nested")).mode & 0o777, 0o700);
  writer(path, { after: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path, "utf8")), { after: true });
  assert.deepEqual(fs.readdirSync(join(root, "nested")), ["record.json"]);
});

for (const operation of ["write", "fsync", "rename"] as const) {
  test(`atomic JSON preserves the previous record and removes temporary files after ${operation} failure`, t => {
    const root = fixture(t), path = join(root, "record.json");
    writeAtomicJson(path, { original: true });
    const fail = () => { throw new Error(`injected ${operation} failure`); };
    const writer = instrumentedWriter(operation === "write" ? { writeFileSync: fail } : operation === "fsync" ? { fsyncSync: fail } : { renameSync: fail });
    assert.throws(() => writer(path, { replacement: true }), new RegExp(`injected ${operation} failure`));
    assert.deepEqual(JSON.parse(fs.readFileSync(path, "utf8")), { original: true });
    assert.deepEqual(fs.readdirSync(root), ["record.json"]);
  });
}

test("exclusive publication never replaces an existing immutable record", t => {
  const root = fixture(t), path = join(root, "record.json");
  writeAtomicJson(path, { original: true }, { exclusive: true });
  assert.throws(() => writeAtomicJson(path, { replacement: true }, { exclusive: true }), { code: "EEXIST" });
  assert.deepEqual(JSON.parse(fs.readFileSync(path, "utf8")), { original: true });
  assert.deepEqual(fs.readdirSync(root), ["record.json"]);
});

test("fault hooks expose the same before/after atomic commit boundary", t => {
  const root = fixture(t), path = join(root, "record.json");
  writeAtomicJson(path, { original: true });
  for (const point of ["before-rename", "after-rename"] as const) {
    assert.throws(() => writeAtomicJson(path, { replacement: true }, { fault: current => { if (current === point) throw new Error(point); } }), new RegExp(point));
    assert.deepEqual(JSON.parse(fs.readFileSync(path, "utf8")), point === "before-rename" ? { original: true } : { replacement: true });
    assert.deepEqual(fs.readdirSync(root), ["record.json"]);
  }
});

test("bash exit-code CLI reads the shared source without station configuration", async t => {
  const lines: unknown[] = [];
  t.mock.method(console, "log", (value: unknown) => lines.push(value));
  assert.deepEqual(EXIT_CODES, { integrationHold: 86, retry: 75, cancelled: 77 });
  assert.ok(Object.isFrozen(EXIT_CODES));
  for (const [name, code] of Object.entries(EXIT_CODES)) {
    await main(["exit-code", name]);
    assert.equal(lines.pop(), code);
  }
  for (const args of [[], ["missing"], ["toString"], ["retry", "extra"]]) await assert.rejects(main(["exit-code", ...args]), /Usage: a4s exit-code/);
});

test("released gate helpers resolve the same runtime without a source checkout", t => {
  const root = fixture(t);
  for (const name of ["runtime.cjs", "gate-cache.cjs", "dagu-gate.cjs"]) {
    const helper = runtimeHelper(name);
    assert.ok(!helper.includes("@a4s/launcher/runtime"));
    fs.writeFileSync(join(root, name), helper);
  }
  assert.equal(fs.readFileSync(join(root, "runtime.cjs"), "utf8"), source);
  const cache = require(join(root, "gate-cache.cjs"));
  const record = { key: "example", result: "PASS", exitCode: 0, remote: false };
  cache.storePass(join(root, "cache"), record);
  assert.deepEqual(cache.lookup(join(root, "cache"), "example"), record);
});
