import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_PATH, exampleConfig, serializeConfig, type LifecycleConfig } from "../../src/config.ts";

export function admissionFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dagu-admission-")));
  const packageDir = join(root, "package");
  const home = join(root, "dagu-home");
  mkdirSync(packageDir);
  mkdirSync(join(root, "node_modules"));
  symlinkSync(fileURLToPath(new URL("./", import.meta.resolve("yaml/package.json"))), join(root, "node_modules", "yaml"));
  mkdirSync(join(home, "dags"), { recursive: true });
  for (const entry of ["src", "bin", "skills", "agents", "package.json"]) cpSync(fileURLToPath(new URL(`../../${entry}`, import.meta.url)), join(packageDir, entry), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  manifest.version = "0.3.1";
  writeFileSync(join(packageDir, "package.json"), JSON.stringify(manifest));
  const configPath = join(packageDir, CONFIG_PATH);
  mkdirSync(dirname(configPath), { recursive: true });
  const git = (...args: string[]): string => execFileSync("git", ["-C", packageDir, ...args], { encoding: "utf8" }).trim();
  const writeConfig = (overrides: Partial<LifecycleConfig> = {}): void => {
    writeFileSync(configPath, serializeConfig(exampleConfig({ lane: "fixture", queueConcurrency: 1, gate: "true", rebaseResolver: "", ...overrides })));
    git("add", CONFIG_PATH);
    if (git("status", "--porcelain", "--", CONFIG_PATH)) git("commit", "-qm", "config");
  };
  writeFileSync(configPath, serializeConfig(exampleConfig({ lane: "fixture", queueConcurrency: 1, gate: "true", rebaseResolver: "" })));
  git("init", "-b", "main");
  git("config", "user.name", "Admission Test");
  git("config", "user.email", "admission@example.test");
  git("remote", "add", "origin", "https://github.com/example/fixture.git");
  git("add", ".");
  git("commit", "-qm", "fixture package 0.3.1");
  const dag = join(packageDir, ".workspace", "dagu", "dags", "feature.yaml");
  const cli = join(packageDir, "bin", "dagu-feature-bundle.ts");
  const command = (subcommand: string, run: string, env: NodeJS.ProcessEnv = {}, params: string[] = [], dagArg = dag) => spawnSync(process.execPath, [cli, subcommand, "--run-id", run, dagArg, "--", "ISSUE=277", ...params], { cwd: packageDir, env: { ...process.env, DAGU_HOME: home, A4S_PRIMARY: packageDir, ...env }, encoding: "utf8", timeout: 30000 });
  const receipt = (run: string): string => join(packageDir, ".git", "dagu-feature", "runs", run, "receipt.json");
  const observe = (run: string, observation: object) => spawnSync(process.execPath, [cli, "observe", run, JSON.stringify(observation)], { cwd: packageDir, env: { ...process.env, DAGU_HOME: home, A4S_PRIMARY: packageDir }, encoding: "utf8" });
  const previousDaguHome = process.env.DAGU_HOME;
  const previousPrimary = process.env.A4S_PRIMARY;
  process.env.DAGU_HOME = home;
  process.env.A4S_PRIMARY = packageDir;
  writeFileSync(join(home, "config.yaml"), "coordinator:\n  enabled: false\n");
  writeFileSync(join(home, "a4s-primary"), `${packageDir}\n`);
  const dispose = (): void => {
    if (previousDaguHome === undefined) delete process.env.DAGU_HOME;
    else process.env.DAGU_HOME = previousDaguHome;
    if (previousPrimary === undefined) delete process.env.A4S_PRIMARY;
    else process.env.A4S_PRIMARY = previousPrimary;
    rmSync(root, { recursive: true, force: true });
  };
  return { root, packageDir, home, dag, cli, command, receipt, observe, writeConfig, configPath, dispose };
}
