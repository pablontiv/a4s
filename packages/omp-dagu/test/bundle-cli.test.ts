import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { BUNDLE_VERSION } from "../src/bundle.ts";
const cli = fileURLToPath(new URL("../bin/dagu-feature-bundle.ts", import.meta.url));
const stamp = `# dagu-feature-bundle: @a4s/omp-dagu@${BUNDLE_VERSION} source=pablontiv/a4s@0123456789012345678901234567890123456789 bootstrap=bootstrap-probe dagu=2.20.1\nlabels:\n  - dagu-feature-bundle=${BUNDLE_VERSION}\n`;

test("CLI reports stamped repositories and the reconciler as compatible", () => {
  const root = mkdtempSync(join(tmpdir(), "dagu-bundle-cli-"));
  try {
    const repo = join(root, "repo");
    const daguHome = join(root, "dagu-home");
    const bin = join(root, "bin");
    mkdirSync(join(repo, ".workspace", "dagu", "dags"), { recursive: true });
    mkdirSync(join(daguHome, "dags"), { recursive: true });
    mkdirSync(bin);
    spawnSync("git", ["init", "-b", "main", repo], { encoding: "utf8" });
    writeFileSync(join(repo, ".workspace", "dagu", "dags", "feature.yaml"), stamp);
    writeFileSync(join(repo, ".workspace", "dagu", "dags", "poc.yaml"), stamp);
    writeFileSync(join(repo, ".workspace", "dagu", "dags", "discovery.yaml"), stamp);
    writeFileSync(join(daguHome, "dags", "reconcile.yaml"), stamp);
    const dagu = join(bin, "dagu");
    writeFileSync(dagu, "#!/bin/sh\nprintf '2.20.1\\n'\n");
    chmodSync(dagu, 0o755);
    const result = spawnSync(process.execPath, [cli, repo], {
      encoding: "utf8",
      env: { ...process.env, DAGU_HOME: daguHome, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    assert.equal(result.status, 0, result.stderr);
    for (const name of ["feature", "poc", "discovery", "reconcile"]) {
      assert.ok(result.stdout.includes(`${name}.yaml `), result.stdout);
    }
    assert.equal((result.stdout.match(/compat=ok/g) ?? []).length, 5);
    assert.match(result.stdout, /dagu version="2\.20\.1" required=2\.20\.1 compat=ok/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI exits nonzero for unstamped repository DAGs", () => {
  const root = mkdtempSync(join(tmpdir(), "dagu-bundle-cli-"));
  try {
    const repo = join(root, "repo");
    const daguHome = join(root, "dagu-home");
    const bin = join(root, "bin");
    mkdirSync(join(repo, ".workspace", "dagu", "dags"), { recursive: true });
    mkdirSync(join(daguHome, "dags"), { recursive: true });
    mkdirSync(bin);
    spawnSync("git", ["init", "-b", "main", repo], { encoding: "utf8" });
    writeFileSync(join(repo, ".workspace", "dagu", "dags", "feature.yaml"), "labels:\n");
    writeFileSync(join(repo, ".workspace", "dagu", "dags", "poc.yaml"), "labels:\n");
    writeFileSync(join(repo, ".workspace", "dagu", "dags", "discovery.yaml"), "labels:\n");
    writeFileSync(join(daguHome, "dags", "reconcile.yaml"), stamp);
    const dagu = join(bin, "dagu");
    writeFileSync(dagu, "#!/bin/sh\nprintf '2.20.1\\n'\n");
    chmodSync(dagu, 0o755);
    const result = spawnSync(process.execPath, [cli, repo], {
      encoding: "utf8",
      env: { ...process.env, DAGU_HOME: daguHome, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /feature\.yaml .*stamp=unstamped compat=unstamped/);
    assert.match(result.stdout, /poc\.yaml .*stamp=unstamped compat=unstamped/);
    assert.match(result.stdout, /discovery\.yaml .*stamp=unstamped compat=unstamped/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
