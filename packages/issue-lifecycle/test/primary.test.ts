import assert from "node:assert/strict";
import { stationEnv, useStation } from "./fixtures/service-environment.ts";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CONFIG_PATH, exampleConfig, serializeConfig } from "@a4s/launcher/config";
import {
  HOST_PRIMARY_REFERENCE,
  bindSnapshotPrimary,
  primaryFromSpec,
  resolveHostPrimary,
  resolvePrimaryBinding,
} from "@a4s/launcher/primary";
import { resourceDecision as decideResources } from "../src/resources.ts";
import { main } from "../src/cli.ts";

const readRepo = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const feature = readRepo("../skills/issue-execution/feature.yaml");
const poc = readRepo("../skills/issue-execution/poc.yaml");
const reconcile = readRepo("../skills/issue-execution/reconcile.yaml");

const resourceDecision: typeof decideResources = (event, cwd) =>
  decideResources(event, cwd, async () => ({ stdout: "[]" }));


test("host PRIMARY resolves workspace file, then A4S_PRIMARY, then the station file", () => {
  const root = mkdtempSync(join(tmpdir(), "a4s-primary-host-"));
  const workspace = join(root, "primaries");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "a4s"), "/home/box/src/a4s\n");
  writeFileSync(join(root, "a4s-primary"), "/station/shared\n");
  try {
    const env = { ...stationEnv(root), A4S_PRIMARY: "/station/env" };
    assert.equal(resolveHostPrimary({ workspace: "a4s", env }), "/home/box/src/a4s");
    assert.equal(resolveHostPrimary({ workspace: "other", env }), "/station/env");
    assert.equal(resolveHostPrimary({ env: stationEnv(root) }), "/station/shared");
    assert.equal(resolvePrimaryBinding("/already/recorded", { env }), "/already/recorded");
    assert.equal(resolvePrimaryBinding(HOST_PRIMARY_REFERENCE, { env }), "/station/env");
    assert.throws(() => resolveHostPrimary({ env: stationEnv(join(root, "missing")) }), /PRIMARY host binding is unset/);
    assert.throws(() => resolveHostPrimary({ env: { ...env, A4S_PRIMARY: "relative" } }), /A4S_PRIMARY must be an absolute/);
    writeFileSync(join(root, "a4s-primary"), "relative\n");
    assert.throws(() => resolveHostPrimary({ env: stationEnv(root) }), /must contain one absolute path/);
    assert.throws(() => resolvePrimaryBinding("${OTHER}", { env }), /PRIMARY binding must be an absolute path/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("host PRIMARY rejects CRLF path files instead of normalizing them", () => {
  const root = mkdtempSync(join(tmpdir(), "a4s-primary-crlf-"));
  mkdirSync(join(root, "primaries"));
  try {
    const env = stationEnv(root);
    writeFileSync(join(root, "a4s-primary"), "/station/shared\r\n");
    assert.throws(() => resolvePrimaryBinding(HOST_PRIMARY_REFERENCE, { env }), /must contain one absolute path/);
    writeFileSync(join(root, "primaries", "a4s"), "/station/workspace\r\n");
    assert.throws(() => resolvePrimaryBinding(HOST_PRIMARY_REFERENCE, {
      workspace: "a4s", env: { ...env, A4S_PRIMARY: "/station/env" },
    }), /must contain one absolute path/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("host PRIMARY rejects invalid workspace labels even with an environment fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "a4s-primary-label-"));
  try {
    const env = { ...stationEnv(root), A4S_PRIMARY: "/station/env" };
    for (const workspace of ["../foreign", "two/segments", "with space", ""]) {
      assert.throws(() => resolvePrimaryBinding(HOST_PRIMARY_REFERENCE, { workspace, env }),
        /workspace label is not a single path segment/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("primary-binding CLI delegates to the TypeScript resolver", async t => {
  const root = mkdtempSync(join(tmpdir(), "a4s-primary-command-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.after(useStation(root));
  const previous = process.env.A4S_PRIMARY;
  process.env.A4S_PRIMARY = "/station/env";
  t.after(() => {
    if (previous === undefined) delete process.env.A4S_PRIMARY;
    else process.env.A4S_PRIMARY = previous;
  });
  const log = t.mock.method(console, "log", () => {});
  await main(["primary-binding", HOST_PRIMARY_REFERENCE, ""]);
  await main(["primary-binding", "/recorded checkout"]);
  assert.deepEqual(log.mock.calls.map(call => call.arguments), [["/station/env"], ["/recorded checkout"]]);
  await assert.rejects(main(["primary-binding", HOST_PRIMARY_REFERENCE, "../invalid"]), /workspace label/);
  writeFileSync(join(root, "a4s-primary"), "/station/shared\r\n");
  delete process.env.A4S_PRIMARY;
  await assert.rejects(main(["primary-binding", HOST_PRIMARY_REFERENCE]), /must contain one absolute path/);
  await assert.rejects(main(["primary-binding"]), /Usage: a4s primary-binding/);
  await assert.rejects(main(["primary-binding", "/recorded", "label", "extra"]), /Usage: a4s primary-binding/);
});

test("spec recovery keeps a recorded path and resolves the host reference", () => {
  const root = mkdtempSync(join(tmpdir(), "a4s-primary-spec-"));
  try {
    const recorded = "/tmp/Repo con espacio/ñ";
    assert.equal(primaryFromSpec(`env:\n  - PRIMARY: ${JSON.stringify(recorded)}\n`), recorded);
    const spec = `labels:\n  - workspace=a4s\nenv:\n  - PRIMARY: "${HOST_PRIMARY_REFERENCE}"\n`;
    writeFileSync(join(root, "a4s-primary"), "/home/box/src/a4s\n");
    assert.equal(primaryFromSpec(spec, stationEnv(root)), "/home/box/src/a4s");
    const bound = bindSnapshotPrimary(spec, "/home/box/src/a4s");
    assert.match(bound, /PRIMARY: "\/home\/box\/src\/a4s"/);
    assert.equal(bound.includes(HOST_PRIMARY_REFERENCE), false);
    const legacy = `env:\n  - PRIMARY: "/already"\n`;
    assert.equal(bindSnapshotPrimary(legacy, "/other"), legacy);
    assert.throws(() => primaryFromSpec("env:\n  - PRIMARY: not-json\n"), SyntaxError);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("feature and reconcile templates delegate PRIMARY resolution to a4s", () => {
  for (const text of [feature, poc, reconcile]) assert.doesNotMatch(text, /resolve_primary_binding/);
  assert.equal(feature.match(/"\$A4S_BIN" primary-binding "\$candidate" "\$workspace"/g)?.length, 2);
  assert.match(reconcile, /"\$A4S_BIN" primary-binding "\$primary" "\$workspace"/);
});

test("feature and poc templates do not advertise a foreign absolute PRIMARY", () => {
  for (const text of [feature, poc]) {
    assert.equal(text.includes("/Users/Shared/harness/a4s"), false);
    assert.match(text, /PRIMARY: __PRIMARY__/);
  }
});


for (const source of ["workspace", "environment", "station"]) {
  test(`resource guard protects an idle committed PRIMARY via ${source} binding, not an identical clone`, async t => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "a4s-primary-guard-")));
    const primary = join(root, "primary");
    const scratch = join(root, "scratch");
    const unadopted = join(root, "unadopted");
    const alias = join(root, "primary alias");
    const previous = { A4S_PRIMARY: process.env.A4S_PRIMARY, DAGU_HOME: process.env.DAGU_HOME };
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
    t.after(useStation(root));
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
