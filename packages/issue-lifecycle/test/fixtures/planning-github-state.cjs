#!/usr/bin/env node
/* Stateful native GitHub boundary fixture shared by planning consumers. */
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.PLANNING_GH_STATE || process.env.FAKE_STATE;
if (!root) throw new Error("PLANNING_GH_STATE is required");
const file = path.join(root, "issues.json");
const load = name => fs.existsSync(path.join(root, name)) ? JSON.parse(fs.readFileSync(path.join(root, name), "utf8")) : [];
const own = load("issues.json"), external = load("external-issues.json");
const normalize = issue => ({
  id: 5950000000 + issue.number, node_id: `I_fixture_${issue.number}`,
  html_url: `https://example.test/owner/repo/issues/${issue.number}`,
  title: `Existing ${issue.number}`, body: "Existing body", labels: [], parent: null,
  blocked_by: [], blocking: [], sub_issues: [], ...issue,
});
const all = [...own, ...external].map(normalize);
const args = process.argv.slice(2);
if (args.shift() !== "api") throw new Error("Only gh api is supported");
let method = "GET", endpoint, input;
while (args.length) {
  const arg = args.shift();
  if (arg === "--method" || arg === "-X") method = args.shift();
  else if (arg === "--input") input = JSON.parse(fs.readFileSync(args.shift(), "utf8"));
  else if (arg === "--paginate" || arg === "--slurp") {}
  else if (!endpoint) endpoint = arg;
  else throw new Error(`Unexpected argument ${arg}`);
}
const find = number => {
  const issue = all.find(issue => issue.number === Number(number));
  if (!issue) throw new Error(`Issue ${number} is unavailable`);
  return issue;
};
const emit = data => process.stdout.write(JSON.stringify(data) + "\n");
const unique = values => [...new Set(values)].sort((a, b) => a - b);
const labels = issue => issue.labels.map(label => typeof label === "string" ? label : label.name);
const rest = issue => ({ ...issue, labels: labels(issue).map(name => ({ name })) });
const graphReference = reference => ({
  number: typeof reference === "number" ? reference : reference.number,
  fullDatabaseId: String(typeof reference === "number" ? 5950000000 + reference : reference.database_id || ((reference.repo.toLowerCase() === "owner/repo" ? 5950000000 : 7950000000) + reference.number)),
  repository: { nameWithOwner: typeof reference === "number" ? "owner/repo" : reference.repo },
});
const save = () => {
  const ownedNumbers = new Set(own.map(issue => issue.number));
  fs.writeFileSync(file + ".tmp", JSON.stringify(all.filter(issue => ownedNumbers.has(issue.number))));
  fs.renameSync(file + ".tmp", file);
  if (external.length) fs.writeFileSync(path.join(root, "external-issues.json"), JSON.stringify(all.filter(issue => !ownedNumbers.has(issue.number))));
};
if (endpoint === "graphql") {
  if (method !== "GET" || !input || typeof input.query !== "string") throw new Error("Expected GraphQL JSON request");
  fs.appendFileSync(path.join(root, "github-reads.jsonl"), JSON.stringify({ query: input.query }) + "\n");
  const repository = {};
  const matches = [...input.query.matchAll(/(i\d*):issue\(number:(\d+)\)/g)];
  for (const [, alias, number] of matches) {
    const issue = all.find(issue => issue.number === Number(number));
    if (!issue) { repository[alias] = null; continue; }
    const connection = (name, values) => {
      const re = new RegExp(name + '\\(first:(\\d+)(?:,after:("(?:[^"\\\\]|\\\\.)*"))?\\)');
      const match = input.query.match(re);
      if (!match) return undefined;
      const offset = match[2] ? Number(JSON.parse(match[2]).slice(7)) : 0;
      const count = Math.min(Number(match[1]), Number(process.env.FAKE_PAGE_SIZE || 100));
      const nodes = values.slice(offset, offset + count);
      return { nodes, totalCount: values.length + (process.env.FAKE_INCOMPLETE_CONNECTION === name ? 1 : 0), pageInfo: { hasNextPage: offset + nodes.length < values.length, endCursor: `cursor:${offset + nodes.length}` } };
    };
    repository[alias] = {
      id: issue.node_id, fullDatabaseId: String(issue.id), number: issue.number, url: issue.html_url,
      repository: { nameWithOwner: "owner/repo" },
      title: issue.title, body: issue.body, parent: issue.parent == null ? null : graphReference(issue.parent),
      labels: connection("labels", labels(issue).map(name => ({ name }))),
      blockedBy: connection("blockedBy", issue.blocked_by.map(graphReference)),
      blocking: connection("blocking", issue.blocking.map(graphReference)),
      subIssues: connection("subIssues", issue.sub_issues.map(graphReference)),
    };
  }
  emit({ data: { repository } });
  process.exit(0);
}
if (method === "GET" && /^repos\/[^/]+\/[^/]+\/issues\?state=all&per_page=100$/.test(endpoint)) {
  const pages = [];
  for (let index = 0; index < all.length; index += 2) pages.push(all.slice(index, index + 2).map(rest));
  emit(pages.length ? pages : [[]]);
  process.exit(0);
}
let response;
if (method === "POST" && /^repos\/[^/]+\/[^/]+\/issues$/.test(endpoint)) {
  const number = Math.max(40, ...all.map(issue => issue.number)) + 1;
  const issue = normalize({ number, title: input.title, body: input.body, labels: input.labels });
  own.push(issue); all.push(issue); response = rest(issue);
} else {
  const match = endpoint.match(/^repos\/[^/]+\/[^/]+\/issues\/(\d+)(.*)$/);
  if (!match) throw new Error(`Unexpected endpoint ${endpoint}`);
  const issue = find(match[1]), suffix = match[2];
  if (method === "PATCH" && suffix === "") {
    for (const [field, value] of Object.entries(input)) {
      if (!["title", "body", "labels"].includes(field)) throw new Error(`Unexpected PATCH field ${field}`);
      if (process.env.FAKE_DROP_PATCH_FIELD !== field) issue[field] = value;
    }
    response = rest(issue);
  } else if (method === "POST" && suffix === "/sub_issues") {
    const child = all.find(candidate => String(candidate.id) === String(input.sub_issue_id));
    if (!child) throw new Error("Unknown sub_issue_id");
    if (child.parent != null && child.parent !== issue.number) throw new Error("Conflicting parent");
    if (!process.env.FAKE_DROP_EDGE) { child.parent = issue.number; issue.sub_issues = unique([...issue.sub_issues, child.number]); }
    response = rest(issue);
  } else if (method === "POST" && suffix === "/dependencies/blocked_by") {
    const dependency = all.find(candidate => String(candidate.id) === String(input.issue_id));
    if (!dependency) throw new Error("Unknown issue_id");
    if (!process.env.FAKE_DROP_EDGE) { issue.blocked_by = unique([...issue.blocked_by, dependency.number]); dependency.blocking = unique([...dependency.blocking, issue.number]); }
    response = rest(issue);
  } else throw new Error(`Unexpected ${method} ${endpoint}`);
}
save();
fs.appendFileSync(path.join(root, "github.log"), JSON.stringify({ method, path: endpoint, payload: input }) + "\n");
const effects = fs.readFileSync(path.join(root, "github.log"), "utf8").trim().split("\n").length;
if (Number(process.env.FAKE_CRASH_AFTER || 0) === effects) process.exit(86);
emit(response);
