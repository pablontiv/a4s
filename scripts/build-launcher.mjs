import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const targets = new Map([["bun-linux-x64", "linux-x64"], ["bun-darwin-arm64", "darwin-arm64"]]);
const selected = [];
let outdir = join(root, "dist");
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === "--target" && targets.has(process.argv[index + 1])) selected.push(process.argv[++index]);
  else if (arg === "--outdir" && process.argv[index + 1]) outdir = resolve(process.argv[++index]);
  else throw new Error("Usage: build-launcher.mjs [--target bun-linux-x64|bun-darwin-arm64] [--outdir <directory>]");
}
await mkdir(outdir, { recursive: true });
for (const target of new Set(selected.length ? selected : targets.keys())) {
  const stage = await mkdtemp(join(outdir, ".a4s-launch-"));
  try {
    const binary = join(stage, "a4s-launch");
    // Protocol/repository constants belong to this source closure, not a payload identity.
    execFileSync(join(root, "node_modules", ".bin", "bun"), ["build", "--compile", "--compile-autoload-package-json", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", `--target=${target}`, "--define=A4S_COMPILED=true", join(root, "packages/launcher/src/cli.ts"), "--outfile", binary], { cwd: root, stdio: "inherit" });
    await chmod(binary, 0o755);
    await copyFile(join(root, "packages/launcher/reconcile.yaml"), join(stage, "reconcile.yaml"));
    await chmod(join(stage, "reconcile.yaml"), 0o644);
    const name = `a4s-launch-${targets.get(target)}.tar.gz`, archive = join(outdir, name);
    execFileSync("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "--format=ustar", "-czf", archive, "a4s-launch", "reconcile.yaml"], { cwd: stage, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    await writeFile(`${archive}.sha256`, `${hash.digest("hex")}  ${name}\n`);
    console.log(archive);
  } finally { await rm(stage, { recursive: true, force: true }); }
}
