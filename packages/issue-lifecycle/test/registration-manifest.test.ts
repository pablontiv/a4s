import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Generation, type Factory } from "@a4s/hot-reload";
import { registrationHash } from "../../launcher/src/contracts.ts";
import { validateRegistrations } from "../../loader/src/manifest.ts";
import { main } from "../src/cli.ts";
import status from "../src/status/index.ts";
import triage from "../src/triage/native.ts";
import { identity } from "../src/identity.ts";
import { packageRoot } from "../src/executable.ts";
import { inProcessArtifact } from "./fixtures/compiled-artifact.ts";

test("a4s version's canonical source manifest equals cached identity.json", async t => {
  const home = mkdtempSync(join(tmpdir(), "a4s-registration-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const outputs: string[] = [];
  t.mock.method(console, "log", (text: string) => { outputs.push(text); });
  await main(["version"]);
  const version = JSON.parse(outputs[0]!);
  const tuple = inProcessArtifact(home);
  const declared = JSON.parse(readFileSync(join(home, "cache/a4s", tuple.version, "identity.json"), "utf8"));
  assert.deepEqual(version.registrationManifest, declared.registrationManifest);
  assert.equal(version.registrationManifestHash, registrationHash(declared.registrationManifest));
  const generation = new Generation(new Map());
  // Captured facades have these two structural host surfaces; no host actions run.
  await generation.record({}, status as unknown as Factory<object>);
  await generation.record({}, triage as unknown as Factory<object>);
  validateRegistrations(generation, identity);
  generation.abort();
});

test("all shipped skill and agent bytes participate in the restart gate", () => {
  const resources = identity.registrationManifest.resources!;
  assert.equal(Object.keys(resources).filter(path => path.endsWith("/SKILL.md")).length, 7);
  assert.equal(Object.keys(resources).filter(path => path.startsWith("agents/")).length, 2);
  for (const [path, hash] of Object.entries(resources)) {
    assert.equal(hash, createHash("sha256").update(readFileSync(join(packageRoot, path))).digest("hex"));
  }
  assert.ok(readFileSync(join(packageRoot, "agents/plan-reviewer.md"), "utf8").includes("@slow"));
  const planning = readFileSync(join(packageRoot, "skills/issue-execution/planning.yaml"), "utf8");
  assert.match(planning, /dirname "\$A4S_BIN"/);
  assert.match(planning, /--no-extensions -e <cached-build>/);
  assert.match(planning, /final native provider\/model/);
});
