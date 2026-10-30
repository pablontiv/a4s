import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { engineCommand } from "../src/executable.ts";
import { identity } from "../src/identity.ts";
import { runA4s } from "./fixtures/compiled-cli.ts";


test("the source entry rejects unknown commands with usage and exposes explicit unbuilt identity", async () => {
  for (const args of [[], ["not-a-command"]]) {
    const result = await runA4s(args);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Usage: a4s/);
  }
  const result = await runA4s(["version"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), identity);
  assert.deepEqual(Object.keys(identity).sort(), ["commit", "dispatch", "layout", "protocols", "registrationManifest", "registrationManifestHash", "requiredLauncherProtocol", "requiredLoaderProtocol", "support", "version"]);
});

test("source self-spawn commands select the existing entry and preserve helper arguments", () => {
  const computation = engineCommand("role-jobs", ["computation", "run", "--id", "example"]);
  assert.equal(computation.file, process.execPath);
  assert.deepEqual(computation.args, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../bin/dagu-role-jobs.ts", import.meta.url)), "computation", "run", "--id", "example"]);
  assert.deepEqual(engineCommand("enqueue", ["--run-id", "one", "feature"]).args.slice(-5),
    [fileURLToPath(new URL("../bin/dagu-feature-bundle.ts", import.meta.url)), "enqueue", "--run-id", "one", "feature"]);
  assert.deepEqual(engineCommand("queue", ["--lane", "example"]).args.slice(-3), ["readiness", "--lane", "example"]);
});
