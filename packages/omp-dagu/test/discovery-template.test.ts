import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const definitions = [
  ["template", fileURLToPath(new URL("../skills/dagu-feature/discovery.yaml", import.meta.url))],
  ["rendered DAG", fileURLToPath(new URL("../../../.workspace/dagu/dags/discovery.yaml", import.meta.url))],
] as const;

const orderedSteps = [
  "snapshot",
  "discover",
  "check_findings",
  "temporal",
  "validate",
  "check_verdicts",
  "consolidate",
  "check_units",
  "approve",
  "materialize",
  "dispose",
];

function extractScript(definition: string, marker: string): string {
  const lines = readFileSync(definition, "utf8").split("\n");
  const markerIndex = lines.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing ${marker} in ${definition}`);
  const runIndex = lines.indexOf("    run: |", markerIndex);
  assert.notEqual(runIndex, -1, `missing run block after ${marker}`);
  let end = runIndex + 1;
  while (end < lines.length && (lines[end]!.startsWith("      ") || lines[end] === "")) end++;
  return lines.slice(runIndex + 1, end).map((line) => line.slice(6)).join("\n");
}

function run(script: string, env: NodeJS.ProcessEnv) {
  return spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, ...env } });
}

function finding(id: string, lens = "0") {
  return {
    id,
    lens,
    unit: "unidad",
    location: "src/example.ts:1",
    criterion: "criterio",
    severity: "alta",
    evidence: "evidencia",
    reproduce: "reproducir",
    status: "verificado",
    verification: "verificación",
  };
}

function jsonl(path: string, values: unknown[]): void {
  writeFileSync(path, values.map((value) => JSON.stringify(value)).join("\n") + (values.length ? "\n" : ""));
}

function baseEnv(outDir: string): NodeJS.ProcessEnv {
  return {
    OUT_DIR: outDir,
    LENSES: "0",
    LIVE_TARGET: "",
    POLICY: "defecto",
    PRIMARY: join(outDir, "primary"),
    OMP_SESSION_ID: "session",
    NWO: "owner/repo",
  };
}

for (const [name, definition] of definitions) {
  test(`${name} declares the discovery contract graph`, () => {
    const yaml = readFileSync(definition, "utf8");
    assert.match(yaml, /^  - workspace=(?:TEMPLATE_REPO|a4s)$/m);
    if (name === "template") {
      assert.equal(yaml.split("\n", 1)[0], "# dagu-feature-bundle: __DAGU_FEATURE_STAMP__");
      assert.match(yaml, /^  - dagu-feature-bundle=TEMPLATE_DAGU_FEATURE_VERSION$/m);
    } else {
      const source = "pablontiv/a4s@fe5d444e9c9133d5bac3d2aeef054fee56d01fdb";
      assert.doesNotMatch(yaml, /__DAGU_FEATURE_|TEMPLATE_/);
      assert.equal(
        yaml.split("\n", 1)[0],
        `# dagu-feature-bundle: @a4s/omp-dagu@0.3.8 source=${source} bootstrap=bootstrap-a4s-v0-3-8 dagu=2.20.1`,
      );
      assert.match(yaml, /^  - dagu-feature-bundle=0\.3\.8$/m);
      assert.match(
        yaml,
        new RegExp(`- DAGU_FEATURE_BUNDLE: "dagu-feature-bundle=0\\.3\\.8 source=${source} bootstrap=bootstrap-a4s-v0-3-8"`),
      );
    }
    for (const param of ["LENSES", "POLICY", "SOURCE", "LIVE_TARGET", "PRIMARY", "OMP_SESSION_ID"])
      assert.match(yaml, new RegExp(`  - name: ${param}\\n`));
    const positions = orderedSteps.map((step) => yaml.indexOf(`  - id: ${step}\n`));
    assert.equal(positions.every((position) => position >= 0), true);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions);
    for (let index = 1; index < orderedSteps.length; index++) {
      const blockStart = positions[index]!;
      const next = positions[index + 1] ?? yaml.length;
      assert.match(yaml.slice(blockStart, next), new RegExp(`depends: ${orderedSteps[index - 1]}`));
    }
    assert.match(yaml, /- id: discover\n    depends: snapshot\n    action: human\.task/);
    assert.match(yaml, /- id: validate\n    depends: temporal\n    action: human\.task/);
    assert.match(yaml, /- id: consolidate\n    depends: check_verdicts\n    action: human\.task/);
    assert.match(yaml, /- id: approve[\s\S]*?action: human\.task[\s\S]*?APPROVED:[\s\S]*?push_back:\n        rewind_to: consolidate/);
  });

  test(`${name} findings validator fails closed and accepts valid JSONL`, () => {
    const root = mkdtempSync(join(tmpdir(), "discovery-findings-"));
    try {
      const script = extractScript(definition, "  - id: check_findings");
      const file = join(root, "findings-0.jsonl");
      const invalid = finding("finding-1") as Record<string, unknown>;
      delete invalid.id;
      jsonl(file, [invalid]);
      const rejected = run(script, baseEnv(root));
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /findings-0\.jsonl:1: rule=findings-schema/);
      jsonl(file, [finding("finding-1")]);
      const accepted = run(script, baseEnv(root));
      assert.equal(accepted.status, 0, accepted.stderr);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`${name} verdict and unit validators enforce finding lineage`, () => {
    const root = mkdtempSync(join(tmpdir(), "discovery-lineage-"));
    try {
      const verdictScript = extractScript(definition, "  - id: check_verdicts");
      const unitScript = extractScript(definition, "  - id: check_units");
      jsonl(join(root, "findings-0.jsonl"), [finding("finding-1")]);
      jsonl(join(root, "verdicts.jsonl"), [{ finding: "unknown", verdict: "confirmado", basis: "basis", live: false }]);
      const unknown = run(verdictScript, baseEnv(root));
      assert.notEqual(unknown.status, 0);
      assert.match(unknown.stderr, /verdicts\.jsonl:1: rule=unknown-finding/);

      jsonl(join(root, "verdicts.jsonl"), [{ finding: "finding-1", verdict: "confirmado", basis: "basis", live: false }]);
      const validVerdict = run(verdictScript, baseEnv(root));
      assert.equal(validVerdict.status, 0, validVerdict.stderr);
      jsonl(join(root, "units.jsonl"), [{ id: "unit-1", title: "Title", body: "Body", classification: "defecto", findings: [] }]);
      const noLineage = run(unitScript, baseEnv(root));
      assert.notEqual(noLineage.status, 0);
      assert.match(noLineage.stderr, /units\.jsonl:1: rule=units-schema-and-lineage/);
      jsonl(join(root, "units.jsonl"), [{ id: "unit-1", title: "Title", body: "Body", classification: "defecto", findings: ["finding-1"] }]);
      const validUnit = run(unitScript, baseEnv(root));
      assert.equal(validUnit.status, 0, validUnit.stderr);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`${name} temporal computes nuevo, persistente, resuelto and regresion`, () => {
    const root = mkdtempSync(join(tmpdir(), "discovery-temporal-"));
    try {
      jsonl(join(root, "findings-0.jsonl"), [finding("new"), finding("persistent"), finding("regression")]);
      jsonl(join(root, "prior-0.jsonl"), [finding("persistent"), finding("resolved")]);
      jsonl(join(root, "prior-temporal-0.jsonl"), [{ id: "regression", lens: "0", temporal: "resuelto" }]);
      const result = run(extractScript(definition, "  - id: temporal"), baseEnv(root));
      assert.equal(result.status, 0, result.stderr);
      const rows = readFileSync(join(root, "temporal-0.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(Object.fromEntries(rows.map((row) => [row.id, row.temporal])), {
        new: "nuevo",
        persistent: "persistente",
        regression: "regresion",
        resolved: "resuelto",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("materialize creates once and then reuses the discovery marker", () => {
  const root = mkdtempSync(join(tmpdir(), "discovery-materialize-"));
  try {
    const bin = join(root, "bin");
    const state = join(root, "gh-state");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), `#!/bin/bash
set -euo pipefail
if [[ "$1 $2" == "issue list" ]]; then
  if test -f "$FAKE_GH_STATE/body"; then
    jq -n --rawfile body "$FAKE_GH_STATE/body" '[{number:41,url:"https://example.test/owner/repo/issues/41",body:$body}]'
  else
    printf '[]\\n'
  fi
elif [[ "$1 $2" == "issue create" ]]; then
  while (($#)); do
    if [[ "$1" == --body-file ]]; then cp "$2" "$FAKE_GH_STATE/body"; shift 2; else shift; fi
  done
  count=0; test ! -f "$FAKE_GH_STATE/count" || count=$(cat "$FAKE_GH_STATE/count")
  printf '%s\\n' "$((count + 1))" > "$FAKE_GH_STATE/count"
  printf 'https://example.test/owner/repo/issues/41\\n'
else
  printf 'unexpected gh call: %s\\n' "$*" >&2; exit 1
fi
`);
    chmodSync(join(bin, "gh"), 0o755);
    mkdirSync(state);
    jsonl(join(root, "units.jsonl"), [{ id: "unit-stable", title: "Title", body: "Body", classification: "defecto", findings: ["finding-1"] }]);
    const env = { ...baseEnv(root), APPROVED: "all", FAKE_GH_STATE: state, PATH: `${bin}:${process.env.PATH ?? ""}` };
    const script = extractScript(definitions[0][1], "  - id: materialize");
    const first = run(script, env);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(readFileSync(join(root, "issues.jsonl"), "utf8")).reused, false);
    const second = run(script, env);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(readFileSync(join(root, "issues.jsonl"), "utf8")).reused, true);
    assert.equal(readFileSync(join(state, "count"), "utf8"), "1\n");
    assert.match(readFileSync(join(state, "body"), "utf8"), /<!-- discovery-unit: unit-stable -->/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispose skips existing run ids and enqueues eligible new issues", () => {
  const root = mkdtempSync(join(tmpdir(), "discovery-dispose-"));
  const outDir = join(root, "run");
  try {
    const bin = join(root, "bin");
    const log = join(root, "dagu.log");
    mkdirSync(bin);
    mkdirSync(outDir);
    mkdirSync(join(root, "primary", ".workspace", "dagu", "dags"), { recursive: true });
    writeFileSync(join(bin, "dagu"), `#!/bin/bash
set -euo pipefail
if [[ "$1" == status && "$*" == *"repo-issue-41"* ]]; then exit 0; fi
if [[ "$1" == status ]]; then exit 1; fi
if [[ "$1" == enqueue ]]; then printf '%s\\n' "$*" >> "$FAKE_DAGU_LOG"; exit 0; fi
exit 1
`);
    chmodSync(join(bin, "dagu"), 0o755);
    jsonl(join(outDir, "issues.jsonl"), [
      { unit: "unit-existing", number: 41, url: "https://example.test/41", reused: true },
      { unit: "unit-new", number: 42, url: "https://example.test/42", reused: false },
      { unit: "unit-improvement", number: 43, url: "https://example.test/43", reused: false },
    ]);
    jsonl(join(outDir, "units.jsonl"), [
      { id: "unit-existing", title: "Existing", body: "Body", classification: "defecto", findings: ["f1"] },
      { id: "unit-new", title: "New", body: "Body", classification: "defecto", findings: ["f2"] },
      { id: "unit-improvement", title: "Improvement", body: "Body", classification: "mejora", findings: ["f3"] },
    ]);
    jsonl(join(outDir, "findings-0.jsonl"), [finding("f1")]);
    jsonl(join(outDir, "temporal-0.jsonl"), [{ id: "f1", lens: "0", temporal: "nuevo" }]);
    const result = run(extractScript(definitions[0][1], "  - id: dispose"), {
      ...baseEnv(outDir),
      NWO: "owner/repo",
      FAKE_DAGU_LOG: log,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /exists=repo-issue-41 issue=41/);
    assert.match(result.stdout, /enqueued=repo-issue-42 issue=42/);
    assert.doesNotMatch(result.stdout, /43/);
    const invocation = readFileSync(log, "utf8");
    assert.match(invocation, /--run-id repo-issue-42/);
    assert.match(invocation, /ISSUE=42/);
    assert.match(invocation, /BRANCH=dagu\/issue-42/);
    assert.equal(readFileSync(join(root, "lenses", "0", "findings.jsonl"), "utf8"), readFileSync(join(outDir, "findings-0.jsonl"), "utf8"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
