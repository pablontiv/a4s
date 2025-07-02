import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderedFeature } from "../fixtures/templates-rendered.ts";

const definitions = [
  ["template", fileURLToPath(new URL("../../skills/issue-execution/feature.yaml", import.meta.url))],
  ["rendered fixture", renderedFeature],
] as const;

for (const [name, definition] of definitions) {
  test(`${name} PR discovery ignores closed history and diagnoses refused PRs`, () => {
    const source = readFileSync(definition, "utf8");
    const resolver = source.slice(source.indexOf("      resolve_run_pr() {"), source.indexOf("      integrated_terminal() {"));
    const root = mkdtempSync(join(tmpdir(), "run-pr-"));
    const row = (number: number, state: string) => ({
      number, state, headRefName: "dagu/issue-849", baseRefName: "main",
    });
    function resolve(rows: { number: number; state: string; headRefName: string; baseRefName: string }[], explicit = "") {
      rmSync(join(root, "pr-number"), { force: true });
      return spawnSync("bash", ["-c", `
        set -euo pipefail
        git() { printf 'fixture/repo\\n'; }
        gh() { printf '%s\\n' "$ROWS"; }
        ${resolver}
        resolve_run_pr
        printf '%s\\n' "$RUN_PR"
      `], {
        encoding: "utf8",
        env: { ...process.env, PRIMARY: root, STATE: root, BRANCH: "dagu/issue-849",
          BASE_BRANCH: "main", PR_NUMBER: explicit,
          ROWS: JSON.stringify(explicit ? rows[0] : rows) },
      });
    }
    try {
      const closed = resolve([row(117, "CLOSED")]);
      assert.equal(closed.status, 0, closed.stderr);
      assert.equal(closed.stdout.trim(), "null");
      assert.match(closed.stderr, /ignoring CLOSED PR #117.*fresh PR/);
      for (const state of ["OPEN", "MERGED"]) {
        const selected = resolve([row(117, "CLOSED"), row(118, state)]);
        assert.equal(selected.status, 0, selected.stderr);
        assert.equal(JSON.parse(selected.stdout).number, 118);
        assert.equal(readFileSync(join(root, "pr-number"), "utf8").trim(), "118");
      }
      const refused = resolve([row(117, "CLOSED")], "117");
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /refusing PR #117.*clear PR_NUMBER/);
      const ambiguous = resolve([row(118, "MERGED"), row(119, "MERGED")]);
      assert.notEqual(ambiguous.status, 0);
      assert.match(ambiguous.stderr, /#118, #119/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
