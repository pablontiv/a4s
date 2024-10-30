import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { TriageGuard } from "../src/triage/guard.ts";
import { parse } from "yaml";

const runId = "fixture-run";
const sessionId = "01a1400f-185a-7646-b9f6-6bee1f622f5f";
const fixtureRoot = new URL("./fixtures/triage-reviewer/", import.meta.url);
const yamlFiles = [
  ["installed DAG", new URL("../../../.workspace/dagu/dags/feature.yaml", import.meta.url)],
  ["skill template", new URL("../skills/dagu-feature/feature.yaml", import.meta.url)],
] as const;

function verifierScript(url: URL): string {
  const yaml = readFileSync(url, "utf8");
  const start = yaml.indexOf("  - id: triage_decision\n");
  const end = yaml.indexOf("\n  - id: start_gate\n", start);
  assert.ok(start >= 0 && end > start, `triage_decision step missing from ${url.pathname}`);
  const step = yaml.slice(start, end);
  const run = step.indexOf("    run: |\n");
  assert.ok(run >= 0, `triage_decision command missing from ${url.pathname}`);
  const body = step
    .slice(run + "    run: |\n".length)
    .split("\n")
    .map((line) => line.startsWith("      ") ? line.slice(6) : line);
  const firstEffect = body.findIndex((line) => line.startsWith("STATE="));
  assert.ok(firstEffect > 0, `triage_decision effect boundary missing from ${url.pathname}`);
  return `${body.slice(0, firstEffect).join("\n")}\n`;
}

type Result = { code: number | null; stdout: string; stderr: string };
async function runBash(script: string, env: NodeJS.ProcessEnv): Promise<Result> {
  const child = spawn("/bin/bash", ["-c", script], { env });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "close") as [number | null];
  return { code, stdout, stderr };
}

const sandbox = mkdtempSync(join(tmpdir(), "omp-dagu-triage-reviewer-"));
const home = join(sandbox, "home");
const tempRoot = join(sandbox, "tmp-root");
const external = join(sandbox, "external.with.dot", "repo");
const homePrimary = join(home, "projects", ".repo");
const tmpPrimary = join(tempRoot, "work", ".repo");
for (const directory of [home, tempRoot, external, homePrimary, tmpPrimary]) mkdirSync(directory, { recursive: true });

function encodePrimary(primary: string): string {
  const canonical = realpathSync(primary);
  const canonicalHome = realpathSync(home);
  const canonicalTmp = realpathSync(tempRoot);
  const relativeEncoding = (prefix: string, relative: string) => {
    const encoded = relative.replace(/[\\/:]/g, "-");
    if (!encoded) return prefix;
    return prefix.endsWith("-") ? `${prefix}${encoded}` : `${prefix}-${encoded}`;
  };
  if (canonical === canonicalTmp) return "-tmp";
  if (canonical.startsWith(`${canonicalTmp}/`)) return relativeEncoding("-tmp", canonical.slice(canonicalTmp.length + 1));
  if (canonical === canonicalHome) return "-";
  if (canonical.startsWith(`${canonicalHome}/`)) return relativeEncoding("-", canonical.slice(canonicalHome.length + 1));
  return `--${canonical.slice(1).replace(/[\\/:]/g, "-")}--`;
}

function fixture(name: string, timestamp?: string): string {
  let content = readFileSync(new URL(name, fixtureRoot), "utf8");
  if (timestamp) content = content.replace(/"timestamp":"[^"]+"/, `"timestamp":"${timestamp}"`);
  return content;
}

function sessionsRoot(): string {
  return join(home, ".omp", "agent", "sessions");
}

function clearTranscripts(): void {
  rmSync(sessionsRoot(), { recursive: true, force: true });
}

function writeTranscript(
  primary: string,
  review: string,
  fixtureName: string,
  directoryStamp = "2026-10-15T12-00-00-000Z",
  timestamp?: string,
): string {
  const directory = join(sessionsRoot(), encodePrimary(primary), `${directoryStamp}_${sessionId}`);
  mkdirSync(directory, { recursive: true });
  const transcript = join(directory, `${review}.jsonl`);
  const parent = `${directory}.jsonl`;
  writeFileSync(transcript, fixture(fixtureName, timestamp).replaceAll("__PARENT__", parent));
  return transcript;
}

let restBody = "";
let port = 0;
const server = createServer((request, response) => {
  if (request.method !== "GET" || request.url !== `/api/v1/dag-runs/feature/${runId}`) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" }).end(restBody);
});

before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  port = address.port;
});

after(async () => {
  server.close();
  await once(server, "close");
  rmSync(sandbox, { recursive: true, force: true });
});

function rest(cutoff = "2026-10-15T12:00:00Z") {
  return JSON.stringify({ dagRunDetails: { nodes: [{ step: { id: "triage" }, startedAt: cutoff }] } });
}

function environment(primary: string, review: string, ompSessionId = sessionId): NodeJS.ProcessEnv {
  return {
    HOME: home,
    TMPDIR: tempRoot,
    PATH: process.env.PATH,
    DAGU_PORT: String(port),
    ISSUE: "",
    PR_NUMBER: "",
    PRIMARY: primary,
    WORKTREE: "",
    BRANCH: "",
    BASE_BRANCH: "",
    REQUIRED_CHECK: "",
    OMP_SESSION_ID: ompSessionId,
    REVIEW: review,
    RUN: runId,
    POC: "no",
    POC_BASIS: "",
    BASIS: "",
  };
}

function pass(result: Result, encoded?: string): void {
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /VERIFIER=PASS/);
  if (encoded) assert.match(result.stdout, new RegExp(`primary\\.encoded=${encoded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\n|$)`));
}

function fail(result: Result, check?: RegExp): void {
  assert.notEqual(result.code, 0, result.stdout);
  if (check) assert.match(`${result.stdout}\n${result.stderr}`, check);
}

for (const [source, url] of yamlFiles) {
  test(`${source} executes the fail-closed triage-reviewer verifier`, async (t) => {
    const script = verifierScript(url);

    await t.test("accepts generation 0 and OMP external/home/tmp path encodings", async () => {
      for (const primary of [external, homePrimary, tmpPrimary]) {
        clearTranscripts();
        writeTranscript(primary, "TriageReview188", "generation-0.jsonl");
        restBody = rest();
        pass(await runBash(script, environment(primary, "TriageReview188")), encodePrimary(primary));
      }
    });

    await t.test("accepts the current post-push-back reviewer and rejects the stale one", async () => {
      clearTranscripts();
      writeTranscript(external, "TriageReview188", "stale.jsonl");
      writeTranscript(external, "TriageReview188v2", "post-push-back.jsonl");
      restBody = rest("2026-10-15T08:00:00-04:00");
      pass(await runBash(script, environment(external, "TriageReview188v2")));
      fail(await runBash(script, environment(external, "TriageReview188")), /check\.timestamp_after_cutoff=FAIL/);
    });
    await t.test("accepts the guard-selected replacement after a bound yes in the same generation", async () => {
      clearTranscripts();
      restBody = rest();
      const guard = new TriageGuard();
      const completion = (review: string) => ({
        toolName: "bash", toolCallId: "complete", input: {
          command: `dagu human-task complete feature --run-id ${runId} --step triage --input POC=no --input REVIEW=${review}`,
        },
      });
      const bind = (id: string, poc: string) => {
        const request = guard.toolCall(completion(id));
        assert.ok(request && "reason" in request);
        const launch = { toolName: "task", toolCallId: id, input: { agent: "triage-reviewer", task: request.reason } };
        const bound = guard.toolCall(launch);
        assert.ok(bound && "input" in bound);
        const decision = { poc, behavior: "already demonstrated", question: "Runtime behavior?", reason: "corrected scope" };
        guard.toolResult({ ...launch, details: { results: [{ index: 0, id, agent: "triage-reviewer", exitCode: 0, output: JSON.stringify(decision) }] } });
        const transcript = writeTranscript(external, id, "generation-0.jsonl");
        const rows = readFileSync(transcript, "utf8").trim().split("\n").map(line => JSON.parse(line));
        rows.find(row => row.type === "session_init").task = bound.input.task;
        rows.find(row => row.type === "message").message.details.data = decision;
        writeFileSync(transcript, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
        return request.reason;
      };
      const first = bind("TriageReview237", "yes");
      const replacement = bind("TriageReview237v2", "no");
      assert.match(first, /GENERATION=0 REQUEST=1/);
      assert.match(replacement, /GENERATION=0 REQUEST=2/);
      const stale = guard.toolCall(completion("TriageReview237"));
      assert.ok(stale && "reason" in stale);
      assert.match(stale.reason, /--input REVIEW=TriageReview237v2/);
      assert.equal(guard.toolCall(completion("TriageReview237v2")), undefined);
      pass(await runBash(script, environment(external, "TriageReview237v2")));
      fail(await runBash(script, environment(external, "TriageReview237")), /check\.last_yield_poc_no=FAIL/);
    });

    for (const [name, fixtureName, check] of [
      ["rejects a parent from another session", "other-session-parent.jsonl", /check\.parentSession=FAIL/],
      ["rejects another agent", "wrong-agent.jsonl", /check\.agent=FAIL/],
      ["rejects another RUN marker", "other-run.jsonl", /check\.task_run_marker=FAIL/],
      ["rejects a last yield with poc=yes", "last-yield-poc-yes.jsonl", /check\.last_yield_poc_no=FAIL/],
      ["rejects invalid JSONL", "invalid.jsonl", /parse error/],
    ] as const) {
      await t.test(name, async () => {
        clearTranscripts();
        writeTranscript(external, "TriageReview188", fixtureName);
        restBody = rest();
        fail(await runBash(script, environment(external, "TriageReview188")), check);
      });
    }

    await t.test("uses the last of multiple yields", async () => {
      clearTranscripts();
      writeTranscript(external, "TriageReview188", "multiple-yields-last-no.jsonl");
      restBody = rest();
      pass(await runBash(script, environment(external, "TriageReview188")));
    });

    await t.test("rejects missing and duplicate transcripts", async () => {
      clearTranscripts();
      restBody = rest();
      fail(await runBash(script, environment(external, "TriageReview188")), /transcript\.match_count=0/);
      writeTranscript(external, "TriageReview188", "generation-0.jsonl", "first");
      writeTranscript(external, "TriageReview188", "generation-0.jsonl", "second");
      fail(await runBash(script, environment(external, "TriageReview188")), /transcript\.match_count=2/);
    });

    await t.test("requires OMP_SESSION_ID and a simple REVIEW file name", async () => {
      clearTranscripts();
      restBody = rest();
      fail(await runBash(script, environment(external, "TriageReview188", "")), /check\.params=FAIL name=OMP_SESSION_ID/);
      fail(await runBash(script, environment(external, "nested\/review")), /check\.review_name=FAIL/);
    });

    await t.test("compares RFC3339 timestamps strictly across fractions and offsets", async () => {
      clearTranscripts();
      writeTranscript(external, "After", "generation-0.jsonl", "after", "2026-10-15T12:00:00.001Z");
      writeTranscript(external, "Equal", "generation-0.jsonl", "equal", "2026-10-15T12:00:00Z");
      writeTranscript(external, "Before", "generation-0.jsonl", "before", "2026-10-15T07:59:59.999-04:00");
      writeTranscript(external, "OffsetAfter", "generation-0.jsonl", "offset", "2026-10-15T14:00:00.001+02:00");
      restBody = rest();
      pass(await runBash(script, environment(external, "After")));
      fail(await runBash(script, environment(external, "Equal")), /check\.timestamp_after_cutoff=FAIL/);
      fail(await runBash(script, environment(external, "Before")), /check\.timestamp_after_cutoff=FAIL/);
      pass(await runBash(script, environment(external, "OffsetAfter")));
    });

    await t.test("rejects REST responses without exactly one triage startedAt", async () => {
      clearTranscripts();
      writeTranscript(external, "TriageReview188", "generation-0.jsonl");
      restBody = JSON.stringify({ dagRunDetails: { nodes: [] } });
      fail(await runBash(script, environment(external, "TriageReview188")), /check\.rest_triage_node=FAIL/);
      restBody = JSON.stringify({ dagRunDetails: { nodes: [{ step: { id: "triage" } }] } });
      fail(await runBash(script, environment(external, "TriageReview188")), /check\.rest_triage_startedAt=FAIL/);
      restBody = JSON.stringify({ dagRunDetails: { nodes: [
        { step: { id: "triage" }, startedAt: "2026-10-15T12:00:00Z" },
        { step: { id: "triage" }, startedAt: "2026-10-15T12:00:01Z" },
      ] } });
      fail(await runBash(script, environment(external, "TriageReview188")), /triage\.node_count=2/);
      restBody = "not-json";
      fail(await runBash(script, environment(external, "TriageReview188")), /check\.rest_json=FAIL/);
    });
  });
}

const passUrl = "https://github.com/owner/repo/issues/41#issuecomment-123";
const passMarker = "<!-- poc-verdict:PASS scope:OK run:producer-run attempt:7 base:producer-base -->";

type ProvenanceFixture = {
  primary: string;
  pages: (value: unknown) => void;
  rawPages: (value: string) => void;
  run: (overrides?: NodeJS.ProcessEnv) => Promise<Result>;
  calls: () => string[][];
  effects: () => { effect: string }[];
  reviewed: () => string;
  cleanup: () => void;
};

function provenanceFixture(): ProvenanceFixture {
  const root = mkdtempSync(join(sandbox, "provenance-"));
  const primary = join(root, "primary");
  const bin = join(root, "bin");
  mkdirSync(primary);
  mkdirSync(bin);
  execFileSync("git", ["init", "-q", primary]);
  const state = join(primary, ".git", "dagu-feature", "runs", runId);
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "dependencies"), "current-dependencies\n");
  writeFileSync(join(state, "reviewed-dependencies"), "previous-reviewed-dependencies\n");
  const pages = join(root, "pages.json");
  const calls = join(root, "calls.jsonl");
  const effects = join(root, "effects.jsonl");
  writeFileSync(pages, JSON.stringify([[{ html_url: passUrl, body: passMarker }]]));
  writeFileSync(calls, "");
  writeFileSync(effects, "");
  writeFileSync(join(bin, "gh"), `#!/bin/bash
set -euo pipefail
[[ "$PWD" == "$PRIMARY" ]] || { echo 'wrong repository cwd' >&2; exit 1; }
jq -nc --args '$ARGS.positional' -- "$@" >> "$FAKE_GH_CALLS"
case "$1 $2" in
  "repo view") printf 'owner/repo\\n' ;;
  "api --paginate")
    if [[ "\${FAKE_API_STATUS:-0}" != 0 ]]; then echo 'fixture API unavailable' >&2; exit "$FAKE_API_STATUS"; fi
    cat "$FAKE_PAGES" ;;
  "issue comment")
    jq -nc '{effect:"comment"}' >> "$FAKE_EFFECTS" ;;
  *) printf 'unexpected gh call: %s\\n' "$*" >&2; exit 1 ;;
esac
`);
  writeFileSync(join(bin, "dagu-feature-bundle"), `#!/bin/bash
set -euo pipefail
jq -nc '{effect:"enqueue"}' >> "$FAKE_EFFECTS"
`);
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "dagu-feature-bundle"), 0o755);
  const template = new URL("../skills/dagu-feature/feature.yaml", import.meta.url);
  const script = parse(readFileSync(template, "utf8")).steps.find((step: { id: string }) => step.id === "triage_decision").run as string;
  return {
    primary,
    pages(value: unknown) { writeFileSync(pages, JSON.stringify(value)); },
    rawPages(value: string) { writeFileSync(pages, value); },
    async run(overrides: NodeJS.ProcessEnv = {}) {
      return runBash(script, {
        ...environment(primary, "TriageReview188"), PATH: `${bin}:${process.env.PATH ?? ""}`,
        ISSUE: "41", QUESTION: "Has this behavior been exercised?", BASE_BRANCH: "main",
        POC: "yes", POC_BASIS: passUrl, BASIS: passUrl,
        FAKE_PAGES: pages, FAKE_GH_CALLS: calls, FAKE_EFFECTS: effects,
        ...overrides,
      });
    },
    calls: () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)),
    effects: () => readFileSync(effects, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)),
    reviewed: () => readFileSync(join(state, "reviewed-dependencies"), "utf8"),
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

function rejectedProvenance(fixture: ProvenanceFixture, result: Result, field: string): void {
  fail(result, new RegExp(`field=${field.replaceAll(".", "\\.")} expected=.+ observed=.+`));
  assert.deepEqual(fixture.effects(), []);
  assert.equal(fixture.reviewed(), "previous-reviewed-dependencies\n");
}

test("feature triage validates promoted PoC provenance before comments or dependency approval", async (t) => {
  await t.test("accepts a complete same-issue URL across pages without a latest/run/base constraint", async () => {
    const fixture = provenanceFixture();
    try {
      fixture.pages([
        [{ html_url: "https://github.com/owner/repo/issues/41#issuecomment-1", body: "unrelated comment" }],
        [{ html_url: passUrl, body: `${passMarker}\r\nEvidence` }],
        [{ html_url: "https://github.com/owner/repo/issues/41#issuecomment-999", body: passMarker.replace("PASS", "FAIL") }],
      ]);
      const result = await fixture.run({ BASIS: `Prior proof: ${passUrl} with an optional explanation.`, REVIEW: "" });
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /POC_BASIS=PASS url=https:\/\/github\.com\/owner\/repo\/issues\/41#issuecomment-123 repo=owner\/repo issue=41/);
      assert.equal(fixture.reviewed(), "current-dependencies\n");
      assert.deepEqual(fixture.effects().map(effect => effect.effect), ["comment", "enqueue"]);
    } finally { fixture.cleanup(); }
  });

  for (const BASIS of [passUrl, `[PASS](${passUrl})`, `<${passUrl}>`, `Proof: ${passUrl}. Explanation follows.`]) {
    await t.test(`accepts a complete URL citation: ${BASIS}`, async () => {
      const fixture = provenanceFixture();
      try {
        const result = await fixture.run({ BASIS });
        assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
        assert.deepEqual(fixture.effects().map(effect => effect.effect), ["comment", "enqueue"]);
      } finally { fixture.cleanup(); }
    });
  }

  for (const BASIS of [
    passUrl.slice(0, -1), passUrl.replace("123", "456"), `prefix${passUrl}`,
    `https://other.invalid/${passUrl}`, `${passUrl}suffix`, `${passUrl}4`,
    `${passUrl}/extra`, `${passUrl}?extra=1`, `${passUrl}#extra`, `${passUrl}.evil`, `${passUrl}%20`,
  ]) {
    await t.test(`rejects a near URL in BASIS: ${BASIS}`, async () => {
      const fixture = provenanceFixture();
      try { rejectedProvenance(fixture, await fixture.run({ BASIS }), "BASIS"); }
      finally { fixture.cleanup(); }
    });
  }

  for (const POC_BASIS of [
    passUrl.slice(0, -1), `${passUrl}4`, `${passUrl}?extra=1`, `${passUrl} `,
    passUrl.replace("/41#", "/42#"), passUrl.replace("owner/repo", "other/repo"),
    passUrl.replace("123", "456"),
  ]) {
    await t.test(`requires exact html_url equality on this repository issue: ${POC_BASIS}`, async () => {
      const fixture = provenanceFixture();
      try {
        rejectedProvenance(fixture, await fixture.run({ POC_BASIS, BASIS: POC_BASIS }), "POC_BASIS");
      } finally { fixture.cleanup(); }
    });
  }

  for (const [body, field, observed] of [
    [passMarker.replace("PASS", "FAIL"), "comment.verdict", "FAIL"],
    [passMarker.replace("PASS", "INCONCLUSIVE"), "comment.verdict", "INCONCLUSIVE"],
    [passMarker.replace("scope:OK", "scope:FAIL"), "comment.scope", "FAIL"],
    [`Explanation\n${passMarker}`, "comment.first_line", "Explanation"],
    [` ${passMarker}`, "comment.first_line", "poc-verdict"],
    [`${passMarker} extra`, "comment.first_line", "extra"],
    [passMarker.replace("attempt:7", "attempt:0"), "comment.first_line", "attempt:0"],
    [passMarker.replace("attempt:7", "attempt:01"), "comment.first_line", "attempt:01"],
    [passMarker.replace("run:producer-run", "run:two words"), "comment.first_line", "run:two words"],
    [passMarker.replace(" base:producer-base", ""), "comment.first_line", "attempt:7"],
  ] as const) {
    await t.test(`requires the producer first-line PASS scope:OK grammar: ${body}`, async () => {
      const fixture = provenanceFixture();
      try {
        fixture.pages([[{ html_url: passUrl, body }]]);
        const result = await fixture.run();
        rejectedProvenance(fixture, result, field);
        assert.ok(result.stderr.includes(observed), result.stderr);
      } finally { fixture.cleanup(); }
    });
  }

  await t.test("rejects missing comments and API/JSON failures with useful diagnostics", async () => {
    for (const [pages, overrides, field, observed] of [
      ["[]", {}, "POC_BASIS", passUrl],
      ["[[]]", {}, "POC_BASIS", passUrl],
      ["[]", { FAKE_API_STATUS: "1" }, "comments", "API_error"],
      ["not-json", {}, "comments", "invalid_JSON"],
      ['[{"html_url":"not-a-page"}]', {}, "comments", "invalid_JSON"],
      ['{"comments":[]}', {}, "comments", "invalid_JSON"],
    ] as const) {
      const fixture = provenanceFixture();
      try {
        fixture.rawPages(pages);
        const result = await fixture.run(overrides);
        rejectedProvenance(fixture, result, field);
        assert.ok(result.stderr.includes(observed), result.stderr);
      } finally { fixture.cleanup(); }
    }
  });

  await t.test("a valid basis preserves POC=no review and comment semantics", async () => {
    const fixture = provenanceFixture();
    try {
      clearTranscripts();
      writeTranscript(fixture.primary, "TriageReview188", "generation-0.jsonl");
      restBody = rest();
      const result = await fixture.run({ POC: "no" });
      pass(result);
      assert.equal(fixture.reviewed(), "current-dependencies\n");
      assert.deepEqual(fixture.effects().map(effect => effect.effect), ["comment"]);
    } finally { fixture.cleanup(); }
  });

  await t.test("a valid basis still requires a current POC=no review", async () => {
    const fixture = provenanceFixture();
    try {
      clearTranscripts();
      restBody = rest();
      const result = await fixture.run({ POC: "no", REVIEW: "MissingReview" });
      fail(result, /check\.transcript_unique=FAIL/);
      assert.deepEqual(fixture.effects(), []);
      assert.equal(fixture.reviewed(), "previous-reviewed-dependencies\n");
    } finally { fixture.cleanup(); }
  });

  for (const POC of ["yes", "no"]) {
    await t.test(`empty POC_BASIS keeps ordinary POC=${POC} free of provenance lookups`, async () => {
      const fixture = provenanceFixture();
      try {
        clearTranscripts();
        writeTranscript(fixture.primary, "TriageReview188", "generation-0.jsonl");
        restBody = rest();
        fixture.rawPages("invalid JSON that must not be fetched");
        const result = await fixture.run({ POC, POC_BASIS: "", BASIS: "Previously demonstrated behavior", FAKE_API_STATUS: "1" });
        assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
        assert.deepEqual(fixture.calls().map(args => args.slice(0, 2)), [["issue", "comment"]]);
        assert.equal(fixture.reviewed(), "current-dependencies\n");
        assert.deepEqual(fixture.effects().map(effect => effect.effect), POC === "yes" ? ["comment", "enqueue"] : ["comment"]);
      } finally { fixture.cleanup(); }
    });
  }
});
