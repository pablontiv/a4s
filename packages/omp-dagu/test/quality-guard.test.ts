import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { inspectImplementer, inspectVerdict, qualityDecision, qualityMarker } from "../src/triage/quality.ts";
import type { TranscriptRow } from "../src/triage/quality.ts";
import { qualityFixture } from "./quality-fixtures.ts";

function fixture(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-quality-guard-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const primary = join(root, "primary space");
  const worktree = join(primary, ".workspace", "worktrees", "issue-189");
  const state = join(primary, ".git", "dagu-feature", "runs", "test-run");
  execFileSync("git", ["init", "--quiet", primary]);
  mkdirSync(worktree, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "candidate.json"), JSON.stringify({ sha: "a".repeat(40), iteration: 0, implementer: "ImplementTest" }));
  return { ...qualityFixture({ root, primary, worktree, state }), primary, state };
}

for (const primarySource of ["adopted env literal", "resolvedPrimary", "historical param"]) {
  test(`quality spawn and completion resolve PRIMARY from ${primarySource}`, async t => {
    const f = fixture(t);
    const requests: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/spec")) return new Response(JSON.stringify({ spec: `env:\n  - PRIMARY: ${JSON.stringify(f.primary)}\n` }));
      return new Response(JSON.stringify({ dagRunDetails: {
        params: `ISSUE=189 OMP_SESSION_ID=parent-id${primarySource === "historical param" ? ` PRIMARY=${f.primary}` : ""}`,
        ...(primarySource === "resolvedPrimary" ? { resolvedPrimary: f.primary } : {}),
        nodes: [{ step: { id: "implement" }, startedAt: f.request.implementStartedAt }],
      } }));
    });
    const ctx = { cwd: f.primary, sessionManager: { getSessionDir: () => dirname(f.parent) }, models: f.models };
    for (const [agent, name] of [["qa", "QATest"], ["reviewer", "ReviewTest"]] as const) {
      const decision = await qualityDecision({ toolName: "task", toolCallId: `spawn-${name}`, input: {
        agent, name, task: qualityMarker(f.request, agent),
      } }, ctx);
      assert.ok(decision && "input" in decision, JSON.stringify(decision));
      assert.ok(decision.input.outputSchema);
    }
    // A plugin reload appends the same assignment to an otherwise completed child.
    const child: TranscriptRow[] = readFileSync(f.paths.qa!, "utf8").trim().split("\n").map(line => JSON.parse(line));
    child.push({ ...child[1]!, timestamp: "2026-10-16T02:00:00Z" });
    writeFileSync(f.paths.qa!, child.map(row => JSON.stringify(row)).join("\n") + "\n");
    const completion = await qualityDecision({ toolName: "bash", toolCallId: "complete", input: {
      command: "dagu human-task complete feature --run-id test-run --step quality_review --input QA=QATest --input REVIEW=ReviewTest",
    } }, ctx);
    assert.equal(completion, undefined);
    const evidence = JSON.parse(readFileSync(join(f.state, "quality.json"), "utf8"));
    assert.equal(evidence.action, "complete");
    assert.equal(evidence.verdicts.length, 2);
    assert.equal(requests.filter(url => url.endsWith("/spec")).length, primarySource === "adopted env literal" ? 3 : 0);
  });
}

for (const role of ["implementer", "qa", "reviewer"] as const) {
  for (const change of ["identical", "agent", "task", "stale first timestamp"] as const) {
    test(`${role} session_init repetition: ${change}`, t => {
      const f = fixture(t);
      const path = f.paths[role]!;
      const rows: TranscriptRow[] = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
      const init = rows[1]!;
      rows.push({ ...init, timestamp: "2026-10-16T02:00:00Z",
        ...(change === "agent" ? { agent: "other-agent" } : {}),
        ...(change === "task" ? { task: `${init.task} changed assignment` } : {}),
      });
      if (change === "stale first timestamp") init.timestamp = "2026-10-15T00:00:00Z";
      writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
      const inspect = () => role === "implementer"
        ? inspectImplementer(f.parent, f.request, f.models)
        : inspectVerdict(f.parent, f.request, role, role === "qa" ? "QATest" : "ReviewTest", f.models);
      if (change === "identical") assert.doesNotThrow(inspect);
      else assert.throws(inspect, change === "stale first timestamp" ? /stale invocation/ : /ambiguous session identity/);
    });
  }
}
