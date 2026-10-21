import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PocDiagnostics } from "./fixtures/poc-diagnostics.ts";

for (const scenario of [
  { status: 200, body: '{"message":"no details"}', message: /lacks valid dagRunDetails/ },
  { status: 200, body: 'not json', message: /malformed JSON/ },
  { status: 503, body: 'unavailable from actual server', message: /not OK/ },
]) {
  test(`records actual HTTP ${scenario.status}: ${scenario.body}`, async t => {
    const server = createServer((_request, response) => { response.writeHead(scenario.status); response.end(scenario.body); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => server.close());
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/run`;
    const diagnostics = new PocDiagnostics();
    await assert.rejects(diagnostics.runDetails(url), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, scenario.message);
      assert.ok(error.message.includes(JSON.stringify({ url, status: scenario.status, body: scenario.body })));
      return true;
    });
    if (scenario.status !== 200) assert.equal(await diagnostics.runDetails(url, true), undefined);
  });
}

for (const outcome of ["failure", "success", "retention failure"] as const) {
  test(`${outcome}: settles server and cleans runtime while preserving primary failure`, async t => {
    const outer = mkdtempSync(join(tmpdir(), "poc-diagnostics-test-"));
    t.after(() => rmSync(outer, { recursive: true, force: true }));
    const root = join(outer, "runtime");
    const home = join(root, "home");
    mkdirSync(join(home, "data"), { recursive: true });
    mkdirSync(join(home, "logs"));
    writeFileSync(join(home, "data", "run.json"), "run evidence");
    writeFileSync(join(home, "logs", "step.log"), "step evidence");
    const foreign = join(outer, "foreign");
    writeFileSync(foreign, "foreign secret");
    symlinkSync(foreign, join(home, "data", "foreign-link"));
    const base = join(outer, "artifacts");
    if (outcome === "retention failure") writeFileSync(base, "not a directory");
    const diagnostics = new PocDiagnostics();
    const service = spawn(process.execPath, ["-e", `process.stdout.write('server output'); process.stderr.write('server error'); process.on('SIGTERM', () => { require('node:fs').writeFileSync(${JSON.stringify(join(home, "data", "settled"))}, 'settled before copy'); process.exit(0); }); setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "pipe"] });
    diagnostics.capture(service);
    await once(service.stderr, "data");
    const primary = new TypeError("original assertion failure");
    const server = createServer((_request, response) => { response.writeHead(502); response.end("retained HTTP body"); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/run`;
    await diagnostics.fetch(url);
    server.close();
    const messages: string[] = [];
    let caught: unknown;
    try {
      try { if (outcome !== "success") throw primary; }
      finally { await diagnostics.finish(service, root, home, primary, outcome !== "success", message => messages.push(message), base); }
    } catch (error) { caught = error; }
    assert.equal(caught, outcome === "success" ? undefined : primary);
    assert.equal(existsSync(root), false);
    if (outcome === "success") {
      assert.equal(existsSync(base), false);
      assert.deepEqual(messages, []);
    } else if (outcome === "retention failure") {
      assert.ok(messages.some(message => message.includes("diagnostic retention failed:")));
    } else {
      const artifact = join(base, readdirSync(base)[0]!);
      assert.ok(messages.includes(`Dagu PoC diagnostics: ${artifact}`));
      assert.match(readFileSync(join(artifact, "failure.txt"), "utf8"), /TypeError: original assertion failure/);
      assert.equal(readFileSync(join(artifact, "server.stdout.log"), "utf8"), "server output");
      assert.equal(readFileSync(join(artifact, "server.stderr.log"), "utf8"), "server error");
      assert.equal(readFileSync(join(artifact, "data", "settled"), "utf8"), "settled before copy");
      assert.equal(readFileSync(join(artifact, "data", "run.json"), "utf8"), "run evidence");
      assert.equal(readFileSync(join(artifact, "logs", "step.log"), "utf8"), "step evidence");
      assert.deepEqual(readdirSync(artifact).sort(), ["data", "failure.txt", "http.json", "logs", "server.stderr.log", "server.stdout.log"]);
      assert.deepEqual(readdirSync(join(artifact, "data")).sort(), ["run.json", "settled"]);
      assert.equal(statSync(artifact).mode & 0o777, 0o700);
      assert.equal(statSync(join(artifact, "data", "run.json")).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(readFileSync(join(artifact, "http.json"), "utf8")), { url, status: 502, body: "retained HTTP body" });
    }
  });
}
