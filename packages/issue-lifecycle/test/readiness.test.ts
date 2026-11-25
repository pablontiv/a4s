import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { queueReadiness, stationReadiness } from "../src/queue.ts";
import { declareService } from "./fixtures/service-environment.ts";
import { main as launcher } from "../../launcher/src/cli.ts";
import { main as release } from "../src/cli.ts";
import { parse } from "yaml";

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

test("station queue reports configured capacity without changing foreign station bytes", () => {
  const home = mkdtempSync(join(tmpdir(), "a4s-readiness-capacity-"));
  try {
    const config = "# foreign capacity\nqueues:\n  enabled: true\n  config:\n    - name: foreign\n      max_concurrency: 3\n";
    writeFileSync(join(home, "config.yaml"), config);
    assert.match(queueReadiness(home, "fixture"), /queue=fixture source=config.yaml ready=no/);
    assert.equal(queueReadiness(home, "foreign"), "queue=foreign source=config.yaml max_concurrency=3 ready=yes");
    assert.equal(readFileSync(join(home, "config.yaml"), "utf8"), config);
  } finally { rmSync(home, { recursive: true, force: true }); }
});


function snapshot(root: string): Record<string, string> {
  return Object.fromEntries(readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? Object.entries(snapshot(path)).map(([name, bytes]) => [`${entry.name}/${name}`, bytes])
      : [[entry.name, readFileSync(path).toString("hex")]];
  }));
}

test("readiness uses only declared file/HTTP boundaries and preserves all station bytes", async () => {
  const home = mkdtempSync(join(tmpdir(), "a4s-readiness-contract-"));
  let status = 200;
  let queues: unknown[] = [{ name: "fixture", type: "global" }];
  let schedulers: unknown[] = [{ status: "active" }];
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    assert.equal(request.headers.authorization, undefined);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/api/v1/queues" ? { queues } : { schedulers }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    assert.notEqual(address.port, 8080);
    const env = declareService(home, `http://127.0.0.1:${address.port}`);
    const config = "# foreign settings\nauth: {mode: none}\ncoordinator: {enabled: true}\nqueues:\n  config:\n    - {name: fixture, max_concurrency: 7}\n    - {name: foreign, max_concurrency: 3}\n";
    writeFileSync(join(home, "config.yaml"), config);
    mkdirSync(join(home, "data"));
    writeFileSync(join(home, "data", "active"), "active run bytes\n");
    writeFileSync(join(home, "data", "waiting"), "waiting run bytes\n");
    writeFileSync(join(home, "operator.service"), "foreign service definition\n");
    const before = snapshot(home);
    for (const PATH of ["/unrelated", process.env.PATH]) {
      const report = await stationReadiness(undefined, "fixture", { ...env, PATH });
      assert.equal(report.ready, true, report.checks.join("\n"));
    }
    assert.deepEqual(requests, Array(2).fill(["GET /api/v1/queues", "GET /api/v1/services/scheduler"]).flat());
    for (const invalid of [{}, { ...env, DAGU_HOME: join(home, "other") }, { ...env, A4S_SERVICE_ENV: join(home, "absent") }]) {
      requests.length = 0;
      const report = await stationReadiness(undefined, "fixture", invalid);
      assert.equal(report.ready, false);
      assert.match(report.checks.join("\n"), /service-environment ready=no.*field=.*action=ask-station-operator/);
      assert.deepEqual(requests, []);
    }
    for (const state of ["missing queue", "inactive scheduler", "unauthorized", "forbidden", "API error"]) {
      queues = state === "missing queue" ? [] : [{ name: "fixture", type: "global" }];
      schedulers = state === "inactive scheduler" ? [] : [{ status: "active" }];
      status = state === "unauthorized" ? 401 : state === "forbidden" ? 403 : state === "API error" ? 500 : 200;
      const report = await stationReadiness(undefined, "fixture", env);
      assert.equal(report.ready, false, state);
      assert.match(report.checks.join("\n"), /ready=no.*action=ask-station-operator/);
    }
    assert.deepEqual(snapshot(home), before);
    status = 200;
    for (const leaves of ["", "auth: {mode: builtin}\n", "auth: {mode: none}\ncoordinator: {enabled: false}\n"]) {
      writeFileSync(join(home, "config.yaml"), leaves + "queues:\n  config:\n    - {name: fixture, max_concurrency: 7}\n");
      const report = await stationReadiness(undefined, "fixture", env);
      assert.equal(report.ready, false);
      assert.match(report.checks.join("\n"), /station-config.*ready=no.*required leaves/);
    }
    rmSync(join(home, "config.yaml"));
    assert.equal((await stationReadiness(undefined, "fixture", env)).ready, false);
    const missingHome = join(home, "not-created");
    const declaration = JSON.parse(readFileSync(env.A4S_SERVICE_ENV!, "utf8"));
    writeFileSync(env.A4S_SERVICE_ENV!, JSON.stringify({ ...declaration, DAGU_HOME: missingHome }));
    assert.equal((await stationReadiness(undefined, "fixture", { A4S_SERVICE_ENV: env.A4S_SERVICE_ENV })).ready, false);
    assert.equal(readdirSync(home).includes("not-created"), false);
  } finally { server.close(); rmSync(home, { recursive: true, force: true }); }
});

test("bootstrap uses its release-bound launcher reader and shares failure diagnostics", async () => {
  const bootstrap = readFileSync(new URL("../skills/issue-execution/dagu-feature-bootstrap.yaml", import.meta.url), "utf8");
  const definition = parse(bootstrap);
  const detect = definition.steps.find((step: { id: string }) => step.id === "detect").run as string;
  assert.ok(detect.includes('service_environment=$("$A4S_BIN" service-environment)'));
  assert.ok(detect.includes('spec_url="$service_url/api/v1/dag-runs/'));
  assert.ok(detect.includes('"$spec_url" "$service_home"'));
  assert.doesNotMatch(detect, /DAGU_PORT|HOME\/\.dagu|A4S_SERVICE_ENV|launchctl|plutil|\/proc|checkout/);
  const old = process.env.A4S_SERVICE_ENV;
  delete process.env.A4S_SERVICE_ENV;
  try {
    const errors: string[] = [];
    for (const command of [launcher, release]) {
      await assert.rejects(async () => {
        try { await command(["service-environment"]); }
        catch (error) { errors.push((error as Error).message); throw error; }
      }, /service-environment ready=no field=A4S_SERVICE_ENV/);
    }
    assert.equal(errors[0], errors[1]);
  } finally {
    if (old === undefined) delete process.env.A4S_SERVICE_ENV;
    else process.env.A4S_SERVICE_ENV = old;
  }
});
