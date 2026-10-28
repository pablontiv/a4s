import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { roleAdmission } from "./role-job-fixtures.ts";
import { compiledArtifact } from "./fixtures/admission.ts";

const cli = fileURLToPath(new URL("../bin/dagu-role-jobs.ts", import.meta.url));
const readyAt = "2026-10-22T05:00:00.000Z";

function runtime(root: string): void {
  const dir = join(root, "runtime");
  mkdirSync(join(dir, "src/config"), { recursive: true });
  mkdirSync(join(dir, "src/task"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "0.0.0-test", type: "module" }));
  writeFileSync(join(dir, "src/config/settings.ts"), `export const Settings = { async loadReadOnly() { return {}; } };\n`);
  writeFileSync(join(dir, "src/task/discovery.ts"), `export async function discoverAgents() { return { agents: [{ name: "task", source: "fixture-agent", model: ["fixture-model"], systemPrompt: "fixture" }] }; }\n`);
  writeFileSync(join(dir, "src/task/settings.ts"), `export const cfgTaskAgentModelOverrides = { get() { return { task: ["fixture-model"] }; } };\n`);
  writeFileSync(join(dir, "src/config/model-resolver.ts"), `export function resolveAgentModelSelection() { return { patterns: ["fixture-model"], role: "implement" }; }\n`);
  writeFileSync(join(dir, "src/task/executor.ts"), `import { createServer } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const tcp = createServer();
await new Promise((resolve, reject) => { tcp.once("error", reject); tcp.listen(0, "127.0.0.1", () => resolve(undefined)); });
const unix = createServer();
await new Promise((resolve, reject) => { unix.once("error", reject); unix.listen(process.env.A4S_ROLE_BRIDGE_SOCKET, () => resolve(undefined)); });
const address = tcp.address();
writeFileSync(process.env.A4S_ROLE_BRIDGE_READY, JSON.stringify({ port: address && typeof address === "object" ? address.port : 0 }) + "\\n");
export async function runSubprocess(options) {
  if (process.env.A4S_ROLE_RESULT === "blocked") return { exitCode: 1, aborted: true, error: "BLOCKED_AUTHORIZATION fixture", output: "" };
  const output = { summary: "completed with bridge open", message: "feat: exit while the bridge is open" };
  const rows = [
    { type: "session", id: "native-session" },
    { type: "message", id: "assistant-1", message: { role: "assistant", provider: "fixture", model: "fixture-model", stopReason: "stop" } },
  ];
  mkdirSync(options.artifactsDir, { recursive: true });
  writeFileSync(join(options.artifactsDir, options.id + ".jsonl"), rows.map(row => JSON.stringify(row)).join("\\n") + "\\n");
  return { exitCode: 0, output: JSON.stringify(output) };
}
`);
}

async function stage(root: string, result: "blocked" | "completed"): Promise<{ code: number | null; stderr: string; output: string }> {
  const repo = realpathSync(join(root, "repo"));
  const home = realpathSync(join(root, "home"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nprintf '%s\\n' '{}'\n");
  chmodSync(join(bin, "gh"), 0o755);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-qm", "initial"]);
  const run = `role-exit-${result}`;
  const common = execFileSync("git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
  const state = join(common, "dagu-feature", "runs", run);
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "receipt.json"), JSON.stringify(roleAdmission(repo, home, run, '"$A4S_BIN" role-jobs stage implement', compiledArtifact(home))));
  writeFileSync(join(state, "identity"), JSON.stringify({ primary: repo, worktree: repo, run, session: "parent-id" }));
  const output = join(root, "outputs");
  writeFileSync(output, "");
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ dagRunDetails: { params: "ISSUE=189 OMP_SESSION_ID=parent-id", nodes: [
      { step: { id: "recover_start_gate" }, statusLabel: "skipped", startedAt: readyAt },
      { step: { id: "implement_budget" }, statusLabel: "succeeded", startedAt: readyAt },
      { step: { id: "escalation_decision" }, statusLabel: "skipped", startedAt: readyAt },
      { step: { id: "implement" }, statusLabel: "running", startedAt: readyAt },
    ] } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), cli, "stage", "implement"], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      PRIMARY: repo,
      WORKTREE: repo,
      DAGU_HOME: home,
      RUN: run,
      ISSUE: "189",
      DAGU_URL: `http://127.0.0.1:${port}`,
      DAGU_OUTPUT_FILE: output,
      DAG_PUSHBACK_ITERATION: "0",
      DAGU_OMP_ROLE_RUNTIME: join(root, "runtime"),
      A4S_ROLE_RESULT: result === "blocked" ? "blocked" : "completed",
      A4S_ROLE_BRIDGE_SOCKET: join("/tmp", `a4s-bridge-${process.pid}-${result}.sock`),
      A4S_ROLE_BRIDGE_READY: join(root, `bridge-${result}`),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`stage still alive after 15s\n${stderr}`));
      }, 15_000);
      child.once("exit", status => { clearTimeout(timer); resolve(status); });
    });
    return { code, stderr, output: readFileSync(output, "utf8") };
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(join("/tmp", `a4s-bridge-${process.pid}-${result}.sock`), { force: true });
  }
}

test("implement exits when a BLOCKED role leaves its tool bridge listening", { timeout: 45_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a4s-role-exit-")));
  mkdirSync(join(root, "repo"));
  mkdirSync(join(root, "home"));
  runtime(root);
  try {
    const blocked = await stage(root, "blocked");
    assert.equal(blocked.code, 1, blocked.stderr);
    assert.match(blocked.stderr, /DAGU_ROLE_JOB_BLOCKED: Role implement failed: Native role execution failed: BLOCKED_AUTHORIZATION fixture/);
    assert.equal(blocked.output, "");
    assert.ok(readFileSync(join(root, "bridge-blocked"), "utf8").includes("port"));
    const completed = await stage(root, "completed");
    assert.equal(completed.code, 0, completed.stderr);
    assert.match(completed.output, /SUMMARY=completed with bridge open/);
    assert.match(completed.output, /MESSAGE=feat: exit while the bridge is open/);
    assert.match(completed.output, /IMPLEMENTER=/);
    assert.ok(readFileSync(join(root, "bridge-completed"), "utf8").includes("port"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a role-job usage error exits instead of waiting for open handles", { timeout: 10_000 }, async () => {
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), cli], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`usage path still alive\n${stderr}`)); }, 5_000);
    child.once("exit", status => { clearTimeout(timer); resolve(status); });
  });
  assert.equal(code, 1, stderr);
  assert.match(stderr, /DAGU_ROLE_JOB_BLOCKED: Usage: dagu-role-jobs/);
});
