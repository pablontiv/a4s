import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import {
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

const runId = "fixture-run";
const sessionId = "01a1400f-185a-7646-b9f6-6bee1f622f5f";
const fixtureRoot = new URL("./fixtures/triage-reviewer/", import.meta.url);
const yamlFiles = [
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
  rmSync(join(home, ".omp"), { recursive: true, force: true });
}

function writeTranscript(
  primary: string,
  review: string,
  fixtureName: string,
  directoryStamp = "2026-10-15T12-00-00-000Z",
  timestamp?: string,
  profile?: string,
): string {
  const root = profile ? join(home, ".omp", "profiles", profile, "agent", "sessions") : sessionsRoot();
  const directory = join(root, encodePrimary(primary), `${directoryStamp}_${sessionId}`);
  mkdirSync(directory, { recursive: true });
  const transcript = join(directory, `${review}.jsonl`);
  const parent = `${directory}.jsonl`;
  writeFileSync(parent, JSON.stringify({ type: "session", id: sessionId }) + "\n");
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
  test(`${source} executes the fail-closed triage verifier`, async (t) => {
    const script = verifierScript(url);

    await t.test("accepts a generic task agent with generation 0 and OMP external/home/tmp path encodings", async () => {
      for (const primary of [external, homePrimary, tmpPrimary, home, tempRoot]) {
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
        const launch = { toolName: "task", toolCallId: id, input: { agent: "task", task: request.reason } };
        const bound = guard.toolCall(launch);
        assert.ok(bound && "input" in bound);
        const decision = { poc, behavior: "already demonstrated", question: "Runtime behavior?", reason: "corrected scope" };
        guard.toolResult({ ...launch, details: { results: [{ index: 0, id, agent: "task", exitCode: 0, output: JSON.stringify(decision) }] } });
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
      ["rejects a missing marker", "missing-marker.jsonl", /check\.task_run_marker=FAIL/],
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

    await t.test("requires the exact parent transcript within the coordinator session", async () => {
      clearTranscripts();
      const transcript = writeTranscript(external, "TriageReview188", "generation-0.jsonl");
      writeFileSync(transcript, readFileSync(transcript, "utf8").replace(`${sessionId}.jsonl`, `other_${sessionId}.jsonl`));
      restBody = rest();
      fail(await runBash(script, environment(external, "TriageReview188")), /check\.parentSession=FAIL/);
    });

    await t.test("requires a single session and consistent initialization identity", async () => {
      for (const type of ["session", "session_init"]) {
        clearTranscripts();
        const transcript = writeTranscript(external, "TriageReview188", "generation-0.jsonl");
        const text = readFileSync(transcript, "utf8");
        const row = text.split("\n").map(line => {
          try { return JSON.parse(line); } catch { return undefined; }
        }).find(row => row?.type === type);
        assert.ok(row);
        if (type === "session_init") row.agent = "reviewer";
        writeFileSync(transcript, `${text.trimEnd()}\n${JSON.stringify(row)}\n`);
        restBody = rest();
        fail(await runBash(script, environment(external, "TriageReview188")), /check\.session_identity=FAIL/);
      }
    });

    await t.test("requires complete marker fields and exact feature run identity", async () => {
      for (const marker of [
        "TRIAGE_REVIEW DAG=poc RUN=fixture-run GENERATION=0 REQUEST=1",
        "TRIAGE_REVIEW DAG=feature RUN=fixture-run-other GENERATION=0 REQUEST=1",
        "TRIAGE_REVIEW DAG=feature RUN=fixture-run GENERATION=0",
        "TRIAGE_REVIEW DAG=feature RUN=fixture-run GENERATION=bad REQUEST=1",
      ]) {
        clearTranscripts();
        const transcript = writeTranscript(external, "TriageReview188", "generation-0.jsonl");
        writeFileSync(transcript, readFileSync(transcript, "utf8").replace("TRIAGE_REVIEW DAG=feature RUN=fixture-run GENERATION=0 REQUEST=1", marker));
        restBody = rest();
        fail(await runBash(script, environment(external, "TriageReview188")), /check\.task_run_marker=FAIL/);
      }
    });

    await t.test("uses the last of multiple yields", async () => {
      clearTranscripts();
      writeTranscript(external, "TriageReview188", "multiple-yields-last-no.jsonl");
      restBody = rest();
      pass(await runBash(script, environment(external, "TriageReview188")));
    });

    await t.test("rejects missing and duplicate transcripts", async () => {
      clearTranscripts();
      restBody = rest();
      fail(await runBash(script, environment(external, "TriageReview188")), /(?:parent|transcript)\.match_count=0/);
      writeTranscript(external, "TriageReview188", "generation-0.jsonl", "first");
      writeTranscript(external, "TriageReview188", "generation-0.jsonl", "second");
      fail(await runBash(script, environment(external, "TriageReview188")), /(?:parent|transcript)\.match_count=2/);
    });

    if (source === "skill template") {
      await t.test("reports zero coordinator parents under nounset across empty profile roots", async () => {
        clearTranscripts();
        restBody = rest();
        const roots = [
          join(sessionsRoot(), encodePrimary(external)),
          join(home, ".omp", "profiles", "work [profile]*", "agent", "sessions", encodePrimary(external)),
        ];
        for (const root of roots) mkdirSync(root, { recursive: true });
        const result = await runBash(script, environment(external, "TriageReview188"));
        assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
        assert.match(result.stdout, /parent\.match_count=0\ncheck\.parent_unique=FAIL\nVERIFIER=FAIL\n/);
        for (const root of roots) assert.ok(result.stdout.includes(`sessions.dir=${root}\n`), result.stdout);
      });

      await t.test("finds a named-profile coordinator with literal spaces and glob characters", async () => {
        clearTranscripts();
        restBody = rest();
        const transcript = writeTranscript(external, "TriageReview188", "generation-0.jsonl", "stamp", undefined, "work [profile]*");
        const result = await runBash(script, environment(external, "TriageReview188"));
        pass(result);
        assert.ok(result.stdout.includes(`transcript.path=${transcript}\n`));
        assert.match(result.stdout, /parent\.match_count=1/);
      });

      await t.test("rejects two actual parents even when only one has the allocated child", async () => {
        clearTranscripts();
        restBody = rest();
        const transcript = writeTranscript(external, "TriageReview188", "generation-0.jsonl", "stamp", undefined, "work");
        const defaultDir = join(sessionsRoot(), encodePrimary(external));
        mkdirSync(defaultDir, { recursive: true });
        const otherParent = join(defaultDir, `other_${sessionId}.jsonl`);
        writeFileSync(otherParent, "{}\n");
        const result = await runBash(script, environment(external, "TriageReview188"));
        assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
        assert.match(result.stdout, /parent\.match_count=2\n/);
        assert.match(result.stdout, /check\.parent_unique=FAIL\nVERIFIER=FAIL\n/);
        for (const path of [defaultDir, transcript.slice(0, transcript.lastIndexOf("/")), otherParent]) assert.ok(result.stdout.includes(path), result.stdout);
      });

      await t.test("requires the exact child under the unique parent", async () => {
        clearTranscripts();
        restBody = rest();
        writeTranscript(external, "OtherReview", "generation-0.jsonl", "stamp", undefined, "work");
        const result = await runBash(script, environment(external, "TriageReview188"));
        fail(result, /transcript\.match_count=0/);
        assert.match(result.stdout, /parent\.match_count=1/);
      });

      await t.test("rejects an orphan child directory without a coordinator parent file", async () => {
        clearTranscripts();
        restBody = rest();
        const transcript = writeTranscript(external, "TriageReview188", "generation-0.jsonl", "stamp", undefined, "work");
        rmSync(`${transcript.slice(0, transcript.lastIndexOf("/"))}.jsonl`);
        const result = await runBash(script, environment(external, "TriageReview188"));
        fail(result, /parent\.match_count=0/);
        assert.match(result.stdout, /check\.parent_unique=FAIL\nVERIFIER=FAIL\n/);
        assert.ok(result.stdout.includes(join(home, ".omp", "profiles", "work", "agent", "sessions", encodePrimary(external))));
      });
    }

    await t.test("requires OMP_SESSION_ID and a simple REVIEW file name", async () => {
      clearTranscripts();
      restBody = rest();
      fail(await runBash(script, environment(external, "TriageReview188", "")), /check\.params=FAIL name=OMP_SESSION_ID/);
      fail(await runBash(script, environment(external, "nested\/review")), /check\.review_name=FAIL/);
    });

    await t.test("compares RFC3339 timestamps strictly across fractions and offsets", async () => {
      clearTranscripts();
      writeTranscript(external, "After", "generation-0.jsonl", "timestamps", "2026-10-15T12:00:00.001Z");
      writeTranscript(external, "Equal", "generation-0.jsonl", "timestamps", "2026-10-15T12:00:00Z");
      writeTranscript(external, "Before", "generation-0.jsonl", "timestamps", "2026-10-15T07:59:59.999-04:00");
      writeTranscript(external, "OffsetAfter", "generation-0.jsonl", "timestamps", "2026-10-15T14:00:00.001+02:00");
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

test("skill template enforces one invocation identity across refreshed session_init rows", async (t) => {
  const script = verifierScript(yamlFiles[0][1]);
  const fixtureRows = (name: string): readonly [string, string, string] => {
    const rows = fixture(name).trim().split("\n");
    const [session, init, yieldNo] = rows;
    assert.equal(rows.length, 3);
    assert.ok(session && init && yieldNo, `incomplete invocation fixture: ${name}`);
    return [session, init, yieldNo];
  };
  const [session, init, yieldNo] = fixtureRows("generation-0.jsonl");
  const refresh = JSON.stringify({ ...JSON.parse(init), timestamp: "2026-10-15T12:00:02Z" });
  const refreshed = (name: string) => {
    const [session, init, yieldNo] = fixtureRows(name);
    const refresh = JSON.stringify({ ...JSON.parse(init), timestamp: "2026-10-15T12:00:02Z" });
    return [session, init, refresh, yieldNo].join("\n");
  };
  for (const [name, content, accepted, check] of [
    ["accepts consistent refreshed identity", [session, init, refresh, yieldNo].join("\n"), true, undefined],
    ["rejects a changed refresh agent", [session, init,
      JSON.stringify({ ...JSON.parse(refresh), agent: "different-review-agent" }), yieldNo].join("\n"), false, /check\.session_identity=FAIL/],
    ["rejects a changed refresh task", [session, init,
      JSON.stringify({ ...JSON.parse(refresh), task: `${JSON.parse(init).task} Changed assignment.` }), yieldNo].join("\n"), false, /check\.session_identity=FAIL/],
    ["requires a session_init", [session, yieldNo].join("\n"), false, /check\.session_identity=FAIL/],
    ["requires a session", [init, refresh, yieldNo].join("\n"), false, /check\.session_identity=FAIL/],
    ["rejects multiple sessions even with the same parent", [session, session, init, refresh, yieldNo].join("\n"), false, /check\.session_identity=FAIL/],
    ["rejects a foreign parent after refresh", refreshed("other-session-parent.jsonl"), false, /check\.parentSession=FAIL/],
    ["rejects a stale first init despite a fresh refresh", refreshed("stale.jsonl"), false, /check\.timestamp_after_cutoff=FAIL/],
    ["rejects a refreshed identity bound to another run", refreshed("other-run.jsonl"), false, /check\.task_run_marker=FAIL/],
    ["rejects an invalid last yield after refresh", [session, init, refresh, yieldNo,
      JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "yield", details: { data: {} } } })].join("\n"), false, /check\.last_yield_poc_no=FAIL/],
  ] as const) {
    await t.test(name, async () => {
      clearTranscripts();
      const transcript = writeTranscript(external, "TriageReview188", "generation-0.jsonl");
      const parent = `${transcript.slice(0, transcript.lastIndexOf("/"))}.jsonl`;
      writeFileSync(transcript, content.replaceAll("__PARENT__", parent) + "\n");
      restBody = rest();
      const result = await runBash(script, environment(external, "TriageReview188"));
      if (accepted) pass(result);
      else {
        fail(result, check);
        assert.match(result.stdout, /VERIFIER=FAIL/);
      }
    });
  }
});
