import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { instancesFromLines } from "../src/instances.mjs";

const FACTORY = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(FACTORY, "src", "instances.mjs");
const LINES = join(FACTORY, "lines.json");
const ROOT = "/repo/packages/factory";

function fixture(providerInstances) {
  const dir = mkdtempSync(join(tmpdir(), "instances-"));
  const settings = join(dir, "settings.json");
  writeFileSync(settings, JSON.stringify({ defaultTheme: "dark", favorites: [1, 2], providerInstances }, null, 2));
  return { dir, settings };
}
const run = (cmd, settings, ...extra) => spawnSync(process.execPath, [CLI, cmd, "--settings", settings, "--prompts-root", ROOT, "--lines", LINES, ...extra], { encoding: "utf8" });
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const foreign = { pi: { driver: "pi", enabled: true, config: { binaryPath: "/x/pi" } }, codex: { driver: "codex", enabled: false } };

test("install merges the lines' instances, keeps foreign keys and settings, backs up, and is idempotent", () => {
  const f = fixture({ ...foreign, "pi-impl": { driver: "pi", enabled: true, config: { binaryPath: "/opt/pi", launchArgs: "--tools read" } } });
  const r = run("install", f.settings);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /~ pi-impl/);
  assert.match(r.stdout, /\+ pi-supervisor \(new\)/);
  assert.match(r.stdout, /backup: .*settings\.json\.bak-/);
  const s = read(f.settings);
  assert.equal(s.defaultTheme, "dark");
  assert.deepEqual(s.favorites, [1, 2]);
  assert.deepEqual(s.providerInstances.pi, foreign.pi);
  assert.deepEqual(s.providerInstances.codex, foreign.codex);
  // the pi binary already configured for pi-impl is kept
  assert.deepEqual(s.providerInstances, { ...foreign, ...instancesFromLines(LINES, "/opt/pi", ROOT) });
  assert.ok(s.providerInstances["pi-supervisor"].config.launchArgs.endsWith(`--append-system-prompt ${ROOT}/prompts/supervisor.md`));
  assert.equal(readdirSync(f.dir).filter((n) => n.includes(".bak-")).length, 1);
  assert.deepEqual(read(join(f.dir, readdirSync(f.dir).find((n) => n.includes(".bak-")))).providerInstances["pi-impl"].config.launchArgs, "--tools read");
  assert.equal(readdirSync(f.dir).filter((n) => n.includes(".tmp-")).length, 0);

  const before = readFileSync(f.settings, "utf8");
  const again = run("install", f.settings);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /already matches/);
  assert.equal(readFileSync(f.settings, "utf8"), before);
  assert.equal(readdirSync(f.dir).filter((n) => n.includes(".bak-")).length, 1, "no backup when nothing changes");
  assert.equal(run("check", f.settings).status, 0);
});

test("check exits 1 and prints the drift; exits 0 once installed", () => {
  const wanted = instancesFromLines(LINES, "/opt/pi", ROOT);
  const drifted = structuredClone(wanted);
  drifted["pi-qa"].config.launchArgs = "--tools read,bash --append-system-prompt /elsewhere/qa.md";
  delete drifted["pi-supervisor"];
  const f = fixture({ ...foreign, ...drifted });
  const r = run("check", f.settings);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /~ pi-qa\n\s+- config\.launchArgs = "--tools read,bash --append-system-prompt \/elsewhere\/qa\.md"\n\s+\+ config\.launchArgs = "--tools read,bash,edit,write,\*web_search/);
  assert.match(r.stdout, /\+ pi-supervisor \(new\)/);
  assert.doesNotMatch(r.stdout, /pi-impl|codex/);
  assert.equal(run("install", f.settings).status, 0);
  assert.equal(run("check", f.settings).status, 0);
});

test("--dry-run prints the diff and writes nothing (no settings change, no backup)", () => {
  const f = fixture({ ...foreign });
  const before = readFileSync(f.settings, "utf8");
  const r = run("install", f.settings, "--dry-run", "--pi", "/bin/pi");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /dry run/);
  assert.match(r.stdout, /\+ pi-impl \(new\)/);
  assert.match(r.stdout, /config\.binaryPath = "\/bin\/pi"/);
  assert.equal(readFileSync(f.settings, "utf8"), before);
  assert.deepEqual(readdirSync(f.dir), ["settings.json"]);
});

test("the supervisor line is an instance without a tool allowlist, not a cycle station", () => {
  const { lines } = read(LINES);
  const sup = lines.supervisor;
  assert.equal(sup.provider, "pi-supervisor");
  assert.equal(sup.instance.prompt, "prompts/supervisor.md");
  assert.equal(sup.instance.tools, undefined);
  assert.equal(sup.model, lines.research.model);
  const inst = instancesFromLines(LINES, "/bin/pi")["pi-supervisor"];
  assert.equal(inst.config.launchArgs, `--append-system-prompt ${join(FACTORY, "prompts", "supervisor.md")}`);
  assert.deepEqual(inst.environment, [{ name: "A4S_LINE", value: "supervisor" }]);
  const cycle = readFileSync(join(FACTORY, "dags", "cycle.yaml"), "utf8");
  assert.doesNotMatch(cycle, /--line supervisor/);
});

test("an unknown command exits 2", () => {
  assert.equal(spawnSync(process.execPath, [CLI, "sync"], { encoding: "utf8" }).status, 2);
});
