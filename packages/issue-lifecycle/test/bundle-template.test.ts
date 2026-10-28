import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const ciWorkflow = parse(readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8"));
test("CI derives every Node setup from the root runtime manifest", () => {
  const jobs = Object.values(ciWorkflow.jobs) as { steps: { uses?: string; with?: Record<string, unknown> }[] }[];
  const setups = jobs.flatMap(job => job.steps).filter(step => step.uses?.startsWith("actions/setup-node@"));
  assert.ok(setups.length > 0);
  for (const setup of setups) {
    assert.equal(setup.with?.["node-version-file"], "package.json");
    assert.equal(setup.with?.["node-version"], undefined);
  }
});
