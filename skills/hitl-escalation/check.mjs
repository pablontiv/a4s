import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adoptedBudgets, assertReplay, formatReport, repoRoot } from "./classify.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = repoRoot(here);
const manifest = JSON.parse(readFileSync(join(here, "citations.json"), "utf8"));
const model = readFileSync(join(here, "references/budgets.md"), "utf8");
const skill = readFileSync(join(here, "SKILL.md"), "utf8");
const agents = readFileSync(join(root, "AGENTS.md"), "utf8");

let failed = 0;
function fail(message) {
  console.error(message);
  failed++;
}

if (manifest.decision !== "skill") fail("citations.json decision is not skill");
if (!model.includes("Decision: skill")) fail("standing model is missing Decision: skill");
if (!skill.includes("Decision: skill")) fail("SKILL.md is missing Decision: skill");
if (/\bBLUF\b/.test(agents)) fail("AGENTS.md now names BLUF; align references/budgets.md before classifying");

const budgets = adoptedBudgets(root);
const declared = manifest.budgets;
if (JSON.stringify(declared) !== JSON.stringify({
  pushbacks: budgets.pushbacks,
  findings: budgets.findings,
  seconds: budgets.seconds,
  ciBlocked: budgets.ciBlocked,
  pocInconclusive: budgets.pocInconclusive,
})) {
  fail("citations.json budgets differ from .workspace/dagu/answers.json escalation");
}

const citations = manifest.citations;
if (!Array.isArray(citations) || citations.length === 0) fail("citations.json has no citations");
for (const row of citations ?? []) {
  if (typeof row.path !== "string" || typeof row.includes !== "string" || row.path.includes("..")) {
    fail("invalid citation row");
    continue;
  }
  if (!model.includes(row.path)) fail(`standing model does not name ${row.path}`);
  const file = join(root, row.path);
  if (!existsSync(file) || !readFileSync(file, "utf8").includes(row.includes)) {
    fail(`missing citation in ${row.path}: ${row.includes}`);
  }
}

const events = JSON.parse(readFileSync(join(here, "fixtures/stream.json"), "utf8")).events;
let report = "";
try {
  report = formatReport(assertReplay(events, budgets));
} catch (error) {
  fail(error.message);
}

if (failed > 0) process.exit(1);
console.log(`hitl-escalation: ${citations.length} citations matched`);
console.log(report);
