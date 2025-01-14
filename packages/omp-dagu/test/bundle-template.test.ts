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

test("distributed promotions enqueue through the admission CLI", () => {
  for (const name of ["feature.yaml", "poc.yaml", "discovery.yaml", "planning.yaml"]) {
    assert.match(skill(name), /dagu-feature-bundle enqueue --run-id/);
    const adopted = readFileSync(fileURLToPath(new URL(`../../../.workspace/dagu/dags/${name}`, import.meta.url)), "utf8");
    assert.match(adopted, /dagu-feature-bundle enqueue --run-id/);
  }
  assert.match(skill("SKILL.md"), /DAGU_ADMISSION_REJECTED/);
  assert.match(skill("SKILL.md"), /deploymentFingerprint/);
});

test("feature render preserves the adopted configuration and matches its template", () => {
  const rendered = readFileSync(fileURLToPath(new URL("../../../.workspace/dagu/dags/feature.yaml", import.meta.url)), "utf8");
  const replacements: Record<string, string> = {
    __DAGU_FEATURE_STAMP__: rendered.split("\n")[0]!.slice("# dagu-feature-bundle: ".length),
    __DAGU_FEATURE_VERSION__: rendered.match(/  - dagu-feature-bundle=(.+)/)![1]!,
    __DAGU_FEATURE_IDENTITY__: rendered.match(/- DAGU_FEATURE_BUNDLE: "(.+)"/)![1]!,
    TEMPLATE_REPO: "a4s", TEMPLATE_BASE_BRANCH: '"main"',
    __GATE__: '"npm ci && npm test && npm run typecheck"',
    __REBASE_RESOLVER__: '"node packages/omp-dagu/bin/dagu-bundle-rebase.mjs"',
    __REQUIRED_CHECK__: '"validate"', __VALIDATION__: '""',
  };
  let expected = skill("feature.yaml");
  for (const [placeholder, value] of Object.entries(replacements)) expected = expected.replaceAll(placeholder, value);
  assert.equal(rendered, expected);
});

const daguAvailable = spawnSync("dagu", ["version"], { encoding: "utf8" });
test("bootstrap renders optional validation as the sole adopted value", {
  skip: daguAvailable.status !== 0 || !/2\.20\.1/.test(daguAvailable.stdout) ? "Dagu 2.20.1 binary required for live integration" : false,
}, () => {
  const bootstrap = skill("dagu-feature-bootstrap.yaml");
  assert.match(bootstrap, /VALIDATION:\n            type: string\n            default: ""/);
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
      assert.ok(output.includes(`default: ${JSON.stringify(validation)}\n    enum: [${JSON.stringify(validation)}]`));
      assert.ok(output.includes('default: "node packages/omp-dagu/bin/dagu-bundle-rebase.mjs"'));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
