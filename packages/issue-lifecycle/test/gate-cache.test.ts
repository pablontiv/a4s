import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const realSpawnSync = childProcess.spawnSync;
// Fingerprinting must not launch npm merely to learn its version.
const spawnMock = mock.method(childProcess, "spawnSync", (file: string, args: string[], options: object) =>
  file === "npm" ? { status: 0, stdout: "fixture-npm\n" } : realSpawnSync(file, args, options));
const {
  cacheDirectory, classifyTestSource, describeTask, forget, lookup, plan, storePass,
} = require("../bin/gate-cache.cjs") as {
  cacheDirectory: (worktree: string) => string;
  classifyTestSource: (text: string) => { classification: string; reason: string };
  describeTask: (input: { worktree: string; primary?: string; cwd: string; task: string; script: string; env?: NodeJS.ProcessEnv }) => {
    action: string; classification?: string; key?: string | null; workspace?: string;
    parts?: Array<{ classification: string; key: string | null; task: string }>;
  };
  forget: (cacheDir: string, key: string) => void;
  lookup: (cacheDir: string, key: string) => { result?: string } | undefined;
  plan: (input: { worktree: string; cwd: string; task: string; script: string; env?: NodeJS.ProcessEnv }) => {
    action: string; cache?: string; key?: string | null; cacheDir?: string; record?: { key: string; result: string; exitCode: number };
    parts?: Array<{ cache: string; classification: string; key: string | null }>;
  };
  storePass: (cacheDir: string, record: { key: string; result: string; exitCode: number; remote?: boolean; schemaVersion?: number; task?: object }) => void;
};
spawnMock.mock.restore();

const gitStateSource = readFileSync(new URL("./fixtures/gate-cache-git-state.js", import.meta.url), "utf8");
const featureTemplate = readFileSync(new URL("./live/feature-template.test.ts", import.meta.url), "utf8");

test("gate cache classifies git-state checks as always executed", () => {
  const gitState = classifyTestSource(gitStateSource);
  assert.equal(gitState.classification, "always");
  assert.match(gitState.reason, /git-state/);
  assert.match(gitState.reason, /merge-base/);
  assert.equal(classifyTestSource(featureTemplate).classification, "cached");
  assert.equal(classifyTestSource(readFileSync(new URL("./gate-cache.test.ts", import.meta.url), "utf8")).classification, "cached");
  assert.equal(classifyTestSource("const test = require('node:test');\ntest('ok', () => {});\n").classification, "cached");
});

function writePackage(root: string, directory: string, manifest: unknown, files: Record<string, string>): void {
  const packageDir = join(root, directory);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [name, text] of Object.entries(files)) {
    const target = join(packageDir, name);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, text);
  }
}

function fixture(root = mkdtempSync(join(tmpdir(), "gate-cache-"))): string {
  writePackage(root, ".", {
    name: "gate-cache-fixture", private: true, workspaces: ["packages/*"],
    scripts: { test: "npm test --workspaces --if-present", typecheck: "npm run typecheck --workspaces --if-present" },
  }, {});
  writeFileSync(join(root, "package-lock.json"), `${JSON.stringify({ name: "gate-cache-fixture", lockfileVersion: 3, packages: {} }, null, 2)}\n`);
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "gate-asset.txt"), "asset\n");
  writePackage(root, "packages/lib", {
    name: "lib", version: "1.0.0",
    scripts: { test: "node --test test/*.test.js", typecheck: "node --check src/lib.js" },
  }, {
    "tsconfig.json": `${JSON.stringify({ include: ["src/**/*.js", "test/**/*.js"] })}\n`,
    "src/lib.js": "module.exports = { value: 1 };\n",
    "test/lib.test.js": "const test = require('node:test');\nconst lib = require('../src/lib.js');\ntest('value', () => { if (lib.value !== 1) throw new Error('value'); });\n",
    "test/git-state.test.js": readFileSync(new URL("./fixtures/gate-cache-git-state.js", import.meta.url), "utf8"),
  });
  writePackage(root, "packages/app", {
    name: "app", version: "1.0.0",
    dependencies: { lib: "1.0.0" },
    scripts: { test: "node --test test/app.test.js", typecheck: "node --check src/app.js" },
  }, {
    "tsconfig.json": `${JSON.stringify({ include: ["src/**/*.js"] })}\n`,
    "src/app.js": "module.exports = { name: 'app' };\n",
    "test/app.test.js": [
      "const test = require('node:test');",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "test('reads the shared asset and probe', () => {",
      "  const asset = fs.readFileSync(path.join(__dirname, '../../../scripts/gate-asset.txt'), 'utf8');",
      "  if (!asset || !process.env.A4S_CACHE_PROBE) throw new Error('asset');",
      "  void process.env.ORCA_SESSION;",
      "  void process.env.PI_CODING_AGENT_DIR;",
      "});",
      "",
    ].join("\n"),
  });
  writePackage(root, "packages/other", {
    name: "other", version: "1.0.0",
    scripts: { test: "node --test test/other.test.js", typecheck: "node --check src/other.js" },
  }, {
    "tsconfig.json": `${JSON.stringify({ include: ["src/**/*.js"] })}\n`,
    "src/other.js": "module.exports = { name: 'other' };\n",
    "test/other.test.js": "const test = require('node:test');\ntest('stable', () => {});\n",
  });
  return root;
}

function scriptOf(root: string, directory: string, task: "test" | "typecheck"): string {
  const manifest = JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8")) as { scripts: Record<string, string> };
  return manifest.scripts[task]!;
}

function described(root: string, directory: string, task: "tests" | "typecheck", env: NodeJS.ProcessEnv) {
  const script = scriptOf(root, directory, task === "tests" ? "test" : "typecheck");
  return describeTask({ worktree: root, cwd: join(root, directory), task, script, env });
}

function cachedKey(root: string, directory: string, task: "tests" | "typecheck", env: NodeJS.ProcessEnv): string | null {
  const result = described(root, directory, task, env);
  if (result.action === "split") return result.parts!.find(part => part.classification === "cached")?.key ?? null;
  return result.key ?? null;
}

test("station-slot wrapper preserves cached and always-run test classification", () => {
  const root = fixture();
  try {
    const result = describeTask({
      worktree: root, cwd: join(root, "packages/lib"), task: "tests",
      script: "python3 bin/heavy-slot.py env A4S_LIVE_DAGU=0 node --test test/*.test.js",
    });
    assert.equal(result.action, "split");
    assert.ok(result.parts!.some(part => part.classification === "always" && part.key === null));
    assert.ok(result.parts!.some(part => part.classification === "cached" && part.key));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("gate cache keys change only for the dependent input class", () => {
  const root = realpathSync(fixture());
  const copy = realpathSync(fixture());
  const previous = process.env.A4S_GATE_CACHE_TOOL;
  const env = { A4S_CACHE_PROBE: "one", ORCA_SESSION: "agent-a", PI_CODING_AGENT_DIR: "/tmp/agent-a" };
  const originals = ["packages/lib/src/lib.js", "packages/lib/test/lib.test.js", "package-lock.json", "packages/app/package.json", "scripts/gate-asset.txt"]
    .map(file => [file, readFileSync(join(root, file), "utf8")] as const);
  const restore = (): void => { for (const [file, text] of originals) writeFileSync(join(root, file), text); };
  try {
    const lib = described(root, "packages/lib", "tests", env);
    assert.equal(lib.action, "split");
    assert.equal(lib.parts!.some(part => part.classification === "always" && part.key === null), true);
    assert.equal(lib.parts!.some(part => part.classification === "cached" && part.key), true);
    const base = {
      libTest: cachedKey(root, "packages/lib", "tests", env),
      libType: cachedKey(root, "packages/lib", "typecheck", env),
      appTest: cachedKey(root, "packages/app", "tests", env),
      appType: cachedKey(root, "packages/app", "typecheck", env),
      otherTest: cachedKey(root, "packages/other", "tests", env),
      otherType: cachedKey(root, "packages/other", "typecheck", env),
    };
    assert.equal(cachedKey(copy, "packages/app", "tests", { ...env, ORCA_SESSION: "agent-b", PI_CODING_AGENT_DIR: "/tmp/agent-b", A4S_CACHE_PROBE: copy }), cachedKey(root, "packages/app", "tests", { ...env, A4S_CACHE_PROBE: root }));
    assert.equal(cachedKey(copy, "packages/other", "typecheck", { ...env, ORCA_SESSION: "agent-b" }), base.otherType);
    assert.notEqual(cachedKey(root, "packages/app", "tests", { ...env, A4S_CACHE_PROBE: "two" }), base.appTest);
    assert.equal(cachedKey(root, "packages/other", "tests", { ...env, A4S_CACHE_PROBE: "two" }), base.otherTest);

    writeFileSync(join(root, "packages/lib/src/lib.js"), "module.exports = { value: 1 };\n// source revision\n");
    assert.notEqual(cachedKey(root, "packages/lib", "tests", env), base.libTest);
    assert.notEqual(cachedKey(root, "packages/lib", "typecheck", env), base.libType);
    assert.notEqual(cachedKey(root, "packages/app", "tests", env), base.appTest);
    assert.notEqual(cachedKey(root, "packages/app", "typecheck", env), base.appType);
    assert.equal(cachedKey(root, "packages/other", "tests", env), base.otherTest);
    restore();

    writeFileSync(join(root, "packages/lib/test/lib.test.js"), `${originals.find(([file]) => file.endsWith("lib.test.js"))![1]}// test revision\n`);
    assert.notEqual(cachedKey(root, "packages/lib", "tests", env), base.libTest);
    assert.notEqual(cachedKey(root, "packages/lib", "typecheck", env), base.libType);
    assert.equal(cachedKey(root, "packages/app", "tests", env), base.appTest);
    assert.equal(cachedKey(root, "packages/app", "typecheck", env), base.appType);
    assert.equal(cachedKey(root, "packages/other", "typecheck", env), base.otherType);
    restore();

    writeFileSync(join(root, "package-lock.json"), `${originals.find(([file]) => file === "package-lock.json")![1]}\n`);
    assert.notEqual(cachedKey(root, "packages/other", "tests", env), base.otherTest);
    assert.notEqual(cachedKey(root, "packages/lib", "typecheck", env), base.libType);
    assert.notEqual(cachedKey(root, "packages/app", "tests", env), base.appTest);
    restore();

    const appManifest = join(root, "packages/app/package.json");
    writeFileSync(appManifest, readFileSync(appManifest, "utf8").replace('"lib": "1.0.0"', '"lib": "1.0.1"'));
    assert.notEqual(cachedKey(root, "packages/app", "tests", env), base.appTest);
    assert.notEqual(cachedKey(root, "packages/app", "typecheck", env), base.appType);
    assert.equal(cachedKey(root, "packages/lib", "tests", env), base.libTest);
    assert.equal(cachedKey(root, "packages/lib", "typecheck", env), base.libType);
    assert.equal(cachedKey(root, "packages/other", "tests", env), base.otherTest);
    restore();

    writeFileSync(join(root, "scripts/gate-asset.txt"), "changed\n");
    assert.notEqual(cachedKey(root, "packages/app", "tests", env), base.appTest);
    assert.equal(cachedKey(root, "packages/app", "typecheck", env), base.appType);
    assert.equal(cachedKey(root, "packages/lib", "tests", env), base.libTest);
    assert.equal(cachedKey(root, "packages/other", "tests", env), base.otherTest);
    restore();

    process.env.A4S_GATE_CACHE_TOOL = "v2";
    assert.notEqual(cachedKey(root, "packages/other", "tests", env), base.otherTest);
    assert.notEqual(cachedKey(root, "packages/app", "typecheck", env), base.appType);
    assert.notEqual(cachedKey(root, "packages/lib", "tests", env), base.libTest);
    assert.equal(described(root, "packages/lib", "tests", env).parts!.find(part => part.classification === "always")?.key ?? null, null);
  } finally {
    if (previous === undefined) delete process.env.A4S_GATE_CACHE_TOOL;
    else process.env.A4S_GATE_CACHE_TOOL = previous;
    rmSync(root, { recursive: true, force: true });
    rmSync(copy, { recursive: true, force: true });
  }
});

test("gate cache stores only a local pass and does not reuse a failure", () => {
  const root = mkdtempSync(join(tmpdir(), "gate-cache-store-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main", root]);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "store", scripts: { test: "node -e process.exit(0)" } }));
    const described = describeTask({ worktree: root, cwd: root, task: "tests", script: "node -e process.exit(0)", env: {} });
    assert.equal(described.action, "observed");
    assert.equal(described.classification, "cached");
    const planned = plan({ worktree: root, cwd: root, task: "tests", script: "node -e process.exit(0)", env: {} });
    assert.equal(planned.cache, "miss");
    const cacheDir = cacheDirectory(root);
    assert.equal(JSON.parse(readFileSync(join(cacheDir, "config.json"), "utf8")).remote, false);
    const key = planned.key!;
    storePass(cacheDir, { schemaVersion: 1, key, result: "FAIL", exitCode: 1, remote: false, task: {} });
    assert.equal(lookup(cacheDir, key), undefined);
    storePass(cacheDir, { schemaVersion: 1, key, result: "PASS", exitCode: 0, remote: true, task: {} });
    assert.equal(lookup(cacheDir, key), undefined);
    writeFileSync(join(cacheDir, `${key}.json`), `${JSON.stringify({ key, result: "PASS", exitCode: 1, remote: false })}\n`);
    assert.equal(lookup(cacheDir, key), undefined);
    storePass(cacheDir, planned.record!);
    assert.equal(lookup(cacheDir, key)?.result, "PASS");
    assert.equal(plan({ worktree: root, cwd: root, task: "tests", script: "node -e process.exit(0)", env: {} }).cache, "hit");
    forget(cacheDir, key);
    assert.equal(lookup(cacheDir, key), undefined);
    assert.equal(plan({ worktree: root, cwd: root, task: "tests", script: "node -e process.exit(0)", env: {} }).cache, "miss");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
