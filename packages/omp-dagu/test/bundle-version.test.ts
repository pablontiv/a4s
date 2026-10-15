import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const bundle = "packages/omp-dagu";
const templates = ["feature.yaml", "poc.yaml", "reconcile.yaml", "discovery.yaml", "dagu-feature-bootstrap.yaml", "SKILL.md"]
  .map((name) => `${bundle}/skills/dagu-feature/${name}`);
const git = (root: string, ...args: string[]): string => execFileSync("git", args, {
  cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();

function mergeBase(root: string): string {
  try {
    return git(root, "merge-base", "origin/main", "HEAD");
  } catch {
    // actions/checkout uses a shallow, single-ref checkout by default.
    const shallow = git(root, "rev-parse", "--is-shallow-repository") === "true";
    git(root, "fetch", ...(shallow ? ["--unshallow"] : []), "origin", "+refs/heads/main:refs/remotes/origin/main");
    return git(root, "merge-base", "origin/main", "HEAD");
  }
}

function checkBundleVersion(root: string): void {
  const base = mergeBase(root);
  const changed = git(root, "diff", "--name-only", base, "--", ...templates).split("\n").filter(Boolean);
  if (!changed.length) return;
  const previous: string = JSON.parse(git(root, "show", `${base}:${bundle}/package.json`)).version;
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
  put(`${bundle}/package.json`, JSON.stringify({ version: "0.2.0" }));
  put(`${bundle}/CHANGELOG.md`, "## 0.2.0\n");
  for (const path of templates) put(path, "original\n");
  commit();
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  return { root, put, commit };
}

test("template changes require a greater bundle version and its release heading", () => {
  const { root, put, commit } = fixture();
  try {
    checkBundleVersion(root);
    for (const path of templates) {
      put(path, "changed\n");
      assert.throws(() => checkBundleVersion(root), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(path));
        assert.ok(error.message.includes("base version 0.2.0"));
        return true;
      });
      put(path, "original\n");
    }
    put(templates[0]!, "changed\n");
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

test("shallow CI checkout fetches main and ancestry to resolve the PR merge base", () => {
  const { root, put, commit } = fixture();
  const checkout = mkdtempSync(join(tmpdir(), "dagu-bundle-checkout-"));
  try {
    git(root, "checkout", "-b", "feature");
    put(templates[0]!, "changed\n");
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

test("repository template diff has a versioned bundle release", () => {
  checkBundleVersion(fileURLToPath(new URL("../../..", import.meta.url)));
});
