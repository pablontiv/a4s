import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { REQUIRED_DAGU_VERSION } from "../src/bundle.ts";

const bundle = "packages/issue-lifecycle";
const skills = `${bundle}/skills`;
const fixturePaths = [`${skills}/issue-execution/feature.yaml`, `${skills}/repository-discovery/SKILL.md`, `${skills}/issue-execution/planning.yaml`];
const git = (root: string, ...args: string[]): string => execFileSync("git", args, {
  cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();

function mergeBase(root: string, branch: string): string {
  const ref = `refs/remotes/origin/${branch}`;
  try {
    return git(root, "merge-base", ref, "HEAD");
  } catch {
    // actions/checkout uses a shallow, single-ref checkout by default.
    const shallow = git(root, "rev-parse", "--is-shallow-repository") === "true";
    git(root, "fetch", ...(shallow ? ["--unshallow"] : []), "origin", `+refs/heads/${branch}:${ref}`);
    return git(root, "merge-base", ref, "HEAD");
  }
}

function baselineBundle(root: string, base: string): { path: string; version: string } {
  const manifests = git(root, "ls-tree", "-r", "--name-only", "-z", base, "--", "packages")
    .split("\0").filter(path => path.endsWith("/package.json"));
  const bundles = manifests.flatMap(path => {
    const manifest = JSON.parse(git(root, "show", `${base}:${path}`));
    return typeof manifest.daguFeature?.dagu === "string" && manifest.bin?.["dagu-feature-bundle"]
      ? [{ path: path.slice(0, -"/package.json".length), version: manifest.version as string }] : [];
  });
  assert.equal(bundles.length, 1, `Expected one lifecycle bundle at integration base ${base}`);
  return bundles[0]!;
}

function checkBundleVersion(root: string, branch = "main"): void {
  const base = mergeBase(root, branch);
  const previousBundle = baselineBundle(root, base);
  const changed = [...new Set([
    ...git(root, "diff", "--name-only", "-z", base, "--", skills, `${previousBundle.path}/skills`).split("\0"),
    ...git(root, "ls-files", "--others", "--exclude-standard", "-z", "--", skills).split("\0"),
  ].filter(Boolean))];
  if (!changed.length) return;
  const previous = previousBundle.version;
  const current: string = JSON.parse(readFileSync(join(root, bundle, "package.json"), "utf8")).version;
  const message = `Bundle templates changed: ${changed.join(", ")}; base version ${previous}. Require a greater package version and a CHANGELOG.md section ## ${current}.`;
  const version = (value: string): number[] => {
    assert.match(value, /^\d+\.\d+\.\d+$/, message);
    return value.split(".").map(Number);
  };
  const before = version(previous);
  const after = version(current);
  const first = after.findIndex((part, i) => part !== before[i]);
  assert.ok(first >= 0 && after[first]! > before[first]!, message);
  const headings = readFileSync(join(root, bundle, "CHANGELOG.md"), "utf8").split(/\r?\n/);
  assert.ok(headings.includes(`## ${current}`), message);
}

function fixture(): { root: string; put: (path: string, text: string) => void; commit: () => void } {
  const root = mkdtempSync(join(tmpdir(), "dagu-bundle-version-"));
  const put = (path: string, text: string): void => {
    const target = join(root, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, text);
  };
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Bundle test");
  git(root, "config", "user.email", "bundle@example.test");
  const commit = (): void => { git(root, "add", "."); git(root, "commit", "-m", "fixture"); };
  put(`${bundle}/package.json`, JSON.stringify({
    name: "@a4s/issue-lifecycle", version: "0.2.0", daguFeature: { dagu: REQUIRED_DAGU_VERSION },
    bin: { "dagu-feature-bundle": "./bin/dagu-feature-bundle.ts" },
  }));
  put(`${bundle}/CHANGELOG.md`, "## 0.2.0\n");
  for (const path of fixturePaths) put(path, "original\n");
  commit();
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  return { root, put, commit };
}

test("template changes require a greater bundle version and its release heading", () => {
  const { root, put, commit } = fixture();
  try {
    checkBundleVersion(root);
    for (const path of fixturePaths) {
      put(path, "changed\n");
      assert.throws(() => checkBundleVersion(root), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(path));
        assert.ok(error.message.includes("base version 0.2.0"));
        return true;
      });
      put(path, "original\n");
    }
    put(fixturePaths[0]!, "changed\n");
    for (const version of ["0.1.9", "0.2.0"]) {
      put(`${bundle}/package.json`, JSON.stringify({ version }));
      assert.throws(() => checkBundleVersion(root), /base version 0.2.0/);
    }
    put(`${bundle}/package.json`, JSON.stringify({ version: "0.3.0" }));
    assert.throws(() => checkBundleVersion(root), /CHANGELOG.md section ## 0.3.0/);
    put(`${bundle}/CHANGELOG.md`, "## 0.3.0\n\n## 0.2.0\n");
    checkBundleVersion(root);
    commit();
    checkBundleVersion(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recursive skill additions and deletions require a versioned release locally and after commit", () => {
  for (const operation of ["add", "delete"] as const) {
    const { root, put, commit } = fixture();
    try {
      const path = operation === "add" ? `${skills}/foo/nested/x.md` : fixturePaths[1]!;
      if (operation === "add") put(path, "new skill\n");
      else rmSync(join(root, path));
      assert.throws(() => checkBundleVersion(root), /base version 0.2.0/);
      commit();
      assert.throws(() => checkBundleVersion(root), /base version 0.2.0/);
      put(`${bundle}/package.json`, JSON.stringify({ version: "0.2.1" }));
      assert.throws(() => checkBundleVersion(root), /CHANGELOG.md section ## 0.2.1/);
      put(`${bundle}/CHANGELOG.md`, "## 0.2.1\n\n## 0.2.0\n");
      checkBundleVersion(root);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("shallow CI checkout fetches main and ancestry to resolve the PR merge base", () => {
  const { root, put, commit } = fixture();
  const checkout = mkdtempSync(join(tmpdir(), "dagu-bundle-checkout-"));
  try {
    git(root, "checkout", "-b", "feature");
    put(fixturePaths[0]!, "changed\n");
    commit();
    git(checkout, "clone", "--depth=1", "--branch=feature", `file://${root}`, ".");
    assert.throws(() => checkBundleVersion(checkout), /base version 0.2.0/);
    assert.equal(git(checkout, "rev-parse", "--is-shallow-repository"), "false");
    put(`${bundle}/package.json`, JSON.stringify({ version: "0.3.0" }));
    put(`${bundle}/CHANGELOG.md`, "## 0.3.0\n");
    commit();
    git(checkout, "pull", "--ff-only");
    checkBundleVersion(checkout);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("release guard follows the lifecycle contract across a package move on main", () => {
  const { root, put, commit } = fixture();
  try {
    const former = "packages/source-bundle";
    git(root, "mv", bundle, former);
    commit();
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(root, "mv", former, bundle);
    assert.throws(() => checkBundleVersion(root), /base version 0.2.0/);
    put(`${bundle}/package.json`, JSON.stringify({ version: "0.3.0" }));
    put(`${bundle}/CHANGELOG.md`, "## 0.3.0\n");
    checkBundleVersion(root);
    commit();
    checkBundleVersion(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("repository template diff has a versioned bundle release", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  checkBundleVersion(fileURLToPath(new URL("../../..", import.meta.url)),
    process.env.GITHUB_BASE_REF || manifest.daguFeature.integrationBase);
});
