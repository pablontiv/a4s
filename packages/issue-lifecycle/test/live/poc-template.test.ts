import { renderedPoc } from "../fixtures/rendered-feature.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { testRunId } from "../fixtures/run-id.ts";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { liveDagu } from "../fixtures/live-dagu.ts";
import { PocDiagnostics } from "../fixtures/poc-diagnostics.ts";
import { BUNDLE_VERSION } from "../../src/bundle.ts";

for (const definition of [
  new URL("../../skills/issue-execution/poc.yaml", import.meta.url),
  new URL(renderedPoc, import.meta.url),
]) {
  test(`${definition.pathname} scope failure rewinds and corrected result publishes in real Dagu`, {
    ...liveDagu,
    timeout: 120_000,
  }, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-dagu-scope-")));
    const id = testRunId("scope-test");
    const home = join(root, "home");
    const primary = join(root, "repo");
    const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
    mkdirSync(join(home, "dags"), { recursive: true });
    git("init", "-b", "main", primary);
    git("-C", primary, "config", "user.name", "test");
    git("-C", primary, "config", "user.email", "test@example.invalid");
    git("-C", primary, "commit", "--allow-empty", "-m", "seed");
    git("init", "--bare", "-b", "main", join(root, "remote.git"));
    git("-C", primary, "remote", "add", "origin", join(root, "remote.git"));
    const state = join(primary, ".git", "poc", "runs", id);
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "base.sha"), git("-C", primary, "rev-parse", "HEAD"));
    writeFileSync(join(state, "question.txt"), "exact question");
    writeFileSync(join(state, "repo"), "test/repo");
    writeFileSync(join(state, "issue.number"), "266");
    const resultPath = join(state, "input.md");
    writeFileSync(join(state, "result.path"), resultPath);
    const result = (question: string) => `VERDICT: PASS\n## Pregunta\n${question}\n## Proposición demostrada\nobserved\n## Ruta ejercitada\nreal Dagu\n## Comandos y salida\noutput\n## Después del PASS\nmaintained result\n`;
    writeFileSync(resultPath, result("wrong question"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    symlinkSync(fileURLToPath(new URL("../../bin/dagu-pr-body.mjs", import.meta.url)), join(bin, "dagu-pr-body"));
    writeFileSync(join(bin, "gh"), `#!/bin/sh\ncase "$*" in\n  "issue view "*) printf '{"body":"original scope"}\\n' ;;\n  *) printf 'https://example.invalid/comment\\n' ;;\nesac\n`, { mode: 0o755 });
    const listener = createServer();
    await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>(resolve => listener.close(() => resolve()));
    const env = { ...process.env, DAGU_PARAMS_JSON: "{}", DAGU_HOME: home, DAGU_COORDINATOR_ENABLED: "false", PATH: `${bin}:${process.env.PATH}` };
    writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\n`);
    const source = readFileSync(definition, "utf8");
    const step = (id: string): string => {
      const start = source.indexOf(`  - id: ${id}\n`);
      const end = source.indexOf("\n  - id:", start + 1);
      let result = source.slice(start, end).split("\nhandler_on:")[0] + "\n";
      if (result.includes("    run: *cancellation_gate")) {
        result = result.replace("    run: *cancellation_gate", source.match(/    run: &cancellation_gate \|[\s\S]*?(?=\n  - id:)/)![0]!.replace(" &cancellation_gate", ""));
      }
      result = result.replace("    run: &cancellation_gate", "    run:");
      if (result.includes("    action: human.task") && source.includes(`  - id: ${id}_cancellation\n`)) result += step(`${id}_cancellation`);
      return result;
    };
    // Exercise production scope, publication and wait dispatcher against a seeded repository.
    const sections = source.match(/cat > "\$STATE\/sections.jq" <<'JQ'\n([\s\S]*?)\n      JQ/);
    assert.ok(sections, "sections module");
    writeFileSync(join(state, "sections.jq"), sections[1]!.split("\n").map(line => line.slice(6)).join("\n"));
    const wait = source.slice(source.indexOf("  wait:\n"), source.indexOf("  failure:\n"));
    writeFileSync(join(home, "dags", "poc.yaml"), [
      "type: graph\nshell: bash\n",
      `env:\n  - PRIMARY: ${primary}\n  - WORKTREE: ${primary}\n  - RUN: ${id}\n  - TEST_PATHS: '^tests/'\n`,
      "steps:\n", step("run_poc").replace("    depends: worktree\n", "").replaceAll("${steps.record.outputs.question}", "exact question").replaceAll("${steps.worktree.outputs.resultpath}", resultPath),
      step("scope_gate"), step("fix_result"), step("publish"), "handler_on:\n", wait,
    ].join(""));
    const diagnostics = new PocDiagnostics();
    const service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
    diagnostics.capture(service);
    const api = `http://127.0.0.1:${port}/api/v1`;
    const dagu = (...args: string[]) => execFileSync("dagu", args, { env, encoding: "utf8" });
    async function until(probe: () => Promise<boolean>) {
      for (let n = 0; n < 400; n++) {
        if (await probe()) return;
        await delay(150);
      }
      throw new Error("Dagu timeout");
    }
    async function waiting(iteration: number) {
      await until(async () => {
        const run = await diagnostics.runDetails<{ statusLabel: string; nodes: Array<{ step: { name: string }; statusLabel: string; approvalIteration?: number }> }>(`${api}/dag-runs/poc/${id}`, true);
        if (!run) return false;
        assert.notEqual(run.statusLabel, "failed", JSON.stringify(run));
        return run.statusLabel === "waiting" && run.nodes.some(node => node.step.name === "run_poc" && node.statusLabel === "waiting" && (node.approvalIteration ?? 0) === iteration);
      });
    }
    let failed = false;
    let failure: unknown;
    try {
      await until(async () => { try { return (await diagnostics.fetch(`${api}/dag-runs`)).ok; } catch { return false; } });
      dagu("enqueue", "--run-id", id, join(home, "dags", "poc.yaml"));
      await waiting(0);
      dagu("human-task", "complete", "poc", "--run-id", id, "--step", "run_poc");
      await waiting(1);
      assert.equal(readFileSync(join(state, "scope-errors"), "utf8").trim(), '## Pregunta differs from QUESTION (normalized): result="wrong question" QUESTION="exact question"');
      const stderrLogs = readdirSync(join(home, "logs"), { recursive: true })
        .filter((path): path is string => typeof path === "string" && path.endsWith(".err"));
      assert.ok(stderrLogs.some(path => readFileSync(join(home, "logs", path), "utf8")
        .includes("## Pregunta differs from QUESTION (normalized)")), "scope diagnostic was emitted on stderr");
      writeFileSync(resultPath, result("exact question"));
      dagu("human-task", "complete", "poc", "--run-id", id, "--step", "run_poc");
      await until(async () => {
        const run = (await diagnostics.runDetails(`${api}/dag-runs/poc/${id}`))!;
        assert.notEqual(run.statusLabel, "failed");
        return run.statusLabel === "succeeded";
      });
      assert.equal(readFileSync(join(state, "scope"), "utf8").trim(), "OK");
      assert.ok(readFileSync(join(state, "comment-2.txt"), "utf8").includes("scope:OK"));
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    } finally {
      await diagnostics.finish(service, root, home, failure, failed);
    }
  });
}

test("real Dagu completes declined PoCs and preserves PASS publication", { ...liveDagu, timeout: 180_000 }, async () => {
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
  "issue view") echo '{"body":"## PoC\\nFallback question\\nwith a second line\\n\\n## Other\\nignored"}' ;;
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
  const diagnostics = new PocDiagnostics();
  const service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(port)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  diagnostics.capture(service);
  const api = `http://127.0.0.1:${port}/api/v1`;
  type Detail = { statusLabel: string; nodes: Array<{ statusLabel: string; stderr?: string; step: { name: string; humanTask?: { prompt?: string } } }> };
  async function until<T>(probe: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const result = await probe();
      if (result !== undefined) return result;
      await delay(150);
    }
    throw new Error("Dagu timeout");
  }
  async function state(id: string, step?: string): Promise<Detail> {
    return until(async () => {
      const run = await diagnostics.runDetails<Detail>(`${api}/dag-runs/poc/${id}`, true);
      if (!run) return;
      if (run.statusLabel === "failed") {
        assert.fail(JSON.stringify(run.nodes.filter(n => n.statusLabel === "failed")
          .map(n => [n.step.name, n.stderr && existsSync(n.stderr) ? readFileSync(n.stderr, "utf8") : n.stderr])));
      }
      if (step ? run.statusLabel === "waiting" && run.nodes.some(n => n.step.name === step && n.statusLabel === "waiting") : run.statusLabel === "succeeded") return run;
    });
  }
  let failed = false;
  let failure: unknown;
  try {
    await until(async () => { try { return (await diagnostics.fetch(`${api}/dag-runs`)).ok ? true : undefined; } catch { return; } });
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
    writeFileSync(definition, readFileSync(new URL("../../skills/issue-execution/poc.yaml", import.meta.url), "utf8")
      .replaceAll("__DAGU_FEATURE_VERSION__", BUNDLE_VERSION)
      .replaceAll("TEMPLATE_REPO", "decline263").replaceAll("TEMPLATE_BASE_BRANCH", "main")
      .replaceAll("__PRIMARY__", primary).replaceAll("__TEST_PATHS__", "_test$")
      .replaceAll("__ESCALATION_POC_INCONCLUSIVE__", '"2"'));
    for (const mode of ["decline", "pass"]) {
      writeFileSync(env.COMMENTS, "");
      const id = testRunId(`test-${mode}`);
      const question = "Explicit question\nwith a second line";
      dagu("enqueue", "--run-id", id, definition, "--", "ISSUE=263", `QUESTION=${question}`,
        'REQUIRED_TARGETS=["local"]', 'AUTHORIZED_TARGETS=["local"]', "SCOPE_BASIS=isolated local fixture");
      const waiting = await state(id, "run_poc");
      const prompt = waiting.nodes.find(n => n.step.name === "run_poc")?.step.humanTask?.prompt;
      const runState = join(primary, ".git", "poc", "runs", id);
      const resolved = readFileSync(join(runState, "question.txt"), "utf8").trimEnd();
      const resultPath = readFileSync(join(runState, "result.path"), "utf8").trim();
      assert.equal(resolved, question);
      assert.ok(prompt?.includes(resolved), JSON.stringify(waiting));
      assert.ok(prompt?.includes(resultPath), JSON.stringify(waiting));
      const worktree = join(primary, ".workspace", "worktrees", `poc-${id}`);
      if (mode === "decline") {
        dagu("human-task", "complete", "poc", "--run-id", id, "--step", "run_poc", "--input", "decline=no longer needed");
      } else {
        const result = git("-C", worktree, "rev-parse", "--path-format=absolute", "--git-path", "poc/result.md");
        writeFileSync(result, `VERDICT: PASS\n## Pregunta\n${question}\n## Proposición demostrada\nobserved\n## Ruta ejercitada\nreal isolated Dagu\n## Comandos y salida\ndagu version succeeded\n## Después del PASS\nmaintain behavior\n`);
        dagu("human-task", "complete", "poc", "--run-id", id, "--step", "run_poc");
        await state(id, "decide");
        assert.equal(readFileSync(join(runState, "attempt"), "utf8").trim(), "1");
        assert.equal(readFileSync(join(runState, "scope"), "utf8").trim(), "OK");
        dagu("human-task", "complete", "poc", "--run-id", id, "--step", "decide", "--input", "promote=no");
      }
      const run = await state(id);
      await until(async () => !existsSync(worktree) ? true : undefined);
      assert.equal(spawnSync("git", ["-C", primary, "show-ref", "--verify", "--quiet", `refs/heads/poc/${id}`]).status, 1);
      const comments = readFileSync(env.COMMENTS, "utf8");
      if (mode === "decline") {
        assert.equal(comments, "PoC declined by operator: no longer needed\n");
        for (const name of ["scope_gate", "fix_result", "publish", "decide", "dispose"]) {
          assert.equal(run.nodes.find(n => n.step.name === name)?.statusLabel, "skipped", name);
        }
      } else {
        assert.match(comments, /^<!-- poc-verdict:PASS scope:OK /);
        assert.equal(run.nodes.find(n => n.step.name === "publish")?.statusLabel, "succeeded");
      }
      const feature = await diagnostics.fetch(`${api}/dag-runs/feature/feature-${id}`);
      assert.equal(feature.status, 404);
    }
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    await diagnostics.finish(service, root, home, failure, failed);
  }
});
