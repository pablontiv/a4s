import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RECEIPT_REL, beginReceipt, endReceipt, snapshotTree, treeHash } from "../src/receipt.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const b = (s) => Buffer.from(s);
const E = (path, kind, c) => ({ path, kind, content: c == null ? null : b(c) });

test("treeHash is pure: same snapshot same hash, order irrelevant, every change alters it", () => {
  const a = [E("a", "modified", "1"), E("packages/factory/x", "untracked", "2")];
  const h = treeHash(a);
  assert.equal(treeHash(structuredClone(a).map((e) => ({ ...e, content: e.content && Buffer.from(e.content) }))), h);
  assert.equal(treeHash([...a].reverse()), h);
  assert.notEqual(treeHash([E("a", "modified", "9"), a[1]]), h); // edit
  assert.notEqual(treeHash([...a, E("n", "untracked", "")]), h); // add
  assert.notEqual(treeHash([a[1], E("a", "deleted", null)]), h); // delete
  // rename into and out of packages/factory/
  const into = [E("old.txt", "deleted", null), E("packages/factory/old.txt", "added", "z")];
  const out = [E("packages/factory/old.txt", "deleted", null), E("old.txt", "added", "z")];
  assert.notEqual(treeHash(into), treeHash(out));
  assert.notEqual(treeHash(into), treeHash([E("packages/factory/old.txt", "added", "z")]));
  assert.notEqual(treeHash(out), treeHash([E("old.txt", "added", "z")]));
});

function repo() {
  const d = mkdtempSync(join(tmpdir(), "rcpt-"));
  const g = (...a) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: d });
  g("init", "-q", "-b", "main");
  mkdirSync(join(d, "packages", "factory"), { recursive: true });
  writeFileSync(join(d, "packages", "factory", "a.mjs"), "1\n");
  writeFileSync(join(d, "b.txt"), "b\n");
  g("add", "-A"); g("commit", "-qm", "i");
  return { d, g };
}

test("snapshotTree sees edits, deletions, untracked and both paths of a staged rename; excludes the receipt", () => {
  const { d, g } = repo();
  assert.deepEqual(snapshotTree(d), []);
  writeFileSync(join(d, "b.txt"), "c\n");
  writeFileSync(join(d, "new.txt"), "n");
  renameSync(join(d, "packages", "factory", "a.mjs"), join(d, "moved.mjs"));
  g("add", "-A");
  writeFileSync(join(d, "packages", "factory", ".selftest-receipt.json"), "{}");
  const s = Object.fromEntries(snapshotTree(d).map((e) => [e.path, e.kind]));
  assert.deepEqual(s, { "b.txt": "modified", "new.txt": "added", "packages/factory/a.mjs": "deleted", "moved.mjs": "added" });
  const h = treeHash(snapshotTree(d));
  writeFileSync(join(d, "moved.mjs"), "2\n");
  assert.notEqual(treeHash(snapshotTree(d)), h);
});

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "rcf-")), "receipt.json");

test("tree edited during the run: no receipt; unchanged: receipt written", () => {
  const { d } = repo(); const file = tmpFile();
  const startHash = beginReceipt({ dir: d, file });
  writeFileSync(join(d, "b.txt"), "edited during run\n");
  const r = endReceipt({ dir: d, file, passed: true, startHash, startedAt: "s", model: "m" });
  assert.equal(r.written, false); assert.match(r.reason, /changed/); assert.equal(existsSync(file), false);
  const h2 = beginReceipt({ dir: d, file });
  assert.equal(endReceipt({ dir: d, file, passed: true, startHash: h2, startedAt: "s", model: "m" }).written, true);
  const rc = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(rc).sort(), ["finishedAt", "model", "startedAt", "treeHash", "version"]);
  assert.equal(rc.version, 1); assert.equal(rc.treeHash, treeHash(snapshotTree(d)));
});

test("a failed selftest leaves no receipt; disabled leaves an existing one untouched", () => {
  const { d } = repo(); const file = tmpFile();
  writeFileSync(file, "stale");
  const h = beginReceipt({ dir: d, file });
  assert.equal(existsSync(file), false);
  writeFileSync(file, "stale");
  assert.equal(endReceipt({ dir: d, file, passed: false, startHash: h }).written, false);
  assert.equal(existsSync(file), false);
  writeFileSync(file, "keep");
  assert.equal(beginReceipt({ dir: d, file, enabled: false }), null);
  assert.equal(endReceipt({ dir: d, file, enabled: false, passed: true, startHash: "x" }).written, false);
  assert.equal(readFileSync(file, "utf8"), "keep");
});

test("selftest process: early failure (mkdtemp) removes a stale receipt; SELFTEST_NO_RECEIPT=1 keeps it", () => {
  const file = tmpFile();
  const run = (extra) => spawnSync("node", [join(here, "..", "selftest", "selftest.mjs")], {
    encoding: "utf8", env: { ...process.env, TMPDIR: "/nonexistent-dir-for-selftest", SELFTEST_RECEIPT_FILE: file, ...extra },
  });
  writeFileSync(file, "stale");
  const r1 = run({ SELFTEST_NO_RECEIPT: "1" });
  assert.equal(r1.status, 1); assert.equal(readFileSync(file, "utf8"), "stale");
  const r2 = run({});
  assert.equal(r2.status, 1); assert.match(r2.stdout, /SELFTEST FAIL/); assert.equal(existsSync(file), false);
});

test("qa prompt allows SELFTEST_NO_RECEIPT=1", () => {
  assert.match(readFileSync(join(here, "..", "prompts", "qa.md"), "utf8"), /SELFTEST_NO_RECEIPT=1/);
});

test("git rm --cached keeps the file's current content in the hash", () => {
  const { d, g } = repo();
  g("rm", "-q", "--cached", "b.txt");
  const h = treeHash(snapshotTree(d));
  writeFileSync(join(d, "b.txt"), "edited\n");
  assert.notEqual(treeHash(snapshotTree(d)), h);
});

test("only the exact receipt path is excluded, not same-named files elsewhere", () => {
  const { d } = repo();
  mkdirSync(join(d, "other"));
  writeFileSync(join(d, "other", ".selftest-receipt.json"), "1");
  const h = treeHash(snapshotTree(d));
  writeFileSync(join(d, "other", ".selftest-receipt.json"), "2");
  assert.notEqual(treeHash(snapshotTree(d)), h);
  assert.notEqual(treeHash([E("other/.selftest-receipt.json", "untracked", "1")]), treeHash([]));
  assert.equal(treeHash([E(RECEIPT_REL, "untracked", "1")]), treeHash([]));
  const h2 = treeHash(snapshotTree(d));
  writeFileSync(join(d, RECEIPT_REL), "{}");
  assert.equal(treeHash(snapshotTree(d)), h2);
});

import { receiptDecision, checkReceipt, FINDING } from "../src/receipt.mjs";
describe_decision();
function describe_decision() {
  const snap = [E("packages/factory/src/x.mjs", "modified", "x")];
  const good = { treeHash: treeHash(snap) };
  test("receiptDecision: matching receipt passes", () => {
    assert.deepEqual(receiptDecision(snap, good), { required: true, ok: true, reason: null });
  });
  test("receiptDecision: stale receipt fails", () => {
    const d = receiptDecision(snap, { treeHash: "0".repeat(64) });
    assert.equal(d.ok, false); assert.equal(d.reason, "stale"); assert.ok(d.finding.startsWith(FINDING)); assert.match(d.finding, /stale/);
  });
  test("receiptDecision: missing receipt fails", () => {
    const d = receiptDecision(snap, null);
    assert.equal(d.ok, false); assert.equal(d.reason, "missing"); assert.match(d.finding, /^selftest not run on this code: receipt missing/);
  });
  test("receiptDecision: a change outside packages/factory/ needs no receipt", () => {
    assert.deepEqual(receiptDecision([E("README.md", "modified", "x")], null), { required: false, ok: true, reason: null });
  });
  test("receiptDecision: a rename out of packages/factory/ still requires it", () => {
    const rn = [E("packages/factory/src/old.mjs", "deleted", null), E("docs/old.mjs", "added", "x")];
    assert.equal(receiptDecision(rn, null).reason, "missing");
    assert.equal(receiptDecision(rn, { treeHash: treeHash(rn) }).ok, true);
  });
  test("checkReceipt writes the finding for the retry on failure", () => {
    const { d } = repo();
    mkdirSync(join(d, "packages/factory"), { recursive: true });
    writeFileSync(join(d, "packages/factory/x.mjs"), "1");
    const ff = join(d, "sf.json");
    assert.equal(checkReceipt({ dir: d, failureFile: ff, run: "r1" }).ok, false);
    const sf = JSON.parse(readFileSync(ff, "utf8"));
    assert.deepEqual([sf.run, sf.step], ["r1", "validate"]);
    assert.match(sf.findings[0], /^selftest not run on this code/);
    writeFileSync(join(d, RECEIPT_REL), JSON.stringify({ treeHash: treeHash(snapshotTree(d)) }));
    assert.equal(checkReceipt({ dir: d, failureFile: ff, run: "r1" }).ok, true);
  });
}
