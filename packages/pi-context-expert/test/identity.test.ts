import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "../..");

function text(path: string): string {
  return readFileSync(path, "utf8");
}

interface PackageManifest {
  name?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function manifest(path: string): PackageManifest {
  return JSON.parse(text(path)) as PackageManifest;
}

test("the active extension exposes only the pi-context-expert identity", () => {
  assert.equal(basename(packageRoot), "pi-context-expert");

  const packageManifest = JSON.parse(text(resolve(packageRoot, "package.json"))) as { name?: string };
  assert.equal(packageManifest.name, "@a4s/pi-context-expert");

  const workspaceManifest = text(resolve(workspaceRoot, "package.json"));
  assert.match(workspaceManifest, /@a4s\/pi-context-expert/);
  assert.doesNotMatch(workspaceManifest, /@a4s\/pi-rule-compiler/);

  const configSource = text(resolve(packageRoot, "src/config.ts"));
  assert.match(configSource, /pi-context-expert\.json/);
  assert.doesNotMatch(configSource, /pi-rule-compiler\.json/);

  const storageSource = text(resolve(packageRoot, "src/storage.ts"));
  assert.match(storageSource, /a4s\.pi-context-expert\./);
  assert.doesNotMatch(storageSource, /a4s\.pi-rule-compiler\./);



  const gitignore = text(resolve(workspaceRoot, ".gitignore"));
  assert.match(gitignore, /^artifacts\/pi-context-expert-e2e\/$/m);
  assert.doesNotMatch(gitignore, /^artifacts\/pi-rule-compiler-e2e\/$/m);
});

test("Pion is the runtime peer while legacy Pi ABI types stay development-only", () => {
  const legacyMinimum = ">=0.99.1";
  const pionVersion = "1.0.0-ports.1";
  const pionArtifact =
    "https://github.com/pablontiv/pi/releases/download/pion-v1.0.0-ports.1/pablontiv-pion-1.0.0-ports.1.tgz";
  const workspace = manifest(resolve(workspaceRoot, "package.json"));
  const contextExpert = manifest(resolve(packageRoot, "package.json"));

  assert.equal(workspace.devDependencies?.["@earendil-works/pi-coding-agent"], legacyMinimum);
  assert.equal(contextExpert.peerDependencies?.["@pablontiv/pion"], pionVersion);
  assert.equal(contextExpert.peerDependencies?.["@earendil-works/pi-coding-agent"], undefined);
  assert.equal(contextExpert.devDependencies?.["@earendil-works/pi-coding-agent"], legacyMinimum);
  assert.equal(contextExpert.devDependencies?.["@earendil-works/pi-ai"], legacyMinimum);
  assert.equal(contextExpert.devDependencies?.["@pablontiv/pion"], pionArtifact);
  for (const hostPackage of [
    "@pablontiv/pion",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-ai",
  ]) {
    assert.equal(contextExpert.dependencies?.[hostPackage], undefined);
  }
});
