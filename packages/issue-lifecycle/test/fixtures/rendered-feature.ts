import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BUNDLE_VERSION } from "../../src/bundle.ts";
import { bootstrapRender } from "./bootstrap-render.ts";

const root = mkdtempSync(join(tmpdir(), "issue-lifecycle-rendered-"));
bootstrapRender({
  packageDir: fileURLToPath(new URL("../../", import.meta.url)),
  directory: root, primary: root, version: BUNDLE_VERSION,
  sourceNwo: "fixture/repo", sourceSha: "a".repeat(40),
});
export const renderedDags = pathToFileURL(`${root}/`);
export const renderedFeature = join(root, "feature.yaml");
export const renderedPoc = join(root, "poc.yaml");
after(() => rmSync(root, { recursive: true, force: true }));
