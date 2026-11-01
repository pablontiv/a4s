import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const lifecycle = fileURLToPath(new URL("../", import.meta.url));
const launcher = fileURLToPath(new URL("../../launcher/", import.meta.url));

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.[cm]?[jt]s$/.test(entry.name) ? [path] : [];
  });
}

test("issue-lifecycle consumes only exported launcher package subpaths", () => {
  const consumed = new Set<string>();
  for (const directory of ["src", "test", "bin"]) {
    for (const path of sources(resolve(lifecycle, directory))) {
      const source = readFileSync(path, "utf8");
      // Include type-only imports, re-exports, dynamic imports and fixture scripts.
      for (const match of source.matchAll(/\b(?:import|export)\s*(?:\([^)]*?|\s+[^;]*?\bfrom\s*)?["']([^"']+)["']/g)) {
        const specifier = match[1]!;
        if (specifier.startsWith(".")) {
          const target = relative(launcher, resolve(dirname(path), specifier));
          assert.ok(target.startsWith(".."), `${relative(lifecycle, path)} bypasses launcher exports: ${specifier}`);
        }
        if (specifier.startsWith("@a4s/launcher")) {
          assert.ok(existsSync(fileURLToPath(import.meta.resolve(specifier))), `Missing launcher export: ${specifier}`);
          consumed.add(specifier);
        }
      }
    }
  }
  assert.ok(consumed.has("@a4s/launcher/artifact-cache"));
  assert.ok(consumed.has("@a4s/launcher/service-environment"));
  assert.throws(() => import.meta.resolve("@a4s/launcher/src/artifact-cache.ts"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
});

test("artifact-cache unit and live tests belong to the launcher workspace", () => {
  for (const path of ["test/artifact-cache.test.ts", "test/live/artifact-cache.test.ts"]) {
    assert.equal(existsSync(resolve(lifecycle, path)), false, path);
    assert.equal(existsSync(resolve(launcher, path)), true, path);
  }
});
