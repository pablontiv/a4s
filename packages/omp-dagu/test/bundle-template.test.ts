import { liveDagu } from "./fixtures/live-dagu.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import { admissionFixture } from "./fixtures/admission.ts";

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
          GATE: "true", REQUIRED_CHECK: "validate", REQUIRED_CHECK_STRICT: "true", TEST_PATHS: "^test/",
          REBASE_RESOLVER: "node packages/omp-dagu/bin/dagu-bundle-rebase.mjs",
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
        GATE: "true", REQUIRED_CHECK: "validate", REQUIRED_CHECK_STRICT: "true", TEST_PATHS: "^test/", REBASE_RESOLVER: "",
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

const bootstrap = parse(skill("dagu-feature-bootstrap.yaml"));
const bootstrapScript = (id: string): string => bootstrap.steps.find((step: { id: string }) => step.id === id).run;
const protectionFlags = [
  "required_linear_history", "allow_force_pushes", "allow_deletions", "block_creations",
  "required_conversation_resolution", "lock_branch", "allow_fork_syncing",
];

// The API fixture reconstructs a full PUT response from its writable fields,
// rather than merging the old response, so omitted policy is observable.
const githubFixture = `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args.shift() !== "api") throw new Error("expected API command");
let method = "GET";
const methodIndex = args.indexOf("-X");
if (methodIndex >= 0) method = args.splice(methodIndex, 2)[1];
const endpoint = args.shift();
const state = JSON.parse(fs.readFileSync(process.env.API_STATE, "utf8"));
const repo = "repos/fixture/repo";
const protection = repo + "/branches/main/protection";
const checks = protection + "/required_status_checks";
let result;
const actors = value => value == null ? null : {
  users: (value.users ?? []).map(login => ({ login })),
  teams: (value.teams ?? []).map(slug => ({ slug })),
  apps: (value.apps ?? []).map(slug => ({ slug }))
};
if (method !== "GET") {
  const payload = JSON.parse(fs.readFileSync(0, "utf8"));
  state.requests.push({ method, endpoint, payload });
  if (method === "PATCH" && endpoint === checks) {
    state.protection.required_status_checks = payload;
  } else if (method === "PUT" && endpoint === protection) {
    for (const field of ["enforce_admins", "required_pull_request_reviews", "restrictions"]) {
      if (!(field in payload)) throw new Error("missing mandatory PUT field: " + field);
    }
    const reviews = payload.required_pull_request_reviews;
    if (reviews) {
      for (const field of ["dismissal_restrictions", "bypass_pull_request_allowances"]) {
        if (field in reviews) reviews[field] = actors(reviews[field]);
      }
    }
    state.protection = {
      required_status_checks: payload.required_status_checks,
      enforce_admins: { enabled: payload.enforce_admins ?? false },
      required_pull_request_reviews: reviews,
      restrictions: actors(payload.restrictions),
      ...Object.fromEntries(${JSON.stringify(protectionFlags)}.map(field => [field, { enabled: payload[field] ?? false }]))
    };
  } else throw new Error("unexpected mutation " + method + " " + endpoint);
  fs.writeFileSync(process.env.API_STATE, JSON.stringify(state));
  result = state.protection;
} else if (endpoint === repo) {
  result = { allow_auto_merge: true, allow_squash_merge: true };
} else if (endpoint === protection || endpoint === checks) {
  if (!state.protection) {
    console.error("Branch not protected");
    process.exit(1);
  }
  result = endpoint === checks ? state.protection.required_status_checks : state.protection;
} else throw new Error("unexpected endpoint " + endpoint);
const query = args.indexOf("--jq");
if (query >= 0) {
  const output = spawnSync("jq", ["-r", args[query + 1]], { input: JSON.stringify(result), encoding: "utf8" });
  process.stdout.write(output.stdout);
  process.stderr.write(output.stderr);
  process.exit(output.status ?? 1);
}
console.log(JSON.stringify(result));
`;

function bootstrapFixture() {
  const root = mkdtempSync(join(tmpdir(), "omp-dagu-bootstrap-strict-"));
  const bin = join(root, "bin");
  const stage = join(root, "stage", "feature.yaml");
  const home = join(root, "home");
  mkdirSync(bin);
  mkdirSync(join(root, "stage"));
  mkdirSync(join(home, "dags"), { recursive: true });
  for (const [name, contents] of [
    ["gh", githubFixture],
    ["git", "#!/bin/sh\nexit 0\n"],
    ["dagu", "#!/bin/sh\nexit 0\n"],
  ]) {
    writeFileSync(join(bin, name!), contents!);
    chmodSync(join(bin, name!), 0o755);
  }
  writeFileSync(join(root, "stage", "reconcile.yaml"), "fixture\n");
  writeFileSync(join(home, "dags", "reconcile.yaml"), "fixture\n");
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, PRIMARY: root, STAGE: stage,
    DAGU_HOME: home, DAG_RUN_ID: "bootstrap-strict", NWO: "fixture/repo", BASE_BRANCH: "main",
    REQUIRED_CHECK: "validate", API_STATE: join(root, "api.json"),
    SKILL_DIR: fileURLToPath(new URL("../skills/dagu-feature", import.meta.url)),
    REPO: "fixture", GATE: "true", TEST_PATHS: "^test/", REBASE_RESOLVER: "",
    BUNDLE_NAME: "@a4s/omp-dagu", BUNDLE_VERSION: "0.3.104", DAGU_VERSION: "2.20.1",
    SOURCE_NWO: "owner/repo", SOURCE_SHA: "a".repeat(40),
  };
  const run = (id: string, strict: string) => spawnSync("bash", ["-c", bootstrapScript(id)], {
    encoding: "utf8", env: { ...env, REQUIRED_CHECK_STRICT: strict },
  });
  return { root, stage, env, run };
}

for (const strict of [false, true]) {
  test(`bootstrap stores and reads back the repository strict=${strict} declaration`, () => {
    const fixture = bootstrapFixture();
    try {
      const form = bootstrap.steps.find((step: { id: string }) => step.id === "answers").with.form;
      assert.ok(form.required.includes("REQUIRED_CHECK_STRICT"));
      assert.ok(form.properties.REQUIRED_CHECK_STRICT.enum.includes(String(strict)));
      const rendered = fixture.run("render", String(strict));
      assert.equal(rendered.status, 0, rendered.stdout + rendered.stderr);
      const policy = parse(readFileSync(fixture.stage, "utf8")).env;
      assert.equal(policy.find((entry: Record<string, string>) => "REQUIRED_CHECK_STRICT" in entry).REQUIRED_CHECK_STRICT, String(strict));
      const readDefault = bootstrapScript("detect").split("read_default() {")[1]!.split("read_stamp() {")[0]!;
      const readback = spawnSync("bash", ["-c", `read_default() {${readDefault}\nread_default "$1" REQUIRED_CHECK_STRICT`, "read-policy", fixture.stage], { encoding: "utf8" });
      assert.equal(readback.status, 0, readback.stderr);
      assert.equal(readback.stdout.trim(), String(strict));
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  for (const existing of ["unprotected", "with-checks", "without-checks"]) {
    test(`bootstrap applies and confirms strict=${strict} twice on ${existing} protection`, () => {
      const fixture = bootstrapFixture();
      try {
        const actors = { users: [{ login: "maintainer" }], teams: [{ slug: "owners" }], apps: [{ slug: "bot" }] };
        const before = existing === "unprotected" ? null : {
          required_status_checks: existing === "with-checks" ? { strict: !strict, contexts: ["lint", "build"] } : null,
          enforce_admins: { enabled: true },
          required_pull_request_reviews: {
            dismiss_stale_reviews: true, require_code_owner_reviews: true,
            required_approving_review_count: 2, require_last_push_approval: true,
            dismissal_restrictions: actors, bypass_pull_request_allowances: actors,
          },
          restrictions: actors,
          ...Object.fromEntries(protectionFlags.map((field, index) => [field, { enabled: index % 2 === 0 }])),
        };
        writeFileSync(fixture.env.API_STATE, JSON.stringify({ protection: before, requests: [] }));
        let first;
        for (let application = 0; application < 2; application++) {
          const applied = fixture.run("github", String(strict));
          assert.equal(applied.status, 0, applied.stdout + applied.stderr);
          const state = JSON.parse(readFileSync(fixture.env.API_STATE, "utf8"));
          assert.equal(state.protection.required_status_checks.strict, strict);
          assert.deepEqual(state.protection.required_status_checks.contexts.toSorted(),
            existing === "with-checks" ? ["build", "lint", "validate"] : ["validate"]);
          if (before) {
            const { required_status_checks: _, ...originalPolicy } = before;
            const { required_status_checks: __, ...observedPolicy } = state.protection;
            assert.deepEqual(observedPolicy, originalPolicy);
          }
          if (application === 0) first = state.protection;
          else assert.deepEqual(state.protection, first);
          assert.equal(state.requests.at(-1).payload.strict ?? state.requests.at(-1).payload.required_status_checks.strict, strict);
          const confirmed = fixture.run("confirm", String(strict));
          assert.equal(confirmed.status, 0, confirmed.stdout + confirmed.stderr);
          assert.ok(confirmed.stdout.includes(`required_check_strict_declared=${strict}\nrequired_check_strict_observed=${strict}\n`));
          const mismatched = fixture.run("confirm", String(!strict));
          assert.notEqual(mismatched.status, 0, "confirm must compare observed policy with declaration");
        }
      } finally { rmSync(fixture.root, { recursive: true, force: true }); }
    });
  }
}

test("adopted strict policy rejects feature run overrides before effects", () => {
  const admission = skill("feature.yaml").split("  - id: admission\n")[1]!.split("\n  - id: triage")[0]!;
  const script = admission.split("    run: |\n")[1]!.split("\n").map(line => line.slice(6)).join("\n");
  for (const strict of ["true", "false"]) {
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", env: {
      ...process.env, DAGU_PARAMS_JSON: JSON.stringify({ REQUIRED_CHECK_STRICT: strict }),
      PRIMARY: "/consumer", GATE: "true", REQUIRED_CHECK: "validate", BRANCH: "dagu/issue-358",
    } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /admission rejected run parameter: REQUIRED_CHECK_STRICT/);
  }
});

test("CLI admission enforces the repository strict declaration before publication", () => {
  const fixture = admissionFixture();
  try {
    for (const strict of ["true", "false"]) {
      const result = fixture.command("enqueue", `strict-override-${strict}`, {}, [`REQUIRED_CHECK_STRICT=${strict}`]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /admission rejected run parameter: REQUIRED_CHECK_STRICT/);
    }
  } finally { fixture.dispose(); }
});
