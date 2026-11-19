#!/usr/bin/env node
// Admission: admit ONE issue as a factory run.
//   admit.mjs --issue <n> --dag <cycle.yaml> [--issues-file F | --repo R] [--dagu-home D] [--config C] [--param K=V ...]
// Admits only when the issue carries the label `factory:ready` (never plain `factory`, the classification label).
// Run-id is deterministic (`factory-issue-<n>`); Dagu rejects a duplicate run-id, reported as "duplicate".
// The issue body must satisfy the issue contract (issue-contract.mjs); otherwise it is not enqueued.
// Exit codes: 0 admitted, 20 not labelled, 21 duplicate, 22 contract, 30 infra.
//   admit.mjs --list F   prints the numbers of the issues in F that carry the label (one per line).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { checkIssue } from "./issue-contract.mjs";

export const ADMIT_LABEL = "factory:ready";
export const EXIT = Object.freeze({ ADMITTED: 0, NOT_LABELLED: 20, DUPLICATE: 21, CONTRACT: 22, INFRA: 30 });

export const runIdFor = (n) => `factory-issue-${n}`;

/** Label names of an issue-like object; labels may be strings or {name}. */
export const labelNames = (issue) => (issue?.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name));
export const isAdmissible = (issue) => labelNames(issue).includes(ADMIT_LABEL);

/** True when Dagu's enqueue failure means the run-id already exists. */
export const isDuplicate = (text) => /already exists/i.test(text);

function parseArgs(argv) {
  const o = { params: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === "--issue") o.issue = v();
    else if (a === "--repo") o.repo = v();
    else if (a === "--dag") o.dag = v();
    else if (a === "--issues-file") o.issuesFile = v();
    else if (a === "--dagu-home") o.daguHome = v();
    else if (a === "--config") o.config = v();
    else if (a === "--param") o.params.push(v());
    else if (a === "--list") o.list = v();
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

function loadIssue(o) {
  if (o.issuesFile) {
    const all = JSON.parse(readFileSync(o.issuesFile, "utf8"));
    return all.find((i) => String(i.number) === String(o.issue)) ?? { number: o.issue, labels: [] };
  }
  if (!o.repo) throw new Error("--repo is required without --issues-file");
  const r = spawnSync("gh", ["issue", "view", String(o.issue), "-R", o.repo, "--json", "number,labels,body"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`gh issue view failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

export function admit(o, daguBin = process.env.DAGU_BIN ?? "dagu") {
  let issue;
  try { issue = loadIssue(o); } catch (e) { console.error(`admit: ${e.message}`); return EXIT.INFRA; }
  if (!isAdmissible(issue)) { console.log(`not-labelled #${o.issue} (needs ${ADMIT_LABEL})`); return EXIT.NOT_LABELLED; }
  const contract = checkIssue(issue.body);
  if (!contract.ok) {
    console.log(`contract #${o.issue} violates the issue contract:`);
    for (const p of contract.problems) console.log(`- ${p}`);
    return EXIT.CONTRACT;
  }
  const runId = runIdFor(o.issue);
  // explicit name: inside an admit step Dagu would register the run under the parent DAG's name
  const args = ["enqueue", "--run-id", runId, "--name", basename(o.dag).replace(/\.ya?ml$/, "")];
  if (o.daguHome) args.push("--dagu-home", o.daguHome);
  if (o.config) args.push("--config", o.config);
  args.push(o.dag, "--", `ISSUE=${o.issue}`, ...o.params);
  // clean env: drop the parent step's DAG_* run variables
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("DAG_")));
  const r = spawnSync(daguBin, args, { encoding: "utf8", env });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.error) { console.error(`admit: ${r.error.message}`); return EXIT.INFRA; }
  if (r.status === 0) { console.log(`admitted #${o.issue} run-id=${runId}`); return EXIT.ADMITTED; }
  if (isDuplicate(out)) { console.log(`duplicate #${o.issue} run-id=${runId}`); return EXIT.DUPLICATE; }
  console.error(`admit: dagu enqueue -> ${r.status}\n${out}`);
  return EXIT.INFRA;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`admit: ${e.message}`); process.exit(EXIT.INFRA); }
  if (o.list) {
    try {
      for (const i of JSON.parse(readFileSync(o.list, "utf8"))) if (isAdmissible(i)) console.log(i.number);
      process.exit(0);
    } catch (e) { console.error(`admit: ${e.message}`); process.exit(EXIT.INFRA); }
  }
  if (!o.issue || !o.dag) { console.error("admit: --issue and --dag are required"); process.exit(EXIT.INFRA); }
  process.exit(admit(o));
}
