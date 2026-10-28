import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after } from "node:test";
import { CONFIG_PATH, exampleConfig, serializeConfig, type LifecycleConfig } from "../../src/config.ts";
import { archiveName, nativePlatform } from "../../src/release.ts";
import { installGithubFixture, packageDirectory, repository, writeReleaseDirectory } from "./artifact.ts";

let compiledDirectory: string | undefined;
let installedDirectory: string | undefined;
function compiledRelease(): string {
  if (compiledDirectory) return compiledDirectory;
  if (process.env.A4S_RELEASE_DIR) return resolve(process.env.A4S_RELEASE_DIR);
  compiledDirectory = mkdtempSync(join(tmpdir(), "a4s-admission-build-"));
  execFileSync(process.execPath, ["scripts/build-a4s.mjs", "--target", `bun-${nativePlatform()}`, "--outdir", compiledDirectory], { cwd: resolve(packageDirectory, "../.."), stdio: "pipe", timeout: 120000 });
  return compiledDirectory;
}
// Deadline/performance fixtures must run the release engine, not repeatedly pay
// Node+tsx source-loader startup inside the operation's wall-clock budget.
export function compiledA4sBin(): string {
  if (!installedDirectory) {
    const releases = compiledRelease();
    installedDirectory = mkdtempSync(join(tmpdir(), "a4s compiled "));
    const { version } = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
    execFileSync("tar", ["-xzf", join(releases, archiveName(version)), "-C", installedDirectory]);
  }
  return join(installedDirectory, "a4s");
}
after(() => {
  if (installedDirectory) rmSync(installedDirectory, { recursive: true, force: true });
  if (compiledDirectory) rmSync(compiledDirectory, { recursive: true, force: true });
});
export function admissionFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dagu-admission-")));
  const packageDir = join(root, "consumer");
  const home = join(root, "dagu-home");
  const releases = join(root, "releases");
  const githubBin = installGithubFixture(join(root, "github-bin"));
  mkdirSync(packageDir);
  mkdirSync(join(home, "dags"), { recursive: true });
  const configPath = join(packageDir, CONFIG_PATH);
  mkdirSync(dirname(configPath), { recursive: true });
  const git = (...args: string[]): string => execFileSync("git", ["-C", packageDir, ...args], { encoding: "utf8" }).trim();
  const writeConfig = (overrides: Partial<LifecycleConfig> = {}): void => {
    writeFileSync(configPath, serializeConfig(exampleConfig({ lane: "fixture", gate: "true", rebaseResolver: "", ...overrides })));
    git("add", CONFIG_PATH);
    if (git("status", "--porcelain", "--", CONFIG_PATH)) git("commit", "-qm", "config");
  };
  git("init", "-b", "main");
  git("config", "user.name", "Admission Test");
  git("config", "user.email", "admission@example.test");
  git("remote", "add", "origin", "https://github.com/example/fixture.git");
  writeConfig();
  const dag = join(packageDir, ".workspace", "dagu", "dags", "feature.yaml");
  const cli = fileURLToPath(new URL("../../bin/dagu-feature-bundle.ts", import.meta.url));
  const command = (subcommand: string, run: string, env: NodeJS.ProcessEnv = {}, params: string[] = [], dagArg = dag, owner = "owner-session") => {
    const directory = compiledRelease();
    const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
    const version = manifest.version as string;
    const archive = archiveName(version);
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: packageDirectory, encoding: "utf8" }).trim();
    writeReleaseDirectory(releases, { repository, moving: { v0: commit }, releases: [{ tag_name: `v${version}`, commit }] });
    for (const file of [archive, `${archive}.sha256`]) cpSync(join(directory, file), join(releases, file));
    return spawnSync(process.execPath, [cli, subcommand, "--run-id", run, dagArg, "--", "ISSUE=277", ...(params.some(param => param.startsWith("OMP_SESSION_ID=")) || !owner ? [] : [`OMP_SESSION_ID=${owner}`]), ...params], { cwd: packageDir,
      env: { ...process.env, DAGU_HOME: home, A4S_PRIMARY: packageDir, ...env, PATH: `${githubBin}:${env.PATH ?? process.env.PATH ?? ""}`, A4S_FIXTURE_RELEASES: releases }, encoding: "utf8", timeout: 30000 });
  };
  const receipt = (run: string): string => join(packageDir, ".git", "dagu-feature", "runs", run, "receipt.json");
  const observe = (run: string, observation: object) => spawnSync(process.execPath, [cli, "observe", run, JSON.stringify(observation)], { cwd: packageDir, env: { ...process.env, DAGU_HOME: home, A4S_PRIMARY: packageDir }, encoding: "utf8" });
  const previousDaguHome = process.env.DAGU_HOME;
  const previousPrimary = process.env.A4S_PRIMARY;
  process.env.DAGU_HOME = home;
  process.env.A4S_PRIMARY = packageDir;
  writeFileSync(join(home, "config.yaml"), "coordinator:\n  enabled: false\n");
  writeFileSync(join(home, "a4s-primary"), `${packageDir}\n`);
  const dispose = (): void => {
    if (previousDaguHome === undefined) delete process.env.DAGU_HOME; else process.env.DAGU_HOME = previousDaguHome;
    if (previousPrimary === undefined) delete process.env.A4S_PRIMARY; else process.env.A4S_PRIMARY = previousPrimary;
    rmSync(root, { recursive: true, force: true });
  };
  return { root, packageDir, home, releases, dag, cli, command, receipt, observe, writeConfig, configPath, dispose };
}
