import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const definitions = [
  ["template", fileURLToPath(new URL("../skills/issue-execution/discovery.yaml", import.meta.url))],
] as const;


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
  return spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, DAGU_PARAMS_JSON: "{}", ...env } });
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
    PRIMARY: join(outDir, "primary"),
    RUN: "discovery-run",
    DAGU_OUTPUT_FILE: join(outDir, "outputs"),
    OMP_SESSION_ID: "session",
    NWO: "owner/repo",
  };
}

for (const [name, definition] of definitions) {

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

test("handoff stages all checked units for one planning run and saves lens history", () => {
  const root = mkdtempSync(join(tmpdir(), "discovery-handoff-"));
  const outDir = join(root, "run");
  try {
    const bin = join(root, "bin");
    const log = join(root, "enqueue.json");
    mkdirSync(bin);
    mkdirSync(outDir);
    mkdirSync(join(outDir, "primary"));
    execFileSync("git", ["init", "-q", join(outDir, "primary")]);
    writeFileSync(join(bin, "a4s"), `#!/bin/bash
set -euo pipefail
test "$1" = enqueue
jq -nc --args '$ARGS.positional' -- "$@" >> "$FAKE_DAGU_LOG"
`);
    chmodSync(join(bin, "a4s"), 0o755);
    const units = [
      { id: "unit-defect", title: "Defect", body: "## Problem\nDefect\n## Change\nFix\n## Acceptance\nWorks", classification: "defecto", findings: ["f1"] },
      { id: "unit-improvement", title: "Improvement", body: "## Problem\nSlow\n## Change\nImprove\n## Acceptance\nFast", classification: "mejora", findings: ["f2"] },
      { id: "unit-duplicate", title: "Duplicate", body: "## Problem\nRepeated\n## Change\nConsolidate\n## Acceptance\nShared", classification: "duplicado", findings: ["f3"] },
    ];
    jsonl(join(outDir, "units.jsonl"), units);
    jsonl(join(outDir, "findings-0.jsonl"), units.flatMap(unit => unit.findings.map(id => finding(id))));
    jsonl(join(outDir, "verdicts.jsonl"), units.flatMap(unit => unit.findings.map(id => ({
      finding: id, verdict: "confirmado", basis: "independent evidence", live: false,
    }))));
    jsonl(join(outDir, "temporal-0.jsonl"), [{ id: "f1", lens: "0", temporal: "nuevo" }]);
    const env: NodeJS.ProcessEnv = { ...baseEnv(outDir), A4S_BIN: join(bin, "a4s"), FAKE_DAGU_LOG: log, PATH: `${bin}:${process.env.PATH ?? ""}` };
    const checked = run(extractScript(definitions[0][1], "  - id: check_units"), env);
    assert.equal(checked.status, 0, checked.stderr);
    const result = run(extractScript(definitions[0][1], "  - id: handoff"), env);
    assert.equal(result.status, 0, result.stderr);
    const invocations = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    assert.equal(invocations.length, 1);
    const args = invocations[0]!;
    assert.deepEqual(args.slice(0, 6), [
      "enqueue", "--parent", join(outDir, "primary", ".git", "dagu-feature", "runs", "discovery-run", "receipt.json"),
      "--run-id", "breakdown-discovery-run",
      join(outDir, "primary", ".workspace", "dagu", "dags", "planning.yaml"),
    ]);
    assert.equal(args[6], "--");
    const params = Object.fromEntries(args.slice(7).map(arg => {
      const separator = arg.indexOf("=");
      return [arg.slice(0, separator), arg.slice(separator + 1)];
    }));
    assert.equal(isAbsolute(params.UNITS_FROM!), true);
    assert.equal(params.SOURCE, "discovery");
    assert.deepEqual(Object.keys(params).sort(), ["OMP_SESSION_ID", "SOURCE", "UNITS_FROM"]);
    assert.equal(params.OMP_SESSION_ID, "session");
    const staged = readFileSync(params.UNITS_FROM!, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(staged, units.map(({ classification, ...unit }) => ({
      ...unit, dag: "feature", labels: [classification], source: "discovery",
      body: `${unit.body}\n\n<!-- discovery-unit: ${unit.id} -->`,
    })));
    assert.equal(readFileSync(join(outDir, "breakdown-run-id"), "utf8"), "breakdown-discovery-run\n");
    assert.equal(readFileSync(env.DAGU_OUTPUT_FILE!, "utf8"), "BACKEND_RUN_ID=breakdown-discovery-run\n");
    for (const file of ["findings", "temporal"]) {
      assert.equal(
        readFileSync(join(root, "lenses", "0", `${file}.jsonl`), "utf8"),
        readFileSync(join(outDir, `${file}-0.jsonl`), "utf8"),
      );
    }
    jsonl(join(outDir, "units.jsonl"), []);
    jsonl(join(outDir, "verdicts.jsonl"), []);
    jsonl(join(outDir, "findings-0.jsonl"), []);
    jsonl(join(outDir, "temporal-0.jsonl"), [{ id: "f1", lens: "0", temporal: "resuelto" }]);
    writeFileSync(log, "");
    writeFileSync(env.DAGU_OUTPUT_FILE!, "");
    const noUnitsChecked = run(extractScript(definitions[0][1], "  - id: check_units"), env);
    assert.equal(noUnitsChecked.status, 0, noUnitsChecked.stderr);
    const noUnits = run(extractScript(definitions[0][1], "  - id: handoff"), env);
    assert.equal(noUnits.status, 0, noUnits.stderr);
    assert.match(noUnits.stdout, /outcome=no-units/);
    assert.equal(readFileSync(log, "utf8"), "");
    assert.equal(readFileSync(env.DAGU_OUTPUT_FILE!, "utf8"), "BACKEND_RUN_ID=\n");
    assert.equal(readFileSync(join(root, "lenses", "0", "findings.jsonl"), "utf8"), "");
    assert.deepEqual(JSON.parse(readFileSync(join(root, "lenses", "0", "temporal.jsonl"), "utf8")), {
      id: "f1", lens: "0", temporal: "resuelto",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
