import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import { currentQueueConcurrency, deriveQueue, queueCompatibility, reconcileQueue, stampedQueue } from "../src/queue.ts";
import { bootstrapRender } from "./fixtures/bootstrap-render.ts";
import { BUNDLE_VERSION } from "../src/bundle.ts";

const packageDir = fileURLToPath(new URL("../", import.meta.url));
const cli = join(packageDir, "bin", "dagu-feature-bundle.ts");
const skill = join(packageDir, "skills", "issue-execution");
const bootstrap = parse(readFileSync(join(skill, "dagu-feature-bootstrap.yaml"), "utf8"));
const queue = { name: "a4s", max_concurrency: 8 };
const stamp = "queue: a4s\nlabels: [dagu-feature-queue-concurrency=8]\n";
const original = "# shared config\nqueues:\n  enabled: true\n  config:\n    # other repository\n    - name: foreign\n      max_concurrency: 3\nserver:\n  port: 8888\n";
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "dagu-repo-queue-"));
  return { home, dispose: () => rmSync(home, { recursive: true, force: true }) };
}

for (const scenario of ["add", "change", "identical"] as const) {
  test(`materialized bootstrap deployment: ${scenario} preserves foreign configuration and waiting data`, () => {
    const f = fixture();
    try {
      const stage = join(f.home, "stage", "feature.yaml");
      const bin = join(f.home, "bin");
      const calls = join(f.home, "calls");
      mkdirSync(join(f.home, "stage"));
      mkdirSync(bin);
      writeFileSync(stage, stamp);
      writeFileSync(join(f.home, "stage", "reconcile.yaml"), "steps:\n  - run: true\n");
      const initial = scenario === "add" ? original : deriveQueue(original, { ...queue, max_concurrency: scenario === "change" ? 2 : 8 }).content.replace("max_concurrency: " + (scenario === "change" ? 2 : 8), "metadata: retained\n      max_concurrency: " + (scenario === "change" ? 2 : 8));
      const config = join(f.home, "config.yaml");
      writeFileSync(config, initial);
      const before = statSync(config).mtimeMs;
      mkdirSync(join(f.home, "data"));
      const waiting = join(f.home, "data", "waiting.json");
      writeFileSync(waiting, '{"status":"waiting","step":"approval"}\n');
      writeFileSync(join(bin, "dagu"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      writeFileSync(join(bin, "launchctl"), `#!/bin/sh
printf '%s\\n' "$*" >> "$SERVICE_CALLS"
if [ "$1" = print ]; then printf 'path = /tmp/queue-test.plist\\nstate = running\\npid = 123\\n'; fi
`, { mode: 0o755 });
      writeFileSync(join(bin, "plutil"), `#!/bin/sh
printf '{"ProgramArguments":["/opt/bin/dagu","start-all"],"EnvironmentVariables":{"DAGU_HOME":"%s"}}\\n' "$DAGU_HOME"
`, { mode: 0o755 });
      writeFileSync(calls, "");
      const output = join(f.home, "outputs");
      const result = spawnSync("bash", ["-c", bootstrap.steps.find((step: { id: string }) => step.id === "reconcile").run], { encoding: "utf8", env: {
        ...process.env, DAGU_HOME: f.home, SKILL_DIR: skill, STAGE: stage,
        DAGU_OUTPUT_FILE: output, SERVICE_CALLS: calls, PATH: `${bin}:${process.env.PATH}`,
      } });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual(parse(readFileSync(config, "utf8")), parse(deriveQueue(initial, queue).content));
      assert.match(readFileSync(config, "utf8"), /# shared config/);
      assert.match(readFileSync(config, "utf8"), /# other repository/);
      if (scenario !== "add") assert.match(readFileSync(config, "utf8"), /metadata: retained/);
      const changed = scenario !== "identical";
      assert.match(readFileSync(output, "utf8"), new RegExp(`QUEUE_STATUS=queue=a4s max_concurrency=8 changed=${changed ? "yes" : "no"}`));
      const commands = readFileSync(calls, "utf8").trim().split("\n");
      assert.equal(commands.filter(command => command.startsWith("kickstart ")).length, changed ? 1 : 0);
      if (changed) assert.ok(commands.includes(`kickstart -k gui/${process.getuid!()}/local.dagu.server`));
      else {
        assert.equal(readFileSync(config, "utf8"), initial);
        assert.equal(statSync(config).mtimeMs, before);
      }
      assert.equal(readFileSync(waiting, "utf8"), '{"status":"waiting","step":"approval"}\n');
    } finally { f.dispose(); }
  });
}

test("bootstrap render stamps capacity and blank answers preserve the detected policy", () => {
  const f = fixture();
  const saved = process.env.QUEUE_CONCURRENCY;
  try {
    for (const value of ["8", "3"]) {
      process.env.QUEUE_CONCURRENCY = value;
      bootstrapRender({ packageDir, directory: f.home, primary: f.home, version: BUNDLE_VERSION, sourceNwo: "example/repo", sourceSha: "a".repeat(40) });
      const files = ["feature", "poc", "discovery"].map(name => join(f.home, `${name}.yaml`));
      for (const file of files) assert.equal(stampedQueue(readFileSync(file, "utf8")).max_concurrency, Number(value));
      assert.equal(currentQueueConcurrency(files), Number(value));
    }
    const render = bootstrap.steps.find((step: { id: string }) => step.id === "render").run as string;
    const answer = render.slice(render.indexOf("# Empty integer-text"), render.indexOf("A4S_BLOCKER_REPORTING="));
    for (const [value, expected] of [["", 8], ["1", 1], ["0", null], ["-1", null], ["1.5", null], ["9007199254740992", null]] as const) {
      const result = spawnSync("bash", ["-euc", `${answer}\nprintf '%s' "$QUEUE_CONCURRENCY"`], { encoding: "utf8", env: { ...process.env, QUEUE_CONCURRENCY: value, CURRENT_QUEUE_CONCURRENCY: "8" } });
      if (expected === null) assert.notEqual(result.status, 0, value);
      else { assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, String(expected)); }
    }
    assert.deepEqual(bootstrap.steps.find((step: { id: string }) => step.id === "answers").with.form.properties.QUEUE_CONCURRENCY, { type: "string", default: "", pattern: "^([1-9][0-9]*)?$" });
    assert.equal(currentQueueConcurrency([join(f.home, "missing.yaml")]), 1);
    writeFileSync(join(f.home, "poc.yaml"), "queue: fixture\nlabels: [dagu-feature-queue-concurrency=7]\n");
    assert.throws(() => currentQueueConcurrency([join(f.home, "feature.yaml"), join(f.home, "poc.yaml")]), /disagree/);
  } finally {
    if (saved === undefined) delete process.env.QUEUE_CONCURRENCY; else process.env.QUEUE_CONCURRENCY = saved;
    f.dispose();
  }
});

test("bundle compatibility reports installed capacity drift through the actual CLI", () => {
  const f = fixture();
  try {
    const repo = join(f.home, "repo");
    const dags = join(repo, ".workspace", "dagu", "dags");
    mkdirSync(dags, { recursive: true });
    const init = spawnSync("git", ["init", "-b", "main", repo], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    writeFileSync(join(dags, "feature.yaml"), stamp);
    for (const installed of [1, 8]) {
      writeFileSync(join(f.home, "config.yaml"), deriveQueue(original, { ...queue, max_concurrency: installed }).content);
      const check = spawnSync(process.execPath, [cli, "queue-check", join(dags, "feature.yaml")], { encoding: "utf8", env: { ...process.env, DAGU_HOME: f.home } });
      assert.equal(check.status, installed === 8 ? 0 : 1, check.stderr);
      assert.match(check.stdout, installed === 8 ? /compat=ok/ : /compat=incompatible action=re-run-bootstrap/);
      assert.equal(queueCompatibility(f.home, queue).endsWith("compat=ok"), installed === 8);
      if (installed === 1) {
        const bundle = spawnSync(process.execPath, [cli, repo], { encoding: "utf8", env: { ...process.env, DAGU_HOME: f.home } });
        assert.equal(bundle.status, 1);
        assert.match(bundle.stdout, /feature.yaml queue=a4s max_concurrency=8 compat=incompatible action=re-run-bootstrap/);
      }
    }
  } finally { f.dispose(); }
});

test("restart failure restores config atomically and releases exclusive station ownership", () => {
  const f = fixture();
  try {
    const path = join(f.home, "config.yaml");
    writeFileSync(path, original);
    const service = (command: string, args: string[]) => {
      if (command === "plutil") return JSON.stringify({ ProgramArguments: ["dagu", "start-all"], EnvironmentVariables: { DAGU_HOME: f.home } });
      if (args[0] === "print") return "path = fixture.plist\nstate = running\npid = 123\n";
      throw new Error("restart rejected");
    };
    assert.throws(() => reconcileQueue(f.home, queue, service), /restored config.yaml/);
    assert.equal(readFileSync(path, "utf8"), original);
    assert.throws(() => reconcileQueue(f.home, queue, () => { throw new Error("unreachable service"); }), /Cannot determine scheduler restart/);
    assert.equal(readFileSync(path, "utf8"), original);
    mkdirSync(join(f.home, ".station-install.lock"));
    assert.throws(() => reconcileQueue(f.home, queue, service), /EEXIST/);
    assert.equal(readFileSync(path, "utf8"), original);
  } finally { f.dispose(); }
});

test("queue stamps and global entries require positive unambiguous identities", () => {
  for (const label of ["0", "-1", "1.5", "9007199254740992"]) assert.throws(() => stampedQueue(`queue: a4s\nlabels: [dagu-feature-queue-concurrency=${label}]\n`), /positive integer/);
  assert.throws(() => stampedQueue(stamp.replace("=8]", "=8, dagu-feature-queue-concurrency=8]")), /one positive integer/);
  assert.throws(() => deriveQueue("queues:\n  config:\n    - name: a4s\n    - name: a4s\n", queue), /Duplicate queue/);
  assert.throws(() => deriveQueue("queues: []\n", queue), /mapping/);
});
