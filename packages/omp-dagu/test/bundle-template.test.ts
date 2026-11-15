import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const skill = (name: string): string => readFileSync(
  fileURLToPath(new URL(`../skills/dagu-feature/${name}`, import.meta.url)),
  "utf8",
);

test("all distributed DAG templates carry bundle stamp and label placeholders", () => {
  for (const name of ["feature.yaml", "poc.yaml", "reconcile.yaml"]) {
    const contents = skill(name);
    assert.equal(contents.split("\n", 1)[0], "# dagu-feature-bundle: __DAGU_FEATURE_STAMP__", name);
    assert.match(contents, /^  - dagu-feature-bundle=__DAGU_FEATURE_VERSION__$/m, name);
  }
});

test("feature and PoC identity steps print the rendered bundle identity", () => {
  const feature = skill("feature.yaml");
  const poc = skill("poc.yaml");
  assert.match(feature, /- DAGU_FEATURE_BUNDLE: "__DAGU_FEATURE_IDENTITY__"/);
  assert.match(feature, /- id: start_gate[\s\S]*?printf '%s\\n' "\$DAGU_FEATURE_BUNDLE"/);
  assert.match(poc, /- DAGU_FEATURE_BUNDLE: "__DAGU_FEATURE_IDENTITY__"/);
  assert.match(poc, /- id: base[\s\S]*?printf '%s\\n' "\$DAGU_FEATURE_BUNDLE"/);
});

test("bootstrap detects source compatibility and renders and confirms all stamps", () => {
  const bootstrap = skill("dagu-feature-bootstrap.yaml");
  assert.match(bootstrap, /git -C "\$source_root" status --porcelain --untracked-files=all/);
  assert.match(bootstrap, /git -C "\$source_root" merge-base --is-ancestor "\$source_sha" "\$source_default"/);
  assert.match(bootstrap, /cmp "\$version_tmp\/expected" "\$version_tmp\/stdout"/);
  assert.match(bootstrap, /CURRENT_FEATURE_STAMP/);
  assert.match(bootstrap, /CURRENT_POC_STAMP/);
  assert.match(bootstrap, /\$SKILL_DIR\/reconcile\.yaml/);
  assert.match(bootstrap, /Dagu-Feature-Bundle: %s/);
  assert.match(bootstrap, /Dagu-Feature-Source: %s@%s/);
  assert.match(bootstrap, /Dagu-Feature-Bootstrap: %s/);
});


test("a4s stamped DAGs are exact template renders", () => {
  for (const name of ["feature.yaml", "poc.yaml", "reconcile.yaml"]) {
    const stamped = readFileSync(fileURLToPath(new URL(`../../../.workspace/dagu/dags/${name}`, import.meta.url)), "utf8");
    const replacements: Record<string, string> = {
      __DAGU_FEATURE_STAMP__: stamped.split("\n", 1)[0]!.slice("# dagu-feature-bundle: ".length),
      __DAGU_FEATURE_VERSION__: "0.2.0",
      __DAGU_FEATURE_IDENTITY__: stamped.match(/DAGU_FEATURE_BUNDLE: "([^"]+)"/)?.[1] ?? "",
      TEMPLATE_REPO: "a4s",
      TEMPLATE_BASE_BRANCH: JSON.stringify("dagu-14steps"),
      __GATE__: JSON.stringify("bash scripts/gate.sh"),
      __REQUIRED_CHECK__: JSON.stringify("validate"),
      __PRIMARY__: JSON.stringify("/home/shared/harness/a4s"),
      __TEST_PATHS__: JSON.stringify("(^|/)(test|tests)/|\\.test\\.(ts|cjs)$"),
    };
    let rendered = skill(name);
    for (const [placeholder, value] of Object.entries(replacements)) rendered = rendered.replaceAll(placeholder, value);
    assert.equal(rendered.trimEnd(), stamped.trimEnd(), name);
  }
});
