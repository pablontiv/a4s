import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("launcher acquisition/verification/lease/state module graph imports no payload identity", () => {
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const seen = new Set<string>();
  function visit(path: string): void {
    if (seen.has(path)) return;
    seen.add(path);
    assert.equal(relative(root, path).startsWith(".."), false, `Payload dependency: ${path}`);
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /A4S_BUILD_(?:VERSION|COMMIT)/);
    // Include type-only imports and dynamic imports as well as re-exports.
    for (const match of source.matchAll(/\b(?:import|export)\s*(?:\([^)]*?|\s+[^;]*?\bfrom\s*)?["']([^"']+)["']/g)) {
      const dependency = match[1]!;
      if (dependency.startsWith(".")) visit(resolve(dirname(path), dependency));
      else assert.ok(dependency.startsWith("node:") || dependency === "yaml" || dependency === "bun:ffi", `Unexpected launcher dependency ${dependency}`);
    }
  }
  visit(resolve(root, "cli.ts"));
  for (const module of ["artifact-cache.ts", "release.ts", "lease.ts", "station-state.ts", "select.ts"]) assert.ok(seen.has(resolve(root, module)));
});
