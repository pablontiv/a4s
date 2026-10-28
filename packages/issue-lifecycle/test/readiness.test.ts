import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { exampleConfig, serializeConfig } from "../src/config.ts";
import { queueReadiness, serviceEnvironmentReadiness } from "../src/queue.ts";

const cli = fileURLToPath(new URL("../bin/dagu-feature-bundle.ts", import.meta.url));
const exec = promisify(execFile);
function snapshot(root: string): Record<string, string> {
  return Object.fromEntries(readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? [[`${entry.name}/`, ""], ...Object.entries(snapshot(path)).map(([name, bytes]) => [`${entry.name}/${name}`, bytes])]
      : [[entry.name, readFileSync(path).toString("hex")]];
  }));
}

for (const initial of [undefined, "# foreign capacity\nqueues:\n  enabled: true\n  config:\n    - name: foreign\n      max_concurrency: 3\n"]) {
  test(`readiness reports a missing lane queue without changing station bytes (${initial ? "foreign config" : "empty home"})`, async () => {
    const home = mkdtempSync(join(tmpdir(), "a4s-readiness-"));
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(request.url?.endsWith("/queues") ? { queues: [] } : { schedulers: [] }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      if (initial) writeFileSync(join(home, "config.yaml"), initial);
      mkdirSync(join(home, "data"));
      writeFileSync(join(home, "data", "waiting.json"), '{"status":"waiting"}\n');
      const before = snapshot(home);
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const result = await exec(process.execPath, [cli, "readiness", "--lane", "fixture"], { env: { ...process.env, DAGU_HOME: home, DAGU_URL: `http://127.0.0.1:${address.port}` } }).then(output => ({ ...output, code: 0 }), error => ({ stdout: error.stdout as string, stderr: error.stderr as string, code: error.code as number }));
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stdout, /queue=fixture source=config.yaml ready=no/);
      assert.match(result.stdout, /missing lane queue fixture in running Dagu API/);
      assert.match(result.stdout, /service-environment ready=no/);
      assert.deepEqual(snapshot(home), before);
      assert.deepEqual(requests, ["GET /api/v1/queues", "GET /api/v1/services/scheduler"]);
    } finally { server.close(); rmSync(home, { recursive: true, force: true }); }
  });
}

test("readiness reports endpoint and authentication failures without writes", async () => {
  const home = mkdtempSync(join(tmpdir(), "a4s-readiness-auth-"));
  const server = createServer((_request, response) => { response.writeHead(401); response.end("authentication required"); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    writeFileSync(join(home, "config.yaml"), "queues:\n  config:\n    - name: fixture\n      max_concurrency: 7\n");
    const before = snapshot(home);
    const endpoint = `http://127.0.0.1:${address.port}`;
    for (const url of [endpoint, "http://127.0.0.1:0"]) {
      const output = await exec(process.execPath, [cli, "readiness", "--lane", "fixture"], { env: { ...process.env, DAGU_HOME: home, DAGU_URL: url } }).then(() => assert.fail("unready station accepted"), error => error.stdout as string);
      assert.match(output, /queue=fixture source=config.yaml max_concurrency=7 ready=yes/);
      assert.match(output, url === endpoint ? /HTTP 401; endpoint\/auth problem/ : /fetch failed/);
      assert.deepEqual(snapshot(home), before);
    }
  } finally { server.close(); rmSync(home, { recursive: true, force: true }); }
});

test("station queue capacity is read-only and malformed or ambiguous entries fail", () => {
  const home = mkdtempSync(join(tmpdir(), "a4s-readiness-config-"));
  try {
    for (const config of ["queues: [broken", "queues: []", "queues:\n  enabled: false\n  config: []", "queues:\n  config:\n    - name: fixture\n    - name: fixture", "queues:\n  config:\n    - name: fixture\n      max_concurrency: 0"]) {
      writeFileSync(join(home, "config.yaml"), config);
      assert.match(queueReadiness(home, "fixture"), /ready=no/);
      assert.equal(readFileSync(join(home, "config.yaml"), "utf8"), config);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("readiness inspects the running scheduler PATH rather than the caller PATH", { skip: process.platform !== "linux" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "a4s-readiness-service-"));
  const service = spawn(process.execPath, ["-e", "process.stdin.resume(); console.log('ready')", "start-all"], { argv0: "dagu", env: { DAGU_HOME: home, PATH: "/missing-service-tools" }, stdio: ["pipe", "pipe", "pipe"] });
  try {
    await once(service.stdout!, "data");
    assert.match(serviceEnvironmentReadiness(home), /scheduler PATH is missing bash, git, gh, jq, node, bun, python3, omp, dagu/);
  } finally { service.kill(); await once(service, "exit"); rmSync(home, { recursive: true, force: true }); }
});

test("install-reconciler creates a missing station DAG and leaves identical bytes untouched", async () => {
  const home = mkdtempSync(join(tmpdir(), "a4s-reconciler-install-"));
  try {
    const config = join(home, "config.json");
    const dest = join(home, "dags", "reconcile.yaml");
    const configText = (ciBlocked: number) => serializeConfig(exampleConfig({ lane: "fixture", escalation: { pushbacks: 3, findings: 2, seconds: 3600, ciBlocked, pocInconclusive: 2 } }));
    writeFileSync(config, configText(2));
    await exec(process.execPath, [cli, "install-reconciler", config, dest]);
    const bytes = readFileSync(dest, "utf8");
    assert.match(bytes, /ESCALATION_CI_BLOCKED: "2"/);
    const stamped = new Date(Date.now() - 60_000);
    utimesSync(dest, stamped, stamped);
    const mtime = statSync(dest).mtimeMs;
    await exec(process.execPath, [cli, "install-reconciler", config, dest]);
    assert.equal(readFileSync(dest, "utf8"), bytes);
    assert.equal(statSync(dest).mtimeMs, mtime);
    writeFileSync(config, configText(5));
    await exec(process.execPath, [cli, "install-reconciler", config, dest]);
    assert.match(readFileSync(dest, "utf8"), /ESCALATION_CI_BLOCKED: "5"/);
    assert.equal(readdirSync(join(home, "dags")).some(name => name.startsWith(".reconcile-")), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
