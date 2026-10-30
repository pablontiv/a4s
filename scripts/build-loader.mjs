import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
if (process.argv.length !== 4 || process.argv[2] !== "--outdir") throw new Error("Usage: node scripts/build-loader.mjs --outdir <DAGU_HOME>/cache/a4s/loader");
const output = resolve(process.argv[3]);
await mkdir(output, { recursive: true });
execFileSync(join(root, "node_modules/.bin/bun"), ["build", "--target=node", "--format=esm",
  join(root, "packages/loader/src/index.ts"), "--outfile", join(output, "loader.ts")], { cwd: root, stdio: "inherit" });
await writeFile(join(output, "package.json"), JSON.stringify({
  name: "@a4s/loader", version: "0.1.0", private: true, type: "module",
  omp: { extensions: ["./loader.ts"], skills: ["../current/skills"], agents: ["../current/agents"] },
}, null, 2) + "\n");
console.log(output);
