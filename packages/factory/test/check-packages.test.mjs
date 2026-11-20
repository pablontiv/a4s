import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { missingPackages } from "../src/check-packages.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "check-packages.mjs");
const LINES = { impl: { instance: { packages: ["pi-web-search"] } }, qa: { instance: { packages: ["pi-web-search"] } } };

test("missingPackages accepts npm: prefixes, versions and object sources", () => {
  assert.deepEqual(missingPackages(LINES, ["npm:pi-web-search"]), []);
  assert.deepEqual(missingPackages(LINES, ["npm:pi-web-search@1.2.0"]), []);
  assert.deepEqual(missingPackages(LINES, [{ source: "npm:pi-web-search" }]), []);
  assert.deepEqual(missingPackages(LINES, ["npm:other"]), ["impl: pi-web-search", "qa: pi-web-search"]);
});

test("the CLI fails with a clear message when the package is not installed, and passes when it is", () => {
  const d = mkdtempSync(join(tmpdir(), "chkpkg-"));
  try {
    const settings = join(d, "settings.json");
    const run = () => spawnSync("node", [SCRIPT], { env: { ...process.env, PI_SETTINGS: settings }, encoding: "utf8" });
    writeFileSync(settings, JSON.stringify({ packages: [] }));
    let r = run(); assert.equal(r.status, 1); assert.match(r.stderr, /pi-web-search/); assert.match(r.stderr, /pi install/);
    writeFileSync(settings, JSON.stringify({ packages: ["npm:pi-web-search"] }));
    r = run(); assert.equal(r.status, 0, r.stderr);
    r = spawnSync("node", [SCRIPT], { env: { ...process.env, PI_SETTINGS: join(d, "none.json") }, encoding: "utf8" });
    assert.equal(r.status, 1); assert.match(r.stderr, /not found/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
