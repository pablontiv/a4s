import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const HIGH_STAKES = new Set(["publish", "merge", "station", "pin", "poc-scope"]);

export function repoRoot(start) {
  let dir = start;
  for (;;) {
    if (exists(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("a4s checkout not found from the skill directory");
    dir = parent;
  }
}

function exists(dir) {
  try {
    readFileSync(join(dir, "package.json"));
    readFileSync(join(dir, "docs/architecture/issue-lifecycle.md"));
    return true;
  } catch {
    return false;
  }
}

export function adoptedBudgets(root) {
  const answers = JSON.parse(readFileSync(join(root, ".workspace/dagu/answers.json"), "utf8"));
  const budgets = answers.escalation;
  for (const key of ["pushbacks", "findings", "seconds", "ciBlocked", "pocInconclusive"]) {
    if (!Number.isInteger(budgets?.[key]) || budgets[key] < 1) {
      throw new Error(`adopted escalation.${key} is not a positive integer`);
    }
  }
  return budgets;
}

export function classify(event, budgets) {
  const repeat = Number.isInteger(event.repeat) ? event.repeat : 1;
  const elapsed = Number.isInteger(event.elapsedSeconds) ? event.elapsedSeconds : 0;
  if (HIGH_STAKES.has(event.kind)) {
    return { disposition: "decide", reason: "explicit authority or a one-time scope park" };
  }
  if (event.kind === "ci-blocked" && event.duplicate === true && elapsed < budgets.seconds && repeat < budgets.ciBlocked) {
    return { disposition: "continue", reason: "duplicate tick does not increment the streak" };
  }
  if (elapsed >= budgets.seconds) {
    return { disposition: "decide", reason: "elapsed window" };
  }
  switch (event.kind) {
    case "code-fail":
      return { disposition: "continue", reason: "CODE_FAIL is not an owner escalation" };
    case "reversible-edit":
    case "clarification":
      return { disposition: "continue", reason: "reversible work stays inside the run" };
    case "blocker-report":
      return { disposition: "continue", reason: "ask policy does not publish automatically" };
    case "finding":
      return repeat >= budgets.findings
        ? { disposition: "decide", reason: "repeated finding fingerprint" }
        : { disposition: "continue", reason: "first finding is recorded" };
    case "pushback":
      return repeat >= budgets.pushbacks
        ? { disposition: "decide", reason: "push-back budget" }
        : { disposition: "continue", reason: "inside the push-back budget" };
    case "poc-inconclusive":
      return repeat >= budgets.pocInconclusive
        ? { disposition: "decide", reason: "repeated access or scope INCONCLUSIVE" }
        : { disposition: "continue", reason: "first inconclusive stays on the run" };
    case "ci-blocked":
      return repeat >= budgets.ciBlocked
        ? { disposition: "decide", reason: "consecutive identical BLOCKED" }
        : { disposition: "notify", reason: "one deduplicated cause" };
    default:
      return { disposition: "decide", reason: "unknown kind fails closed" };
  }
}

export function replay(events, budgets) {
  const rows = events.map(event => {
    const result = classify(event, budgets);
    return { ...event, ...result };
  });
  const counts = { continue: 0, notify: 0, decide: 0 };
  for (const row of rows) counts[row.disposition] += 1;
  const baseline = rows.length;
  const contacts = counts.notify + counts.decide;
  return { rows, counts, baseline, contacts };
}

export function assertReplay(events, budgets) {
  const result = replay(events, budgets);
  for (const row of result.rows) {
    if (row.expect !== row.disposition) {
      throw new Error(`${row.id}: expected ${row.expect}, classified ${row.disposition}`);
    }
  }
  if (result.contacts >= result.baseline) {
    throw new Error("fixture did not reduce contacts against the per-event baseline");
  }
  const unknown = classify({ kind: "mystery", repeat: 1, elapsedSeconds: 0 }, budgets);
  if (unknown.disposition !== "decide") throw new Error("unknown kind must decide");
  return result;
}

export function formatReport(result) {
  const { counts, baseline, contacts } = result;
  const continued = counts.continue;
  return `hitl-escalation: ${baseline} events, baseline contacts ${baseline}, skill contacts ${contacts} (${counts.decide} decide, ${counts.notify} notify), continued ${continued}`;
}

function main() {
  const root = repoRoot(here);
  const budgets = adoptedBudgets(root);
  const events = JSON.parse(readFileSync(join(here, "fixtures/stream.json"), "utf8")).events;
  const result = assertReplay(events, budgets);
  console.log(formatReport(result));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
