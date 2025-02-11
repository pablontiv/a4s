import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parse, stringify } from "yaml";
import { liveDagu, liveDaguVersion } from "../fixtures/live-dagu.ts";

type Step = {
  id: string; depends?: string; continue_on?: unknown;
  preconditions?: Array<{ condition: string; expected: string }>;
  env?: Record<string, string>[]; run?: string;
  with?: { push_back?: { rewind_to: string } };
};
type Node = { step: { name: string }; statusLabel: string; error?: string; doneCount: number };
type Details = { statusLabel: string; nodes: Node[]; onExit?: { statusLabel: string } };
const pairs = [
  ["feature", "start_gate", "recover_start_gate"],
  ["feature", "gate", "recover_gate"],
  ["feature", "push", "recover_push"],
  ["feature", "poc_scope_resolve", "recover_poc_scope"],
  ["poc", "scope_gate", "fix_result"],
] as const;
const cases = [
  ...pairs.map(pair => ({ pair, mode: "cancel" })),
  ...["healthy", "no", "omitted", "repair", "unsafe", "unexpected-error"].map(mode => ({ pair: pairs[0]!, mode })),
  { pair: pairs[3]!, mode: "unexpected-error" },
];

for (const [index, { pair: [kind, predecessor, checkpoint], mode }] of cases.entries()) {
  const label = `${kind}-${checkpoint}-${mode}`;
  const evidence = process.env.A4S_RECOVERY_EVIDENCE;
  const completed = evidence && process.env.A4S_RECOVERY_RESUME === "1" && existsSync(join(evidence, `shard-${index}.json`));
  test(`isolated recovery ${label}`, { ...liveDagu, timeout: 45_000,
    skip: liveDagu.skip || (completed ? "Retained completed shard" :
      process.env.A4S_RECOVERY_CASE && process.env.A4S_RECOVERY_CASE !== label ? "Selected another fixture case" : false),
  }, async t => {
    const started = Date.now();
    const root = realpathSync(mkdtempSync(join(evidence ?? tmpdir(), `recovery-${index}-`)));
    const home = join(root, "dagu");
    const primary = join(root, "primary");
    mkdirSync(join(home, "dags"), { recursive: true });
    mkdirSync(primary);
    execFileSync("git", ["init", "-q", primary]);
    const socket = createServer();
    const listening = once(socket, "listening");
    socket.listen(0, "127.0.0.1");
    await listening;
    const address = socket.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    const closed = once(socket, "close");
    socket.close();
    await closed;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DAGU_")));
    Object.assign(env, { HOME: root, DAGU_HOME: home, DAGU_AUTH_MODE: "none", DAGU_COORDINATOR_ENABLED: "false" });
    const commands: Array<{ args: string[]; stdout: string }> = [];
    const dagu = (...args: string[]) => {
      const stdout = execFileSync("dagu", args, { env, encoding: "utf8", timeout: 10_000 });
      commands.push({ args, stdout });
      return stdout;
    };
    const service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
    let logs = "";
    service.stdout.on("data", chunk => { logs += chunk; });
    service.stderr.on("data", chunk => { logs += chunk; });
    async function until<T>(description: string, probe: () => Promise<T | undefined>): Promise<T> {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const result = await probe();
        if (result !== undefined) return result;
        await delay(50);
      }
      throw new Error(`Timed out: ${description}\n${logs}`);
    }
    const name = `recovery-${index}`;
    const run = "fixture";
    const details = async (): Promise<Details | undefined> => {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/dag-runs/${name}/${run}`);
      if (!response.ok) return;
      const body: { dagRunDetails: Details } = await response.json();
      return body.dagRunDetails;
    };
    const lines = (file: string) => existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8").trim().split("\n") : [];
    let passed = false;
    try {
      await until("private server ready", async () => {
        try { return (await fetch(`http://127.0.0.1:${port}/api/v1/dag-runs`)).ok ? true : undefined; } catch { return; }
      });
      const source: { steps: Step[] } = parse(readFileSync(new URL(`../../skills/issue-execution/${kind}.yaml`, import.meta.url), "utf8"));
      const original = source.steps.find(step => step.id === predecessor)!;
      const recovery = structuredClone(source.steps.find(step => step.id === checkpoint)!);
      const gate = structuredClone(source.steps.find(step => step.id === `${checkpoint}_cancellation`)!);
      // Exercise actual continuation, form and routing with effect-free commands.
      // Full lifecycle setup/automatic wait dispatchers are deliberately absent.
      assert.ok(recovery.preconditions);
      recovery.preconditions = recovery.preconditions.map(condition => ({ ...condition,
        condition: condition.condition.replaceAll("${steps.run_poc.outputs.decline}", "${FIXTURE_DECLINE}"),
      }));
      assert.ok(recovery.with?.push_back);
      recovery.with.push_back.rewind_to = predecessor;
      if (mode === "unsafe") gate.preconditions = recovery.preconditions;
      gate.run = `printf 'gate\\n' >> "$HOME/gate"\n${gate.run}`;
      const code = mode === "unexpected-error" ? 24 : 23;
      const definition = {
        type: "graph", shell: "bash", max_active_steps: 1,
        env: [{ PRIMARY: primary }, { WORKTREE: primary }, { RUN: run }, { FIXTURE_DECLINE: "" }],
        steps: [
          { id: predecessor, continue_on: original.continue_on,
            run: `printf 'attempt\\n' >> "$HOME/attempts"\nif [[ -f "$HOME/repaired" ]]; then exit 0; fi\nexit ${mode === "healthy" ? 0 : code}` },
          recovery, gate,
          { id: "successor", depends: gate.id, run: 'printf "effect\\n" >> "$HOME/successor"' },
        ],
        handler_on: { exit: { run: 'printf "onExit\\n" >> "$HOME/onExit"' } },
      };
      const file = join(home, "dags", `${name}.yaml`);
      writeFileSync(file, stringify(definition));
      dagu("validate", file);
      dagu("enqueue", "--run-id", run, file);
      const terminalOnly = mode === "healthy" || (mode === "unexpected-error" && predecessor === "poc_scope_resolve");
      if (!terminalOnly) {
        const before = await until("recovery Waiting", async () => {
          const state = await details();
          return state?.statusLabel === "waiting" ? state : undefined;
        });
        writeFileSync(join(root, "before.json"), JSON.stringify(before, null, 2));
        assert.equal(before.nodes.find(node => node.step.name === checkpoint)?.statusLabel, "waiting");
        assert.equal(lines("attempts").length, 1);
        if (mode === "repair") {
          writeFileSync(join(root, "repaired"), "yes");
          dagu("human-task", "push-back", name, "--run-id", run, "--step", checkpoint, "--expected-iteration", "0");
        } else {
          const input = mode === "omitted" ? [] : ["--input", `CANCEL=${mode === "no" ? "no" : "yes"}`];
          assert.match(dagu("human-task", "complete", name, "--run-id", run, "--step", checkpoint, ...input), /queued for resume/);
        }
      }
      const cancelled = mode === "cancel" || (mode === "unexpected-error" && !terminalOnly);
      const terminal = cancelled || (mode === "unexpected-error" && terminalOnly) ? "failed" : "succeeded";
      const result = await until(`native ${terminal} and onExit`, async () => {
        const state = await details();
        return state?.statusLabel === terminal && state.onExit?.statusLabel === "succeeded" ? state : undefined;
      });
      writeFileSync(join(root, "after.json"), JSON.stringify(result, null, 2));
      assert.equal(lines("attempts").length, mode === "repair" ? 2 : 1);
      assert.deepEqual(lines("onExit"), ["onExit"]);
      const node = (id: string) => result.nodes.find(node => node.step.name === id)!;
      if (cancelled) {
        assert.equal(node(predecessor).statusLabel, "succeeded");
        assert.match(node(predecessor).error!, new RegExp(`exit status ${code}`));
        assert.equal(node(gate.id).statusLabel, "failed");
        assert.match(node(gate.id).error!, /exit status 77/);
        assert.equal(node("successor").statusLabel, "aborted");
        assert.equal(node("successor").doneCount, 0);
        assert.deepEqual(lines("successor"), []);
        assert.deepEqual(lines("gate"), ["gate"]);
        const record = join(primary, ".git", kind === "feature" ? "dagu-feature" : "poc", "runs", run, "cancellation.json");
        assert.equal(JSON.parse(readFileSync(record, "utf8")).checkpoint, checkpoint);
      } else if (terminalOnly && mode === "unexpected-error") {
        assert.equal(node(predecessor).statusLabel, "failed", "scope resolver only tolerates exit 23");
        assert.equal(node(checkpoint).doneCount, 0);
        assert.deepEqual(lines("successor"), []);
      } else {
        assert.deepEqual(lines("successor"), ["effect"]);
        if (mode === "unsafe") {
          assert.equal(node(gate.id).statusLabel, "skipped", "mark-success alone silently bypasses cancellation");
          assert.deepEqual(lines("gate"), []);
        }
      }
      t.diagnostic(`${liveDaguVersion}: attempts=${lines("attempts").length}; gate=${node(gate.id).statusLabel}; terminal=${result.statusLabel}; effects=${lines("successor").length}; onExit=1`);
      passed = true;
      if (evidence) writeFileSync(join(evidence, `shard-${index}.json`), JSON.stringify({ index, range: [label, label], completedAt: new Date().toISOString(), durationMs: Date.now() - started, runtime: liveDaguVersion }));
    } finally {
      service.kill("SIGTERM");
      if (service.exitCode === null && service.signalCode === null) {
        await once(service, "exit");
      }
      writeFileSync(join(root, "server.log"), logs);
      writeFileSync(join(root, "commands.json"), JSON.stringify(commands, null, 2));
      if (passed && !evidence) rmSync(root, { recursive: true, force: true });
      else t.diagnostic(`Retained fixture evidence: ${root}`);
    }
  });
}
