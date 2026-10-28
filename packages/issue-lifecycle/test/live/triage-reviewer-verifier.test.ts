import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { a4sBin } from "../fixtures/a4s.ts";
import { fixture } from "../fixtures/planning-triage.ts";
test("template verifies the exact role receipt before state or publication effects", () => {
  const f = fixture();
  try {
    const yaml = readFileSync(new URL("../../skills/issue-execution/feature.yaml", import.meta.url), "utf8");
    const step = yaml.split("  - id: triage_decision\n")[1]!.split("\n  - id: detect_start_primary\n")[0]!;
    const script = step.split("    run: |\n")[1]!.split("\n").map(line => line.startsWith("      ") ? line.slice(6) : line).join("\n");
    writeFileSync(f.transcript, "invalid transcript prefix\n");
    const triage = join(f.root, ".git", "dagu-feature", "runs", "fixture-run", "triage.md");
    writeFileSync(triage, "Retained prior triage evidence\n");
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", env: {
      ...process.env, A4S_BIN: a4sBin, PRIMARY: f.root, RUN: "fixture-run",
      REVIEW: f.id, POC: "no", QUESTION: "Already proven runtime?", BASIS: "PoC PASS",
    } });
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stdout.includes(`result.path=${f.path}\n`));
    assert.match(result.stderr, /transcript changed[\s\S]*VERIFIER=FAIL/);
    assert.equal(readFileSync(triage, "utf8"), "Retained prior triage evidence\n");
  } finally { f.cleanup(); }
});
