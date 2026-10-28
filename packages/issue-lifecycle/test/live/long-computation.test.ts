import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { liveDagu } from "../fixtures/live-dagu.ts";
import { PocDiagnostics } from "../fixtures/poc-diagnostics.ts";
import { testRunId } from "../fixtures/run-id.ts";

test("Dagu runs the checkpoint scenario in an isolated home", { ...liveDagu, timeout: 120_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a4s-live-computation-")));
  const home = join(root, "dagu-home");
  const scenario = join(root, "scenario");
  mkdirSync(join(home, "dags"), { recursive: true });
  mkdirSync(scenario, { recursive: true });
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const tsx = import.meta.resolve("tsx");
  const runner = join(root, "run-scenario.mts");
  writeFileSync(runner, `import { proveLongComputation } from ${JSON.stringify(fileURLToPath(new URL("../long-computation-scenario.ts", import.meta.url)))};\nawait proveLongComputation(${JSON.stringify(scenario)});\n`);
  const command = join(root, "run-scenario.sh");
  writeFileSync(command, `#!/bin/bash\nset -euo pipefail\nexec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(tsx)} ${JSON.stringify(runner)}\n`, { mode: 0o700 });
  chmodSync(command, 0o700);
  const id = testRunId("computation");
  writeFileSync(join(home, "dags", "computation.yaml"), `name: computation\ntype: graph\nsteps:\n  - id: scenario\n    run: ${JSON.stringify(command)}\n`);
  writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\n`);
  const env = { ...process.env, DAGU_HOME: home, DAGU_COORDINATOR_ENABLED: "false" };
  const diagnostics = new PocDiagnostics();
  const service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
  diagnostics.capture(service);
  const dagu = (...args: string[]) => execFileSync("dagu", args, { env, encoding: "utf8" });
  let failure: unknown;
  let failed = false;
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        if ((await diagnostics.fetch(`http://127.0.0.1:${port}/api/v1/dag-runs`)).ok) break;
      } catch { /* The isolated scheduler is still opening its port. */ }
      await delay(100);
    }
    dagu("enqueue", "--run-id", id, join(home, "dags", "computation.yaml"));
    const finished = Date.now() + 90_000;
    let status = "";
    while (Date.now() < finished) {
      const run = await diagnostics.runDetails<{ statusLabel: string }>(`http://127.0.0.1:${port}/api/v1/dag-runs/computation/${id}`);
      status = run?.statusLabel ?? "";
      if (status === "succeeded" || status === "failed") break;
      await delay(200);
    }
    assert.equal(status, "succeeded");
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    await diagnostics.finish(service, root, home, failure, failed);
  }
});
