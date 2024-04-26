import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../../../.github/workflows/release.yml", import.meta.url), "utf8"));
const jobs = workflow.jobs;
const runs = (id: string): string => jobs[id].steps.map((step: { run?: string }) => step.run ?? "").join("\n");

test("publication requires successful compiled, live, reproducibility and all platform smoke jobs", () => {
  assert.deepEqual(jobs.release.needs, ["build", "compiled", "live-feature", "reproducibility", "smoke"]);
  // No always()/failure()/cancelled() override may bypass implicit success().
  assert.equal(jobs.release.if, "needs.build.outputs.publish == 'true'");
  for (const id of jobs.release.needs.filter((id: string) => id !== "build")) {
    assert.equal(jobs[id].needs, "build");
    assert.equal(jobs[id].if, "needs.build.outputs.publish == 'true'");
    assert.equal(jobs[id]["continue-on-error"], undefined);
    for (const step of jobs[id].steps) assert.equal(step["continue-on-error"], undefined);
  }
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(jobs.release.permissions.contents, "write");
  for (const [id, job] of Object.entries(jobs) as Array<[string, { steps: Array<{ run?: string; uses?: string; with?: Record<string, unknown> }> }]>) {
    for (const step of job.steps) {
      if (step.uses?.startsWith("actions/checkout@")) assert.equal(step.with?.ref, "${{ github.event.workflow_run.head_sha }}", id);
      if (step.run?.includes("publish-a4s.mjs publish")) assert.equal(id, "release");
    }
  }
});

test("release checks execute the intended commands and publish the checked artifacts without rebuilding", () => {
  assert.match(runs("compiled"), /A4S_RELEASE_DIR=.*npm run test:compiled --workspace @a4s\/issue-lifecycle/);
  assert.match(runs("live-feature"), /npm run test:release-live --workspace @a4s\/issue-lifecycle/);
  const install = jobs["live-feature"].steps.find((step: { name?: string }) => step.name === "Install pinned Dagu");
  assert.equal(install.env.DAGU_VERSION, "2.24.0");
  assert.match(install.run, /curl --fail/);
  assert.match(runs("reproducibility"), /node scripts\/build-a4s.mjs --outdir/);
  assert.match(runs("reproducibility"), /for checksum in dist\/\*\.sha256/);
  assert.match(runs("reproducibility"), /cmp "\$checksum"/);
  assert.match(runs("reproducibility"), /sha256sum --check \*\.sha256/);
  assert.deepEqual(jobs.smoke.strategy.matrix.include, [
    { runner: "ubuntu-latest", platform: "linux-x64" },
    { runner: "macos-14", platform: "darwin-arm64" },
  ]);
  assert.match(runs("smoke"), /\.\/payload\/a4s version/);
  assert.match(runs("smoke"), /\.\/launcher\/a4s-launch launcher-version/);
  assert.match(runs("smoke"), /shasum -a 256 --check/);
  assert.doesNotMatch(runs("release"), /build-a4s|build:a4s|npm ci/);
  for (const id of ["compiled", "reproducibility", "smoke", "release"]) {
    const download = jobs[id].steps.find((step: { uses?: string }) => step.uses?.startsWith("actions/download-artifact@"));
    assert.equal(download.with.name, "release-archives");
  }
});
