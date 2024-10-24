import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseAllDocuments } from "yaml";
import { exampleConfig } from "../../launcher/src/config.ts";
import { readServiceEnvironment } from "../../launcher/src/service-environment.ts";
import { confirmFirstAttempt } from "../../launcher/src/tick-binding.ts";
import { listStationRuns } from "../../launcher/src/station-inventory.ts";
import { LIFECYCLE_DAGS, materializeDag } from "../src/materialize.ts";
import { readOwners } from "../src/resources.ts";
import { useDefaultStation, useStation } from "./fixtures/service-environment.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
test("every fresh lifecycle render freezes one normalized endpoint and space-containing home", t => {
  const home = mkdtempSync(join(tmpdir(), "a4s station spaces "));
  const restore = useStation(home, "http://127.0.0.1:19643///");
  t.after(() => { restore(); rmSync(home, { recursive: true, force: true }); });
  const service = readServiceEnvironment();
  for (const name of LIFECYCLE_DAGS) {
    const path = join(root, "skills/issue-execution", name);
    const before = readFileSync(path, "utf8");
    const rendered = materializeDag(root, name, exampleConfig(), { version: "fixture", source: "fixture", executable: "/release with spaces/a4s" });
    for (const document of parseAllDocuments(rendered)) {
      const env = Object.assign({}, ...document.toJSON().env);
      assert.equal(env.DAGU_URL, "http://127.0.0.1:19643");
      assert.equal(env.DAGU_HOME, home);
      assert.equal(env.PATH, service.PATH);
      assert.equal(env.A4S_SERVICE_ENV, process.env.A4S_SERVICE_ENV);
    }
    assert.doesNotMatch(rendered, /DAGU_PORT|HOME\/\.dagu|127\.0\.0\.1:8080/);
    assert.equal(readFileSync(path, "utf8"), before, "source definitions remain immutable");
  }
});
test("inventory, tick and resource children use the declared station and never the default", async t => {
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input); requests.push(url);
    assert.ok(url.startsWith(`${readServiceEnvironment().DAGU_URL}/api/v1/`));
    assert.ok(!url.includes(":8080"));
    return url.includes("dag-runs/reconcile/")
      ? Response.json({ dagRunDetails: { name: "reconcile", dagRunId: "run with spaces", triggerType: "manual" } })
      : Response.json({ dagRuns: [] });
  });
  assert.equal(await confirmFirstAttempt("run with spaces", { ...process.env, DAG_NAME: "reconcile" }), "first");
  assert.ok(requests[0]!.includes("run%20with%20spaces"));
  await listStationRuns();
  let children = 0;
  await readOwners(async (_file, _args, options) => {
    children++;
    assert.equal(options.env?.DAGU_HOME, process.env.DAGU_HOME);
    assert.equal(options.env?.DAGU_URL, readServiceEnvironment().DAGU_URL);
    assert.equal(options.env?.PATH, readServiceEnvironment().PATH);
    return { stdout: "[]" };
  });
  assert.equal(children, 2);
});
test("missing and conflicting declarations fail before network or native state access", async t => {
  const previous = process.env;
  let requests = 0, children = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; throw new Error("unintended station"); });
  try {
    for (const patch of [{ A4S_SERVICE_ENV: join(tmpdir(), "missing-station-declaration.json") }, { DAGU_URL: "http://127.0.0.1:8080" }, { DAGU_HOME: join(tmpdir(), "unintended-station") }, { DAGU_PORT: "8080" }]) {
      process.env = { ...previous, ...patch };
      await assert.rejects(confirmFirstAttempt("run", process.env), /service-environment ready=no/);
      await assert.rejects(listStationRuns(), /service-environment ready=no/);
      await assert.rejects(readOwners(async () => { children++; return { stdout: "[]" }; }), /service-environment ready=no/);
      assert.throws(() => materializeDag(root, "feature.yaml", exampleConfig(), { version: "fixture", source: "fixture" }), /service-environment ready=no/);
    }
  } finally { process.env = previous; }
  assert.equal(requests, 0);
  assert.equal(children, 0);
});

test("fresh snapshots pin the discovered declaration even when child config homes differ", t => {
  const home = mkdtempSync(join(tmpdir(), "a4s-default-render-"));
  const restore = useDefaultStation(home, "http://127.0.0.1:19643");
  t.after(() => { restore(); rmSync(home, { recursive: true, force: true }); });
  const service = readServiceEnvironment();
  for (const name of LIFECYCLE_DAGS) {
    const rendered = materializeDag(root, name, exampleConfig(), { version: "fixture", source: "fixture" });
    for (const document of parseAllDocuments(rendered)) {
      const env = Object.assign({}, ...document.toJSON().env);
      assert.equal(env.A4S_SERVICE_ENV, join(home, "config", "a4s", "service-environment.json"));
      assert.deepEqual(readServiceEnvironment({ ...env, HOME: "/unrelated", XDG_CONFIG_HOME: "/unrelated" }), service);
    }
  }
});
