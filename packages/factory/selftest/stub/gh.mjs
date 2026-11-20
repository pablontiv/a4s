#!/usr/bin/env node
// Stand-in for `gh` (selftest:stub): serves issues, labels, comments and CI run lists from a fixture directory
// and records every call in <fixture>/gh-calls.jsonl. Config next to this file: gh-config.json = {"fixture","remote"}.
//   <fixture>/issues/<n>.json   {number,title,body,state,labels:[name],comments:[text]}
//   <fixture>/runs.json         [{match: "<regex on the commit subject>", runs: [{status,conclusion,workflowName,url,createdAt}]}]
//                               the first matching rule answers `run list --commit <sha>`; no match = one green CI run
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const { fixture, remote } = JSON.parse(readFileSync(join(HERE, "gh-config.json"), "utf8"));
const argv = process.argv.slice(2);
appendFileSync(join(fixture, "gh-calls.jsonl"), JSON.stringify({ argv, cwd: process.cwd() }) + "\n");
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const all = (name) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));
const issueFile = (n) => join(fixture, "issues", `${n}.json`);
const loadIssue = (n) => { if (!existsSync(issueFile(n))) { console.error(`gh: issue ${n} not found`); process.exit(1); } return JSON.parse(readFileSync(issueFile(n), "utf8")); };
const saveIssue = (i) => writeFileSync(issueFile(i.number), JSON.stringify(i, null, 1));
const emit = (obj) => {
  const jq = flag("--jq");
  if (!jq) { console.log(JSON.stringify(obj)); return; }
  const r = spawnSync("jq", ["-r", jq], { input: JSON.stringify(obj), encoding: "utf8" });
  process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exit(r.status ?? 1);
};
const pick = (obj, fields) => Object.fromEntries(fields.split(",").map((f) => [f, obj[f]]));

const [group, cmd] = argv;
const n = argv[2] && /^\d+$/.test(argv[2]) ? Number(argv[2]) : argv[2];
if (group === "issue" && cmd === "view") {
  const i = loadIssue(n);
  emit(pick({ ...i, labels: (i.labels ?? []).map((name) => ({ name })) }, flag("--json") ?? "number"));
} else if (group === "issue" && cmd === "close") {
  const i = loadIssue(n);
  i.state = "CLOSED";
  if (flag("--comment")) (i.comments ??= []).push(flag("--comment"));
  saveIssue(i);
} else if (group === "issue" && cmd === "comment") {
  const i = loadIssue(n);
  (i.comments ??= []).push(flag("--body") ?? "");
  saveIssue(i);
} else if (group === "issue" && cmd === "edit") {
  const i = loadIssue(n);
  const rm = all("--remove-label");
  i.labels = [...(i.labels ?? []).filter((l) => !rm.includes(l)), ...all("--add-label").filter((l) => !(i.labels ?? []).includes(l))];
  saveIssue(i);
} else if (group === "label") {
  // create: always fine
} else if (group === "run" && cmd === "list") {
  const sha = flag("--commit") ?? "";
  const subject = spawnSync("git", ["--git-dir", remote, "log", "-1", "--format=%s", sha], { encoding: "utf8" }).stdout.trim();
  const rules = existsSync(join(fixture, "runs.json")) ? JSON.parse(readFileSync(join(fixture, "runs.json"), "utf8")) : [];
  const rule = rules.find((r) => new RegExp(r.match).test(subject));
  console.log(JSON.stringify(rule?.runs ?? [{ status: "completed", conclusion: "success", workflowName: "CI", url: `https://stub/runs/${sha.slice(0, 7)}`, createdAt: "2026-01-01T00:00:00Z" }]));
} else if (group === "api") {
  console.log("[]");
} else {
  console.error(`gh stub: unsupported command: ${argv.join(" ")}`);
  process.exit(1);
}
