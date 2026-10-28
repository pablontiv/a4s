import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BUNDLE_VERSION } from "../src/bundle.ts";
import { CONFIG_PATH, exampleConfig, serializeConfig } from "../src/config.ts";
import {
  HOST_PRIMARY_REFERENCE,
  bindSnapshotPrimary,
  primaryFromSpec,
  resolveHostPrimary,
  resolvePrimaryBinding,
} from "../src/primary.ts";
import { resourceDecision } from "../src/resources.ts";
import { admissionFixture } from "./fixtures/admission.ts";
import { bootstrapRender } from "./fixtures/bootstrap-render.ts";

const packageDir = fileURLToPath(new URL("../", import.meta.url));
const readRepo = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const feature = readRepo("../skills/issue-execution/feature.yaml");
const poc = readRepo("../skills/issue-execution/poc.yaml");
const reconcile = readRepo("../skills/issue-execution/reconcile.yaml");

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  assert.ok(start >= 0, name);
  let depth = 0;
  let quote = "";
  for (let index = start; index < source.length; index++) {
    const char = source[index]!;
    if (quote) {
      if (char === "\\" && quote !== "'") { index++; continue; }
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unclosed ${name}`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

test("bootstrap renders the same host PRIMARY on a Mac path and a Linux path", () => {
  const root = mkdtempSync(join(tmpdir(), "a4s-primary-render-"));
  try {
    const render = (primary: string, directory: string): void => {
      bootstrapRender({
        packageDir, directory, primary, version: BUNDLE_VERSION,
        sourceNwo: "fixture/repo", sourceSha: "a".repeat(40),
      });
    };
    const macPrimary = join(root, "Users", "Shared", "harness", "a4s");
    const linuxPrimary = join(root, "home", "box", "src", "a4s");
    const mac = join(root, "mac-out");
    const linux = join(root, "linux-out");
    mkdirSync(macPrimary, { recursive: true });
    mkdirSync(linuxPrimary, { recursive: true });
    mkdirSync(mac);
    mkdirSync(linux);
    render(macPrimary, mac);
    render(linuxPrimary, linux);
    for (const name of ["feature.yaml", "poc.yaml"]) {
      const left = readFileSync(join(mac, name), "utf8");
      const right = readFileSync(join(linux, name), "utf8");
      assert.equal(left, right);
      assert.match(left, /PRIMARY: "\$\{A4S_PRIMARY\}"/);
      assert.equal(left.includes("__PRIMARY__"), false);
      assert.equal(left.includes(macPrimary), false);
      assert.equal(left.includes(linuxPrimary), false);
      assert.equal(left.includes("/Users/Shared/harness/a4s"), false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("host PRIMARY resolves workspace file, then A4S_PRIMARY, then the station file", () => {
  const root = mkdtempSync(join(tmpdir(), "a4s-primary-host-"));
  const workspace = join(root, "primaries");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "a4s"), "/home/box/src/a4s\n");
  writeFileSync(join(root, "a4s-primary"), "/station/shared\n");
  try {
    const env = { DAGU_HOME: root, A4S_PRIMARY: "/station/env" };
    assert.equal(resolveHostPrimary({ workspace: "a4s", env }), "/home/box/src/a4s");
    assert.equal(resolveHostPrimary({ workspace: "other", env }), "/station/env");
    assert.equal(resolveHostPrimary({ env: { DAGU_HOME: root } }), "/station/shared");
    assert.equal(resolvePrimaryBinding("/already/recorded", { env }), "/already/recorded");
    assert.equal(resolvePrimaryBinding(HOST_PRIMARY_REFERENCE, { env }), "/station/env");
    assert.throws(() => resolveHostPrimary({ env: { DAGU_HOME: join(root, "missing") } }), /PRIMARY host binding is unset/);
    assert.throws(() => resolveHostPrimary({ env: { ...env, A4S_PRIMARY: "relative" } }), /A4S_PRIMARY must be an absolute/);
    writeFileSync(join(root, "a4s-primary"), "relative\n");
    assert.throws(() => resolveHostPrimary({ env: { DAGU_HOME: root } }), /must contain one absolute path/);
    assert.throws(() => resolvePrimaryBinding("${OTHER}", { env }), /PRIMARY binding must be an absolute path/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("spec recovery keeps a recorded path and resolves the host reference", () => {
  const root = mkdtempSync(join(tmpdir(), "a4s-primary-spec-"));
  try {
    const recorded = "/tmp/Repo con espacio/ñ";
    assert.equal(primaryFromSpec(`env:\n  - PRIMARY: ${JSON.stringify(recorded)}\n`), recorded);
    const spec = `labels:\n  - workspace=a4s\nenv:\n  - PRIMARY: "${HOST_PRIMARY_REFERENCE}"\n`;
    writeFileSync(join(root, "a4s-primary"), "/home/box/src/a4s\n");
    assert.equal(primaryFromSpec(spec, { DAGU_HOME: root }), "/home/box/src/a4s");
    const bound = bindSnapshotPrimary(spec, "/home/box/src/a4s");
    assert.match(bound, /PRIMARY: "\/home\/box\/src\/a4s"/);
    assert.equal(bound.includes(HOST_PRIMARY_REFERENCE), false);
    const legacy = `env:\n  - PRIMARY: "/already"\n`;
    assert.equal(bindSnapshotPrimary(legacy, "/other"), legacy);
    assert.throws(() => primaryFromSpec("env:\n  - PRIMARY: not-json\n"), SyntaxError);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("feature and reconcile templates share the shell PRIMARY contract", () => {
  const binding = extractFunction(feature, "resolve_primary_binding");
  assert.equal(extractFunction(reconcile, "resolve_primary_binding"), binding);
  const root = mkdtempSync(join(tmpdir(), "a4s-primary-shell-"));
  mkdirSync(join(root, "primaries"));
  writeFileSync(join(root, "primaries", "a4s"), "/home/box/src/a4s\n");
  writeFileSync(join(root, "a4s-primary"), "/station/shared\n");
  const run = (value: string, workspace: string, env: NodeJS.ProcessEnv) => spawnSync("bash", ["-c", `${binding}\nresolve_primary_binding ${shellQuote(value)} ${shellQuote(workspace)}`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: root, ...env },
  });
  try {
    const specific = run(HOST_PRIMARY_REFERENCE, "a4s", { DAGU_HOME: root, A4S_PRIMARY: "/station/env" });
    assert.equal(specific.status, 0, specific.stderr);
    assert.equal(specific.stdout, "/home/box/src/a4s\n");
    const fromEnv = run(HOST_PRIMARY_REFERENCE, "", { DAGU_HOME: root, A4S_PRIMARY: "/station/env" });
    assert.equal(fromEnv.status, 0, fromEnv.stderr);
    assert.equal(fromEnv.stdout, "/station/env\n");
    const shared = run(HOST_PRIMARY_REFERENCE, "missing", { DAGU_HOME: root });
    assert.equal(shared.status, 0, shared.stderr);
    assert.equal(shared.stdout, "/station/shared\n");
    const recorded = run("/tmp/Repo con espacio/ñ", "", {});
    assert.equal(recorded.status, 0, recorded.stderr);
    assert.equal(recorded.stdout, "/tmp/Repo con espacio/ñ\n");
    const missing = run(HOST_PRIMARY_REFERENCE, "", { DAGU_HOME: join(root, "absent") });
    assert.equal(missing.status, 1);
    const relative = run("relative/checkout", "", {});
    assert.equal(relative.status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("feature and poc templates do not advertise a foreign absolute PRIMARY", () => {
  for (const text of [feature, poc]) {
    assert.equal(text.includes("/Users/Shared/harness/a4s"), false);
    assert.match(text, /PRIMARY: __PRIMARY__/);
  }
});

test("feature admission rejects an A4S_PRIMARY run parameter", () => {
  const admission = feature.split("  - id: admission\n")[1]!.split("\n  - id: triage")[0]!;
  const script = admission.split("    run: |\n")[1]!.split("\n").map(line => line.slice(6)).join("\n");
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8", env: {
    ...process.env,
    DAGU_PARAMS_JSON: JSON.stringify({ A4S_PRIMARY: "/foreign" }),
    PRIMARY: "/consumer", GATE: "true", REBASE_RESOLVER: "", REQUIRED_CHECK: "validate",
    BRANCH: "dagu/issue-659", CODE_SCANNING: "required",
  } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /admission rejected run parameter: A4S_PRIMARY/);
});

test("enqueue records the resolved checkout and leaves the durable render portable", () => {
  const fixture = admissionFixture();
  const bin = join(fixture.root, "bin");
  mkdirSync(bin);
  const dagu = join(bin, "dagu");
  writeFileSync(dagu, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "version") console.log("2.24.0");
else if (args[0] === "enqueue") console.log("fixture enqueue");
else { console.error("unexpected " + JSON.stringify(args)); process.exitCode = 1; }
`);
  chmodSync(dagu, 0o755);
  try {
    assert.equal(existsSync(fixture.dag), false);
    const admitted = fixture.command("admit", "primary-bound", { PATH: `${bin}:${process.env.PATH ?? ""}` });
    assert.equal(admitted.status, 0, admitted.stderr);
    const receipt = JSON.parse(readFileSync(fixture.receipt("primary-bound"), "utf8"));
    assert.equal(receipt.initial.execution.primary, fixture.packageDir);
    const unbound = receipt.initial.deployment.installedDAG.snapshot as string;
    assert.match(unbound, /PRIMARY: "\$\{A4S_PRIMARY\}"/);
    assert.equal(unbound.includes(fixture.packageDir), false);
    const snapshot = receipt.initial.execution.dagSnapshot as string;
    assert.equal(/^  - PRIMARY: (.+)$/m.exec(snapshot)?.[1], JSON.stringify(fixture.packageDir));
    assert.equal(existsSync(fixture.dag), false);
    const enqueued = fixture.command("enqueue", "primary-enqueued", { PATH: `${bin}:${process.env.PATH ?? ""}` });
    assert.equal(enqueued.status, 0, enqueued.stderr);
    assert.equal(readFileSync(join(fixture.receipt("primary-enqueued"), "..", "snapshot", "feature.yaml"), "utf8"), JSON.parse(readFileSync(fixture.receipt("primary-enqueued"), "utf8")).initial.execution.dagSnapshot);
  } finally { fixture.dispose(); }
});

for (const source of ["workspace", "environment", "station"]) {
  test(`resource guard protects an idle committed PRIMARY via ${source} binding, not an identical clone`, async t => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "a4s-primary-guard-")));
    const primary = join(root, "primary");
    const scratch = join(root, "scratch");
    const unadopted = join(root, "unadopted");
    const alias = join(root, "primary alias");
    const bin = join(root, "bin");
    const previous = { PATH: process.env.PATH, A4S_PRIMARY: process.env.A4S_PRIMARY, DAGU_HOME: process.env.DAGU_HOME };
    const git = (cwd: string, ...args: string[]) => {
      const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    });
    mkdirSync(bin);
    writeFileSync(join(bin, "dagu"), "#!/bin/sh\nprintf '[]\\n'\n");
    chmodSync(join(bin, "dagu"), 0o755);
    process.env.PATH = `${bin}:${previous.PATH ?? ""}`;
    process.env.DAGU_HOME = root;
    delete process.env.A4S_PRIMARY;
    for (const repo of [primary, unadopted]) {
      git(root, "init", "-q", "-b", "main", repo);
      git(repo, "config", "user.name", "Test");
      git(repo, "config", "user.email", "test@example.com");
      writeFileSync(join(repo, "value"), "base\n");
      if (repo === primary) {
        mkdirSync(join(repo, ".workspace", "dagu"), { recursive: true });
        writeFileSync(join(repo, CONFIG_PATH), serializeConfig(exampleConfig({ lane: "guard-fixture" })));
      }
      git(repo, "add", ".");
      git(repo, "commit", "-qm", "base");
    }
    git(root, "clone", "-q", primary, scratch);
    symlinkSync(primary, alias);
    const binding = source === "workspace" ? join(root, "primaries", "guard-fixture") : join(root, "a4s-primary");
    mkdirSync(join(root, "primaries"));
    const bind = (path: string) => {
      if (source === "environment") process.env.A4S_PRIMARY = path;
      else writeFileSync(binding, `${path}\n`);
    };
    // Workspace bindings must take precedence over both lower-priority sources.
    if (source === "workspace") process.env.A4S_PRIMARY = scratch;
    if (source !== "station") writeFileSync(join(root, "a4s-primary"), `${scratch}\n`);
    bind(alias);
    assert.equal(existsSync(join(primary, ".workspace", "dagu", "dags")), false);
    const event = (command: string) => ({ toolName: "bash", toolCallId: command, input: { command } });
    for (const command of [
      `rm -rf '${primary}'`, `rm -rf '${alias}'`,
      `git worktree remove '${primary}'`, `git -C '${primary}' branch -D main`,
    ]) {
      const decision = await resourceDecision(event(command), scratch);
      assert.ok(decision && "block" in decision && decision.block, command);
      assert.match(decision.reason!, /protected primary/);
    }
    const ancestorDecision = await resourceDecision(event(`rm -rf '${root}'`), primary);
    assert.ok(ancestorDecision && "block" in ancestorDecision && ancestorDecision.block);
    assert.match(ancestorDecision.reason!, /protected primary/);
    for (const command of [`rm -rf '${scratch}'`, `git -C '${scratch}' branch -D main`]) {
      assert.equal(await resourceDecision(event(command), primary), undefined, command);
    }
    bind(unadopted);
    const dags = join(unadopted, ".workspace", "dagu", "dags");
    mkdirSync(dags, { recursive: true });
    writeFileSync(join(dags, "feature.yaml"), `env:\n  - PRIMARY: ${JSON.stringify(unadopted)}\n`);
    for (const command of [`rm -rf '${unadopted}'`, `git -C '${unadopted}' branch -D main`]) {
      assert.equal(await resourceDecision(event(command), primary), undefined, command);
    }
    // A working-tree policy alone does not adopt a checkout.
    writeFileSync(join(unadopted, CONFIG_PATH), readFileSync(join(primary, CONFIG_PATH)));
    assert.equal(await resourceDecision(event(`rm -rf '${unadopted}'`), primary), undefined);
  });
}
