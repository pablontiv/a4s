import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_PATH, exampleConfig, serializeConfig, type LifecycleConfig } from "../../src/config.ts";

/** Genuine committed consumer policy, without binary builds or PATH fixtures. */
export function inProcessAdmissionFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a4s-admission-unit-")));
  const packageDir = join(root, "consumer"), home = join(root, "dagu-home");
  mkdirSync(packageDir); mkdirSync(join(home, "dags"), { recursive: true });
  const configPath = join(packageDir, CONFIG_PATH);
  mkdirSync(dirname(configPath), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", packageDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const writeConfig = (overrides: Partial<LifecycleConfig> = {}) => {
    writeFileSync(configPath, serializeConfig(exampleConfig({ lane: "fixture", gate: "true", rebaseResolver: "", ...overrides })));
    git("add", CONFIG_PATH);
    if (git("status", "--porcelain", "--", CONFIG_PATH)) git("commit", "-qm", "config");
  };
  git("init", "-b", "main"); git("config", "user.name", "Admission Test"); git("config", "user.email", "admission@example.test");
  // Background Git maintenance must not change metadata during read-only snapshots.
  git("config", "maintenance.auto", "false");
  git("remote", "add", "origin", "https://github.com/example/fixture.git"); writeConfig();
  const previous = { DAGU_HOME: process.env.DAGU_HOME, A4S_PRIMARY: process.env.A4S_PRIMARY };
  process.env.DAGU_HOME = home; process.env.A4S_PRIMARY = packageDir;
  writeFileSync(join(home, "config.yaml"), "coordinator:\n  enabled: false\n");
  writeFileSync(join(home, "a4s-primary"), `${packageDir}\n`);
  const receipt = (run: string) => join(packageDir, ".git", "dagu-feature", "runs", run, "receipt.json");
  return { root, packageDir, home, configPath, writeConfig, receipt,
    dag: join(packageDir, ".workspace", "dagu", "dags", "feature.yaml"),
    dispose() {
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
