import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { withResourceGuard } from "./resource-fixtures.ts";

for (const [name, definition] of [
  ["template", new URL("../skills/dagu-feature/poc.yaml", import.meta.url)],
  ["rendered DAG", new URL("../../../.workspace/dagu/dags/poc.yaml", import.meta.url)],
] as const) {
  test(`${name} PoC base accepts a symlinked primary and creates its worktree`, () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-dagu-poc-symlink-")));
    const primary = join(root, "primary-link");
    const actual = join(root, "primary");
    const remote = join(root, "remote.git");
    const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
    try {
      git("init", "--bare", "-b", "main", remote);
      git("init", "-b", "main", actual);
      symlinkSync(actual, primary, "dir");
      git("-C", primary, "config", "user.name", "PoC test");
      git("-C", primary, "config", "user.email", "poc@example.invalid");
      writeFileSync(join(primary, ".gitignore"), "/.workspace/\n");
      git("-C", primary, "add", ".");
      git("-C", primary, "commit", "-m", "seed");
      git("-C", primary, "remote", "add", "origin", remote);
      git("-C", primary, "push", "origin", "main");
      const state = join(primary, ".git", "poc", "runs", "symlink-test");
      mkdirSync(state, { recursive: true });
      const worktree = join(primary, ".workspace", "worktrees", "poc-symlink-test");
      const source = readFileSync(definition, "utf8").split("\n");
      const script = (id: string) => {
        const start = source.indexOf("    run: |", source.indexOf(`  - id: ${id}`)) + 1;
        assert.ok(start > 0);
        let end = start;
        while (end < source.length && (source[end]!.startsWith("      ") || source[end] === "")) end++;
        return withResourceGuard(source.slice(start, end).map(line => line.slice(6)).join("\n"), fileURLToPath(definition));
      };
      for (const id of ["base", "worktree"]) {
        const result = spawnSync("bash", ["-c", script(id)], {
          encoding: "utf8",
          env: { ...process.env, DAGU_PARAMS_JSON: "{}", PRIMARY: primary, WORKTREE: worktree, BASE_BRANCH: "main", RUN: "symlink-test", DAGU_FEATURE_BUNDLE: "test", DAGU_OUTPUT_FILE: join(root, "outputs") },
        });
        assert.equal(result.status, 0, `${id}\n${result.stdout}\n${result.stderr}`);
      }
      assert.ok(existsSync(worktree));
      assert.equal(git("-C", worktree, "branch", "--show-current"), "poc/symlink-test");
      assert.equal(readFileSync(join(state, "base.sha"), "utf8").trim(), git("-C", worktree, "rev-parse", "HEAD"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

