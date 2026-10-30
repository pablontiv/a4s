import { stationEnvironment } from "../fixtures/service-environment.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { liveDagu, liveDaguVersion } from "../fixtures/live-dagu.ts";

function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(root, e.name)) : [join(root, e.name)]);
}

// The production step uses 30 seconds; the runtime-contract experiment uses three
// to prove fresh budgets without slowing the explicitly opted-in lane further.
const cases = [
  ...Array.from({ length: 13 }, (_, i) => ({ name: `current-${i + 1}`, current: i + 1, mode: "normal" })),
  { name: "exhaustion", current: 99, mode: "normal" },
  { name: "auth", current: 99, mode: "auth" },
  { name: "hang", current: 99, mode: "hang" },
  { name: "delayed-current", current: 2, mode: "delay" },
  { name: "delayed-hang", current: 99, mode: "delayed-hang" },
];

test("native PR observation contract (pinned Dagu, isolated and mutation-free)", { ...liveDagu, concurrency: true }, async t => {
  assert.equal(liveDaguVersion, "2.24.0", "Re-establish the bounded runtime contract before changing the pinned runtime");
  await Promise.all(cases.map(async scenario => {
    await t.test(scenario.name, async () => {
      const home = mkdtempSync(join(tmpdir(), "a4s-native-observation-"));
      let passed = false;
      try {
        const bin = join(home, "bin"); mkdirSync(bin);
        const candidate = "a".repeat(40), old = "b".repeat(40);
        const events = join(home, "events.jsonl"), downstream = join(home, "downstream");
        const stub = `#!${process.execPath}
const fs = require('node:fs');
const countFile = ${JSON.stringify(join(home, "count"))};
let n = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile)) + 1 : 1;
fs.writeFileSync(countFile, String(n));
const record = kind => { const line = JSON.stringify({kind, n, time: Date.now()}); fs.appendFileSync(${JSON.stringify(events)}, line+'\\n'); console.error('GH_READ_'+kind+' '+line); };
if (process.argv.slice(2).join(' ') !== 'pr view poc --json headRefOid --jq .headRefOid') process.exit(2);
record('BEGIN');
const mode = ${JSON.stringify(scenario.mode)};
const finish = () => { record('END'); if (mode === 'auth') { console.error('GraphQL: Resource not accessible by integration (HTTP 403)'); process.exit(4); } console.log(n >= ${scenario.current} ? '${candidate}' : '${old}'); };
if (mode === 'hang' || (mode === 'delayed-hang' && n > 1)) setTimeout(finish, 600000);
else if (mode === 'delay' || mode === 'delayed-hang') setTimeout(finish, 2000);
else finish();
`;
        writeFileSync(join(bin, "gh"), stub); chmodSync(join(bin, "gh"), 0o755);
        const definition = `name: observation-${scenario.name}
type: graph
shell: bash
env:
  - PATH: ${JSON.stringify(`${bin}:${process.env.PATH}`)}
steps:
  - id: pr_head_ready
    timeout_sec: 3
    retry_policy:
      limit: 12
      interval_sec: 5
      exit_code: [75]
    run: |
      set -euo pipefail
      status=0
      observed=$(gh pr view poc --json headRefOid --jq .headRefOid) || status=$?
      if [[ "$status" != 0 ]]; then
        printf 'rule=pr_head_ready.read status=%s\\n' "$status" >&2
        exit 1
      fi
      if [[ "$observed" != ${candidate} ]]; then
        printf 'rule=pr_head_ready.head_convergence expected=${candidate} observed=%s\\n' "$observed" >&2
        exit 75
      fi
  - id: downstream
    depends: pr_head_ready
    run: printf 'merge\\n' >> ${JSON.stringify(downstream)}
`;
        const dag = join(home, "observation.yaml"); writeFileSync(dag, definition);
        const config = join(home, "config.yaml");
        writeFileSync(config, `coordinator:\n  enabled: false\npaths:\n  dags_dir: ${home}/dags\n  log_dir: ${home}/logs\n  data_dir: ${home}/data\n`);
        const start = Date.now();
        const { promise, resolve, reject } = Promise.withResolvers<{ code: number | null; output: string }>();
        const child = spawn("dagu", ["start", "--config", config, "--run-id", scenario.name, dag], {
          env: stationEnvironment({ ...process.env, DAGU_HOME: home, DAGU_COORDINATOR_ENABLED: "false" }),
        });
        let output = "";
        child.stdout.on("data", b => { output += b; }); child.stderr.on("data", b => { output += b; });
        // Native timeout/retry timing is the subject of this opt-in integration
        // test: fake timers cannot control the external Dagu/gh processes.
        const watchdog = setTimeout(() => { child.kill("SIGKILL"); }, 95000);
        child.once("error", reject);
        child.once("close", code => { clearTimeout(watchdog); resolve({ code, output }); });
        const result = await promise;
        const elapsed = Date.now() - start;
        writeFileSync(join(home, "cli.log"), result.output);
        const records = readFileSync(events, "utf8").trim().split("\n").map(line => JSON.parse(line) as { kind: string; n: number; time: number });
        const begins = records.filter(e => e.kind === "BEGIN");
        const success = scenario.current <= 13;
        const reads = scenario.mode === "auth" || scenario.mode === "hang" ? 1 : scenario.mode === "delayed-hang" ? 2 : Math.min(13, scenario.current);
        assert.equal(begins.length, reads);
        assert.deepEqual(begins.map(e => e.n), Array.from({ length: reads }, (_, i) => i + 1));
        assert.equal(result.code, success ? 0 : 1, result.output);
        const allFiles = files(home);
        assert.equal(allFiles.includes(downstream) ? readFileSync(downstream, "utf8") : "", success ? "merge\n" : "");
        const nativeLogs = allFiles.filter(f => f.includes("/logs/")).map(f => readFileSync(f, "utf8")).join("\n");
        const statuses = allFiles.filter(f => f.endsWith("/status.jsonl")).flatMap(f =>
          readFileSync(f, "utf8").trim().split("\n").map(line => JSON.parse(line)));
        const status = statuses.findLast(s => Array.isArray(s.nodes) && s.nodes.some((n: { step?: { id?: string } }) => n.step?.id === "pr_head_ready"));
        assert.ok(status, "native final node status must be inspectable");
        const ready = status.nodes.find((n: { step: { id: string } }) => n.step.id === "pr_head_ready");
        const stepLog = readFileSync(ready.stderr, "utf8");
        assert.equal((stepLog.match(/GH_READ_BEGIN /g) ?? []).length, reads);
        const next = status.nodes.find((n: { step: { id: string } }) => n.step.id === "downstream");
        const retries = scenario.mode === "auth" || scenario.mode === "hang" ? 0 : reads - 1;
        const runLog = readFileSync(status.log, "utf8");
        assert.equal((runLog.match(/Step execution started with timeout/g) ?? []).length, reads);
        assert.equal((runLog.match(/Step execution failed; retrying/g) ?? []).length, retries);
        assert.equal(ready.retryCount ?? 0, retries);
        if (success) {
          assert.equal(ready.status, 4);
          assert.equal(next.status, 4);
        } else {
          assert.match(result.output, /pr_head_ready[\s\S]*failed/i);
          assert.match(result.output, /downstream[\s\S]*aborted/i);
          assert.notEqual(ready.status, 4);
          assert.notEqual(next.status, 4);
        }
        for (let i = 1; i < begins.length; i++) {
          const end = records.find(e => e.kind === "END" && e.n === i)!;
          assert.ok(begins[i]!.time - end.time >= 4900, "native five-second retry interval");
        }
        if (scenario.name === "exhaustion") {
          assert.match(nativeLogs, new RegExp(`expected=${candidate} observed=${old}`));
          assert.ok(Date.now() - records.at(-1)!.time < 4500, "no final retry sleep");
        }
        if (scenario.mode.includes("hang")) assert.match(nativeLogs + result.output, /timed out|timeout.*context deadline exceeded/);
        if (scenario.mode === "delay") assert.ok(elapsed >= 9000, "two two-second reads plus retry interval succeed with fresh three-second budgets");
        assert.ok(elapsed < (retries * 5 + (scenario.mode.includes("hang") ? 8 : scenario.mode === "delay" ? 9 : 8)) * 1000, "bounded termination");
        t.diagnostic(JSON.stringify({
          runtime: liveDaguVersion, scenario: scenario.name, reads, retries,
          elapsedMs: elapsed, downstreamInvocations: success ? 1 : 0,
          routing: success ? ["succeeded", "succeeded"] : ["failed", "aborted"],
          attempts: begins.map(begin => ({
            attempt: begin.n, start: begin.time,
            readMs: (records.find(e => e.kind === "END" && e.n === begin.n)?.time ?? begin.time) - begin.time,
          })),
        }));
        writeFileSync(join(home, "evidence.json"), JSON.stringify({ runtime: liveDaguVersion, scenario, elapsed, records, status }, null, 2));
        passed = true;
      } finally {
        if (passed) rmSync(home, { recursive: true, force: true });
        else t.diagnostic(`Native observation artifacts retained in ${home}`);
      }
    });
  }));
});
