import { liveDagu } from "./fixtures/live-dagu.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

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
          GATE: "true", REQUIRED_CHECK: "validate", TEST_PATHS: "^test/",
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
        GATE: "true", REQUIRED_CHECK: "validate", TEST_PATHS: "^test/", REBASE_RESOLVER: "",
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
