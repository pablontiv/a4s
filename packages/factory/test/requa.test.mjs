import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { needsReQa } from "../src/requa.mjs";

test("needsReQa: disjoint files -> false", () => assert.equal(needsReQa(["a.txt"], ["b.txt", "c/d.txt"]), false));
test("needsReQa: same file -> true", () => assert.equal(needsReQa(["a.txt", "x"], ["b.txt", "a.txt"]), true));
test("needsReQa: rename into a touched path -> true", () => {
  assert.equal(needsReQa(["a.txt"], [{ from: "old.txt", to: "a.txt" }]), true);
  assert.equal(needsReQa(["a.txt"], [["old.txt", "a.txt"]]), true);
});
test("needsReQa: rename out of a touched path -> true", () => {
  assert.equal(needsReQa(["a.txt"], [{ path: "new.txt", oldPath: "a.txt" }]), true);
  assert.equal(needsReQa([{ from: "a.txt", to: "z.txt" }], ["z.txt"]), true);
  assert.equal(needsReQa(["a.txt"], [{ from: "p", to: "q" }]), false);
});
test("needsReQa: empty incoming range or empty issue -> false", () => {
  assert.equal(needsReQa(["a.txt"], []), false);
  assert.equal(needsReQa([], ["a.txt"]), false);
  assert.equal(needsReQa(["a.txt"], undefined), false);
});
test("requa.mjs: decide, log and fail", () => {
  const d = mkdtempSync(join(tmpdir(), "requa-"));
  writeFileSync(join(d, "i"), "a\nb\n"); writeFileSync(join(d, "n1"), "b\n"); writeFileSync(join(d, "n2"), "c\n");
  const cli = (...a) => spawnSync("node", [join(import.meta.dirname, "..", "src", "requa.mjs"), ...a], { encoding: "utf8" });
  assert.equal(cli("decide", join(d, "i"), join(d, "n1")).stdout.trim(), "true");
  assert.equal(cli("decide", join(d, "i"), join(d, "n2")).stdout.trim(), "false");
  cli("log", "--file", join(d, "l.json"), "--from", "1000", "--to", "4000", "--incoming", "2", "--result", "pass");
  assert.equal(JSON.parse(readFileSync(join(d, "l.json"), "utf8")).ms, 3000);
  cli("fail", "--file", join(d, "f.json"), "--run", "r1", "--findings", '["bad"]');
  assert.deepEqual(JSON.parse(readFileSync(join(d, "f.json"), "utf8")), { run: "r1", step: "integrate", findings: ["re-qa: bad"] });
});
