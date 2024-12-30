import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { queueReadiness } from "../../src/queue.ts";
import { readServiceEnvironment } from "../../../launcher/src/service-environment.ts";
import { declareService } from "../fixtures/service-environment.ts";
import { parse } from "yaml";

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
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const env = { ...process.env, ...declareService(home, `http://127.0.0.1:${address.port}`) };
      const before = snapshot(home);
      const result = await exec(process.execPath, ["--import", import.meta.resolve("tsx"), cli, "readiness", "--lane", "fixture"], { env }).then(output => ({ ...output, code: 0 }), error => ({ stdout: error.stdout as string, stderr: error.stderr as string, code: error.code as number }));
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stdout, /queue=fixture source=config.yaml ready=no/);
      assert.match(result.stdout, /station-config source=config.yaml ready=no/);
      assert.match(result.stdout, /auth.mode: none and coordinator.enabled: true/);
      assert.match(result.stdout, /restart the Dagu service/);
      assert.match(result.stdout, /missing lane queue fixture in running Dagu API/);
      assert.match(result.stdout, /service-environment ready=yes/);
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
    const endpoint = `http://127.0.0.1:${address.port}`;
    for (const url of [endpoint, "http://127.0.0.1:1"]) {
      const env = { ...process.env, ...declareService(home, url) };
      const before = snapshot(home);
      const output = await exec(process.execPath, ["--import", import.meta.resolve("tsx"), cli, "readiness", "--lane", "fixture"], { env }).then(() => assert.fail("unready station accepted"), error => error.stdout as string);
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

test("readiness uses the declared scheduler PATH rather than the caller PATH", () => {
  const home = mkdtempSync(join(tmpdir(), "a4s-readiness-service-"));
  try {
    const env = declareService(home, "http://127.0.0.1:18765", "/missing-service-tools");
    assert.throws(() => readServiceEnvironment({ ...process.env, ...env }), /declared scheduler PATH is missing bash, git, gh, jq, curl, node, omp, dagu/);
  } finally { rmSync(home, { recursive: true, force: true }); }
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
    const env = { ...process.env, ...declareService(home, `http://127.0.0.1:${address.port}`) };
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
        env,
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

test("readiness accepts the complete station contract without changing files on any host", async () => {
  const home = mkdtempSync(join(tmpdir(), "a4s-ready-contract-"));
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
    writeFileSync(join(home, "config.yaml"), "# foreign setting\nhost: 127.0.0.1\nauth: {mode: none}\ncoordinator: {enabled: true}\nqueues:\n  config:\n    - name: fixture\n      max_concurrency: 7\n");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const env = { ...process.env, ...declareService(home, `http://127.0.0.1:${address.port}`), PATH: "/unrelated-caller-path" };
    const before = snapshot(home);
    const result = await exec(process.execPath, ["--import", import.meta.resolve("tsx"), cli, "readiness", "--lane", "fixture"], {
      env,
    });
    assert.match(result.stdout, /station-config source=config.yaml auth.mode=none coordinator.enabled=true ready=yes/);
    assert.match(result.stdout, /service-environment ready=yes/);
    assert.deepEqual(snapshot(home), before);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("bootstrap probe resolves its nondefault endpoint/home through release-bound A4S_BIN", async () => {
  const home = mkdtempSync(join(tmpdir(), "a4s-bootstrap-contract-"));
  const requests: string[] = [];
  let specOk = true;
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url?.endsWith("/spec") ? (specOk ? { spec: "existing snapshot" } : {})
      : request.url?.endsWith("/queues") ? { queues: [{ name: "fixture", type: "global" }] }
      : { schedulers: [{ status: "active" }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const bin = join(home, "bin");
    const primary = join(home, "primary");
    mkdirSync(bin);
    await exec("git", ["init", "-q", primary]);
    writeFileSync(join(bin, "gh"), '#!/bin/sh\ncase "$*" in\n  "auth status") exit 0 ;;\n  *nameWithOwner*) printf "owner/fixture\\n" ;;\n  "repo view"*) printf "fixture\\n" ;;\n  *) exit 1 ;;\nesac\n', { mode: 0o755 });
    const selection = declareService(home, `http://127.0.0.1:${address.port}`, `${bin}:${process.env.PATH}`);
    writeFileSync(join(home, "config.yaml"), "auth: {mode: none}\ncoordinator: {enabled: true}\nqueues:\n  config:\n    - {name: fixture, max_concurrency: 2}\n");
    const executable = join(home, "release-a4s");
    const release = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
    writeFileSync(executable, `#!/bin/sh\nif [ "$1 $2" = "role-jobs detect" ]; then exit 0; fi\nexec '${process.execPath}' --import '${import.meta.resolve("tsx")}' '${release}' "$@"\n`);
    chmodSync(executable, 0o755);
    const definition = parse(readFileSync(new URL("../../skills/issue-execution/dagu-feature-bootstrap.yaml", import.meta.url), "utf8"));
    const detect = definition.steps.find((step: { id: string }) => step.id === "detect").run as string;
    const probe = detect.slice(detect.indexOf("service_environment="), detect.indexOf("base=${BASE_BRANCH"));
    const env = { ...process.env, ...selection, PRIMARY: primary, A4S_BIN: executable, DAGU_PORT: String(address.port), DAG_RUN_ID: "fixture run" };
    const script = `set -euo pipefail\nrepo=fixture\n${probe}`;
    const before = snapshot(home);
    await exec("bash", ["-c", script], { env });
    assert.deepEqual(requests, ["GET /api/v1/queues", "GET /api/v1/services/scheduler", "GET /api/v1/dag-runs/dagu-feature-bootstrap/fixture%20run/spec"]);
    requests.length = 0;
    const failure = await exec("bash", ["-c", script], { env: { ...env, A4S_SERVICE_ENV: "" } }).then(() => assert.fail("missing declaration accepted"), error => String(error.stderr));
    assert.match(failure, /service-environment ready=no field=A4S_SERVICE_ENV/);
    assert.deepEqual(requests, []);
    const portFailure = await exec("bash", ["-c", script], { env: { ...env, DAGU_PORT: "1" } }).then(() => assert.fail("conflicting port accepted"), error => String(error.stderr));
    assert.match(portFailure, /DAGU_PORT/);
    assert.deepEqual(requests, []);
    specOk = false;
    const specFailure = await exec("bash", ["-c", script], { env }).then(() => assert.fail("invalid spec accepted"), error => String(error.stderr));
    assert.ok(specFailure.includes(`${selection.DAGU_URL}/api/v1/dag-runs/`), specFailure);
    assert.ok(specFailure.includes(`${home}/config.yaml`), specFailure);
    assert.deepEqual(snapshot(home), before);
  } finally { server.close(); rmSync(home, { recursive: true, force: true }); }
});
