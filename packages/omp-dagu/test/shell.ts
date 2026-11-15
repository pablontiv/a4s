import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";

export function runBash(script: string, options: SpawnSyncOptionsWithStringEncoding) {
  // NixOS system startup files can replace PATH and bypass fixture executables.
  return spawnSync("bash", ["--noprofile", "--norc", "-c", script], options);
}

export function extractScript(definition: string, marker: string): string {
  const lines = readFileSync(definition, "utf8").split("\n");
  const markerIndex = lines.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing ${marker} in ${definition}`);
  const runIndex = lines.indexOf("    run: |", markerIndex);
  assert.notEqual(runIndex, -1, `missing run block after ${marker}`);
  let end = runIndex + 1;
  while (end < lines.length && (lines[end]!.startsWith("      ") || lines[end] === "")) end++;
  return lines.slice(runIndex + 1, end).map((line) => line.slice(6)).join("\n");
}

// Keep shell-guard tests portable; the pinned Dagu integration tests exercise native execution.
export function featureCloseScript(definition: string): string {
  assert.match(readFileSync(definition, "utf8"), /action: git\.worktree\.remove\n    with:\n      path: \$\{steps\.prepare_close_gate\.outputs\.worktree\}\n      branch: \$\{BRANCH\}\n      delete_branch: true\n      force_delete_branch: true/);
  return [
    extractScript(definition, "  - id: prepare_close_gate"),
    'git -C "$PRIMARY" worktree remove "$worktree_real"',
    'git -C "$PRIMARY" branch -D "$BRANCH"',
    extractScript(definition, "  - id: finish_close_gate"),
  ].join("\n");
}

export function pocCleanupScript(definition: string): string {
  assert.match(readFileSync(definition, "utf8"), /action: git\.worktree\.remove\n    with:\n      path: \$\{steps\.prepare_cleanup\.outputs\.worktree\}\n      branch: poc\/\$\{RUN\}\n      delete_branch: true\n      force_delete_branch: true/);
  return [
    extractScript(definition, "  - id: prepare_cleanup"),
    'git -C "$PRIMARY" worktree remove "$WT_REAL"',
    'git -C "$PRIMARY" branch -D "poc/$RUN"',
    extractScript(definition, "  - id: verify_cleanup"),
  ].join("\n");
}
