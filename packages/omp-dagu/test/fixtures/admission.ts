import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function admissionFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dagu-admission-")));
  const packageDir = join(root, "package");
  const home = join(root, "dagu-home");
  mkdirSync(packageDir);
  mkdirSync(join(home, "dags"), { recursive: true });
  for (const entry of ["src", "bin", "skills", "agents", "package.json"]) cpSync(fileURLToPath(new URL(`../../${entry}`, import.meta.url)), join(packageDir, entry), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  manifest.version = "0.3.1";
  writeFileSync(join(packageDir, "package.json"), JSON.stringify(manifest));
  const git = (...args: string[]): string => execFileSync("git", ["-C", packageDir, ...args], { encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Admission Test");
  git("config", "user.email", "admission@example.test");
  git("remote", "add", "origin", "https://github.com/example/fixture.git");
  git("add", ".");
  git("commit", "-qm", "fixture package 0.3.1");
  const commit = git("rev-parse", "HEAD");
  const dag = join(packageDir, ".workspace", "dagu", "dags", "feature.yaml");
  mkdirSync(join(packageDir, ".workspace", "dagu", "dags"), { recursive: true });
  const render = (name: string, destination: string, version = "0.3.1"): void => {
    const stamp = `@a4s/omp-dagu@${version} source=example/fixture@${commit} bootstrap=bootstrap-fixture dagu=2.20.1`;
    const identity = `dagu-feature-bundle=${version} source=example/fixture@${commit} bootstrap=bootstrap-fixture`;
    const substitutions: Record<string, string> = { __DAGU_FEATURE_STAMP__: stamp, __DAGU_FEATURE_VERSION__: version, __DAGU_FEATURE_IDENTITY__: identity, TEMPLATE_DAGU_FEATURE_VERSION: version, TEMPLATE_REPO: "fixture", TEMPLATE_BASE_BRANCH: '"main"', __GATE__: '"true"', __REBASE_RESOLVER__: '""', __REQUIRED_CHECK__: '"gate"', __VALIDATION__: '""', __PRIMARY__: JSON.stringify(packageDir), __TEST_PATHS__: '"test"' };
    const template = readFileSync(join(packageDir, "skills", "dagu-feature", name), "utf8");
    writeFileSync(destination, template.replace(/__[A-Z_]+__|TEMPLATE_[A-Z_]+/g, key => substitutions[key] ?? key));
  };
  render("feature.yaml", dag);
  render("reconcile.yaml", join(home, "dags", "reconcile.yaml"));
  writeFileSync(join(home, "config.yaml"), "coordinator:\n  enabled: false\n");
  const cli = join(packageDir, "bin", "dagu-feature-bundle.ts");
  const command = (subcommand: string, run: string, env: NodeJS.ProcessEnv = {}, params: string[] = []) => spawnSync(process.execPath, [cli, subcommand, "--run-id", run, dag, "--", "ISSUE=277", ...params], { cwd: packageDir, env: { ...process.env, DAGU_HOME: home, ...env }, encoding: "utf8", timeout: 30000 });
  const receipt = (run: string): string => join(packageDir, ".git", "dagu-feature", "runs", run, "receipt.json");
  const observe = (run: string, observation: object) => spawnSync(process.execPath, [cli, "observe", run, JSON.stringify(observation)], { cwd: packageDir, env: { ...process.env, DAGU_HOME: home }, encoding: "utf8" });
  const previousDaguHome = process.env.DAGU_HOME;
  process.env.DAGU_HOME = home;
  const dispose = (): void => {
    if (previousDaguHome === undefined) delete process.env.DAGU_HOME;
    else process.env.DAGU_HOME = previousDaguHome;
    rmSync(root, { recursive: true, force: true });
  };
  return { root, packageDir, home, dag, cli, command, receipt, observe, render, dispose };
}
