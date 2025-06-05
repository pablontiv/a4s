import { liveDagu } from "./fixtures/live-dagu.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { BUNDLE_VERSION } from "../src/bundle.ts";
import { stampedQueue } from "../src/queue.ts";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse, stringify } from "yaml";

const skill = (name: string): string => readFileSync(
  fileURLToPath(new URL(`../skills/dagu-feature/${name}`, import.meta.url)),
  "utf8",
);

test("all distributed DAG templates carry bundle stamp and label placeholders", () => {
  for (const name of ["feature.yaml", "poc.yaml", "discovery.yaml", "planning.yaml", "reconcile.yaml"]) {
    const contents = skill(name);
    assert.equal(contents.split("\n", 1)[0], "# dagu-feature-bundle: __DAGU_FEATURE_STAMP__", name);
    assert.match(contents, name === "discovery.yaml"
      ? /^  - dagu-feature-bundle=TEMPLATE_DAGU_FEATURE_VERSION$/m
      : /^  - dagu-feature-bundle=__DAGU_FEATURE_VERSION__$/m, name);
  }
  for (const name of ["feature.yaml", "poc.yaml", "discovery.yaml"]) {
    assert.match(skill(name), /^  - dagu-feature-queue-concurrency=TEMPLATE_QUEUE_CONCURRENCY$/m);
  }
});

test("interactive repository DAG identity steps print the rendered bundle identity", () => {
  const feature = skill("feature.yaml");
  const poc = skill("poc.yaml");
  const discovery = skill("discovery.yaml");
  assert.match(feature, /- DAGU_FEATURE_BUNDLE: "__DAGU_FEATURE_IDENTITY__"/);
  assert.match(feature, /- id: start_gate[\s\S]*?printf '%s\\n' "\$DAGU_FEATURE_BUNDLE"/);
  assert.match(poc, /- DAGU_FEATURE_BUNDLE: "__DAGU_FEATURE_IDENTITY__"/);
  assert.match(poc, /- id: base[\s\S]*?printf '%s\\n' "\$DAGU_FEATURE_BUNDLE"/);
  assert.match(discovery, /- DAGU_FEATURE_BUNDLE: "__DAGU_FEATURE_IDENTITY__"/);
  assert.match(discovery, /- id: snapshot[\s\S]*?printf '%s\\n' "\$DAGU_FEATURE_BUNDLE"/);
  const planning = skill("planning.yaml");
  assert.match(planning, /- DAGU_FEATURE_BUNDLE: "__DAGU_FEATURE_IDENTITY__"/);
  assert.match(planning, /- id: init[\s\S]*?printf '%s\\n' "\$DAGU_FEATURE_BUNDLE"/);
});

test("bootstrap detects source compatibility and renders and confirms all stamps", () => {
  const bootstrap = skill("dagu-feature-bootstrap.yaml");
  assert.match(bootstrap, /git -C "\$source_root" status --porcelain --untracked-files=all/);
  assert.match(bootstrap, /git -C "\$source_root" merge-base --is-ancestor "\$source_sha" "\$source_default"/);
  assert.match(bootstrap, /cmp "\$version_tmp\/expected" "\$version_tmp\/stdout"/);
  assert.match(bootstrap, /CURRENT_FEATURE_STAMP/);
  assert.match(bootstrap, /CURRENT_POC_STAMP/);
  assert.match(bootstrap, /CURRENT_DISCOVERY_STAMP/);
  assert.match(bootstrap, /CURRENT_PLANNING_STAMP/);
  assert.match(bootstrap, /\$SKILL_DIR\/planning\.yaml/);
  assert.match(bootstrap, /\$SKILL_DIR\/reconcile\.yaml/);
  assert.match(bootstrap, /\$SKILL_DIR\/discovery\.yaml/);
  assert.match(bootstrap, /Dagu-Feature-Bundle: %s/);
  assert.match(bootstrap, /Dagu-Feature-Source: %s@%s/);
  assert.match(bootstrap, /Dagu-Feature-Bootstrap: %s/);
  assert.match(bootstrap, /CURRENT_REBASE_RESOLVER/);
  assert.match(bootstrap, /REBASE_RESOLVER: \$\{steps.answers.outputs.REBASE_RESOLVER\}/);
  assert.match(bootstrap, /--arg resolver "\$REBASE_RESOLVER"/);
  assert.ok(bootstrap.includes('gsub(\\"__REBASE_RESOLVER__\\"; \\$resolver | tojson)'));
  assert.match(bootstrap, /CURRENT_QUEUE_CONCURRENCY/);
  assert.match(bootstrap, /CURRENT_QUEUE_CONCURRENCY: \$\{steps.detect.outputs.CURRENT_QUEUE_CONCURRENCY\}/);
  assert.match(bootstrap, /queue-reconcile "\$STAGE"/);
  assert.match(bootstrap, /queue-check "\$STAGE"/);
  assert.match(bootstrap, /QUEUE_STATUS: \$\{steps.reconcile.outputs.QUEUE_STATUS\}/);
});

test("bootstrap renders optional validation as the sole adopted value", {
  ...liveDagu,
}, () => {
  const bootstrap = skill("dagu-feature-bootstrap.yaml");
  const render = bootstrap.split("  - id: render\n")[1]!.split("\n  - id: reconcile")[0]!;
  const script = render.split("    run: |\n")[1]!.split("\n").map(line => line.slice(6)).join("\n");
  const root = mkdtempSync(join(tmpdir(), "omp-dagu-bootstrap-validation-"));
  try {
    for (const validation of ["", "Run smoke\nKeep 'quotes', $HOME and backslashes \\\\ literal"]) {
      const stage = join(root, "feature.yaml");
      const result = spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        env: {
          ...process.env, DAGU_HOME: join(root, "home"), DAG_RUN_ID: "bootstrap-test",
          SKILL_DIR: fileURLToPath(new URL("../skills/dagu-feature", import.meta.url)),
          STAGE: stage, REPO: "fixture", BASE_BRANCH: "main", PRIMARY: root,
          GATE: "true", REQUIRED_CHECK: "validate", TEST_PATHS: "^test/",
          REBASE_RESOLVER: "node packages/omp-dagu/bin/dagu-bundle-rebase.mjs",
          CURRENT_QUEUE_CONCURRENCY: "1",
          VALIDATION: validation, BUNDLE_NAME: "@a4s/omp-dagu", BUNDLE_VERSION: "0.3.14",
          DAGU_VERSION: "2.20.1", SOURCE_NWO: "owner/repo", SOURCE_SHA: "a".repeat(40),
        },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const output = readFileSync(stage, "utf8");
      assert.ok(output.includes(`default: ${JSON.stringify(validation)}\n      enum: [${JSON.stringify(validation)}]`));
      assert.ok(output.includes('- REBASE_RESOLVER: "node packages/omp-dagu/bin/dagu-bundle-rebase.mjs"'));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bootstrap preserves the installed blocker reporting choice and accepts explicit changes", liveDagu, () => {
  const bootstrap = skill("dagu-feature-bootstrap.yaml");
  const render = bootstrap.split("  - id: render\n")[1]!.split("\n  - id: reconcile")[0]!;
  const script = render.split("    run: |\n")[1]!.split("\n").map(line => line.slice(6)).join("\n");
  const detect = bootstrap.split("      read_default() {")[1]!.split("      read_stamp() {")[0]!;
  const readDefault = "read_default() {" + detect.split("\n").map(line => line.startsWith("      ") ? line.slice(6) : line).join("\n");
  const root = mkdtempSync(join(tmpdir(), "omp-dagu-blocker-policy-"));
  const stage = join(root, "feature.yaml");
  let installed = "";
  try {
    for (const [answer, expected] of [["", "ask"], ["auto", "auto"], ["", "auto"], ["ask", "ask"], ["", "ask"]]) {
      const result = spawnSync("bash", ["-c", script], { encoding: "utf8", env: {
        ...process.env, DAGU_HOME: join(root, "home"), DAG_RUN_ID: "bootstrap-policy",
        SKILL_DIR: fileURLToPath(new URL("../skills/dagu-feature", import.meta.url)),
        STAGE: stage, PRIMARY: root, REPO: "fixture", BASE_BRANCH: "main",
        GATE: "true", REQUIRED_CHECK: "validate", TEST_PATHS: "^test/", REBASE_RESOLVER: "",
        CURRENT_QUEUE_CONCURRENCY: "1",
        BUNDLE_NAME: "@a4s/omp-dagu", BUNDLE_VERSION: "0.3.98", DAGU_VERSION: "2.20.1",
        SOURCE_NWO: "owner/repo", SOURCE_SHA: "a".repeat(40),
        A4S_BLOCKER_REPORTING: answer, CURRENT_A4S_BLOCKER_REPORTING: installed,
      } });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const readback = spawnSync("bash", ["-c", `${readDefault}\nread_default "$1" A4S_BLOCKER_REPORTING`, "read-policy", stage], { encoding: "utf8" });
      assert.equal(readback.status, 0, readback.stderr);
      installed = readback.stdout.trim();
      assert.equal(installed, expected);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("adopted blocker reporting policy rejects run input before effects", () => {
  const admission = skill("feature.yaml").split("  - id: admission\n")[1]!.split("\n  - id: triage")[0]!;
  const script = admission.split("    run: |\n")[1]!.split("\n").map(line => line.slice(6)).join("\n");
  for (const value of ["ask", "auto", ""]) {
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", env: {
      ...process.env, DAGU_PARAMS_JSON: JSON.stringify({ A4S_BLOCKER_REPORTING: value }),
      PRIMARY: "/consumer", GATE: "true", REQUIRED_CHECK: "validate", BRANCH: "dagu/issue-454",
    } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /admission rejected run parameter: A4S_BLOCKER_REPORTING/);
  }
  const accepted = spawnSync("bash", ["-c", script], { encoding: "utf8", env: {
    ...process.env, DAGU_PARAMS_JSON: JSON.stringify({ ISSUE: "454", OMP_SESSION_ID: "consumer-owner" }),
  } });
  assert.equal(accepted.status, 0, accepted.stderr);
});

test("bootstrap binds feature and PoC primary and feature policy at adoption", () => {
  const bootstrap = skill("dagu-feature-bootstrap.yaml");
  assert.match(bootstrap, /PRIMARY=\$\(cd "\$PRIMARY" && pwd -P\)/);
  assert.equal((bootstrap.match(/gsub\(\\"__PRIMARY__\\"/g) ?? []).length, 2);
  assert.match(skill("feature.yaml"), /env:\n  - PRIMARY: __PRIMARY__\n  - BRANCH: dagu\/issue-\$\{ISSUE\}\n  - GATE: __GATE__\n  - REBASE_RESOLVER: __REBASE_RESOLVER__\n  - REQUIRED_CHECK: __REQUIRED_CHECK__/);
  assert.match(skill("poc.yaml"), /env:\n  - PRIMARY: __PRIMARY__/);
});

const ciScript = fileURLToPath(new URL("../../../scripts/ci-workspaces.mjs", import.meta.url));
const ciWorkflow = parse(readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8"));
type CiWorkspace = {
  dir: string;
  name: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};
const ciJobs = (...names: string[]) => names.sort().map(name => ({ name, test: true, typecheck: true }));
const mainWorkspaces: CiWorkspace[] = [
  { dir: "packages/context-expert", name: "@a4s/context-expert" },
  { dir: "packages/omp-cross-family-review", name: "@a4s/omp-cross-family-review" },
  { dir: "packages/omp-dagu", name: "@a4s/omp-dagu", dependencies: { "@a4s/omp-cross-family-review": "*" } },
  { dir: "packages/omp-hot-reload", name: "@a4s/omp-hot-reload" },
  { dir: "packages/orca-omp-integration", name: "@a4s/orca-omp-integration" },
  { dir: "packages/pi-tool-row-presentation", name: "@a4s/pi-tool-row-presentation" },
  { dir: "packages/synagent/core", name: "@a4s/synagent" },
  { dir: "packages/synagent/bus", name: "@a4s/synagent-bus" },
];
const integrationWorkspaces: CiWorkspace[] = [
  { dir: "packages/review-routing", name: "@a4s/review-routing",
    devDependencies: { "@oh-my-pi/pi-coding-agent": "18.12.5" } },
  { dir: "packages/agent-messaging", name: "@a4s/agent-messaging" },
  { dir: "apps/message-bus", name: "@a4s/message-bus", dependencies: { "@a4s/agent-messaging": "*" } },
  { dir: "packages/omp-dagu", name: "@a4s/omp-dagu", devDependencies: { "@a4s/review-routing": "*" } },
];

function ciFixture(workspaces: CiWorkspace[]) {
  const root = mkdtempSync(join(tmpdir(), "a4s-ci-workspaces-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({
    private: true, workspaces: ["packages/*", "packages/synagent/*", "packages/tools/*", "apps/*"],
  }));
  for (const { dir, ...manifest } of workspaces) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "package.json"), JSON.stringify({
      scripts: { test: "node --test", typecheck: "tsc --noEmit" }, ...manifest,
    }));
  }
  const command = (mode: string, env: Record<string, string>, input = "[]") =>
    spawnSync(process.execPath, [ciScript, mode], { cwd: root, encoding: "utf8",
      env: { ...process.env, ...env }, input });
  return {
    root, command,
    select(files: unknown[], event = "pull_request") {
      const result = command("select", { EVENT_NAME: event }, JSON.stringify(files));
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return JSON.parse(result.stdout);
    },
    dispose() { rmSync(root, { recursive: true, force: true }); },
  };
}

test("CI selects checked-out main manifests, nested owners and declared routing consumers", () => {
  const fixture = ciFixture(mainWorkspaces);
  try {
    const cases: [unknown[], string[]][] = [
      [["packages/context-expert/src/index.ts"], ["@a4s/context-expert"]],
      [["packages/omp-cross-family-review/src/settings.ts"], ["@a4s/omp-cross-family-review", "@a4s/omp-dagu"]],
      [["packages/synagent/core/src/index.ts"], ["@a4s/synagent"]],
      [[{ filename: "packages/synagent/bus/src/deleted.ts", status: "removed" }], ["@a4s/synagent-bus"]],
      [[{ filename: "packages/synagent/core/src/new.ts", previous_filename: "packages/synagent/core/src/old.ts" }],
        ["@a4s/synagent"]],
      [[{ filename: "packages/synagent/bus/src/new.ts", previous_filename: "packages/synagent/core/src/old.ts" }],
        ["@a4s/synagent", "@a4s/synagent-bus"]],
      [[], []],
    ];
    for (const [files, names] of cases) assert.deepEqual(fixture.select(files), ciJobs(...names), JSON.stringify(files));
    assert.deepEqual(fixture.select(["packages/pi-tool-row-presentation/src/index.ts"]), [
      { name: "@a4s/pi-tool-row-presentation", test: true, typecheck: false },
    ]);
  } finally { fixture.dispose(); }
});

test("CI selects future integration package/app names and both sides of package-to-app renames", () => {
  const fixture = ciFixture(integrationWorkspaces);
  try {
    const cases: [unknown[], string[]][] = [
      [["packages/review-routing/src/index.ts"], ["@a4s/review-routing", "@a4s/omp-dagu"]],
      [["packages/agent-messaging/src/index.ts"], ["@a4s/agent-messaging", "@a4s/message-bus"]],
      [["apps/message-bus/src/index.ts"], ["@a4s/message-bus"]],
      [[{ filename: "apps/message-bus/src/new.ts", previous_filename: "packages/agent-messaging/src/old.ts" }],
        ["@a4s/agent-messaging", "@a4s/message-bus"]],
    ];
    for (const [files, names] of cases) assert.deepEqual(fixture.select(files), ciJobs(...names), JSON.stringify(files));
  } finally { fixture.dispose(); }
});

test("CI follows moved manifest identities, longest nested ownership and transitive consumer declarations", () => {
  const fixture = ciFixture([
    { dir: "packages/tools", name: "@a4s/tools" },
    { dir: "packages/tools/routing", name: "@a4s/review-routing", scripts: { typecheck: "tsc --noEmit" } },
    { dir: "apps/message-bus", name: "@a4s/message-bus", scripts: { test: "node --test" },
      peerDependencies: { "@a4s/review-routing": "*" } },
    { dir: "packages/omp-dagu", name: "@a4s/omp-dagu", optionalDependencies: { "@a4s/message-bus": "*" } },
  ]);
  try {
    assert.deepEqual(fixture.select(["packages/tools/routing/src/index.ts"]), [
      { name: "@a4s/message-bus", test: true, typecheck: false },
      { name: "@a4s/omp-dagu", test: true, typecheck: true },
      { name: "@a4s/review-routing", test: false, typecheck: true },
    ]);
    assert.deepEqual(fixture.select(["packages/tools/README.md"]), ciJobs("@a4s/tools"));
  } finally { fixture.dispose(); }
});

test("CI broad changes and both configured branch events select all actual workspaces", () => {
  for (const [branch, workspaces] of [["main", mainWorkspaces], ["integration/v1", integrationWorkspaces]] as const) {
    const fixture = ciFixture(workspaces);
    try {
      const expected = ciJobs(...workspaces.map(workspace => workspace.name)).map(job =>
        job.name === "@a4s/pi-tool-row-presentation" ? { ...job, typecheck: false } : job);
      for (const event of ["push", "pull_request"]) {
        assert.ok(ciWorkflow.on[event].branches.includes(branch), `${event} must admit ${branch}`);
        assert.deepEqual(fixture.select(["package.json"], event), expected, `${event} ${branch}`);
      }
      for (const filename of ["package-lock.json", "tsconfig.json", ".github/workflows/ci.yml",
        "scripts/ci-workspaces.mjs", "scripts/bootstrap.sh", "packages/README.md",
        "packages/removed-workspace/src/old.ts", "packages/review-routing-extra/src/index.ts",
        "apps/removed-app/src/index.ts", "packages/omp-hot-reload/src/index.ts"]) {
        assert.deepEqual(fixture.select([filename]), expected, `${branch}: ${filename}`);
      }
      assert.deepEqual(fixture.select([{ filename: "apps/message-bus/src/new.ts",
        previous_filename: "packages/removed-workspace/src/old.ts" }]), expected);
    } finally { fixture.dispose(); }
  }
});

test("CI workflow selector executes paginated rename records and the NUL-safe git fallback", () => {
  const fixture = ciFixture(integrationWorkspaces);
  try {
    mkdirSync(join(fixture.root, "scripts"));
    symlinkSync(ciScript, join(fixture.root, "scripts/ci-workspaces.mjs"));
    const bin = join(fixture.root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), "#!/bin/sh\nprintf '%s' \"$CI_FILES\"\nexit \"$CI_API_STATUS\"\n", { mode: 0o755 });
    writeFileSync(join(bin, "git"), "#!/bin/sh\nprintf 'packages/agent-messaging/src/old file.ts\\000apps/message-bus/src/new\\nfile.ts\\000'\nexit \"$CI_DIFF_STATUS\"\n",
      { mode: 0o755 });
    const output = join(fixture.root, "output");
    const selector = ciWorkflow.jobs.changes.steps.find((step: { id?: string }) => step.id === "workspaces").run;
    for (const apiStatus of ["0", "1"]) {
      writeFileSync(output, "");
      const result = spawnSync("bash", ["-euo", "pipefail", "-c", selector], {
        cwd: fixture.root, encoding: "utf8", env: { ...process.env, EVENT_NAME: "pull_request",
          GITHUB_REPOSITORY: "fixture/repo", PR_NUMBER: "416", GITHUB_OUTPUT: output,
          PATH: `${bin}:${process.env.PATH}`, CI_API_STATUS: apiStatus, CI_DIFF_STATUS: "0",
          CI_FILES: JSON.stringify([[{ filename: "apps/message-bus/src/new.ts",
            previous_filename: "packages/agent-messaging/src/old.ts" }], []]) },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual(JSON.parse(readFileSync(output, "utf8").trim().slice("workspaces=".length)),
        ciJobs("@a4s/agent-messaging", "@a4s/message-bus"));
    }
    const failure = fixture.command("changes", { EVENT_NAME: "pull_request", PATH: `${bin}:${process.env.PATH}`,
      CI_API_STATUS: "1", CI_DIFF_STATUS: "1" });
    assert.equal(failure.status, 1);
  } finally { fixture.dispose(); }
});

test("CI validate executes the real aggregate and requires all selected job outcomes", () => {
  const root = dirname(dirname(ciScript));
  const aggregate = ciWorkflow.jobs.validate.steps.find((step: { run?: string }) => step.run).run;
  const run = (workspaces: string, changes: string, tests: string, live: string) =>
    spawnSync("bash", ["-euo", "pipefail", "-c", aggregate], { cwd: root, encoding: "utf8", env: {
      ...process.env, WORKSPACES: workspaces, CHANGES_RESULT: changes, TEST_RESULT: tests, LIVE_RESULT: live,
    } });
  const dagu = JSON.stringify(ciJobs("@a4s/omp-dagu", "@a4s/review-routing"));
  const app = JSON.stringify(ciJobs("@a4s/message-bus"));
  for (const [matrix, tests, live] of [[dagu, "success", "success"], [app, "success", "skipped"], ["[]", "skipped", "skipped"]]) {
    const result = run(matrix!, "success", tests!, live!);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  for (const outcome of ["failure", "cancelled", "skipped", ""]) {
    assert.equal(run(dagu, "success", outcome, "success").status, 1, `test=${outcome}`);
    assert.equal(run(dagu, "success", "success", outcome).status, 1, `live=${outcome}`);
    assert.equal(run(dagu, outcome, "success", "success").status, 1, `changes=${outcome}`);
  }
  for (const outcome of ["failure", "cancelled", "success", ""]) {
    assert.equal(run(app, "success", "success", outcome).status, 1, `unaffected live=${outcome}`);
    assert.equal(run("[]", "success", outcome, "skipped").status, 1, `empty test=${outcome}`);
  }
  for (const matrix of ["", "null", "{}", "broken", '[{"name":"@a4s/omp-dagu"}]',
    '[{"name":"@a4s/omp-dagu","test":"true","typecheck":true}]']) {
    assert.equal(run(matrix, "success", "success", "success").status, 1, `matrix=${matrix}`);
  }
});

const queue = { name: "example", max_concurrency: 6 };
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "dagu-bootstrap-live-"));
  return { home, dispose: () => rmSync(home, { recursive: true, force: true }) };
}
test("bootstrap validates and renders all repository queue stamps with real isolated Dagu", liveDagu, () => {
  const f = fixture();
  try {
    const skill = fileURLToPath(new URL("../skills/dagu-feature/", import.meta.url));
    const bootstrap = join(skill, "dagu-feature-bootstrap.yaml");
    const dag = parse(readFileSync(bootstrap, "utf8"));
    const answers = dag.steps.find((step: { id: string }) => step.id === "answers");
    assert.match(answers.with.prompt, /current stamped value/);
    assert.deepEqual(answers.with.form.properties.QUEUE_CONCURRENCY, { type: "string", default: "", pattern: "^([1-9][0-9]*)?$" });
    const stage = join(f.home, "stage", "feature.yaml");
    const env = { ...process.env, DAGU_HOME: f.home, PRIMARY: f.home, SKILL_DIR: skill, STAGE: stage,
      DAG_RUN_ID: "bootstrap-test", REPO: "example", BASE_BRANCH: "main", GATE: "true", REQUIRED_CHECK: "validate", REBASE_RESOLVER: "", TEST_PATHS: "test/", QUEUE_CONCURRENCY: "6", CURRENT_QUEUE_CONCURRENCY: "6", BUNDLE_NAME: "@a4s/omp-dagu", BUNDLE_VERSION, DAGU_VERSION: "2.20.1", SOURCE_NWO: "example/package", SOURCE_SHA: "a".repeat(40) };
    mkdirSync(join(f.home, "dags"));
    const validate = spawnSync("dagu", ["validate", bootstrap], { env, encoding: "utf8" });
    assert.equal(validate.status, 0, validate.stdout + validate.stderr);
    const render = spawnSync("bash", ["-c", dag.steps.find((step: { id: string }) => step.id === "render").run], { env, encoding: "utf8" });
    assert.equal(render.status, 0, render.stdout + render.stderr);
    for (const name of ["feature", "poc", "discovery"]) assert.deepEqual(stampedQueue(readFileSync(join(f.home, "stage", `${name}.yaml`), "utf8")), queue);
  } finally { f.dispose(); }
});

test("bootstrap integer-text answer overrides the stamp and omission keeps its default in real Dagu", { ...liveDagu, timeout: 90_000 }, async () => {
  const f = fixture();
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const env = { ...process.env, DAGU_HOME: f.home, DAGU_HOST: "127.0.0.1", DAGU_PORT: String(port), DAGU_COORDINATOR_ENABLED: "false", QUEUE_CONCURRENCY: undefined };
  mkdirSync(join(f.home, "dags"));
  writeFileSync(join(f.home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\nscheduler:\n  port: 0\n`);
  const bootstrap = parse(readFileSync(new URL("../skills/dagu-feature/dagu-feature-bootstrap.yaml", import.meta.url), "utf8"));
  const renderStep = bootstrap.steps.find((step: { id: string }) => step.id === "render");
  const render = renderStep.run as string;
  const resolveAnswer = render.slice(render.indexOf("# Empty integer-text"), render.indexOf('mkdir -p'));
  const dag = join(f.home, "dags", "queue-answer.yaml");
  writeFileSync(dag, stringify({
    type: "graph", shell: "bash",
    steps: [
      { id: "detect", run: 'echo CURRENT_QUEUE_CONCURRENCY=6 >> "$DAGU_OUTPUT_FILE"', outputs: [{ name: "CURRENT_QUEUE_CONCURRENCY" }] },
      { id: "answers", depends: "detect", action: "human.task", with: {
        prompt: "Keep current stamp 6 by omitting the answer",
        form: { type: "object", properties: { QUEUE_CONCURRENCY: bootstrap.steps.find((step: { id: string }) => step.id === "answers").with.form.properties.QUEUE_CONCURRENCY } },
      } },
      { id: "worktrees", depends: "answers", run: "true" },
      { id: "render", depends: "worktrees", env: renderStep.env.filter((entry: Record<string, string>) =>
        "CURRENT_QUEUE_CONCURRENCY" in entry || "QUEUE_CONCURRENCY" in entry),
      run: `${resolveAnswer}\nprintf '%s' "$QUEUE_CONCURRENCY" > '${join(f.home, "answer")}'` },
    ],
  }));
  const service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  service.stdout.on("data", data => { log += data; });
  service.stderr.on("data", data => { log += data; });
  const dagu = (...args: string[]) => execFileSync("dagu", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  async function until(probe: () => Promise<boolean>) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await probe()) return;
      await delay(100);
    }
    throw new Error(`Timed out waiting for queue answer\n${log}`);
  }
  async function state(id: string, wanted: string) {
    await until(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/dag-runs/queue-answer/${id}`);
      if (!response.ok) return false;
      const detail = (await response.json() as { dagRunDetails: { statusLabel: string } }).dagRunDetails;
      assert.notEqual(detail.statusLabel, "failed", log);
      return detail.statusLabel === wanted;
    });
  }
  try {
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/v1/dag-runs`)).ok; } catch { return false; } });
    for (const [id, inputs, expected] of [["keep", [], "6"], ["override", ["--input", "QUEUE_CONCURRENCY=1"], "1"]] as const) {
      dagu("enqueue", "--run-id", id, dag);
      await state(id, "waiting");
      const invalid = spawnSync("dagu", ["human-task", "complete", "queue-answer", "--run-id", id, "--step", "answers", "--input", "QUEUE_CONCURRENCY=0"], { env, encoding: "utf8" });
      assert.notEqual(invalid.status, 0, "the form accepts positive integers or its empty default");
      dagu("human-task", "complete", "queue-answer", "--run-id", id, "--step", "answers", ...inputs);
      await state(id, "succeeded");
      assert.equal(readFileSync(join(f.home, "answer"), "utf8"), expected);
    }
  } finally {
    service.kill("SIGTERM");
    await new Promise<void>(resolve => { if (service.exitCode !== null) resolve(); else service.once("exit", () => resolve()); });
    f.dispose();
  }
});
