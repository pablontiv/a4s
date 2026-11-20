import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { slugify } from "../src/research.mjs";

const F = join(dirname(fileURLToPath(import.meta.url)), "..");
const doc = JSON.parse(readFileSync(join(F, "lines.json"), "utf8"));

test("research profile: pi-research, read/write/edit/shell/web/backscroll/opensrc", () => {
  const lines = JSON.parse(readFileSync(new URL("../lines.json", import.meta.url), "utf8")).lines;
  const r = lines.research;
  assert.equal(r.provider, "pi-research");
  const t = r.instance.tools.map((x) => x.replace(/^\*/, ""));
  for (const w of ["read", "write", "edit", "bash", "web_search", "web_fetch", "backscroll", "opensrc"]) assert.ok(t.includes(w), w);
});

test("prompt: everything except main, no live factory changes, own branch, handoff protocol, never factory:ready", () => {
  const p = readFileSync(new URL("../prompts/research.md", import.meta.url), "utf8");
  for (const s of ["except merging to main", "research/<slug>", "Never push to, merge into or commit on `main`", "Never change the live factory", "Never create, edit or label issues yourself", "NEVER `factory:ready`", "[research <slug>] <absolute artifact path>", "quote it verbatim", "checkIssue", "context only"]) assert.ok(p.includes(s), s);
});

test("slugify: readable, stable, collision-safe", () => {
  assert.match(slugify("Uso de tokens / Cuotas!"), /^uso-de-tokens-cuotas-[0-9a-f]{10}$/);
  assert.equal(slugify("Token usage"), slugify("  Token   usage "));
  assert.notEqual(slugify("Token usage"), slugify("Token-usage"));
  assert.notEqual(slugify("配额"), slugify("进度"));
});

test("start is idempotent per topic (fixture T3 CLI)", () => {
  const root = mkdtempSync(join(tmpdir(), "research-"));
  const calls = join(root, "calls.log");
  const stub = join(root, "t3stub.mjs");
  writeFileSync(stub, `import { appendFileSync, readFileSync } from "node:fs";
const a = process.argv.slice(2); let input = ""; try { input = readFileSync(0, "utf8"); } catch {}
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ a, input }) + "\\n");
if (a[0] === "thread" && a[1] === "start") console.log(JSON.stringify({ threadId: "T-R1", runId: "r" }));
`);
  const state = join(root, "state");
  const run = (topic) => spawnSync("node", [join(F, "src", "research.mjs"), "start", topic, "--primary", root, "--t3-home", root, "--state", state],
    { encoding: "utf8", env: { ...process.env, RESEARCH_T3CLI: stub } });
  const r1 = run("Token usage");
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(JSON.parse(r1.stdout).reused, false);
  const r2 = run("Token usage");
  assert.equal(r2.status, 0);
  assert.equal(JSON.parse(r2.stdout).reused, true);
  assert.equal(JSON.parse(r2.stdout).threadId, "T-R1");
  const calls1 = readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const starts = calls1.filter((c) => c.a[0] === "thread" && c.a[1] === "start");
  assert.equal(starts.length, 1);
  assert.ok(starts[0].a.includes("pi-research"));
  assert.ok(!calls1.some((c) => c.a.includes("delegate")));
  assert.deepEqual(readdirSync(join(state, "research")), [`${slugify("Token usage")}.json`]);
  assert.equal(JSON.parse(readFileSync(join(state, "research", `${slugify("Token usage")}.json`), "utf8")).threadId, "T-R1");
  assert.equal(JSON.parse(run("  Token   usage ").stdout).reused, true);
  run("Otro tema");
  assert.equal(readdirSync(join(state, "research")).length, 2);
  // distinct topics with the same readable slug get distinct threads
  const nStart = () => readFileSync(calls, "utf8").trim().split("\n").filter((l) => JSON.parse(l).a[1] === "start").length;
  const before = nStart();
  for (const t of ["Token-usage", "配额", "进度"]) assert.equal(JSON.parse(run(t).stdout).reused, false, t);
  assert.equal(nStart(), before + 3);
  assert.equal(JSON.parse(run("配额").stdout).reused, true);
  assert.equal(readdirSync(join(state, "research")).length, 5);
});
