import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const packageDir = fileURLToPath(new URL("../", import.meta.url));
const skillDir = join(packageDir, "skills", "issue-execution");
function bootstrap(): { steps: Array<{ id: string; run?: string }> } {
  return parse(readFileSync(join(skillDir, "dagu-feature-bootstrap.yaml"), "utf8"));
}

test("bootstrap checks one release executable and never installs station assets", () => {
  const bins = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).bin;
  assert.deepEqual(bins, { a4s: "./src/cli.ts" });
  const spec = bootstrap();
  assert.deepEqual(spec.steps.map(step => step.id), ["detect", "config", "worktrees", "write_config", "readiness", "github", "confirm"]);
  const detect = spec.steps.find(step => step.id === "detect")!.run!;
  assert.match(detect, /for tool in git gh jq curl dagu "\$A4S_BIN"; do/);
  assert.match(detect, /"\$A4S_BIN" role-jobs detect/);
  assert.match(detect, /"\$A4S_BIN" queue --lane "\$repo"/);
  const scripts = spec.steps.map(step => step.run ?? "").join("\n");
  assert.doesNotMatch(scripts, /install-reconciler|seal-checkout|SOURCE_SHA|SOURCE_NWO|SKILL_DIR|\$DAGU_HOME\/dags|dagu validate/);
  for (const id of ["readiness", "confirm"]) {
    assert.match(spec.steps.find(step => step.id === id)!.run!, /"\$A4S_BIN" queue "\$STAGE"/);
  }
});

