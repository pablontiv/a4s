import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");
const gate = read("scripts", "factory-gate.sh");
const selftest = read("packages", "factory", "selftest", "selftest.mjs");

test("gate derives the Node major from ci.yml", () => {
  assert.match(gate, /\.github\/workflows\/ci\.yml/);
  assert.match(gate, /node-version/);
  assert.match(gate, /nodejs_\$\{ci_node\}/);
  assert.match(read(".github", "workflows", "ci.yml"), /^\s*node-version:\s*\d+/m);
});

test("gate runs only the stub selftest, never the full selftest (#1108)", () => {
  assert.match(gate, /^npm run selftest:stub -w @a4s\/factory$/m);
  assert.doesNotMatch(gate, /^[^#]*npm run selftest(\s|$)/m);
});

test("selftest Dagu binary defaults to dagu on PATH", () => {
  assert.match(selftest, /DAGU_BIN\s*=\s*process\.env\.FACTORY_DAGU_BIN\s*\?\?\s*"dagu"\s*;/);
});

test("selftest passes only PATH, HOME, DAGU_HOME, DAGU_SKIP_EXAMPLES to Dagu", () => {
  const allowed = ["PATH", "HOME", "DAGU_HOME", "DAGU_SKIP_EXAMPLES"];
  const envs = [...selftest.matchAll(/const\s+(env|adEnv)\s*=\s*\{([^}]*)\}/g)];
  assert.equal(envs.length, 2);
  for (const m of envs) {
    const keys = [...m[2].matchAll(/(?:^|,)\s*([A-Z_]+)\s*:/g)].map((k) => k[1]);
    assert.deepEqual(keys, allowed);
  }
  const spawns = [...selftest.matchAll(/(?:spawn|spawnSync)\(DAGU_BIN[^\n]*/g)].map((m) => m[0]);
  assert.ok(spawns.length >= 3);
  for (const s of spawns) {
    assert.match(s, /\benv(:\s*(env|adEnv))?\s*[,}]/, s);
    assert.doesNotMatch(s, /process\.env/);
  }
});
