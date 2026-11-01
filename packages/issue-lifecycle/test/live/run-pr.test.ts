import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  test(`${name} PR discovery binds merged integration to the candidate and diagnoses refused PRs`, () => {
    const source = readFileSync(definition, "utf8");
    const resolver = source.slice(source.indexOf("      resolve_run_pr() {"), source.indexOf("steps:\n"));
    const root = mkdtempSync(join(tmpdir(), "run-pr-"));
    const candidate = "a".repeat(40);
    const row = (number: number, state: string, headRefOid = candidate) => ({
      number, state, headRefName: "dagu/issue-849", baseRefName: "main", headRefOid,
    });
    function resolve(rows: { number: number; state: string; headRefName: string; baseRefName: string; headRefOid: string }[], binding: "discovery" | "explicit" | "retained" = "discovery", integrated = false) {
      rmSync(join(root, "pr-number"), { force: true });
      rmSync(join(root, "integrated.json"), { force: true });
      writeFileSync(join(root, "candidate.json"), JSON.stringify({ sha: candidate }));
      if (binding === "retained") writeFileSync(join(root, "pr-number"), String(rows[0]!.number));
      return spawnSync("bash", ["-c", `
        set -euo pipefail
        git() { printf 'fixture/repo\\n'; }
        gh() { if [[ "$2" == view ]]; then printf '%s\\n' "$BOUND_PR"; else printf '%s\\n' "$ROWS"; fi; }
        ${resolver}
        resolve_run_pr
        ${integrated ? "integrated_terminal checkpoint_push" : ""}
        printf '%s\\n' "$RUN_PR"
      `], {
        encoding: "utf8",
        env: { ...process.env, PRIMARY: root, STATE: root, BRANCH: "dagu/issue-849",
          BASE_BRANCH: "main", RUN: "test-run", PR_NUMBER: binding === "explicit" ? String(rows[0]!.number) : "",
          ROWS: JSON.stringify(rows), BOUND_PR: JSON.stringify(rows[0]) },
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
      for (const binding of ["discovery", "explicit", "retained"] as const) {
        const merged = resolve([row(117, "MERGED", "b".repeat(40))], binding, true);
        assert.equal(merged.status, 0, merged.stderr);
        assert.equal(merged.stdout.trim(), "null");
        assert.match(merged.stderr, /ignoring MERGED PR #117.*head=b+ candidate=a+.*fresh PR/);
        assert.equal(existsSync(join(root, "pr-number")), false);
        assert.equal(existsSync(join(root, "integrated.json")), false);
        const resumed = resolve([row(118, "MERGED")], binding, true);
        assert.equal(resumed.status, 0, resumed.stderr);
        assert.match(resumed.stdout, /integrated: PR #118 already MERGED.*no publication/);
        const evidence = JSON.parse(readFileSync(join(root, "integrated.json"), "utf8"));
        assert.equal(evidence.headRefOid, candidate);
        assert.equal(evidence.candidate, candidate);
        const open = resolve([row(118, "OPEN", "b".repeat(40))], binding);
        assert.equal(open.status, 0, open.stderr);
        assert.equal(JSON.parse(open.stdout).number, 118, "OPEN PRs may still await the candidate push");
        if (binding !== "discovery") {
          const refused = resolve([row(117, "CLOSED")], binding);
          assert.equal(refused.status, 1);
          assert.match(refused.stderr, /refusing PR #117.*clear PR_NUMBER/);
          const mismatch = resolve([{ ...row(117, "MERGED", "b".repeat(40)), headRefName: "other-branch" }], binding);
          assert.equal(mismatch.status, 1);
          assert.match(mismatch.stderr, /refusing PR #117.*head=other-branch/);
          const replacement = resolve([row(117, "MERGED", "b".repeat(40)), row(118, "OPEN")], binding);
          assert.equal(replacement.status, 0, replacement.stderr);
          assert.equal(JSON.parse(replacement.stdout).number, 118);
        }
      }
      const preferred = resolve([row(118, "MERGED"), row(119, "OPEN")]);
      assert.equal(preferred.status, 0, preferred.stderr);
      assert.equal(JSON.parse(preferred.stdout).number, 119);
      for (const state of ["OPEN", "MERGED"]) {
        const ambiguous = resolve([row(118, state), row(119, state)]);
        assert.notEqual(ambiguous.status, 0);
        assert.match(ambiguous.stderr, /#118, #119/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
