import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { liveDagu } from "../fixtures/live-dagu.ts";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../../bin/dagu-feature-bundle.ts", import.meta.url));

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  server.close();
  await once(server, "close");
  return address.port;
}

test("readiness observes an operator-configured queue and the live scheduler without changing config", {
  ...liveDagu, skip: liveDagu.skip || process.platform !== "linux", timeout: 90_000,
}, async () => {
  const home = mkdtempSync(join(tmpdir(), "a4s-live-readiness-"));
  const port = await freePort();
  const schedulerPort = await freePort();
  const coordinatorPort = await freePort();
  mkdirSync(join(home, "dags"));
  const config = `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: true\n  port: ${coordinatorPort}\nscheduler:\n  port: ${schedulerPort}\nqueues:\n  enabled: true\n  config:\n    - name: readiness-lane\n      max_concurrency: 3\n`;
  const path = join(home, "config.yaml");
  writeFileSync(path, config);
  writeFileSync(join(home, "dags", "readiness-lane.yaml"), "queue: readiness-lane\nsteps:\n  - run: true\n");
  const modified = statSync(path).mtimeMs;
  const env = { ...process.env, DAGU_HOME: home, DAGU_URL: `http://127.0.0.1:${port}`, DAGU_COORDINATOR_ENABLED: "true", DAGU_COORDINATOR_PORT: String(coordinatorPort), DAGU_PARAMS_JSON: "{}" };
  const service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  service.stdout.on("data", value => { log += value; });
  service.stderr.on("data", value => { log += value; });
  try {
    const deadline = Date.now() + 60_000;
    let output = "";
    for (;;) {
      try {
        output = (await exec(process.execPath, ["--import", import.meta.resolve("tsx"), cli, "readiness", "--lane", "readiness-lane"], { env })).stdout;
        break;
      } catch (error) {
        output = String(error);
        if (Date.now() >= deadline || service.exitCode !== null) throw new Error(`Readiness failed: ${output}\n${log}`);
        await delay(50);
      }
    }
    assert.match(output, /queue=readiness-lane source=config.yaml max_concurrency=3 ready=yes/);
    assert.match(output, /station-config source=config.yaml auth.mode=none coordinator.enabled=true ready=yes/);
    assert.match(output, /queue=readiness-lane source=api ready=yes/);
    assert.match(output, /scheduler source=api ready=yes/);
    assert.match(output, /service-environment ready=yes/);
    assert.equal(readFileSync(path, "utf8"), config);
    assert.equal(statSync(path).mtimeMs, modified);
  } finally {
    if (service.exitCode === null && service.signalCode === null) {
      const exited = once(service, "exit");
      service.kill("SIGTERM");
      await exited;
    }
    rmSync(home, { recursive: true, force: true });
  }
});
