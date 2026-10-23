import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const methodRoot = fileURLToPath(new URL("../skills/repository-discovery", import.meta.url));
const lensRoot = join(methodRoot, "lenses");


test("the discovery method links its execution contract and every installed lens", () => {
  const method = readFileSync(join(methodRoot, "METHOD.md"), "utf8");
  assert.ok(method.includes("(CONTRACT.md)"));
  const linked = new Set([...method.matchAll(/\(lenses\/([^)]+\.md)\)/g)].map((match) => match[1]));
  const present = new Set(readdirSync(lensRoot).filter((name) => name.endsWith(".md")));
  assert.deepEqual(linked, present);
});
