import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import { exampleAnswers, parseAnswers, serializeAnswers } from "../src/answers.ts";
import { currentQueueConcurrency, deriveQueue, queueCompatibility, reconcileQueue } from "../src/queue.ts";
import { bootstrapRender } from "./fixtures/bootstrap-render.ts";
import { BUNDLE_VERSION } from "../src/bundle.ts";

const packageDir = fileURLToPath(new URL("../", import.meta.url));
const cli = join(packageDir, "bin", "dagu-feature-bundle.ts");
const skill = join(packageDir, "skills", "issue-execution");
const bootstrap = parse(readFileSync(join(skill, "dagu-feature-bootstrap.yaml"), "utf8"));
const queue = { name: "a4s", max_concurrency: 8 };
function answersText(concurrency = 8, lane = "a4s"): string {
  return serializeAnswers(exampleAnswers({ lane, queueConcurrency: concurrency, gate: "true", requiredCheck: "validate", testPaths: "test" }));
}
const original = "# shared config\nqueues:\n  enabled: true\n  config:\n    # other repository\n    - name: foreign\n      max_concurrency: 3\nserver:\n  port: 8888\n";
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "dagu-repo-queue-"));
  return { home, dispose: () => rmSync(home, { recursive: true, force: true }) };
}

function fileMtime(path: string): number {
  const fd = openSync(path, "r");
  try { return fstatSync(fd).mtimeMs; }
  finally { closeSync(fd); }
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
      writeFileSync(stage, answersText());
      const initial = scenario === "add" ? original : deriveQueue(original, { ...queue, max_concurrency: scenario === "change" ? 2 : 8 }).content.replace("max_concurrency: " + (scenario === "change" ? 2 : 8), "metadata: retained\n      max_concurrency: " + (scenario === "change" ? 2 : 8));
      const config = join(f.home, "config.yaml");
      writeFileSync(config, initial);
      const before = fileMtime(config);
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
        assert.equal(fileMtime(config), before);
      }
      assert.equal(readFileSync(waiting, "utf8"), '{"status":"waiting","step":"approval"}\n');
    } finally { f.dispose(); }
  });
}

test("materialized templates carry capacity and blank answers preserve the detected policy", () => {
  const f = fixture();
  const saved = process.env.QUEUE_CONCURRENCY;
  try {
    for (const value of ["8", "3"]) {
      process.env.QUEUE_CONCURRENCY = value;
      bootstrapRender({ packageDir, directory: f.home, primary: f.home, version: BUNDLE_VERSION, sourceNwo: "example/repo", sourceSha: "a".repeat(40) });
      for (const name of ["feature", "poc", "discovery"]) {
        assert.match(readFileSync(join(f.home, `${name}.yaml`), "utf8"), new RegExp(`dagu-feature-queue-concurrency=${value}`));
      }
      writeFileSync(join(f.home, "answers.json"), answersText(Number(value), "fixture"));
      assert.equal(currentQueueConcurrency([join(f.home, "answers.json")]), Number(value));
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
    writeFileSync(join(f.home, "other.json"), answersText(7, "fixture"));
    assert.throws(() => currentQueueConcurrency([join(f.home, "answers.json"), join(f.home, "other.json")]), /disagree/);
  } finally {
    if (saved === undefined) delete process.env.QUEUE_CONCURRENCY; else process.env.QUEUE_CONCURRENCY = saved;
    f.dispose();
  }
});

test("bundle compatibility reports installed capacity drift through the actual CLI", () => {
  const f = fixture();
  try {
    const repo = join(f.home, "repo");
    const answers = join(repo, ".workspace", "dagu", "answers.json");
    mkdirSync(join(answers, ".."), { recursive: true });
    const init = spawnSync("git", ["init", "-b", "main", repo], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    spawnSync("git", ["-C", repo, "config", "user.email", "queue@example.test"]);
    spawnSync("git", ["-C", repo, "config", "user.name", "Queue Test"]);
    writeFileSync(answers, answersText());
    spawnSync("git", ["-C", repo, "add", "."]);
    const committed = spawnSync("git", ["-C", repo, "commit", "-qm", "answers"], { encoding: "utf8" });
    assert.equal(committed.status, 0, committed.stderr);
    for (const installed of [1, 8]) {
      writeFileSync(join(f.home, "config.yaml"), deriveQueue(original, { ...queue, max_concurrency: installed }).content);
      const check = spawnSync(process.execPath, [cli, "queue-check", answers], { encoding: "utf8", env: { ...process.env, DAGU_HOME: f.home } });
      assert.equal(check.status, installed === 8 ? 0 : 1, check.stderr);
      assert.match(check.stdout, installed === 8 ? /compat=ok/ : /compat=incompatible action=re-run-bootstrap/);
      assert.equal(queueCompatibility(f.home, queue).endsWith("compat=ok"), installed === 8);
      if (installed === 1) {
        const bundle = spawnSync(process.execPath, [cli, repo], { encoding: "utf8", env: { ...process.env, DAGU_HOME: f.home } });
        assert.equal(bundle.status, 1);
        assert.match(bundle.stdout, /answers path=\.workspace\/dagu\/answers\.json .*lane=a4s .*queue=a4s max_concurrency=8 compat=incompatible action=re-run-bootstrap/);
      }
    }
  } finally { f.dispose(); }
});

test("install-reconciler creates a missing station DAG and leaves identical bytes untouched", () => {
  const f = fixture();
  try {
    const answers = join(f.home, "answers.json");
    const dest = join(f.home, "dags", "reconcile.yaml");
    const reconcilerAnswers = (ciBlocked: number) => serializeAnswers(exampleAnswers({
      lane: "a4s", queueConcurrency: 8, gate: "true", requiredCheck: "validate", testPaths: "test",
      escalation: { pushbacks: 3, findings: 2, seconds: 3600, ciBlocked, pocInconclusive: 2 },
    }));
    writeFileSync(answers, reconcilerAnswers(2));
    const created = spawnSync(process.execPath, [cli, "install-reconciler", answers, dest], { encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    assert.match(created.stdout, new RegExp(`^reconcile=${dest}\\n$`));
    const bytes = readFileSync(dest, "utf8");
    assert.match(bytes, /ESCALATION_CI_BLOCKED: "2"/);
    const stamped = new Date(Date.now() - 60_000);
    utimesSync(dest, stamped, stamped);
    const mtime = fileMtime(dest);
    const again = spawnSync(process.execPath, [cli, "install-reconciler", answers, dest], { encoding: "utf8" });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(readFileSync(dest, "utf8"), bytes);
    assert.equal(fileMtime(dest), mtime);
    writeFileSync(answers, reconcilerAnswers(5));
    const replaced = spawnSync(process.execPath, [cli, "install-reconciler", answers, dest], { encoding: "utf8" });
    assert.equal(replaced.status, 0, replaced.stderr);
    assert.match(readFileSync(dest, "utf8"), /ESCALATION_CI_BLOCKED: "5"/);
    assert.notEqual(fileMtime(dest), mtime);
    assert.equal(readdirSync(join(f.home, "dags")).some(name => name.startsWith(".reconcile-")), false);
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

test("answers and global queue entries require positive unambiguous identities", () => {
  const valid = exampleAnswers({ lane: "a4s", queueConcurrency: 8 });
  for (const queueConcurrency of [0, -1, 1.5, 9007199254740992]) assert.throws(() => parseAnswers({ ...valid, queueConcurrency }), /positive integer/);
  assert.throws(() => parseAnswers({ ...valid, extra: true }), /unknown field/);
  assert.throws(() => deriveQueue("queues:\n  config:\n    - name: a4s\n    - name: a4s\n", queue), /Duplicate queue/);
  assert.throws(() => deriveQueue("queues: []\n", queue), /mapping/);
});
