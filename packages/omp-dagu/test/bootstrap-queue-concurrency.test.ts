import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import { currentQueueConcurrency, deriveQueue, queueCompatibility, reconcileQueue, schedulerRestart, stampedQueue, type ServiceCommand } from "../src/queue.ts";
import { BUNDLE_VERSION } from "../src/bundle.ts";

const cli = fileURLToPath(new URL("../bin/dagu-feature-bundle.ts", import.meta.url));
const stamp = `# dagu-feature-bundle: @a4s/omp-dagu@${BUNDLE_VERSION} source=pablontiv/a4s@0123456789012345678901234567890123456789 bootstrap=bootstrap-probe dagu=2.20.1\nqueue: fixture\nlabels:\n  - dagu-feature-bundle=${BUNDLE_VERSION}\n  - dagu-feature-queue-concurrency=6\n`;

const queue = { name: "example", max_concurrency: 6 };
const rendered = (n: number) => `queue: example\nlabels: [dagu-feature-queue-concurrency=${n}]\n`;
const original = "# shared config\nqueues:\n  enabled: true\n  config:\n    # other repo\n    - name: sibling\n      max_concurrency: 4\n      extra: retained\nserver:\n  port: 8888\n";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "dagu-queue-"));
  const calls: string[][] = [];
  const run: ServiceCommand = (command, args) => {
    calls.push([command, ...args]);
    if (command === "plutil") return JSON.stringify({ ProgramArguments: ["/opt/bin/dagu", "start-all"], EnvironmentVariables: { DAGU_HOME: home } });
    if (args[0] === "print") return `path = /tmp/fixture.plist\nstate = running\npid = 123\n`;
    return "";
  };
  return { home, calls, run, dispose: () => rmSync(home, { recursive: true, force: true }) };
}

test("queue derivation adds and changes the repo entry while preserving keys, comments and other queues", () => {
  const added = deriveQueue(original, queue);
  assert.equal(added.changed, true);
  const desired = parse(original);
  desired.queues.config.push(queue);
  assert.deepEqual(parse(added.content), desired);
  assert.match(added.content, /# shared config/);
  assert.match(added.content, /# other repo/);
  const existing = added.content.replace("max_concurrency: 6", "max_concurrency: 2\n      metadata: keep");
  const changed = deriveQueue(existing, queue);
  assert.equal(changed.changed, true);
  assert.equal(parse(changed.content).queues.config[1].metadata, "keep");
  assert.equal(parse(changed.content).queues.config[1].max_concurrency, 6);
  assert.deepEqual(deriveQueue(changed.content, queue), { changed: false, content: changed.content });
  assert.equal(parse(deriveQueue("queues:\n  enabled: false\n", queue).content).queues.enabled, false);
});

test("reconcile restarts the matching launchd scheduler for add/change and preserves identical bytes without restart", () => {
  const f = fixture();
  try {
    const config = join(f.home, "config.yaml");
    writeFileSync(config, original);
    assert.equal(reconcileQueue(f.home, queue, f.run), "queue=example max_concurrency=6 changed=yes");
    assert.equal(f.calls.filter(call => call[1] === "kickstart").length, 1);
    assert.deepEqual(f.calls.at(-1), ["launchctl", "kickstart", "-k", `gui/${process.getuid!()}/local.dagu.server`]);
    const same = readFileSync(config, "utf8");
    f.calls.length = 0;
    assert.equal(reconcileQueue(f.home, queue, f.run), "queue=example max_concurrency=6 changed=no");
    assert.equal(f.calls.filter(call => call[1] === "kickstart").length, 0);
    assert.equal(f.calls[0]?.[1], "print");
    assert.equal(readFileSync(config, "utf8"), same);
    assert.equal(reconcileQueue(f.home, { ...queue, max_concurrency: 3 }, f.run), "queue=example max_concurrency=3 changed=yes");
    assert.equal(f.calls.filter(call => call[1] === "kickstart").length, 1);
  } finally { f.dispose(); }
});

test("scheduler detection fails closed before config writes for unknown services or a different home", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.home, "config.yaml"), original);
    assert.throws(() => reconcileQueue(f.home, queue, () => { throw new Error("not loaded"); }), /Cannot determine scheduler restart.*install\/load/);
    assert.equal(readFileSync(join(f.home, "config.yaml"), "utf8"), original);
    assert.throws(() => schedulerRestart(f.home, (command, args) => command === "plutil"
      ? JSON.stringify({ ProgramArguments: ["/opt/bin/dagu", "start-all"], EnvironmentVariables: { DAGU_HOME: "/" } }) : f.run(command, args)), /command\/home does not match/);
  } finally { f.dispose(); }
});

test("restart failure restores the original config and leaves reconciliation retryable", () => {
  const f = fixture();
  try {
    const path = join(f.home, "config.yaml");
    writeFileSync(path, original);
    const fail: ServiceCommand = (command, args) => {
      if (args[0] === "kickstart") throw new Error("launchctl failed");
      return f.run(command, args);
    };
    assert.throws(() => reconcileQueue(f.home, queue, fail), /restored config.yaml/);
    assert.equal(readFileSync(path, "utf8"), original);
    assert.match(reconcileQueue(f.home, queue, f.run), /changed=yes/);
  } finally { f.dispose(); }
});

test("current renders supply the default, with first-adoption fallback one and agreement required", () => {
  const f = fixture();
  try {
    const feature = join(f.home, "feature.yaml"), poc = join(f.home, "poc.yaml");
    assert.equal(currentQueueConcurrency([feature, poc]), 1);
    writeFileSync(feature, "queue: example\nlabels: [workspace=example]\n");
    assert.equal(currentQueueConcurrency([feature, poc]), 1);
    writeFileSync(feature, rendered(6));
    assert.equal(currentQueueConcurrency([feature, poc]), 6);
    writeFileSync(poc, rendered(2));
    assert.throws(() => currentQueueConcurrency([feature, poc]), /disagree/);
    assert.deepEqual(stampedQueue(rendered(6)), queue);
    for (const n of [0, -1, 1.5]) assert.throws(() => stampedQueue(rendered(n)), /positive integer/);
  } finally { f.dispose(); }
});

test("compat reports queue drift with the bootstrap corrective action", () => {
  assert.match(queueCompatibility(original, queue), /compat=incompatible action=re-run-bootstrap/);
  assert.match(queueCompatibility(deriveQueue(original, { ...queue, max_concurrency: 2 }).content, queue), /compat=incompatible action=re-run-bootstrap/);
  assert.equal(queueCompatibility(deriveQueue(original, queue).content, queue), "queue=example max_concurrency=6 compat=ok");
});

test("CLI marks global queue drift incompatible and directs bootstrap reconciliation", () => {
  const root = mkdtempSync(join(tmpdir(), "dagu-bundle-drift-"));
  try {
    const repo = join(root, "repo"), home = join(root, "home"), bin = join(root, "bin");
    mkdirSync(join(repo, ".workspace/dagu/dags"), { recursive: true });
    mkdirSync(join(home, "dags"), { recursive: true });
    mkdirSync(bin);
    spawnSync("git", ["init", "-b", "main", repo]);
    for (const name of ["feature", "poc", "discovery"]) writeFileSync(join(repo, ".workspace/dagu/dags", `${name}.yaml`), stamp);
    writeFileSync(join(home, "dags/reconcile.yaml"), stamp);
    writeFileSync(join(bin, "dagu"), "#!/bin/sh\nprintf '2.20.1\\n'\n", { mode: 0o755 });
    for (const config of ["queues:\n  enabled: true\n", "queues:\n  config:\n    - name: fixture\n      max_concurrency: 2\n"]) {
      writeFileSync(join(home, "config.yaml"), config);
      const result = spawnSync(process.execPath, [cli, repo], {
        encoding: "utf8", env: { ...process.env, DAGU_HOME: home, PATH: `${bin}:${process.env.PATH}` },
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stdout, /feature.yaml queue=fixture max_concurrency=6 compat=incompatible action=re-run-bootstrap/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const scenario of ["add", "change", "identical"] as const) {
  test(`materialized bootstrap deploy: ${scenario} preserves shared config and waiting data`, () => {
    const f = fixture();
    try {
      const skill = fileURLToPath(new URL("../skills/dagu-feature/", import.meta.url));
      const bootstrap = parse(readFileSync(join(skill, "dagu-feature-bootstrap.yaml"), "utf8"));
      const stage = join(f.home, "stage", "feature.yaml");
      const bin = join(f.home, "bin");
      const calls = join(f.home, "service-calls");
      mkdirSync(join(f.home, "stage"));
      mkdirSync(bin);
      writeFileSync(stage, "queue: a4s\nlabels: [dagu-feature-queue-concurrency=8]\n");
      writeFileSync(join(f.home, "stage", "reconcile.yaml"), "steps:\n  - run: true\n");
      const config = join(f.home, "config.yaml");
      const before = scenario === "add" ? original : `${original}    - name: a4s\n      max_concurrency: ${scenario === "change" ? 2 : 8}\n      metadata: retained\n`;
      // Keep the queue in the config sequence, before the unrelated server mapping.
      const initial = scenario === "add" ? before : before.replace("server:\n  port: 8888\n", "") + "server:\n  port: 8888\n";
      writeFileSync(config, initial);
      const waiting = join(f.home, "data", "waiting-run.json");
      mkdirSync(join(f.home, "data"));
      writeFileSync(waiting, '{"status":"waiting","step":"approval"}\n');
      writeFileSync(join(bin, "dagu"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      writeFileSync(join(bin, "launchctl"), `#!/bin/sh
printf '%s\\n' "$*" >> "$SERVICE_CALLS"
if [ "$1" = print ]; then
  printf 'path = /tmp/queue-test.plist\\nstate = running\\npid = 123\\n'
fi
`, { mode: 0o755 });
      writeFileSync(join(bin, "plutil"), `#!/bin/sh
printf '{"ProgramArguments":["/opt/bin/dagu","start-all"],"EnvironmentVariables":{"DAGU_HOME":"%s"}}\\n' "$DAGU_HOME"
`, { mode: 0o755 });
      const script = join(f.home, "deploy.sh");
      writeFileSync(script, bootstrap.steps.find((step: { id: string }) => step.id === "reconcile").run);
      const output = join(f.home, "outputs");
      const result = spawnSync("bash", [script], { encoding: "utf8", env: {
        ...process.env, DAGU_HOME: f.home, SKILL_DIR: skill, STAGE: stage,
        DAGU_OUTPUT_FILE: output, SERVICE_CALLS: calls, PATH: `${bin}:${process.env.PATH}`,
      } });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const expected = parse(initial);
      const entry = expected.queues.config.find((item: { name: string }) => item.name === "a4s");
      if (entry) entry.max_concurrency = 8;
      else expected.queues.config.push({ name: "a4s", max_concurrency: 8 });
      assert.deepEqual(parse(readFileSync(config, "utf8")), expected);
      assert.match(readFileSync(config, "utf8"), /# shared config/);
      assert.match(readFileSync(config, "utf8"), /# other repo/);
      const changed = scenario !== "identical";
      assert.match(readFileSync(output, "utf8"), new RegExp(`QUEUE_STATUS=queue=a4s max_concurrency=8 changed=${changed ? "yes" : "no"}`));
      const commands = readFileSync(calls, "utf8").trim().split("\n");
      assert.equal(commands.filter(command => command.startsWith("kickstart ")).length, changed ? 1 : 0);
      if (changed) assert.ok(commands.includes(`kickstart -k gui/${process.getuid!()}/local.dagu.server`));
      else assert.equal(readFileSync(config, "utf8"), initial);
      assert.equal(readFileSync(waiting, "utf8"), '{"status":"waiting","step":"approval"}\n');
    } finally { f.dispose(); }
  });
}
