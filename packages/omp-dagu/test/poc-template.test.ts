import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { withResourceGuard } from "./resource-fixtures.ts";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

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
          env: { ...process.env, PRIMARY: primary, WORKTREE: worktree, BASE_BRANCH: "main", RUN: "symlink-test", DAGU_FEATURE_BUNDLE: "test", DAGU_OUTPUT_FILE: join(root, "outputs") },
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

test("real Dagu completes declined PoCs and preserves PASS publication", { timeout: 180_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-dagu-poc-decline-")));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(join(home, "dags"), { recursive: true });
  mkdirSync(bin);
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const env = { ...process.env, DAGU_HOME: home, DAGU_HOST: "127.0.0.1", DAGU_PORT: String(port), DAGU_COORDINATOR_ENABLED: "false", PATH: `${bin}:${process.env.PATH}`, COMMENTS: join(root, "comments") };
  const command = (exe: string, args: string[], cwd = root) => execFileSync(exe, args, { cwd, env, encoding: "utf8" }).trim();
  const git = (...args: string[]) => command("git", args);
  const dagu = (...args: string[]) => command("dagu", args);
  writeFileSync(join(bin, "gh"), `#!/bin/bash
set -eu
COMMENTS='${env.COMMENTS}'
case "$1 $2" in
  "repo view") echo owner/repo ;;
  "issue view") echo '{"body":"question"}' ;;
  "issue comment")
    shift 2
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --body) printf '%s\\n' "$2" >> "$COMMENTS"; shift 2 ;;
        --body-file) cat "$2" >> "$COMMENTS"; shift 2 ;;
        *) shift ;;
      esac
    done
    echo https://example.invalid/comment/1 ;;
  "issue edit") ;;
  *) echo "unexpected gh: $*" >&2; exit 1 ;;
esac
`);
  chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\n`);
  let logs = "";
  const service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(port)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  service.stdout.on("data", data => { logs += data; });
  service.stderr.on("data", data => { logs += data; });
  const api = `http://127.0.0.1:${port}/api/v1`;
  type Detail = { statusLabel: string; nodes: Array<{ statusLabel: string; stderr?: string; step: { name: string } }> };
  async function until<T>(probe: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const result = await probe();
      if (result !== undefined) return result;
      await delay(150);
    }
    throw new Error(`Dagu timeout\n${logs}`);
  }
  async function state(id: string, step?: string): Promise<Detail> {
    return until(async () => {
      const response = await fetch(`${api}/dag-runs/poc/${id}`);
      if (!response.ok) return;
      const run = (await response.json() as { dagRunDetails: Detail }).dagRunDetails;
      assert.notEqual(run.statusLabel, "failed", JSON.stringify(run.nodes.map(n => [n.step.name, n.statusLabel, n.stderr && readFileSync(n.stderr, "utf8")])));
      if (step ? run.nodes.some(n => n.step.name === step && n.statusLabel === "waiting") : run.statusLabel === "succeeded") return run;
    });
  }
  try {
    await until(async () => { try { return (await fetch(`${api}/dag-runs`)).ok ? true : undefined; } catch { return; } });
    const primary = join(root, "primary");
    git("init", "--bare", "-b", "main", join(root, "remote.git"));
    git("init", "-b", "main", primary);
    git("-C", primary, "config", "user.name", "PoC test");
    git("-C", primary, "config", "user.email", "poc@example.invalid");
    writeFileSync(join(primary, ".gitignore"), "/.workspace/\n");
    git("-C", primary, "add", ".");
    git("-C", primary, "commit", "-m", "seed");
    git("-C", primary, "remote", "add", "origin", join(root, "remote.git"));
    git("-C", primary, "push", "origin", "main");
    const definition = join(home, "dags", "poc.yaml");
    writeFileSync(definition, readFileSync(new URL("../skills/dagu-feature/poc.yaml", import.meta.url), "utf8")
      .replaceAll("__DAGU_FEATURE_VERSION__", "0.3.11")
      .replaceAll("TEMPLATE_REPO", "decline263").replaceAll("TEMPLATE_BASE_BRANCH", "main")
      .replaceAll("__PRIMARY__", primary).replaceAll("__TEST_PATHS__", "_test$"));
    for (const mode of ["decline", "pass"]) {
      writeFileSync(env.COMMENTS, "");
      const id = `test-${mode}-${randomUUID()}`;
      dagu("enqueue", "--run-id", id, definition, "--", "ISSUE=263", "QUESTION=question", `PRIMARY=${primary}`);
      await state(id, "run_poc");
      const worktree = join(primary, ".workspace", "worktrees", `poc-${id}`);
      if (mode === "decline") {
        dagu("human-task", "complete", "poc", "--run-id", id, "--step", "run_poc", "--input", "decline=no longer needed");
      } else {
        const result = git("-C", worktree, "rev-parse", "--path-format=absolute", "--git-path", "poc/result.md");
        writeFileSync(result, "VERDICT: PASS\n## Pregunta\nquestion\n## Proposición demostrada\nobserved\n## Ruta ejercitada\nreal isolated Dagu\n## Comandos y salida\ndagu version succeeded\n## Después del PASS\nmaintain behavior\n");
        dagu("human-task", "complete", "poc", "--run-id", id, "--step", "run_poc");
        await state(id, "decide");
        dagu("human-task", "complete", "poc", "--run-id", id, "--step", "decide", "--input", "promote=no");
      }
      const run = await state(id);
      await until(async () => !existsSync(worktree) ? true : undefined);
      assert.equal(spawnSync("git", ["-C", primary, "show-ref", "--verify", "--quiet", `refs/heads/poc/${id}`]).status, 1);
      const comments = readFileSync(env.COMMENTS, "utf8");
      if (mode === "decline") {
        assert.equal(comments, "PoC declined by operator: no longer needed\n");
        for (const name of ["scope_gate", "publish", "decide", "dispose"]) {
          assert.equal(run.nodes.find(n => n.step.name === name)?.statusLabel, "skipped", name);
        }
      } else {
        assert.match(comments, /^<!-- poc-verdict:PASS scope:OK /);
        assert.equal(run.nodes.find(n => n.step.name === "publish")?.statusLabel, "succeeded");
      }
      const feature = await fetch(`${api}/dag-runs/feature/feature-${id}`);
      assert.equal(feature.status, 404);
    }
  } finally {
    service.kill("SIGTERM");
    await new Promise<void>(resolve => service.once("exit", () => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
