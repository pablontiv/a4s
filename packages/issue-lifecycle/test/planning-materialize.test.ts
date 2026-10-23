import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

const definition = parse(readFileSync(new URL("../skills/issue-execution/planning.yaml", import.meta.url), "utf8"));
const materialize = definition.steps.find((step: { id: string }) => step.id === "materialize").run;
const github = fileURLToPath(new URL("./fixtures/planning-github-state.cjs", import.meta.url));
const cli = fileURLToPath(new URL("../bin/dagu-feature-bundle.ts", import.meta.url));
type Row = Record<string, any>;
function unit(id: string, extra: Row = {}): Row {
  return { id, title: `Deliver ${id}`, dag: "feature", labels: ["change"], body: "## Problem\nFull problem\n## Change\nComplete scope\n## Acceptance\nObserve native publication", ...extra };
}
function issue(number: number, extra: Row = {}): Row {
  return { number, title: `Existing ${number}`, body: `Preserved body ${number}`, labels: ["existing"], parent: null, blocked_by: [], blocking: [], sub_issues: [], ...extra };
}
function executable(file: string, text: string): void { writeFileSync(file, text); chmodSync(file, 0o755); }
function fixture(rows: Row[], initial: Row[] = []) {
  const root = mkdtempSync(join(tmpdir(), "planning-materialize-"));
  const bin = join(root, "bin"), out = join(root, "out");
  mkdirSync(bin); mkdirSync(out);
  writeFileSync(join(root, "issues.json"), JSON.stringify(initial));
  executable(join(bin, "gh"), `#!/bin/bash\nexport PLANNING_GH_STATE=${JSON.stringify(root)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(github)} "$@"\n`);
  executable(join(bin, "dagu-feature-bundle"), `#!/bin/bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`);
  executable(join(bin, "curl"), '#!/bin/bash\nprintf \'%s\\n\' \'{"dagRunDetails":{"nodes":[{"step":{"id":"review"},"approvalIteration":0}]}}\'\n');
  const snapshot = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
  for (const name of ["units.jsonl", "reviewed-units.jsonl", "validated-units.jsonl"]) writeFileSync(join(out, name), snapshot);
  const marker = "PLAN_REVIEW AGENT=plan-reviewer DAG=planning RUN=materialize-test ITERATION=0 END\n";
  for (const name of ["review-accepted", "generation"]) writeFileSync(join(out, name), marker);
  writeFileSync(join(out, "review-0.json"), JSON.stringify({ verdict: "accept", findings: [] }));
  writeFileSync(join(out, "findings.md"), "Existing coordinator finding\n");
  const env = { ...process.env, OUT_DIR: out, SOURCE: "plan", RUN: "materialize-test", APPROVED: "all", NWO: "owner/repo", PATH: `${bin}:${process.env.PATH}` };
  return {
    root, out, env,
    run: (extra: NodeJS.ProcessEnv = {}) => spawnSync("/bin/bash", ["-c", materialize], { env: { ...env, ...extra }, encoding: "utf8" }),
    issues: (): Row[] => JSON.parse(readFileSync(join(root, "issues.json"), "utf8")),
    state: (): Row => JSON.parse(readFileSync(join(out, `materialization-${env.RUN}-0.json`), "utf8")),
    mapping: (): Row[] => readFileSync(join(out, "issues.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)),
    mutations: (): Row[] => existsSync(join(root, "github.log")) ? readFileSync(join(root, "github.log"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [],
    diagnostics: (): Row[] => readFileSync(join(out, "materialization-validation-findings.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
function successful(result: SpawnSyncReturns<string>): void { assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`); }
function failed(result: SpawnSyncReturns<string>, rule?: RegExp): void {
  assert.notEqual(result.status, 0, result.stdout);
  if (rule) assert.match(result.stderr, rule);
}

test("materialize creates literal canonical fields with provenance and reuses identities without implicit revisions", () => {
  const row = unit("literal-input", { title: '--title="literal" $(touch never)', labels: ["with spaces", 'quote"label', "comma,label"], findings: ["finding-a"] });
  const f = fixture([row]);
  try {
    successful(f.run());
    const created = f.issues()[0];
    assert.ok(created);
    assert.equal(created.title, row.title);
    assert.deepEqual([...created.labels].sort(), [...row.labels].sort());
    assert.match(created.body, /<!-- breakdown-unit: materialize-test\/literal-input -->/);
    assert.match(created.body, /Breakdown source: plan/);
    assert.match(created.body, /Finding lineage: finding-a/);
    assert.equal(f.state().status, "verified");
    assert.deepEqual(f.state().readback.diagnostics, []);
    successful(f.run());
    assert.deepEqual(f.issues(), [created]);
    assert.equal(f.mutations().length, 1);
    assert.deepEqual(f.mapping().map(row => [row.id, row.number, row.reused]), [["literal-input", created.number, true]]);
    assert.equal(readFileSync(join(f.out, "materialization-materialize-test-0-units.jsonl"), "utf8"), readFileSync(join(f.out, "reviewed-units.jsonl"), "utf8"));
  } finally { f.close(); }
});

test("existing run and discovery markers bind only and preserve remote title body and labels", () => {
  for (const source of ["plan", "discovery"]) {
    const marker = source === "plan" ? "<!-- breakdown-unit: materialize-test/bound -->" : "<!-- discovery-unit: bound -->";
    const original = issue(51, { body: `Operator-authored body\n${marker}` });
    const row = unit("bound", { source, body: `${unit("bound").body}\n${marker}` });
    const f = fixture([row], [original]);
    try {
      successful(f.run());
      assert.deepEqual(f.issues(), [original]);
      assert.deepEqual(f.mutations(), []);
      assert.deepEqual(f.mapping().map(row => row.number), [51]);
      assert.equal(f.state().units.bound.status, "verified");
    } finally { f.close(); }
  }
});

test("explicit revision fields alone change existing issues and empty fields bind without marker edits", () => {
  const rows = [
    unit("revise", { title: 'Reviewed "title"', body: `${unit("revise").body}\nExact approved trailing newline\n`, labels: [], revision: { issue: 51, fields: ["title", "body", "labels"] } }),
    unit("bind", { revision: { issue: 52, fields: [] } }),
    unit("label-set", { labels: ["z", "a", "a"], revision: { issue: 53, fields: ["labels"] } }),
  ];
  const f = fixture(rows, [issue(51), issue(52), issue(53)]);
  try {
    successful(f.run());
    const [changed, bound, labelSet] = f.issues();
    const reviewed = rows[0];
    assert.ok(changed); assert.ok(bound); assert.ok(labelSet); assert.ok(reviewed);
    assert.deepEqual([changed.title, changed.body, changed.labels], [reviewed.title, reviewed.body, []]);
    assert.deepEqual([bound.title, bound.body, bound.labels], ["Existing 52", "Preserved body 52", ["existing"]]);
    assert.deepEqual(labelSet.labels, ["a", "z"]);
    assert.deepEqual(f.mutations().map(event => event.payload), [{ title: reviewed.title, body: reviewed.body, labels: [] }, { labels: ["a", "z"] }]);
    assert.equal(f.state().units.revise.prestate.body, "Preserved body 51");
    assert.deepEqual(f.state().units.revise.field_status, { title: "verified", body: "verified", labels: "verified" });
    successful(f.run());
    assert.equal(f.mutations().length, 2);
  } finally { f.close(); }
});

test("native cross-unit and existing-issue edges preserve complete paginated relationships in grouped readback", () => {
  const rows = [
    unit("consumer", { revision: { issue: 51, fields: ["body"] }, relationships: [
      { kind: "parent", target: { unit: "umbrella" } },
      { kind: "blocked_by", target: { unit: "dependency" } },
      { kind: "blocked_by", target: { issue: 81 } },
    ] }),
    unit("umbrella", { revision: { issue: 61, fields: [] } }),
    unit("dependency", { revision: { issue: 71, fields: [] } }),
    unit("new-child", { relationships: [{ kind: "parent", target: { unit: "umbrella" } }, { kind: "blocked_by", target: { unit: "consumer" } }] }),
  ];
  const f = fixture(rows, [
    issue(51, { parent: 61, blocked_by: [91, 92], labels: ["one", "two", "three"] }),
    issue(61, { sub_issues: [51, 101, 102] }), issue(71, { blocking: [111, 112] }), issue(81),
  ]);
  try {
    successful(f.run({ FAKE_PAGE_SIZE: "1" }));
    const by = Object.fromEntries(f.issues().map(row => [row.number, row]));
    const created = f.mapping().find(row => row.id === "new-child")!.number;
    assert.deepEqual(by[51].blocked_by, [71, 81, 91, 92]);
    assert.equal(by[51].parent, 61);
    assert.deepEqual(by[61].sub_issues, [51, 101, 102, created].sort((a, b) => a - b));
    assert.deepEqual(by[71].blocking, [51, 111, 112]);
    assert.deepEqual(by[created].blocked_by, [51]);
    assert.equal(by[created].parent, 61);
    assert.deepEqual(by[51].labels, ["one", "two", "three"]);
    const state = f.state();
    assert.equal(state.status, "verified");
    assert.ok(state.edges.every((edge: Row) => edge.status === "verified" && "prestate" in edge && typeof edge.source_database_id === "string" && typeof edge.target_database_id === "string"));
    assert.deepEqual(state.readback.observed[51].blocked_by.map((edge: Row) => edge.number), [71, 81, 91, 92]);
    const reads = readFileSync(join(f.root, "github-reads.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line).query);
    assert.ok(reads.some(query => query.includes("i51:issue") && query.includes("i61:issue") && query.includes("i71:issue")));
    assert.ok(reads.some(query => query.includes('after:"cursor:1"')));
    const mutations = f.mutations().length;
    successful(f.run({ FAKE_PAGE_SIZE: "1" }));
    assert.equal(f.mutations().length, mutations);
  } finally { f.close(); }
});

test("approval closes unit references before creating, revising or adding edges", () => {
  const f = fixture([
    unit("consumer", { revision: { issue: 51, fields: ["title"] }, relationships: [{ kind: "blocked_by", target: { unit: "dependency" } }] }), unit("dependency"),
  ], [issue(51)]);
  try {
    failed(f.run({ APPROVED: "consumer" }), /rule=approved-relationship-target/);
    assert.deepEqual(f.issues(), [issue(51)]);
    assert.deepEqual(f.mutations(), []);
  } finally { f.close(); }
});

test("all identity ambiguity and conflicting parents fail preflight before any publication", () => {
  const marker = "<!-- breakdown-unit: materialize-test/consumer -->";
  const cases: Array<{ rows: Row[]; issues: Row[]; rule?: RegExp; diagnostic?: string }> = [
    { rows: [unit("new"), unit("consumer")], issues: [issue(51, { body: marker }), issue(52, { body: marker })], rule: /rule=unique-issue-marker unit=consumer/ },
    { rows: [unit("new"), unit("consumer", { revision: { issue: 52, fields: ["body"] } })], issues: [issue(51, { body: marker }), issue(52)], rule: /rule=ambiguous-issue-identity/ },
    { rows: [unit("new"), unit("consumer", { revision: { issue: 51, fields: [] } }), unit("alias", { source: "discovery", body: `${unit("alias").body}\n<!-- discovery-unit: alias -->` })], issues: [issue(51, { body: "<!-- discovery-unit: alias -->" })], diagnostic: "revision-unique-issue" },
    { rows: [unit("new"), unit("consumer", { revision: { issue: 51, fields: ["title"] }, relationships: [{ kind: "parent", target: { issue: 61 } }] })], issues: [issue(51, { parent: 71 }), issue(61)], rule: /rule=conflicting-parent/ },
    { rows: [unit("consumer", { revision: { issue: 51, fields: [] }, relationships: [{ kind: "blocked_by", target: { issue: 51 } }] })], issues: [issue(51)], diagnostic: "relationship-self" },
  ];
  for (const sample of cases) {
    const f = fixture(sample.rows, sample.issues);
    try {
      failed(f.run(), sample.rule);
      if (sample.diagnostic) assert.ok(f.diagnostics().some(diagnostic => diagnostic.rule === sample.diagnostic));
      assert.deepEqual(f.issues(), sample.issues);
      assert.deepEqual(f.mutations(), []);
      assert.match(readFileSync(join(f.out, "findings.md"), "utf8"), /Existing coordinator finding/);
    } finally { f.close(); }
  }
});

test("resolved marker and checkpoint identities reject per-kind cycles before creates or declared field revisions", () => {
  const cases = [
    { kind: "blocked_by", existingBeta: false, checkpoint: false },
    { kind: "blocked_by", existingBeta: true, checkpoint: false },
    { kind: "parent", existingBeta: false, checkpoint: false },
    { kind: "parent", existingBeta: true, checkpoint: false },
    { kind: "blocked_by", existingBeta: false, checkpoint: true },
  ];
  for (const sample of cases) {
    const rows = [
      unit("alpha", { relationships: [{ kind: sample.kind, target: { unit: "beta" } }] }),
      unit("beta", { relationships: [{ kind: sample.kind, target: { issue: 51 } }] }),
      unit("uncreated"),
      unit("declared-patch", { revision: { issue: 61, fields: ["title"] } }),
    ];
    const alpha = issue(51, sample.checkpoint ? {} : { body: "<!-- breakdown-unit: materialize-test/alpha -->" });
    const initial = [alpha, issue(61), ...(sample.existingBeta ? [issue(52, { body: "<!-- breakdown-unit: materialize-test/beta -->" })] : [])];
    const f = fixture(rows, initial);
    try {
      successful(spawnSync(process.execPath, [cli, "validate-planning-units", "--input", join(f.out, "units.jsonl")], { encoding: "utf8" }));
      const canonical = readFileSync(join(f.out, "units.jsonl"), "utf8");
      if (sample.checkpoint) {
        writeFileSync(join(f.out, "materialization-materialize-test-0-units.jsonl"), canonical);
        writeFileSync(join(f.out, "materialization-materialize-test-0.json"), JSON.stringify({
          scope: { run: f.env.RUN, repo: f.env.NWO, source: f.env.SOURCE, iteration: 0 },
          units: { alpha: { id: "alpha", number: 51, url: "https://example.test/owner/repo/issues/51", origin: "marker", reused: true, fields: [], prestate: alpha,
            intended: { title: alpha.title, body: alpha.body, labels: alpha.labels }, field_status: {}, status: "bound" } },
          baseline: {}, edges: [], status: "preflight",
        }));
      }
      failed(f.run());
      assert.ok(f.diagnostics().some(diagnostic => diagnostic.rule === "relationship-cycle" && diagnostic.unit === "beta"));
      assert.deepEqual(f.issues(), initial);
      assert.deepEqual(f.mutations(), []);
      assert.equal(f.state().status, "preflight");
      for (const name of ["units.jsonl", "reviewed-units.jsonl", "validated-units.jsonl", "materialization-materialize-test-0-units.jsonl"]) {
        assert.equal(readFileSync(join(f.out, name), "utf8"), canonical);
      }
      assert.deepEqual(JSON.parse(readFileSync(join(f.out, "approved-units.json"), "utf8")), rows);
      assert.deepEqual(JSON.parse(readFileSync(join(f.out, "materialization-plan.json"), "utf8")).map((row: Row) => row.unit), rows);
      assert.match(readFileSync(join(f.out, "findings.md"), "utf8"), /Existing coordinator finding/);
    } finally { f.close(); }
  }
});

test("resolved marker aliases share duplicate and self relationship diagnostics before publication", () => {
  const cases = [
    {
      rows: [
        unit("uncreated"),
        unit("alpha", { revision: { issue: 51, fields: ["title"] }, relationships: [
          { kind: "blocked_by", target: { unit: "beta" } }, { kind: "blocked_by", target: { issue: 71 } },
        ] }),
        unit("beta"),
      ],
      initial: [issue(51), issue(71, { body: "<!-- breakdown-unit: materialize-test/beta -->" })],
      rule: "relationship-duplicate",
    },
    {
      rows: [
        unit("uncreated"),
        unit("alpha", { relationships: [{ kind: "blocked_by", target: { issue: 51 } }] }),
        unit("declared-patch", { revision: { issue: 61, fields: ["title"] } }),
      ],
      initial: [issue(51, { body: "<!-- breakdown-unit: materialize-test/alpha -->" }), issue(61)],
      rule: "relationship-self",
    },
  ];
  for (const sample of cases) {
    const f = fixture(sample.rows, sample.initial);
    try {
      successful(spawnSync(process.execPath, [cli, "validate-planning-units", "--input", join(f.out, "units.jsonl")], { encoding: "utf8" }));
      failed(f.run());
      assert.ok(f.diagnostics().some(diagnostic => diagnostic.rule === sample.rule && diagnostic.unit === "alpha"));
      assert.deepEqual(f.issues(), sample.initial);
      assert.deepEqual(f.mutations(), []);
      assert.equal(f.state().status, "preflight");
    } finally { f.close(); }
  }
});

test("resolved aliases preserve independent kinds, mixed-kind paths and opaque existing issue targets", () => {
  const cases = [
    {
      alpha: [{ kind: "blocked_by", target: { unit: "beta" } }],
      beta: [{ kind: "parent", target: { issue: 51 } }, { kind: "blocked_by", target: { issue: 71 } }],
      expected: { alphaParent: null, alphaBlocked: [52], betaParent: 51, betaBlocked: [71] },
    },
    {
      alpha: [{ kind: "parent", target: { unit: "beta" } }, { kind: "blocked_by", target: { issue: 52 } }],
      beta: [],
      expected: { alphaParent: 52, alphaBlocked: [52], betaParent: null, betaBlocked: [] },
    },
  ];
  for (const sample of cases) {
    const rows = [
      unit("alpha", { relationships: sample.alpha }),
      unit("beta", { relationships: sample.beta }),
      unit("uncreated"),
      unit("declared-patch", { revision: { issue: 61, fields: ["title"] } }),
    ];
    const alpha = issue(51, { body: "<!-- breakdown-unit: materialize-test/alpha -->" });
    const beta = issue(52, { body: "<!-- breakdown-unit: materialize-test/beta -->" });
    const f = fixture(rows, [alpha, beta, issue(61), issue(71)]);
    try {
      const canonical = readFileSync(join(f.out, "units.jsonl"), "utf8");
      successful(f.run());
      const by = Object.fromEntries(f.issues().map(row => [row.number, row]));
      assert.equal(by[51].parent, sample.expected.alphaParent);
      assert.deepEqual(by[51].blocked_by, sample.expected.alphaBlocked);
      assert.equal(by[52].parent, sample.expected.betaParent);
      assert.deepEqual(by[52].blocked_by, sample.expected.betaBlocked);
      for (const original of [alpha, beta]) {
        assert.deepEqual([by[original.number].title, by[original.number].body, by[original.number].labels], [original.title, original.body, original.labels]);
      }
      assert.deepEqual([by[61].title, by[61].body, by[61].labels], ["Deliver declared-patch", "Preserved body 61", ["existing"]]);
      assert.equal(f.state().status, "verified");
      assert.deepEqual(f.state().readback.diagnostics, []);
      assert.deepEqual(f.state().units.alpha.fields, []);
      assert.deepEqual(f.state().units.beta.fields, []);
      assert.deepEqual(f.state().units["declared-patch"].fields, ["title"]);
      for (const name of ["units.jsonl", "reviewed-units.jsonl", "validated-units.jsonl", "materialization-materialize-test-0-units.jsonl"]) {
        assert.equal(readFileSync(join(f.out, name), "utf8"), canonical);
      }
      assert.deepEqual(JSON.parse(readFileSync(join(f.out, "approved-units.json"), "utf8")), rows);
      const mutations = f.mutations().length;
      successful(f.run());
      assert.equal(f.mutations().length, mutations);
    } finally { f.close(); }
  }
});

test("a same-number foreign parent conflicts with approved local parent before publication", () => {
  const foreign = { number: 61, repo: "Other/Repo", database_id: "995000000000000061" };
  const initial = [issue(51, { parent: foreign }), issue(61)];
  const f = fixture([
    unit("new"),
    unit("consumer", { revision: { issue: 51, fields: ["title"] }, relationships: [{ kind: "parent", target: { issue: 61 } }] }),
  ], initial);
  try {
    failed(f.run(), /rule=conflicting-parent.*"repo":"other\/repo"/);
    assert.deepEqual(f.issues(), initial);
    assert.deepEqual(f.mutations(), []);
  } finally { f.close(); }
});

test("foreign native identities remain distinct when same-number local edges are added", () => {
  const foreign = { number: 61, repo: "Other/Repo", database_id: "995000000000000061" };
  const f = fixture([
    unit("consumer", { revision: { issue: 51, fields: ["body"] }, relationships: [{ kind: "blocked_by", target: { issue: 61 } }] }),
    unit("local-blocker", { revision: { issue: 61, fields: [] } }),
    unit("local-dependent", { revision: { issue: 71, fields: [] }, relationships: [{ kind: "blocked_by", target: { unit: "consumer" } }] }),
    unit("local-child", { revision: { issue: 81, fields: [] }, relationships: [{ kind: "parent", target: { unit: "consumer" } }] }),
  ], [
    issue(51, { parent: foreign, blocked_by: [foreign], blocking: [{ number: 71, repo: "Other/Repo" }], sub_issues: [{ number: 81, repo: "Other/Repo" }] }),
    issue(61, { blocking: [{ number: 91, repo: "OWNER/REPO" }] }), issue(71), issue(81),
  ]);
  try {
    successful(f.run({ FAKE_PAGE_SIZE: "1" }));
    const observed = f.state().readback.observed;
    const foreignParent = { database_id: foreign.database_id, repo: "other/repo", number: 61 };
    assert.deepEqual(observed[51].parent, foreignParent);
    assert.deepEqual(observed[51].blocked_by.map((edge: Row) => [edge.database_id, edge.repo, edge.number]),
      [["5950000061", "owner/repo", 61], [foreign.database_id, "other/repo", 61]]);
    assert.deepEqual(observed[51].blocking.map((edge: Row) => [edge.database_id, edge.repo, edge.number]),
      [["5950000071", "owner/repo", 71], ["7950000071", "other/repo", 71]]);
    assert.deepEqual(observed[51].sub_issues.map((edge: Row) => [edge.database_id, edge.repo, edge.number]),
      [["5950000081", "owner/repo", 81], ["7950000081", "other/repo", 81]]);
    assert.deepEqual(observed[61].blocking.map((edge: Row) => [edge.database_id, edge.repo, edge.number]),
      [["5950000051", "owner/repo", 51], ["5950000091", "owner/repo", 91]]);
    assert.equal(f.state().units.consumer.database_id, "5950000051");
    const mutations = f.mutations();
    assert.equal(mutations.filter(event => event.path.endsWith("/51/dependencies/blocked_by")).length, 1);
    assert.ok(mutations.every(event => event.path.startsWith("repos/owner/repo/issues/")));
    successful(f.run({ FAKE_PAGE_SIZE: "1" }));
    assert.equal(f.mutations().length, mutations.length);
    assert.deepEqual(f.state().readback.observed[51].parent, foreignParent);
  } finally { f.close(); }
});

test("expanded and narrowed approvals retain earlier unit identities and verified native edges", () => {
  const f = fixture([
    unit("consumer", { relationships: [{ kind: "blocked_by", target: { unit: "dependency" } }] }),
    unit("dependency"), unit("later"),
  ]);
  try {
    successful(f.run({ APPROVED: "consumer,dependency" }));
    const initial = f.mapping();
    const [consumer, dependency] = initial;
    assert.ok(consumer); assert.ok(dependency);
    successful(f.run({ APPROVED: "dependency" }));
    assert.deepEqual(f.mapping().map(row => row.number), [dependency.number]);
    successful(f.run());
    assert.equal(f.issues().length, 3);
    assert.deepEqual(f.mapping().slice(0, 2).map(row => row.number), initial.map(row => row.number));
    assert.deepEqual(f.issues().find(row => row.number === consumer.number)!.blocked_by, [dependency.number]);
    assert.deepEqual(f.issues().find(row => row.number === dependency.number)!.blocking, [consumer.number]);
    assert.equal(f.state().status, "verified");
    assert.equal(f.mutations().filter(event => event.path.endsWith("/dependencies/blocked_by")).length, 1);
    successful(f.run({ APPROVED: "later,dependency" }));
    assert.deepEqual(f.mapping().map(row => row.id), ["later", "dependency"]);
  } finally { f.close(); }
});

test("lost create, revision and native-edge responses retain intent and converge without duplicate side effects", () => {
  const rows = [unit("new"), unit("consumer", { revision: { issue: 51, fields: ["body"] }, relationships: [
    { kind: "parent", target: { issue: 61 } }, { kind: "blocked_by", target: { issue: 71 } },
  ] })];
  const consumer = rows[1];
  assert.ok(consumer);
  for (const point of [1, 2, 3, 4]) {
    const f = fixture(rows, [issue(51), issue(61), issue(71)]);
    try {
      failed(f.run({ FAKE_CRASH_AFTER: String(point) }), /rule=materialization-command/);
      const progress = f.state();
      assert.equal(progress.units.consumer.intended.body, consumer.body);
      assert.equal(progress.edges.length, 2);
      assert.ok(readdirSync(f.out).includes("materialization-materialize-test-0-units.jsonl"));
      successful(f.run());
      assert.equal(f.issues().length, 4);
      assert.equal(f.mutations().length, 4, `checkpoint ${point} performs exactly one create, PATCH and each native edge`);
      assert.equal(f.state().status, "verified");
      assert.equal(f.mapping().length, 2);
      successful(f.run());
      assert.equal(f.mutations().length, 4);
    } finally { f.close(); }
  }
});

test("remote core and native-edge mismatches persist actionable grouped evidence and retry converges", () => {
  for (const fault of [{ FAKE_DROP_PATCH_FIELD: "body" }, { FAKE_DROP_EDGE: "1" }]) {
    const row = unit("consumer", { revision: { issue: 51, fields: ["body"] }, relationships: [{ kind: "blocked_by", target: { issue: 61 } }] });
    const f = fixture([row], [issue(51), issue(61)]);
    try {
      failed(f.run(fault), /rule=remote-state-mismatch/);
      const progress = f.state();
      assert.equal(progress.status, "mismatch");
      assert.ok(progress.readback.diagnostics.some((diagnostic: Row) => diagnostic.rule === "remote-state-mismatch" && "expected" in diagnostic && "observed" in diagnostic));
      assert.match(readFileSync(join(f.out, "findings.md"), "utf8"), /Existing coordinator finding[\s\S]*rule=remote-state-mismatch/);
      successful(f.run());
      assert.equal(f.state().status, "verified");
      const [remote] = f.issues();
      assert.ok(remote);
      assert.equal(remote.title, "Existing 51");
      assert.deepEqual(remote.labels, ["existing"]);
    } finally { f.close(); }
  }
});

test("an incomplete terminal native connection is diagnosed before approved mutations", () => {
  const f = fixture([unit("consumer", { revision: { issue: 51, fields: ["body"] } })], [issue(51)]);
  try {
    failed(f.run({ FAKE_INCOMPLETE_CONNECTION: "blockedBy" }), /rule=remote-readback/);
    assert.deepEqual(f.issues(), [issue(51)]);
    assert.deepEqual(f.mutations(), []);
    successful(f.run());
    assert.equal(f.state().status, "verified");
  } finally { f.close(); }
});

test("reentry diagnoses changed unapproved fields without overwriting them", () => {
  const f = fixture([unit("consumer", { revision: { issue: 51, fields: ["body"] } })], [issue(51)]);
  try {
    successful(f.run());
    const changed = f.issues();
    const [remote] = changed;
    assert.ok(remote);
    remote.title = "Concurrent operator title";
    writeFileSync(join(f.root, "issues.json"), JSON.stringify(changed));
    const count = f.mutations().length;
    failed(f.run(), /rule=remote-unapproved-field-mismatch/);
    assert.deepEqual(f.issues().map(row => row.title), ["Concurrent operator title"]);
    assert.equal(f.mutations().length, count);
    assert.equal(f.state().units.consumer.prestate.title, "Existing 51");
  } finally { f.close(); }
});
