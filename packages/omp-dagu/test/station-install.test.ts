import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

const cli = fileURLToPath(new URL("../bin/dagu-station-install.ts", import.meta.url));
const templates = new URL("../dagu/", import.meta.url);
const daguAvailable = spawnSync("dagu", ["version"], { encoding: "utf8" });
const isolatedDagu = {
  skip: daguAvailable.status !== 0 || !/^2\.20\.1\s*$/.test(daguAvailable.stdout)
    ? "Dagu 2.20.1 binary required for live integration"
    : false,
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dagu-station-test-"));
  const home = join(root, "Dagu & workflows");
  const agent = join(root, "LaunchAgents", "local.dagu.server.plist");
  mkdirSync(home);
  return {
    root, home, agent,
    run(extra: string[] = [], env: NodeJS.ProcessEnv = {}) {
      return spawnSync(process.execPath, [cli, "--launch-agent", agent, ...extra], {
        encoding: "utf8", env: { ...process.env, DAGU_PARAMS_JSON: "{}", DAGU_HOME: home, ...env },
      });
    },
    dispose() { rmSync(root, { recursive: true, force: true }); },
  };
}

test("station installer creates versioned files using real Dagu and preserves bytes and mtimes on repeat", isolatedDagu, () => {
  const f = fixture();
  try {
    const first = f.run();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(readFileSync(join(f.home, "base.yaml"), "utf8"), readFileSync(new URL("base.yaml", templates), "utf8"));
    assert.equal(readFileSync(join(f.home, "config.yaml"), "utf8"), readFileSync(new URL("config.yaml", templates), "utf8"));
    const plist = readFileSync(f.agent, "utf8");
    assert.match(plist, /<string>local\.dagu\.server<\/string>/);
    assert.match(plist, /<string>start-all<\/string>/);
    assert.ok(plist.includes(f.home.replace(/&/g, "&amp;")));
    if (process.platform === "darwin") {
      const resolved = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", f.agent], { encoding: "utf8" }));
      assert.equal(resolved.EnvironmentVariables.DAGU_HOME, f.home);
      assert.equal(resolved.EnvironmentVariables.DAGU_HOST, "127.0.0.1");
      assert.equal(resolved.EnvironmentVariables.DAGU_PORT, "8080");
      assert.equal(resolved.ProgramArguments[0], execFileSync("which", ["dagu"], { encoding: "utf8" }).trim());
      assert.equal(resolved.KeepAlive, true);
      assert.equal(resolved.ProcessType, "Interactive");
    }
    const paths = [join(f.home, "base.yaml"), join(f.home, "config.yaml"), f.agent];
    const before = paths.map((path) => ({ bytes: readFileSync(path), mtime: statSync(path).mtimeMs }));
    const repeat = f.run();
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.equal(repeat.stdout.split("\n").filter((line) => line.startsWith("unchanged ")).length, 3);
    assert.deepEqual(paths.map((path) => ({ bytes: readFileSync(path), mtime: statSync(path).mtimeMs })), before);
    const check = f.run(["--check"]);
    assert.equal(check.status, 0, check.stderr);
  } finally { f.dispose(); }
});

test("station installer preserves foreign queues, comments and nested keys while reconciling owned leaves", isolatedDagu, () => {
  const f = fixture();
  try {
    writeFileSync(join(f.home, "config.yaml"), "# Other repositories own these values\nauth:\n  mode: basic\n  basic:\n    username: operator\n    password: local-secret\nqueues:\n  enabled: false\n  config:\n    - name: antojea-e2e\n      max_concurrency: 4\n    - name: antojea-e2e-device\n      max_concurrency: 1\ncoordinator:\n  enabled: false\n  port: 50056\nhost: 0.0.0.0\nport: 9000\nui:\n  dags:\n    sort_order: desc\npaths:\n  data_dir: /foreign/owned/data\n");
    const installed = f.run();
    assert.equal(installed.status, 0, installed.stderr);
    const text = readFileSync(join(f.home, "config.yaml"), "utf8");
    const config = parse(text);
    assert.deepEqual(config.queues, { enabled: true, config: [
      { name: "antojea-e2e", max_concurrency: 4 },
      { name: "antojea-e2e-device", max_concurrency: 1 },
      { name: "a4s", max_concurrency: 2 },
    ] });
    assert.deepEqual(config.auth, { mode: "none", basic: { username: "operator", password: "local-secret" } });
    assert.deepEqual(config.coordinator, { enabled: true, port: 50056 });
    assert.deepEqual(config.ui, { dags: { sort_order: "desc" } });
    assert.deepEqual(config.paths, { data_dir: "/foreign/owned/data" });
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 8080);
    assert.match(text, /# Other repositories own these values/);
    const repeat = f.run();
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.equal(readFileSync(join(f.home, "config.yaml"), "utf8"), text);
  } finally { f.dispose(); }
});

test("station installer reports version mismatch before replacing existing configuration", () => {
  const f = fixture();
  try {
    const bin = join(f.root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "dagu"), "#!/bin/sh\nprintf '2.19.0\\n'\n");
    chmodSync(join(bin, "dagu"), 0o755);
    const original = "queues:\n  config:\n    - name: antojea-e2e\n      max_concurrency: 4\n";
    writeFileSync(join(f.home, "config.yaml"), original);
    const result = f.run([], { PATH: `${bin}:${process.env.PATH}` });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /dagu version="2\.19\.0" required=2\.20\.1/);
    assert.equal(readFileSync(join(f.home, "config.yaml"), "utf8"), original);
  } finally { f.dispose(); }
});

test("station installer check reports drift and preserves the installed bytes", isolatedDagu, () => {
  const f = fixture();
  try {
    const initial = f.run();
    assert.equal(initial.status, 0, initial.stderr);
    const custom = "hist_retention_days: 30\n";
    writeFileSync(join(f.home, "base.yaml"), custom);
    const result = f.run(["--check"]);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stdout.includes(`drift ${join(f.home, "base.yaml")}`));
    assert.equal(readFileSync(join(f.home, "base.yaml"), "utf8"), custom);
  } finally { f.dispose(); }
});

test("station apply requires explicit admission and restart hooks before writing", () => {
  const f = fixture();
  try {
    const result = f.run(["--apply"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires admission-close, admission-open and restart-command/);
    assert.equal(existsSync(join(f.home, "config.yaml")), false);
  } finally { f.dispose(); }
});

test("station installer reconciles existing managed capacity and preserves queue metadata", isolatedDagu, () => {
  const f = fixture();
  try {
    writeFileSync(join(f.home, "config.yaml"), "queues:\n  config:\n    - name: a4s\n      max_concurrency: 1\n      scheduler: operator-value\n");
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(parse(readFileSync(join(f.home, "config.yaml"), "utf8")).queues.config, [
      { name: "a4s", max_concurrency: 2, scheduler: "operator-value" },
    ]);
  } finally { f.dispose(); }
});

test("station installer preserves malformed operator config for correction", isolatedDagu, () => {
  const f = fixture();
  try {
    const original = "queues: [broken\n";
    writeFileSync(join(f.home, "config.yaml"), original);
    const result = f.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /config.yaml:/);
    assert.equal(readFileSync(join(f.home, "config.yaml"), "utf8"), original);
  } finally { f.dispose(); }
});
