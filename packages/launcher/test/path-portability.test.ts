import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
test("production source never embeds a user-home or versioned store path", () => {
  const violations: string[] = [];
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!["node_modules", "test", "tests", "fixtures", "dist", ".git", ".workspace"].includes(entry.name)) visit(path);
      } else if (/\.(?:ts|js|mjs|cjs|sh|yaml|yml)$/.test(entry.name)) {
        for (const [line, text] of readFileSync(path, "utf8").split("\n").entries()) {
          if (/\/(?:home|Users)\/[^\s/"'`]+|\/(?:nix|gnu)\/store\//.test(text)) violations.push(`${relative(repository, path)}:${line + 1}`);
        }
      }
    }
  }
  visit(join(repository, "packages"));
  visit(join(repository, "scripts"));
  assert.deepEqual(violations, [], "use declaration/XDG configuration, not machine paths");
});
