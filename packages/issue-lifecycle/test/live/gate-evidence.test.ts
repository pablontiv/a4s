import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const helper = fileURLToPath(new URL("../../bin/dagu-gate.cjs", import.meta.url));

for (const entrypoint of ["postinstall", "npm"] as const) {
  test(`gate preload resolves ${entrypoint} like Node`, () => {
    const state = mkdtempSync(join(tmpdir(), "a4s-gate-preload-"));
    try {
      const script = join(state, entrypoint === "npm" ? "npm-cli.js" : "postinstall.js");
      writeFileSync(script, 'console.log("entrypoint completed");\n');
      if (entrypoint === "npm") symlinkSync(script, join(state, "npm"));
      const journal = join(state, "journal.jsonl");
      const result = spawnSync(process.execPath, ["--require", helper, join(state, entrypoint), "ci"], {
        env: { ...process.env, A4S_GATE_JOURNAL: journal }, encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(result.stdout, "entrypoint completed\n");
      if (entrypoint === "npm") {
        const [started, ended] = readFileSync(journal, "utf8").trim().split("\n").map(line => JSON.parse(line));
        assert.equal(started.name, "install");
        assert.equal(started.command, "npm ci");
        assert.equal(ended.id, started.id);
        assert.equal(ended.exitCode, 0);
      } else {
        assert.equal(existsSync(journal), false, "dependency scripts must not be classified as npm");
      }
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });
}

for (const scenario of [
  { name: "complete success", expected: "PASS" },
  { name: "unfinished command", unfinished: "command" },
  { name: "missing command", missing: "command" },
  { name: "failed command", failed: "command" },
  { name: "failed leaf masked by successful shell", failed: "tests" },
  { name: "unfinished leaf", unfinished: "tests" },
  { name: "missing post_checks", missing: "post_checks" },
  { name: "unfinished post_checks", unfinished: "post_checks" },
  { name: "failed post_checks", failed: "post_checks" },
  { name: "signalled shell with completed phases", code: "143" },
  { name: "absent shell exit code", code: "" },
]) {
  test(`gate finish fails closed: ${scenario.name}`, () => {
    const state = mkdtempSync(join(tmpdir(), "a4s-gate-evidence-"));
    try {
      writeFileSync(join(state, "candidate.json"), JSON.stringify({ sha: "a".repeat(40) }));
      const begin = spawnSync(process.execPath, [helper, "begin", state], { env: { ...process.env, GATE: "true" }, encoding: "utf8" });
      assert.equal(begin.status, 0, begin.stderr);
      const journal = begin.stdout.trim();
      const start = Date.now();
      const phases = ["lock_wait", "command", "tests", "post_checks"];
      for (const [index, name] of phases.entries()) {
        if (name === scenario.missing) continue;
        appendFileSync(journal, JSON.stringify({ id: name, name, startedAt: start + index * 2,
          ...(name === scenario.unfinished ? {} : { endedAt: start + index * 2 + 1, exitCode: name === scenario.failed ? 17 : 0 }),
        }) + "\n");
      }
      const finish = spawnSync(process.execPath, [helper, "finish", scenario.code ?? "0"], {
        env: { ...process.env, A4S_GATE_JOURNAL: journal }, encoding: "utf8",
      });
      const evidence = JSON.parse(readFileSync(join(state, "gate.json"), "utf8"));
      assert.equal(evidence.result, scenario.expected ?? "FAIL", finish.stdout + finish.stderr);
      assert.equal(evidence.attempts[0].result, evidence.result);
      assert.equal(finish.status === 0, evidence.result === "PASS");
      assert.equal(evidence.attempts[0].exitCode === 0, evidence.result === "PASS");
      if (scenario.unfinished) assert.notEqual(evidence.attempts[0].phases.find((phase: { name: string }) => phase.name === scenario.unfinished)?.exitCode, 0);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });
}
