import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";
import { BUNDLE_VERSION } from "../src/bundle.ts";
import { bootstrapRender } from "./fixtures/bootstrap-render.ts";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

test("versioned global base config retains thirty days of run history", () => {
  const base = readFileSync(new URL("../dagu/base.yaml", import.meta.url), "utf8");
  const values = [...base.matchAll(/^hist_retention_days:\s*(\d+)\s*$/gm)];
  assert.deepEqual(values.map((match) => Number(match[1])), [30]);
});

test("rendered reconcile root retains 1440 runs while feature, PoC and planning keep the day horizon", () => {
  const directory = mkdtempSync(join(tmpdir(), "reconcile-retention-"));
  try {
    bootstrapRender({
      packageDir,
      directory,
      primary: directory,
      version: BUNDLE_VERSION,
      sourceNwo: "example/fixture",
      sourceSha: "a".repeat(40),
    });
    const documents = parseAllDocuments(readFileSync(join(directory, "reconcile.yaml"), "utf8"))
      .map(document => document.toJS() as Record<string, unknown>);
    const root = documents[0];
    const child = documents[1];
    assert.ok(root);
    assert.equal(root.hist_retention_runs, 1440);
    assert.equal(Object.hasOwn(root, "hist_retention_days"), false);
    assert.equal(child?.name, "reconcile-run");
    assert.equal(Object.hasOwn(child ?? {}, "hist_retention_runs"), false);
    for (const name of ["feature.yaml", "poc.yaml", "planning.yaml"]) {
      const dag = parseAllDocuments(readFileSync(join(directory, name), "utf8"))[0]?.toJS() as Record<string, unknown>;
      assert.equal(Object.hasOwn(dag, "hist_retention_runs"), false, name);
      assert.equal(Object.hasOwn(dag, "hist_retention_days"), false, name);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
