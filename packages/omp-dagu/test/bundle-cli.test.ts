import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../bin/dagu-feature-bundle.ts", import.meta.url));
const stamp = "# dagu-feature-bundle: @a4s/omp-dagu@0.2.0 source=pablontiv/a4s@0123456789012345678901234567890123456789 bootstrap=bootstrap-probe-0.2.0 dagu=2.19.2\nlabels:\n  - dagu-feature-bundle=0.2.0\n";

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
    writeFileSync(dagu, "#!/bin/sh\nprintf '2.19.2\\n'\n");
    chmodSync(dagu, 0o755);
    const result = spawnSync(process.execPath, [cli, repo], {
      encoding: "utf8",
      env: { ...process.env, DAGU_HOME: daguHome, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /feature\.yaml .*version=0\.2\.0 .*compat=ok/);
    assert.match(result.stdout, /poc\.yaml .*version=0\.2\.0 .*compat=ok/);
    assert.match(result.stdout, /discovery\.yaml .*version=0\.2\.0 .*compat=ok/);
    assert.match(result.stdout, /reconcile\.yaml .*version=0\.2\.0 .*compat=ok/);
    assert.match(result.stdout, /dagu version="2\.19\.2" required=2\.19\.2 compat=ok/);
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
    writeFileSync(dagu, "#!/bin/sh\nprintf '2.19.2\\n'\n");
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
