import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { gitBuildIdentity } from "./release-identity.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "packages", "issue-lifecycle");
const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
const supported = new Map([["bun-linux-x64", "linux-x64"], ["bun-darwin-arm64", "darwin-arm64"]]);
const targets = [];
let outdir = join(root, "dist");
let testVersion;
let testCommit;
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  if (flag === "--target" && process.argv[index + 1]) targets.push(process.argv[++index]);
  else if (flag === "--outdir" && process.argv[index + 1]) outdir = resolve(process.argv[++index]);
  else if (flag === "--test-version" && process.env.A4S_LIVE_DAGU === "1" && process.argv[index + 1]) testVersion = process.argv[++index];
  else if (flag === "--test-commit" && process.env.A4S_LIVE_DAGU === "1" && process.argv[index + 1]) testCommit = process.argv[++index];
  else throw new Error("Usage: node scripts/build-a4s.mjs [--target bun-linux-x64|bun-darwin-arm64] [--outdir <directory>]");
}
if (!targets.length) targets.push(...supported.keys());
for (const target of targets) if (!supported.has(target)) throw new Error(`Unsupported a4s target: ${target}`);
const build = gitBuildIdentity(root);
const version = testVersion ?? build.version;
if (!/^(?:r(0|[1-9]\d*)|(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))$/.test(version)) throw new Error("Invalid a4s build ID");
const commit = testCommit ?? build.commit;
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("The release build requires a full Git commit SHA");
const bun = join(root, "node_modules", ".bin", "bun");
const identity = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", join(source, "src", "cli.ts"), "version"], { cwd: root, encoding: "utf8" }));
identity.commit = commit;
identity.version = version;
await mkdir(outdir, { recursive: true });
execFileSync(process.execPath, [join(root, "scripts", "build-launcher.mjs"), "--outdir", outdir, ...targets.flatMap(target => ["--target", target])], { cwd: root, stdio: "inherit" });

for (const target of new Set(targets)) {
  const stage = await mkdtemp(join(outdir, ".a4s-build-"));
  try {
    const output = join(stage, "a4s");
    execFileSync(bun, ["build", "--compile", "--compile-autoload-package-json", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
      `--target=${target}`, `--define=A4S_COMPILED=true`, `--define=A4S_RELEASE_EXTENSION=false`,
      `--define=A4S_BUILD_VERSION=${JSON.stringify(version)}`, `--define=A4S_BUILD_COMMIT=${JSON.stringify(commit)}`,
      join(source, "src", "cli.ts"), "--outfile", output], { cwd: root, stdio: "inherit" });
    await chmod(output, 0o755);
    const releaseManifest = { name: manifest.name, version, repository: manifest.repository, private: true, type: "module", exports: manifest.exports, omp: manifest.omp };
    await writeFile(join(stage, "package.json"), `${JSON.stringify(releaseManifest, null, 2)}\n`);
    await writeFile(join(stage, "identity.json"), `${JSON.stringify(identity, null, 2)}\n`);
    await mkdir(join(stage, "bin"));
    for (const name of ["dagu-gate.cjs", "gate-cache.cjs", "gate-cache-run.cjs"]) await copyFile(join(source, "bin", name), join(stage, "bin", name));
    await mkdir(join(stage, "agents"));
    for (const name of ["plan-reviewer.md", "triage-reviewer.md"]) await copyFile(join(source, "agents", name), join(stage, "agents", name));
    await cp(join(source, "skills"), join(stage, "skills"), {
      recursive: true,
      filter: path => !["dagu-feature-bootstrap.yaml", "__pycache__"].includes(path.split("/").at(-1)),
    });
    // Bundle both reloadable entries AND their reload targets. Their own closure
    // (including hot-reload and YAML) must not resolve through a source checkout.
    for (const entry of ["status/reloadable.ts", "status/index.ts", "triage/reloadable.ts", "triage/native.ts"]) {
      const destination = join(stage, "src", entry);
      await mkdir(dirname(destination), { recursive: true });
      execFileSync(bun, ["build", "--target=node", "--format=esm", "--define=A4S_COMPILED=false", "--define=A4S_RELEASE_EXTENSION=true",
        `--define=A4S_BUILD_VERSION=${JSON.stringify(version)}`, `--define=A4S_BUILD_COMMIT=${JSON.stringify(commit)}`,
        join(source, "src", entry), "--outfile", destination], { cwd: root, stdio: "inherit" });
    }
    // Explicit modes, not umask or the source checkout's executable bits, own the
    // tar headers. GNU tar fixes ordering, timestamps and numeric ownership.
    async function modes(directory) {
      await chmod(directory, 0o755);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await modes(path);
        else await chmod(path, path === output ? 0o755 : 0o644);
      }
    }
    await modes(stage);
    const archive = `a4s-${version.startsWith("r") ? version : `v${version}`}-${supported.get(target)}.tar.gz`;
    const archivePath = join(outdir, archive);
    const tar = spawn("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "--format=ustar", "-cf", "-", ...(await readdir(stage)).sort()], {
      cwd: stage, env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "inherit"],
    });
    const finished = new Promise((resolve, reject) => {
      tar.once("error", reject);
      tar.once("exit", code => code === 0 ? resolve() : reject(new Error(`tar exited ${code}`)));
    });
    await Promise.all([pipeline(tar.stdout, createGzip({ level: 9 }), createWriteStream(archivePath)), finished]);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(archivePath)) hash.update(chunk);
    await writeFile(`${archivePath}.sha256`, `${hash.digest("hex")}  ${archive}\n`);
    console.log(archivePath);
  } finally { await rm(stage, { recursive: true, force: true }); }
}
