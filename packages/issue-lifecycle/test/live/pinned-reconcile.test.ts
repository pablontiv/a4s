import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { stringify } from "yaml";
import { compiledArtifact } from "../fixtures/admission.ts";
import { roleAdmission } from "../role-job-fixtures.ts";
import { liveDagu } from "../fixtures/live-dagu.ts";
import { artifactToken } from "../../src/release.ts";

async function execute(file: string, args: string[], env: NodeJS.ProcessEnv) {
  return await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(file, args, { env });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", status => resolve({ status, stdout, stderr }));
  });
}
function logs(directory: string): string {
  if (!existsSync(directory)) return "";
  return readdirSync(directory, { withFileTypes: true }).map(entry => entry.isDirectory() ? logs(join(directory, entry.name)) : /\.(log|err|out)$/.test(entry.name) ? readFileSync(join(directory, entry.name), "utf8") : "").join("\n");
}

test("a B-pinned live tick dispatches A and B and leaves an unavailable artifact untouched", { ...liveDagu, timeout: 180_000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a4s-pinned-reconcile-")));
  const home = join(root, "home"), primary = join(root, "primary"), bin = join(root, "bin");
  mkdirSync(join(home, "dags"), { recursive: true }); mkdirSync(bin);
  execFileSync("git", ["init", "-q", primary]);
  execFileSync("git", ["-C", primary, "-c", "user.name=Live pin", "-c", "user.email=pin@example.test", "commit", "--allow-empty", "-qm", "seed"]);
  execFileSync("git", ["-C", primary, "remote", "add", "origin", "https://github.com/example/pinned.git"]);
  writeFileSync(join(bin, "gh"), "#!/bin/sh\ncase \"$1 $2\" in\n  'repo view') printf '%s\\n' 'example/pinned';;\n  'api --method') printf '%s\\n' '[{\"number\":189,\"state\":\"open\"},{\"number\":190,\"state\":\"open\"},{\"number\":191,\"state\":\"open\"}]';;\n  *) exit 91;;\nesac\n", { mode: 0o755 });
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address(); assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DAGU_")));
  Object.assign(env, { DAGU_HOME: home, DAGU_PORT: String(port), DAGU_URL: `http://127.0.0.1:${port}`, DAGU_COORDINATOR_ENABLED: "false", PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\nqueues:\n  enabled: true\n  config:\n    - name: pinned-fixture\n      max_concurrency: 8\n`);
  const a = compiledArtifact(home, "0.6.1", "a".repeat(40));
  const b = compiledArtifact(home, "0.6.2", "b".repeat(40));
  const missing = { version: "0.6.3", commit: "c".repeat(40), digest: "d".repeat(64) };
  const pinned = join(home, "cache/a4s", b.version, "a4s");
  const rendered = execFileSync(pinned, ["reconcile", "render", "--artifact", artifactToken(b)], { env, encoding: "utf8" });
  // Leave the exact rendered bytes outside scheduler discovery: this test starts
  // one manual tick, without racing the operator-owned minute schedule.
  const reconcile = join(root, "reconcile.yaml");
  writeFileSync(reconcile, rendered);
  const service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
  let serviceLogs = "";
  service.stdout.on("data", chunk => { serviceLogs += chunk; }); service.stderr.on("data", chunk => { serviceLogs += chunk; });
  async function until<T>(probe: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) { const value = await probe(); if (value !== undefined) return value; await delay(100); }
    throw new Error(`Dagu timeout\n${serviceLogs}`);
  }
  try {
    await until(async () => { try { return (await fetch(`${env.DAGU_URL}/api/v1/health`)).ok ? true : undefined; } catch { return; } });
    const stateFor = (run: string) => join(primary, ".git/dagu-feature/runs", run);
    for (const [index, tuple] of [a, b, missing].entries()) {
      const run = ["pinned-a", "pinned-b", "pinned-missing"][index]!;
      const snapshot = stringify({
        name: "feature", type: "graph", shell: "bash", queue: "pinned-fixture",
        labels: [`dagu-feature-bundle=${tuple.version}`], env: [{ PRIMARY: primary }], params: [{ ISSUE: String(189 + index) }],
        steps: [{ id: "triage", action: "human.task", with: { prompt: "Operator validation" } }],
      }, { defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN", lineWidth: 0 });
      const file = join(home, "dags/feature.yaml"); writeFileSync(file, snapshot);
      const state = stateFor(run); mkdirSync(state, { recursive: true });
      writeFileSync(join(state, "receipt.json"), JSON.stringify(roleAdmission(primary, home, run, snapshot, tuple)));
      execFileSync("dagu", ["enqueue", "--run-id", run, file, "--", `ISSUE=${189 + index}`], { env, stdio: "pipe" });
      await until(async () => {
        const response = await fetch(`${env.DAGU_URL}/api/v1/dag-runs/feature/${run}`);
        if (!response.ok) return;
        const value = await response.json() as { dagRunDetails?: { statusLabel: string } };
        return value.dagRunDetails?.statusLabel === "waiting" ? true : undefined;
      });
    }
    const missingReceipt = readFileSync(join(stateFor("pinned-missing"), "receipt.json"), "utf8");
    const result = await execute("dagu", ["start", "--run-id", "pinned-one-tick", reconcile], env);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${serviceLogs}`);
    const output = `${result.stdout}\n${result.stderr}\n${logs(join(home, "logs"))}`;
    for (const [run, tuple] of [["pinned-a", a], ["pinned-b", b]] as const) {
      assert.ok(existsSync(join(stateFor(run), "ci-observation.json")), `${output}\n${serviceLogs}`);
      const observation = JSON.parse(readFileSync(join(stateFor(run), "ci-observation.json"), "utf8"));
      assert.equal(observation.run, run);
      assert.equal(observation.class, "PENDING");
      assert.ok(existsSync(join(stateFor(run), "ci-no-progress.json")));
      assert.ok(output.includes(`a4s-run run=${run} artifact=${artifactToken(tuple)} command=reconcile inspect`), output);
      assert.ok(output.includes(`a4s-run run=${run} artifact=${artifactToken(tuple)} command=reconcile finish`), output);
    }
    assert.match(output, /reconcile-failure run=pinned-missing status=1/);
    assert.equal(readFileSync(join(stateFor("pinned-missing"), "receipt.json"), "utf8"), missingReceipt);
    assert.deepEqual(readdirSync(stateFor("pinned-missing")), ["receipt.json"]);
    t.diagnostic(JSON.stringify({ pinned: artifactToken(b), runs: [artifactToken(a), artifactToken(b)], missing: "untouched, status=1 reported" }));
  } finally {
    service.kill("SIGTERM");
    await new Promise<void>(resolve => service.once("exit", () => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
