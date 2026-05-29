import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { queueReadiness, serviceEnvironmentReadiness } from "../../src/queue.ts";

const cli = fileURLToPath(new URL("../../bin/dagu-feature-bundle.ts", import.meta.url));
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
      const result = await exec(process.execPath, ["--import", import.meta.resolve("tsx"), cli, "readiness", "--lane", "fixture"], { env: { ...process.env, DAGU_HOME: home, DAGU_URL: `http://127.0.0.1:${address.port}` } }).then(output => ({ ...output, code: 0 }), error => ({ stdout: error.stdout as string, stderr: error.stderr as string, code: error.code as number }));
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stdout, /queue=fixture source=config.yaml ready=no/);
      assert.match(result.stdout, /station-config source=config.yaml ready=no/);
      assert.match(result.stdout, /auth.mode: none and coordinator.enabled: true/);
      assert.match(result.stdout, /restart the Dagu service/);
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
      const output = await exec(process.execPath, ["--import", import.meta.resolve("tsx"), cli, "readiness", "--lane", "fixture"], { env: { ...process.env, DAGU_HOME: home, DAGU_URL: url } }).then(() => assert.fail("unready station accepted"), error => error.stdout as string);
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
    assert.match(serviceEnvironmentReadiness(home), /scheduler PATH is missing bash, git, gh, jq, node, omp, dagu/);
  } finally { service.kill(); await once(service, "exit"); rmSync(home, { recursive: true, force: true }); }
});

test("readiness requires explicit station leaves even when the unauthenticated API responds", async () => {
  const home = mkdtempSync(join(tmpdir(), "a4s-readiness-contract-"));
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url?.endsWith("/queues")
      ? { queues: [{ name: "fixture", type: "global" }] }
      : { schedulers: [{ status: "active" }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const queue = "# preserve operator settings\nqueues:\n  config:\n    - name: fixture\n      max_concurrency: 7\n";
    for (const [leaves, missing] of [
      ["", ["auth.mode: none", "coordinator.enabled: true"]],
      ["auth: {mode: builtin}\ncoordinator: {enabled: true}\n", ["auth.mode: none"]],
      ["auth: {mode: none}\n", ["coordinator.enabled: true"]],
      ["auth: {mode: none}\ncoordinator: {enabled: false}\n", ["coordinator.enabled: true"]],
      ['auth: {mode: none}\ncoordinator: {enabled: "true"}\n', ["coordinator.enabled: true"]],
      ["auth: [none]\ncoordinator: true\n", ["auth.mode: none", "coordinator.enabled: true"]],
    ] as const) {
      writeFileSync(join(home, "config.yaml"), queue + leaves);
      const before = snapshot(home);
      const result: { stdout: string; code: unknown } = await exec(process.execPath, ["--import", import.meta.resolve("tsx"), cli, "readiness", "--lane", "fixture"], {
        env: { ...process.env, DAGU_HOME: home, DAGU_URL: `http://127.0.0.1:${address.port}` },
      }).then(() => assert.fail("invalid station contract accepted"), error => ({ stdout: String(error.stdout), code: error.code }));
      assert.equal(result.code, 1);
      assert.ok(result.stdout.includes(`missing or incorrect required leaves: ${missing.join(", ")}`), result.stdout);
      assert.ok(result.stdout.includes(join(home, "config.yaml")));
      assert.match(result.stdout, /preserving unrelated settings, then restart the Dagu service/);
      assert.match(result.stdout, /queue=fixture source=api ready=yes/);
      assert.deepEqual(snapshot(home), before);
    }
  } finally { server.close(); rmSync(home, { recursive: true, force: true }); }
});

test("readiness accepts the complete station contract without changing files", { skip: process.platform !== "linux" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "a4s-ready-contract-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  for (const tool of ["bash", "git", "gh", "jq", "node", "omp", "dagu"]) {
    writeFileSync(join(bin, tool), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, tool), 0o755);
  }
  const service = spawn(process.execPath, ["-e", "process.stdin.resume(); console.log('ready')", "start-all"], {
    argv0: "dagu", env: { DAGU_HOME: home, PATH: bin }, stdio: ["pipe", "pipe", "pipe"],
  });
  const server = createServer((request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(request.headers.authorization, undefined);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url?.endsWith("/queues")
      ? { queues: [{ name: "fixture", type: "global" }] }
      : { schedulers: [{ status: "active" }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await once(service.stdout!, "data");
    writeFileSync(join(home, "config.yaml"), "# foreign setting\nhost: 127.0.0.1\nauth: {mode: none}\ncoordinator: {enabled: true}\nqueues:\n  config:\n    - name: fixture\n      max_concurrency: 7\n");
    const before = snapshot(home);
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const result = await exec(process.execPath, ["--import", import.meta.resolve("tsx"), cli, "readiness", "--lane", "fixture"], {
      env: { ...process.env, DAGU_HOME: home, DAGU_URL: `http://127.0.0.1:${address.port}` },
    });
    assert.match(result.stdout, /station-config source=config.yaml auth.mode=none coordinator.enabled=true ready=yes/);
    assert.match(result.stdout, /service-environment ready=yes/);
    assert.deepEqual(snapshot(home), before);
  } finally {
    server.close();
    service.kill();
    await once(service, "exit");
    rmSync(home, { recursive: true, force: true });
  }
});
