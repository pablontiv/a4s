import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectCandidate, compareCandidates } from "../src/candidate.mjs";
import { missingPackages } from "../src/check-packages.mjs";

function repo(t) {
  const d = mkdtempSync(join(tmpdir(), "cand-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const git = (...a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(d, ".gitignore"), "node_modules/\n.cache/\nforced.txt\nlinked\n");
  writeFileSync(join(d, "a.txt"), "a\n");
  writeFileSync(join(d, "forced.txt"), "f\n");
  git("add", "-f", "a.txt", ".gitignore", "forced.txt");
  git("-c", "user.email=a@b", "-c", "user.name=t", "commit", "-q", "-m", "i");
  return d;
}
const diff = (d, mutate) => { const b = collectCandidate(d); mutate(); return compareCandidates(b, collectCandidate(d)); };

test("tracked edit, mode change, deletion, new non-ignored file are reported", (t) => {
  const d = repo(t);
  assert.deepEqual(diff(d, () => writeFileSync(join(d, "a.txt"), "b\n")), ["a.txt: changed"]);
  assert.deepEqual(diff(d, () => execFileSync("chmod", ["+x", join(d, "a.txt")])), ["a.txt: changed"]);
  assert.deepEqual(diff(d, () => rmSync(join(d, "a.txt"))), ["a.txt: deleted"]);
  assert.deepEqual(diff(d, () => writeFileSync(join(d, "n.txt"), "n")), ["n.txt: added"]);
  assert.deepEqual(diff(d, () => writeFileSync(join(d, "n.txt"), "m")), ["n.txt: changed"]);
});

test("ignored paths are not compared: node_modules, cache dir, receipt-like files", (t) => {
  const d = repo(t);
  assert.deepEqual(diff(d, () => {
    mkdirSync(join(d, "node_modules", "x"), { recursive: true }); writeFileSync(join(d, "node_modules", "x", "i.js"), "1");
    mkdirSync(join(d, ".cache")); writeFileSync(join(d, ".cache", "c"), "1");
  }), []);
});

test("a symlinked ignored path (node_modules) pointing outside the worktree is ignored and never followed", (t) => {
  const d = repo(t), outside = mkdtempSync(join(tmpdir(), "cand-out-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  assert.deepEqual(diff(d, () => { symlinkSync(outside, join(d, "linked")); writeFileSync(join(outside, "f"), "1"); }), []);
});

test("an untracked non-ignored symlink is compared by target, not followed", (t) => {
  const d = repo(t);
  assert.deepEqual(diff(d, () => symlinkSync("/nonexistent-target", join(d, "l"))), ["l: added"]);
});

test("tracked wins over ignored: a tracked file matching .gitignore is compared", (t) => {
  const d = repo(t);
  assert.deepEqual(diff(d, () => writeFileSync(join(d, "forced.txt"), "g\n")), ["forced.txt: changed"]);
});

test("changing .gitignore itself is a violation", (t) => {
  const d = repo(t);
  assert.ok(diff(d, () => writeFileSync(join(d, ".gitignore"), "")).includes(".gitignore: changed"));
});

test("a path named __proto__ is tracked like any other (edit, delete, add)", (t) => {
  const d = repo(t);
  writeFileSync(join(d, "__proto__"), "1");
  execFileSync("git", ["add", "__proto__"], { cwd: d });
  assert.deepEqual(diff(d, () => writeFileSync(join(d, "__proto__"), "2")), ["__proto__: changed"]);
  assert.deepEqual(diff(d, () => rmSync(join(d, "__proto__"))), ["__proto__: deleted"]);
  const e = repo(t);
  assert.deepEqual(diff(e, () => writeFileSync(join(e, "__proto__"), "1")), ["__proto__: added"]);
});

test("missingPackages: required Pi packages vs settings.json entries", () => {
  const lines = { impl: { instance: { packages: ["pi-web-search"] } }, qa: { instance: { packages: ["pi-web-search"] } }, x: {} };
  assert.deepEqual(missingPackages(lines, ["npm:pi-web-search"]), []);
  assert.deepEqual(missingPackages(lines, ["npm:pi-web-search@1.2.0"]), []);
  assert.deepEqual(missingPackages(lines, [{ source: "npm:pi-web-search" }]), []);
  assert.deepEqual(missingPackages(lines, ["npm:other"]), ["impl: pi-web-search", "qa: pi-web-search"]);
});
