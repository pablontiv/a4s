import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(packageRoot, "../..");

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

test("Context Expert exposes one canonical Pi adapter", () => {
  const manifest = json(`${packageRoot}/package.json`) as {
    name?: string;
    exports?: Record<string, string>;
    pi?: { extensions?: string[] };
  };

  assert.equal(manifest.name, "@a4s/context-expert");
  assert.equal(manifest.exports?.["./pi"], "./adapters/pi/src/index.ts");
  assert.deepEqual(manifest.pi?.extensions, ["./adapters/pi/src/index.ts"]);
  assert.equal(existsSync(`${packageRoot}/adapters/pi/src/index.ts`), true);
  assert.equal(existsSync(`${repositoryRoot}/packages/pi-context-expert`), false);
});

test("Pi host packages are wildcard peers, not runtime dependencies", () => {
  const manifest = json(`${packageRoot}/package.json`) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };

  assert.equal(manifest.dependencies?.["@earendil-works/pi-coding-agent"], undefined);
  assert.equal(manifest.peerDependencies?.["@earendil-works/pi-coding-agent"], "*");
});
