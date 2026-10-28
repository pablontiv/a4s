import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";
import { exampleConfig } from "../../src/config.ts";
import { BUNDLE_VERSION } from "../../src/bundle.ts";
import { materializeDag } from "../../src/materialize.ts";

const root = mkdtempSync(join(tmpdir(), "templates-rendered-"));
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const config = exampleConfig({ lane: "fixture", gate: "true", requiredCheck: "validate", testPaths: "test" });
for (const name of ["feature.yaml", "poc.yaml"] as const) {
  writeFileSync(join(root, name), materializeDag(packageRoot, name, config, {
    version: BUNDLE_VERSION, source: `fixture/repo@${"a".repeat(40)}`, executable: "/fixture/a4s",
  }));
}
export const renderedFeature = join(root, "feature.yaml");
export const renderedPoc = join(root, "poc.yaml");
after(() => rmSync(root, { recursive: true, force: true }));
