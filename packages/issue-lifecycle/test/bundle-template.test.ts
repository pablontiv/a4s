import { liveDagu } from "./fixtures/live-dagu.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

const skill = (name: string): string => readFileSync(
  fileURLToPath(new URL(`../skills/issue-execution/${name}`, import.meta.url)),
  "utf8",
);

test("bootstrap selects and verifies the explicit lane or the GitHub default", () => {
  const bootstrap = skill("dagu-feature-bootstrap.yaml");
  const selection = bootstrap.slice(bootstrap.indexOf("      base=${BASE_BRANCH:"),
    bootstrap.indexOf("      if ! required=")).split("\n").map(line => line.slice(6)).join("\n");
  for (const [requested, expected] of [["", "main"], ["release/candidate", "release/candidate"]]) {
    const result = spawnSync("bash", ["-euc", `
      gh() {
        if test "$1" = repo; then printf 'main\\n';
        else test "$2" = "repos/owner/repo/branches/$EXPECTED"; fi
      }
      nwo=owner/repo
      ${selection}
      printf '%s' "$base"
    `], { encoding: "utf8", env: { ...process.env, BASE_BRANCH: requested, EXPECTED: expected } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
  }
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
          SKILL_DIR: fileURLToPath(new URL("../skills/issue-execution", import.meta.url)),
          STAGE: stage, REPO: "fixture", BASE_BRANCH: "main", PRIMARY: root,
          GATE: "true", REQUIRED_CHECK: "validate", TEST_PATHS: "^test/",
          REBASE_RESOLVER: "node packages/issue-lifecycle/bin/dagu-bundle-rebase.mjs",
          VALIDATION: validation, BUNDLE_NAME: "@a4s/issue-lifecycle", BUNDLE_VERSION: "0.3.14",
          DAGU_VERSION: "2.20.1", SOURCE_NWO: "owner/repo", SOURCE_SHA: "a".repeat(40),
        },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const output = readFileSync(stage, "utf8");
      assert.ok(output.includes(`default: ${JSON.stringify(validation)}\n      enum: [${JSON.stringify(validation)}]`));
      assert.ok(output.includes('- REBASE_RESOLVER: "node packages/issue-lifecycle/bin/dagu-bundle-rebase.mjs"'));
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
        SKILL_DIR: fileURLToPath(new URL("../skills/issue-execution", import.meta.url)),
        STAGE: stage, PRIMARY: root, REPO: "fixture", BASE_BRANCH: "main",
        GATE: "true", REQUIRED_CHECK: "validate", TEST_PATHS: "^test/", REBASE_RESOLVER: "",
        BUNDLE_NAME: "@a4s/issue-lifecycle", BUNDLE_VERSION: "0.3.98", DAGU_VERSION: "2.20.1",
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

test("bootstrap renders default, preserved and explicit CodeQL thresholds and rejects enqueue overrides", () => {
  const bootstrap = skill("dagu-feature-bootstrap.yaml");
  const script = bootstrap.split("  - id: render\n")[1]!.split("    run: |\n")[1]!.split("      for rendered in")[0]!
    .split("\n").map(line => line.slice(6)).join("\n");
  const admission = skill("feature.yaml").split("  - id: admission\n")[1]!.split("\n  - id: triage")[0]!
    .split("    run: |\n")[1]!.split("\n").map(line => line.slice(6)).join("\n");
  const root = mkdtempSync(join(tmpdir(), "a4s-codeql-policy-"));
  try {
    for (const [answer, installed, expected] of [
      ["", "", "high_or_higher"], ["", "medium_or_higher", "medium_or_higher"], ["critical", "medium_or_higher", "critical"],
    ]) {
      const stage = join(root, "feature.yaml");
      const result = spawnSync("bash", ["-c", script], { encoding: "utf8", env: {
        ...process.env, PRIMARY: root, SKILL_DIR: fileURLToPath(new URL("../skills/issue-execution", import.meta.url)),
        STAGE: stage, DAG_RUN_ID: "bootstrap-codeql", REPO: "fixture", BASE_BRANCH: "main",
        GATE: "true", REQUIRED_CHECK: "validate", REBASE_RESOLVER: "", TEST_PATHS: "test",
        BUNDLE_NAME: "@a4s/issue-lifecycle", BUNDLE_VERSION: "0.4.4", DAGU_VERSION: "2.20.1",
        SOURCE_NWO: "example/repo", SOURCE_SHA: "a".repeat(40),
        CODEQL_SECURITY_THRESHOLD: answer, CURRENT_CODEQL_SECURITY_THRESHOLD: installed,
        CODEQL_ALERTS_THRESHOLD: "", CURRENT_CODEQL_ALERTS_THRESHOLD: "errors_and_warnings",
      } });
      assert.equal(result.status, 0, result.stderr);
      const rendered = parse(readFileSync(stage, "utf8"));
      assert.ok(rendered.env.some((entry: Record<string, string>) => entry.CODEQL_SECURITY_THRESHOLD === expected));
      assert.ok(rendered.env.some((entry: Record<string, string>) => entry.CODEQL_ALERTS_THRESHOLD === "errors_and_warnings"));
    }
    for (const key of ["CODEQL_SECURITY_THRESHOLD", "CODEQL_ALERTS_THRESHOLD"]) {
      const result = spawnSync("bash", ["-c", admission], { encoding: "utf8", env: {
        ...process.env, DAGU_PARAMS_JSON: JSON.stringify({ [key]: "none" }),
        PRIMARY: root, GATE: "true", REBASE_RESOLVER: "", REQUIRED_CHECK: "validate", BRANCH: "dagu/issue-570",
      } });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.ok(result.stderr.includes(`admission rejected run parameter: ${key}`));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
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
  { dir: "packages/review-routing", name: "@a4s/review-routing" },
  { dir: "packages/issue-lifecycle", name: "@a4s/issue-lifecycle" },
  { dir: "packages/hot-reload", name: "@a4s/hot-reload" },
  { dir: "packages/orca-integration", name: "@a4s/orca-integration" },
  { dir: "packages/pi-tool-row-presentation", name: "@a4s/pi-tool-row-presentation",
    scripts: { test: "tsx --test test/*.test.ts" } },
  { dir: "packages/agent-messaging", name: "@a4s/agent-messaging" },
  { dir: "apps/message-bus", name: "@a4s/message-bus" },
];
const dependencyWorkspaces: CiWorkspace[] = [
  { dir: "packages/review-routing", name: "@a4s/review-routing",
    devDependencies: { "@oh-my-pi/pi-coding-agent": "18.12.5" } },
  { dir: "packages/agent-messaging", name: "@a4s/agent-messaging" },
  { dir: "packages/orca-integration", name: "@a4s/orca-integration",
    dependencies: { "@a4s/hot-reload": "0.1.0" } },
  { dir: "apps/message-bus", name: "@a4s/message-bus", dependencies: { "@a4s/agent-messaging": "*" } },
  { dir: "packages/issue-lifecycle", name: "@a4s/issue-lifecycle", devDependencies: { "@a4s/review-routing": "*" } },
];

function ciFixture(workspaces: CiWorkspace[]) {
  const root = mkdtempSync(join(tmpdir(), "a4s-ci-workspaces-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({
    private: true, workspaces: ["packages/*", "packages/tools/*", "apps/*"],
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
      [["packages/review-routing/src/settings.ts"], ["@a4s/review-routing"]],
      [["packages/agent-messaging/src/index.ts"], ["@a4s/agent-messaging"]],
      [[{ filename: "apps/message-bus/src/deleted.ts", status: "removed" }], ["@a4s/message-bus"]],
      [[{ filename: "packages/agent-messaging/src/new.ts", previous_filename: "packages/agent-messaging/src/old.ts" }],
        ["@a4s/agent-messaging"]],
      [[{ filename: "apps/message-bus/src/new.ts", previous_filename: "packages/agent-messaging/src/old.ts" }],
        ["@a4s/agent-messaging", "@a4s/message-bus"]],
      [[], []],
    ];
    for (const [files, names] of cases) assert.deepEqual(fixture.select(files), ciJobs(...names), JSON.stringify(files));
    assert.deepEqual(fixture.select(["packages/pi-tool-row-presentation/src/index.ts"]), [
      { name: "@a4s/pi-tool-row-presentation", test: true, typecheck: false },
    ]);
  } finally { fixture.dispose(); }
});

test("CI selects declared package/app consumers and both sides of package-to-app renames", () => {
  const fixture = ciFixture(dependencyWorkspaces);
  try {
    const cases: [unknown[], string[]][] = [
      [["packages/review-routing/src/index.ts"], ["@a4s/review-routing", "@a4s/issue-lifecycle"]],
      [["packages/agent-messaging/src/index.ts"], ["@a4s/agent-messaging", "@a4s/message-bus"]],
      [["packages/orca-integration/src/index.ts"], ["@a4s/orca-integration"]],
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
    { dir: "packages/issue-lifecycle", name: "@a4s/issue-lifecycle", optionalDependencies: { "@a4s/message-bus": "*" } },
  ]);
  try {
    assert.deepEqual(fixture.select(["packages/tools/routing/src/index.ts"]), [
      { name: "@a4s/issue-lifecycle", test: true, typecheck: true },
      { name: "@a4s/message-bus", test: true, typecheck: false },
      { name: "@a4s/review-routing", test: false, typecheck: true },
    ]);
    assert.deepEqual(fixture.select(["packages/tools/README.md"]), ciJobs("@a4s/tools"));
  } finally { fixture.dispose(); }
});

test("CI broad changes and main push/PR events select all actual workspaces", () => {
  const branch = "main";
  for (const workspaces of [mainWorkspaces, dependencyWorkspaces]) {
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
        "apps/removed-app/src/index.ts", "packages/hot-reload/src/index.ts"]) {
        assert.deepEqual(fixture.select([filename]), expected, `${branch}: ${filename}`);
      }
      assert.deepEqual(fixture.select([{ filename: "apps/message-bus/src/new.ts",
        previous_filename: "packages/removed-workspace/src/old.ts" }]), expected);
    } finally { fixture.dispose(); }
  }
});

test("CI workflow selector executes paginated rename records and the NUL-safe git fallback", () => {
  const fixture = ciFixture(dependencyWorkspaces);
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
  const run = (workspaces: string, changes: string, tests: string, live: string,
    prBody = "success", event = "pull_request") =>
    spawnSync("bash", ["-euo", "pipefail", "-c", aggregate], { cwd: root, encoding: "utf8", env: {
      ...process.env, WORKSPACES: workspaces, CHANGES_RESULT: changes, TEST_RESULT: tests, LIVE_RESULT: live,
      PR_BODY_RESULT: prBody, EVENT_NAME: event,
    } });
  const dagu = JSON.stringify(ciJobs("@a4s/issue-lifecycle", "@a4s/review-routing"));
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
  assert.equal(run(dagu, "success", "success", "success", "skipped", "push").status, 0);
  for (const outcome of ["failure", "cancelled", "skipped", ""]) {
    assert.equal(run(dagu, "success", "success", "success", outcome).status, 1, `pr-body=${outcome}`);
  }
  for (const outcome of ["failure", "cancelled", "success", ""]) {
    assert.equal(run(dagu, "success", "success", "success", outcome, "push").status, 1, `push pr-body=${outcome}`);
  }
  for (const matrix of ["", "null", "{}", "broken", '[{"name":"@a4s/issue-lifecycle"}]',
    '[{"name":"@a4s/issue-lifecycle","test":"true","typecheck":true}]']) {
    assert.equal(run(matrix, "success", "success", "success").status, 1, `matrix=${matrix}`);
  }
});
