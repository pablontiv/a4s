import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

type Manifest = Record<string, unknown>;
const root = fileURLToPath(new URL("../../..", import.meta.url));
const lifecyclePath = "packages/issue-lifecycle/package.json";

function object(value: unknown): Manifest {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Manifest;
}

function manifest(path: string): Manifest {
  return object(JSON.parse(readFileSync(join(root, path), "utf8")));
}

// Match complete semver literals, not dotted IP addresses or version prefixes.
function versions(text: string): string[] {
  return [...text.matchAll(/(?<![\d.])\d+\.\d+\.\d+(?:[-+][\w.-]+)?(?![\w.])/g)].map(match => match[0]);
}

const rootManifest = manifest("package.json");
const development = object(rootManifest.devDependencies);
const node = object(rootManifest.engines).node;
assert.equal(typeof node, "string");
const pins = new Map<string, string>();
for (const [field, value] of [
  ["package.json engines.node", node],
  ...Object.entries(development).map(([name, value]) => [`package.json devDependencies.${name}`, value]),
]) {
  assert.equal(typeof value, "string", `${field} must be a version requirement`);
  const literals = versions(String(value));
  assert.ok(literals.length, `${field} must declare a version`);
  for (const literal of literals) pins.set(literal, `${pins.has(literal) ? `${pins.get(literal)}; ` : ""}${field}`);
}

function historical(path: string): boolean {
  return /(^|\/)(?:package-lock\.json|CHANGELOG\.md)$/.test(path)
    || path === "docs/operations/retirement-625.json"
    || path === "docs/operations/v1-walkthrough.md";
}

function outsidePinFields(path: string, text: string): string {
  if (!/(^|\/)package\.json$/.test(path)) return text;
  const value = object(JSON.parse(text));
  // Own versions and dependency/peer compatibility contracts belong to their
  // declaring manifests. Shared development tools and Node belong only to root.
  delete value.version;
  delete value.dependencies;
  delete value.peerDependencies;
  if (value.devDependencies !== undefined) {
    const dependencies = object(value.devDependencies);
    if (path !== "package.json") for (const name of Object.keys(development)) {
      assert.equal(dependencies[name], undefined, `${path}: ${name} belongs only in root devDependencies`);
    }
    delete value.devDependencies;
  }
  if (value.engines !== undefined) {
    const engines = object(value.engines);
    if (path === "package.json") delete engines.node;
    else assert.equal(engines.node, undefined, `${path}: engines.node belongs only in root package.json`);
    // Other runtimes retain their declaring package's independent contract.
    delete engines.bun;
  }
  return JSON.stringify(value);
}

function copies(text: string): string[] {
  return [...new Set(versions(text).filter(version => pins.has(version)))];
}

test("version guard recognizes manifest-derived pin copies without matching IP addresses or prefixes", () => {
  for (const version of pins.keys()) {
    assert.deepEqual(copies(`requires ${version}`), [version]);
    assert.deepEqual(copies(`v${version}`), [version]);
    assert.deepEqual(copies(`${version}0`), []);
  }
  assert.deepEqual(copies("http://127.0.0.1:8080"), []);
});

test("version guard permits only canonical manifest fields and historical artifacts", () => {
  assert.deepEqual(copies(outsidePinFields("package.json", JSON.stringify(rootManifest))), []);
  assert.deepEqual(copies(outsidePinFields(lifecyclePath, JSON.stringify(manifest(lifecyclePath)))), []);
  assert.throws(() => outsidePinFields("packages/example/package.json", JSON.stringify({ engines: { node } })), /engines.node belongs only/);
  const [name, version] = Object.entries(development)[0]!;
  assert.throws(() => outsidePinFields("packages/example/package.json", JSON.stringify({ devDependencies: { [name]: version } })), /belongs only in root devDependencies/);
  assert.ok(historical("docs/operations/v1-walkthrough.md"));
  assert.equal(historical(".workspace/dagu/answers.json"), false);
  assert.equal(historical("packages/issue-lifecycle/skills/issue-execution/reconcile.yaml"), false);
  assert.deepEqual(copies(outsidePinFields("package.json", JSON.stringify({ ...rootManifest, copiedRuntime: node }))), versions(String(node)));
});

test("tracked source derives Node and shared development versions from their canonical manifests", () => {
  const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).split("\0").filter(Boolean);
  const violations: string[] = [];
  for (const path of new Set(paths)) {
    if (historical(path) || !existsSync(join(root, path))) continue;
    const text = readFileSync(join(root, path), "utf8");
    if (text.includes("\0")) continue;
    for (const version of copies(outsidePinFields(path, text))) {
      violations.push(`${path}: ${version} must be read from ${pins.get(version)}`);
    }
  }
  assert.deepEqual(violations, [], `Copied component versions:\n${violations.join("\n")}`);
});
