import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function repoRoot(start) {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "docs/architecture/issue-lifecycle.md"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("a4s checkout not found from the skill directory");
    dir = parent;
  }
}

const root = repoRoot(here);
const manifest = JSON.parse(readFileSync(join(here, "citations.json"), "utf8"));
const model = readFileSync(join(here, "references/boundaries.md"), "utf8");
const citations = manifest.citations;
if (!Array.isArray(citations) || citations.length === 0) throw new Error("citations.json has no citations");
if (!model.includes("Decision: skill")) throw new Error("standing model is missing Decision: skill");

let failed = 0;
for (const row of citations) {
  if (typeof row.path !== "string" || typeof row.includes !== "string" || row.path.includes("..")) {
    console.error("invalid citation row");
    failed++;
    continue;
  }
  if (!model.includes(row.path)) {
    console.error(`standing model does not name ${row.path}`);
    failed++;
  }
  const file = join(root, row.path);
  if (!existsSync(file) || !readFileSync(file, "utf8").includes(row.includes)) {
    console.error(`missing citation in ${row.path}: ${row.includes}`);
    failed++;
  }
}

if (failed > 0) process.exit(1);
console.log(`sandbox-threat-model: ${citations.length} citations matched`);
