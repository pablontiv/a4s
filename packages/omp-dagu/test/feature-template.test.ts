import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import crossFamilyReview from "@a4s/omp-cross-family-review";
import { Transitions } from "../src/status/progress.ts";
import type { RunDetails } from "../src/status/progress.ts";
import { BUNDLE_VERSION } from "../src/bundle.ts";
import { stubHistory, withResourceGuard } from "./resource-fixtures.ts";
import { inspectVerdict, qualityDecision, qualityMarker, verifyQuality } from "../src/triage/quality.ts";
import type { QualityRequest, TranscriptRow } from "../src/triage/quality.ts";
import { qualityFixture } from "./quality-fixtures.ts";
import { liveDagu, liveDaguVersion } from "./fixtures/live-dagu.ts";

const definitions = [
  ["template", fileURLToPath(new URL("../skills/dagu-feature/feature.yaml", import.meta.url))],
  ["rendered DAG", fileURLToPath(new URL("../../../.workspace/dagu/dags/feature.yaml", import.meta.url))],
] as const;

function extractScript(definition: string, marker: string): string {
  const lines = readFileSync(definition, "utf8").split("\n");
  const markerIndex = lines.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing ${marker} in ${definition}`);
  const anchor = lines.indexOf("    run: &feature_cleanup |");
  const runIndex = anchor >= 0 && (marker === "  exit:" || marker === "  - id: close_gate")
    ? anchor : lines.indexOf("    run: |", markerIndex);
  assert.notEqual(runIndex, -1, `missing run block after ${marker}`);
  let end = runIndex + 1;
  while (end < lines.length && (lines[end]!.startsWith("      ") || lines[end] === "")) end++;
  return withResourceGuard((marker === "  - id: close_gate" ? "CLEANUP_CLOSE=true\n" : "") +
    lines.slice(runIndex + 1, end).map((line) => line.slice(6)).join("\n"), definition);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function hasRef(cwd: string, ref: string): boolean {
  return spawnSync("git", ["-C", cwd, "show-ref", "--verify", "--quiet", ref]).status === 0;
}

type Repository = {
  root: string;
  primary: string;
  worktree: string;
  branch: string;
  state: string;
};

function repository(): Repository {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-dagu-feature-")));
  const primary = join(root, "primary");
  const remote = join(root, "remote.git");
  const worktree = join(primary, ".workspace", "worktrees", "issue-189");
  const branch = "dagu/issue-189";
  execFileSync("git", ["init", "--bare", "-b", "main", remote]);
  execFileSync("git", ["init", "-b", "main", primary]);
  git(primary, "config", "user.name", "Feature Test");
  git(primary, "config", "user.email", "feature-test@example.com");
  git(primary, "remote", "add", "origin", remote);
  writeFileSync(join(primary, ".git", "info", "exclude"), "/.workspace/\n");
  mkdirSync(join(primary, "packages", "first"), { recursive: true });
  mkdirSync(join(primary, "packages", "second"), { recursive: true });
  writeFileSync(join(primary, "packages", "first", "package.json"), '{"dependencies":{"shared":"1.0.0"}}\n');
  writeFileSync(join(primary, "packages", "second", "package.json"), "{}\n");
  writeFileSync(join(primary, "README.txt"), "base\n");
  git(primary, "add", ".");
  git(primary, "commit", "-m", "base");
  git(primary, "push", "-u", "origin", "main");
  writeFileSync(join(primary, ".git", "info", "exclude"), "/.workspace/worktrees/\n");
  stubHistory(root);
  git(primary, "worktree", "add", "-b", branch, worktree, "origin/main");
  const state = join(primary, ".git", "dagu-feature", "runs", "test-run");
  mkdirSync(state, { recursive: true });
  const identity = JSON.stringify({ primary, worktree, branch, run: "test-run", session: "" }) + "\n";
  writeFileSync(join(state, "identity"), identity);
  writeFileSync(git(worktree, "rev-parse", "--path-format=absolute", "--git-path", "dagu-feature-owner"), identity);
  writeFileSync(join(state, "base"), git(worktree, "rev-parse", "HEAD") + "\n");
  recordCandidate({ root, primary, worktree, branch, state });
  const resource = JSON.stringify({ run: "test-run", primary, branch, worktree });
  writeFileSync(join(state, "resource.json"), resource);
  const hash = execFileSync("git", ["hash-object", "--stdin"], { input: branch, encoding: "utf8" }).trim();
  const resources = join(primary, ".git", "dagu-feature", "resources");
  mkdirSync(resources, { recursive: true });
  writeFileSync(join(resources, `${hash}.json`), resource);
  writeFileSync(join(state, "tested-sha"), git(worktree, "rev-parse", "HEAD") + "\n");
  return { root, primary, worktree, branch, state };
}

function recordCandidate(repo: Repository): void {
  const sha = git(repo.worktree, "rev-parse", "HEAD");
  writeFileSync(join(repo.state, "candidate.json"), JSON.stringify({
    sha, base: readFileSync(join(repo.state, "base"), "utf8").trim(),
    tree: git(repo.worktree, "rev-parse", "HEAD^{tree}"), message: "base", iteration: -1, implementer: "ImplementTest",
  }) + "\n");
}

function commit(repo: Repository, path: string, content: string): void {
  const target = join(repo.worktree, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  git(repo.worktree, "add", path);
  git(repo.worktree, "commit", "-m", "feature change");
  recordCandidate(repo);
  writeFileSync(join(repo.state, "tested-sha"), git(repo.worktree, "rev-parse", "HEAD") + "\n");
}

function stubGh(repo: Repository, stdout: string, status: number, stderr = ""): void {
  const bin = join(repo.root, "bin");
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, "gh");
  writeFileSync(
    executable,
    `#!/bin/sh\ncase " $* " in *" --repo "*) ;; *)\n  if [ "$PWD" != ${JSON.stringify(repo.primary)} ]; then\n    printf 'failed to run git: fatal: not a git repository\\n' >&2\n    exit 2\n  fi\nesac\nprintf '%b' ${JSON.stringify(stdout)}\nprintf '%b' ${JSON.stringify(stderr)} >&2\nexit ${status}\n`,
  );
  chmodSync(executable, 0o755);
}

function stubSuccessfulCloseGateGh(repo: Repository, files = "README.txt"): void {
  const head = git(repo.worktree, "rev-parse", "HEAD");
  const bin = join(repo.root, "bin");
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, "gh");
  writeFileSync(
    executable,
    `#!/bin/sh
case "$*" in
  "pr view ${repo.branch} --repo ${repo.root}/remote.git --json number,state,headRefOid,mergeCommit") printf '%s\\n' '${JSON.stringify({ number: 190, state: "MERGED", headRefOid: head, mergeCommit: { oid: head } })}' ;;
  "pr checks 190 --repo ${repo.root}/remote.git --required --json name,state --jq "*) printf 'SUCCESS\\n' ;;
  "pr diff 190 --repo ${repo.root}/remote.git --name-only") printf '%s\\n' ${JSON.stringify(files)} ;;
  *) printf 'unexpected gh invocation: %s\\n' "$*" >&2; exit 1 ;;
esac
`,
  );
  chmodSync(executable, 0o755);
}

function featureScriptEnv(repo: Repository): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME,
    PATH: `${join(repo.root, "bin")}:${process.env.PATH ?? ""}`,
    DAGU_PARAMS_JSON: "{}",
    ISSUE: "189",
    PR_NUMBER: "",
    PRIMARY: repo.primary,
    WORKTREE: repo.worktree,
    BRANCH: repo.branch,
    BASE_BRANCH: "main",
    GATE: "true",
    REQUIRED_CHECK: "validate",
    OMP_SESSION_ID: "",
    POC_BASIS: "",
    RUN: "test-run",
    SUMMARY: "Delivered files",
    MESSAGE: "feat: delivered change",
    IMPLEMENTER: "ImplementTest",
  };
}

function runFailingCloseGate(script: string, repo: Repository) {
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: featureScriptEnv(repo),
  });
}

function runScript(script: string, repo: Repository, env: NodeJS.ProcessEnv = {}): string {
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    cwd: repo.root,
    env: { ...featureScriptEnv(repo), ...env },
  });
  assert.equal(result.status, 0, `script failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
}


function admitQuality(repo: Repository, definition: string, verdict: "PASS" | "FAIL" = "PASS") {
  const fixture = qualityFixture(repo, verdict);
  const evidence = verifyQuality(fixture.parent, fixture.request, "QATest", "ReviewTest", fixture.models);
  writeFileSync(join(repo.state, "quality.json"), JSON.stringify(evidence));
  runScript(extractScript(definition, "  - id: quality_admit"), repo, { QA: "QATest", REVIEW: "ReviewTest", OMP_SESSION_ID: "parent-id" });
  return { ...fixture, evidence };
}

function changeTranscript(path: string, mutate: (rows: TranscriptRow[]) => void): void {
  const rows: TranscriptRow[] = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
  mutate(rows);
  writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
}

test("effective quality accepts two independent PASS using canonical family tokens", () => {
  const repo = repository();
  try {
    const fixture = qualityFixture(repo);
    const evidence = verifyQuality(fixture.parent, fixture.request, "QATest", "ReviewTest", fixture.models);
    assert.equal(evidence.action, "complete");
    assert.equal(evidence.implementer.family, "canonical-openai");
    assert.deepEqual(evidence.verdicts.map(verdict => [verdict.role, verdict.model.family]),
      [["qa", "canonical-anthropic"], ["reviewer", "canonical-anthropic"]]);
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

test("template and installed render share the executable candidate publication contract", () => {
  const contracts = definitions.map(([, path]) => {
    const source = readFileSync(path, "utf8");
    return source.slice(source.indexOf("  - id: implement\n"));
  });
  assert.equal(contracts[0], contracts[1]);
});

for (const scenario of ["fabricated report", "other SHA", "same subagent", "same-family fallback",
  "indeterminate model", "wrong parent", "wrong invocation", "stale invocation", "wrong role",
  "unattributed id", "uncorrelated SHA", "exhaustion", "effective implementer fallback",
  "other run", "other iteration", "other attempt"] as const) {
  test(`effective quality rejects ${scenario} with diagnostics and preserves local candidate`, () => {
    const repo = repository();
    try {
      const fixture = qualityFixture(repo);
      const before = git(repo.worktree, "rev-parse", "HEAD");
      if (scenario === "wrong invocation") changeTranscript(fixture.parent, rows => { rows.splice(2, 1); });
      else if (scenario !== "same subagent") changeTranscript(
        fixture.paths[scenario === "effective implementer fallback" ? "implementer" : "qa"]!, rows => {
          const final = rows.at(-1)!.message!;
          if (scenario === "fabricated report") final.role = "user";
          if (scenario === "other SHA" || scenario === "wrong role" || scenario === "other run" ||
            scenario === "other iteration" || scenario === "other attempt") {
            assert.ok(Array.isArray(final.content));
            const report: Record<string, unknown> = JSON.parse(final.content[0]!.text!);
            if (scenario === "other SHA") report.sha = "b".repeat(40);
            if (scenario === "wrong role") report.role = "reviewer";
            if (scenario === "other run") report.run = "other-run";
            if (scenario === "other iteration") report.iteration = 999;
            if (scenario === "other attempt") report.attempt = "older-attempt";
            final.content[0]!.text = JSON.stringify(report);
          }
          if (scenario === "same-family fallback") {
            rows.splice(3, 0, { type: "model_change", role: "fallback", model: "openai-codex/effective", resolvedModelIsFallback: true });
            final.provider = "openai-codex"; final.model = "effective";
          }
          if (scenario === "effective implementer fallback") { final.provider = "anthropic"; final.model = "alternate"; }
          if (scenario === "indeterminate model") delete final.model;
          if (scenario === "wrong parent") rows[0]!.parentSession = "/other/parent.jsonl";
          if (scenario === "stale invocation") rows[1]!.timestamp = fixture.request.attempt;
          if (scenario === "unattributed id") rows[2]!.role = "subagent:Other";
          if (scenario === "uncorrelated SHA") rows[4]!.message!.toolCallId = "invented";
          if (scenario === "exhaustion") for (const row of rows) if (row.message?.role === "assistant") {
            row.message.stopReason = "error"; row.message.errorMessage = "provider unavailable";
          }
        });
      assert.throws(() => verifyQuality(fixture.parent, fixture.request, "QATest",
        scenario === "same subagent" ? "QATest" : "ReviewTest", fixture.models), /mismatch|missing|distinct|same-family|indeterminate|parent|invocation|attributed|exhausted|invalid/);
      assert.equal(git(repo.worktree, "rev-parse", "HEAD"), before);
      assert.equal(git(repo.worktree, "status", "--porcelain"), "");
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });
}

for (const role of ["qa", "reviewer"] as const) {
  test(`a ${role} FAIL independently returns findings to implementation`, () => {
    const repo = repository();
    try {
      const fixture = qualityFixture(repo);
      changeTranscript(fixture.paths[role]!, rows => {
        const message = rows.at(-1)!.message!;
        assert.ok(Array.isArray(message.content));
        const report: Record<string, unknown> = JSON.parse(message.content[0]!.text!);
        report.verdict = "FAIL"; report.findings = [`${role} acceptance regression`];
        message.content[0]!.text = JSON.stringify(report);
      });
      const evidence = verifyQuality(fixture.parent, fixture.request, "QATest", "ReviewTest", fixture.models);
      assert.equal(evidence.action, "rewind");
      assert.equal(evidence.verdicts.find(verdict => verdict.role === role)?.verdict, "FAIL");
      assert.equal(evidence.verdicts.find(verdict => verdict.role !== role)?.verdict, "PASS");
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });
}

test("effective quality records actual failed attempts and successful fallback", () => {
  const repo = repository();
  try {
    const fixture = qualityFixture(repo);
    changeTranscript(fixture.paths.qa!, rows => {
      rows.splice(3, 0,
        { type: "message", id: "failed-primary", message: { role: "assistant", provider: "openai-codex", model: "effective",
          stopReason: "error", errorMessage: "stream interrupted", content: [] } },
        { type: "model_change", id: "actual-fallback", role: "fallback", model: "anthropic/alternate", resolvedModelIsFallback: true });
    });
    const evidence = verifyQuality(fixture.parent, fixture.request, "QATest", "ReviewTest", fixture.models);
    assert.equal(evidence.action, "complete");
    assert.equal(evidence.verdicts[0]!.model.provider, "anthropic");
    assert.ok(evidence.verdicts[0]!.attempts.some(attempt => attempt.event === "failed-primary" && attempt.error === "stream interrupted"));
    assert.equal(evidence.verdicts[0]!.fallbacks[0]!.resolvedModelIsFallback, true);
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

test("effective quality attributes structured yield to its emitting message", () => {
  const repo = repository();
  try {
    const fixture = qualityFixture(repo);
    changeTranscript(fixture.paths.qa!, rows => {
      const message = rows.at(-1)!.message!;
      assert.ok(Array.isArray(message.content));
      const report: Record<string, unknown> = JSON.parse(message.content[0]!.text!);
      message.stopReason = "toolUse";
      message.content = [{ type: "toolCall", name: "yield", id: "yield-qa", arguments: report }];
      rows.push({ type: "message", message: { role: "toolResult", toolName: "yield", toolCallId: "yield-qa", content: [] } });
    });
    assert.equal(verifyQuality(fixture.parent, fixture.request, "QATest", "ReviewTest", fixture.models).action, "complete");
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

for (const format of ["single", "batch"] as const) {
  test(`quality ${format} assignments produce admitted raw-JSON verdicts and inspected byte seals`, async t => {
    const repo = repository();
    try {
      const fixture = qualityFixture(repo);
      t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ dagRunDetails: {
        params: `PRIMARY=${repo.primary} ISSUE=189 OMP_SESSION_ID=parent-id`,
        nodes: [{ step: { id: "implement" }, startedAt: fixture.request.implementStartedAt }],
      } })));
      const ctx = { cwd: repo.primary, sessionManager: { getSessionDir: () => dirname(fixture.parent) }, models: fixture.models };
      for (const [role, name] of [["qa", "QATest"], ["reviewer", "ReviewTest"]] as const) {
        const task = { name, agent: role, task: qualityMarker(fixture.request, role) };
        const routed = await qualityDecision({ toolName: "task", toolCallId: `spawn-${name}`,
          input: format === "single" ? task : { tasks: [task] } }, ctx);
        assert.ok(routed && "input" in routed);
        const assigned = format === "single" ? routed.input : routed.input.tasks[0];
        assert.ok(assigned.outputSchema);
        const lines = (assigned.task as string).split("\n");
        const command = lines.find(line => line.startsWith("git -C "))!;
        const report = JSON.parse(lines.find(line => line.startsWith("{"))!);
        report.findings = ["Acceptance checked ✓"];
        const sha = execFileSync("bash", ["-c", command], { encoding: "utf8" }).trim();
        assert.equal(sha, fixture.request.sha);
        changeTranscript(fixture.parent, rows => {
          for (const row of rows) {
            const content = row.message?.content;
            if (!Array.isArray(content)) continue;
            for (const call of content) {
              const tasks = call.arguments?.tasks as { name: string; task: string }[] | undefined;
              const invoked = tasks?.find(item => item.name === name);
              if (invoked) invoked.task = assigned.task;
            }
          }
        });
        changeTranscript(fixture.paths[role]!, rows => {
          rows[1]!.task = assigned.task;
          rows[3]!.message!.content = [{ type: "toolCall", id: `sha-${name}`, name: "bash", arguments: { command } }];
          rows[4]!.message!.content = sha;
          rows.at(-1)!.message!.content = JSON.stringify(report);
        });
        const verdict = inspectVerdict(fixture.parent, fixture.request, role, name, fixture.models);
        const inspected = readFileSync(fixture.paths[role]!);
        assert.equal(verdict.verdict, "PASS");
        assert.deepEqual(verdict.findings, ["Acceptance checked ✓"]);
        assert.equal(verdict.bytes, inspected.length);
        assert.equal(verdict.digest, createHash("sha256").update(inspected).digest("hex"));
      }
      assert.equal(verifyQuality(fixture.parent, fixture.request, "QATest", "ReviewTest", fixture.models).action, "complete");
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });
}

test("template quality admission accepts appended session_exit rows on sealed transcripts", () => {
  const repo = repository();
  try {
    const definition = definitions[0][1];
    runScript(extractScript(definition, "  - id: gate"), repo);
    const fixture = admitQuality(repo, definition);
    for (const role of ["qa", "reviewer"]) appendFileSync(fixture.paths[role]!,
      JSON.stringify({ type: "custom", customType: "session_exit", data: { reason: "dispose" } }) + "\n");
    runScript(extractScript(definition, "  - id: quality_admit"), repo,
      { QA: "QATest", REVIEW: "ReviewTest", OMP_SESSION_ID: "parent-id" });
    assert.equal(readFileSync(join(repo.state, "quality-action"), "utf8"), "complete\n");
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

test("template quality admission checks provenance on the sealed prefix after duplicate event appends", () => {
  const repo = repository();
  try {
    const definition = definitions[0][1];
    runScript(extractScript(definition, "  - id: gate"), repo);
    const fixture = admitQuality(repo, definition);
    for (const verdict of fixture.evidence.verdicts) {
      const duplicate = readFileSync(verdict.transcript, "utf8").split("\n")
        .find(line => line && JSON.parse(line).id === verdict.event);
      assert.ok(duplicate);
      appendFileSync(verdict.transcript, duplicate + "\n");
    }
    runScript(extractScript(definition, "  - id: quality_admit"), repo,
      { QA: "QATest", REVIEW: "ReviewTest", OMP_SESSION_ID: "parent-id" });
    assert.equal(readFileSync(join(repo.state, "quality-action"), "utf8"), "complete\n");
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

test("template quality admission rejects truncated inspected transcripts", () => {
  const repo = repository();
  try {
    const definition = definitions[0][1];
    runScript(extractScript(definition, "  - id: gate"), repo);
    const fixture = admitQuality(repo, definition);
    const inspected = readFileSync(fixture.paths.qa!);
    writeFileSync(fixture.paths.qa!, inspected.subarray(0, inspected.length - 1));
    const result = spawnSync("bash", ["-c", extractScript(definition, "  - id: quality_admit")], {
      encoding: "utf8", env: { ...featureScriptEnv(repo), QA: "QATest", REVIEW: "ReviewTest", OMP_SESSION_ID: "parent-id" },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /transcript changed/);
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

test("template quality preparation fails before writing a request for a missing worktree", () => {
  const repo = repository();
  try {
    const bin = join(repo.root, "bin");
    const curl = join(bin, "curl");
    writeFileSync(curl, "#!/bin/sh\nprintf '%s\\n' '{\"dagRunDetails\":{\"nodes\":[{\"step\":{\"id\":\"implement\"},\"startedAt\":\"2026-10-16T00:00:00Z\"}]}}'\n");
    chmodSync(curl, 0o755);
    const missing = join(repo.root, "missing-worktree");
    const result = spawnSync("bash", ["-c", extractScript(definitions[0][1], "  - id: quality_prepare")], {
      encoding: "utf8", env: { ...featureScriptEnv(repo), WORKTREE: missing, OMP_SESSION_ID: "parent-id" },
    });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(missing));
    assert.equal(existsSync(join(repo.state, "quality-request.json")), false);
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

test("quality completion hook validates provenance and persists independent evidence", async t => {
  const repo = repository();
  try {
    const fixture = qualityFixture(repo);
    t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ dagRunDetails: {
      params: `PRIMARY=${repo.primary} ISSUE=189 OMP_SESSION_ID=parent-id`,
      nodes: [{ step: { id: "implement" }, startedAt: fixture.request.implementStartedAt }],
    } })));
    const ctx = { cwd: repo.primary, sessionManager: { getSessionDir: () => dirname(fixture.parent) }, models: fixture.models };
    const routed = await qualityDecision({ toolName: "task", toolCallId: "quality-spawn", input: {
      tasks: [{ name: "NewQA", agent: "qa", task: qualityMarker(fixture.request, "qa") }],
    } }, ctx);
    assert.ok(routed && "input" in routed);
    assert.equal("model" in routed.input.tasks[0], false);
    assert.ok(routed.input.tasks[0].outputSchema);
    let spawnHook: ((event: { agent: string; patterns: string[]; spawnKey?: string }, ctx: { models: unknown }) => { model?: string[] } | undefined) | undefined;
    crossFamilyReview({ on: (_event: string, handler: typeof spawnHook) => { spawnHook = handler; } } as never);
    // The coordinator shares the reviewer's family, so only the bound implementer
    // admits that family; OMP keys a nested, renamed async spawn as `parent.name-N`.
    const coordinator = { ...fixture.models, current: () => ({ provider: "anthropic", id: "alternate", lineage: "canonical-anthropic" }) };
    const selected = spawnHook!({ agent: "qa", spawnKey: "Parent.NewQA-2", patterns: ["openai-codex/effective", "anthropic/alternate"] }, { models: coordinator });
    assert.deepEqual(selected?.model?.[0], "anthropic/alternate");
    assert.ok(selected?.model?.every(spec => fixture.models.resolve(spec)?.provider !== "openai-codex"));
    const event = { toolName: "bash", toolCallId: "complete-quality", input: {
      command: "dagu human-task complete feature --run-id test-run --step quality_review --input QA=QATest --input REVIEW=ReviewTest",
    } };
    assert.equal(await qualityDecision(event, ctx), undefined);
    const evidence = JSON.parse(readFileSync(join(repo.state, "quality.json"), "utf8"));
    assert.equal(evidence.verdicts.length, 2);
    assert.equal(evidence.action, "complete");
    const blocked = await qualityDecision({ ...event, input: { command: event.input.command.replace("QA=QATest", "QA=Invented") } }, ctx);
    assert.ok(blocked && "block" in blocked);
    assert.match(blocked.reason, /QUALITY_BLOCKED.*candidate retained/);
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

for (const [name, definition] of definitions) {
  const exitScript = extractScript(definition, "  exit:");
  const checkpointScript = extractScript(definition, "  - id: checkpoint_push");
  const closeGateScript = extractScript(definition, "  - id: close_gate");

  test(`${name} close and exit resolve the same cleanup script with merged-close mode`, () => {
    const source = readFileSync(definition, "utf8");
    assert.match(source, /- id: close_gate\n[\s\S]*?- CLEANUP_CLOSE: "true"\n    run: &feature_cleanup \|/);
    assert.match(source, /  exit:\n    run: \*feature_cleanup/);
    assert.equal(closeGateScript.replace("CLEANUP_CLOSE=true\n", ""), exitScript);
  });
  const autoMergeScript = extractScript(definition, "  - id: auto_merge");

  const captureScript = extractScript(definition, "  - id: capture");
  const gateScript = extractScript(definition, "  - id: gate");
  const pushScript = extractScript(definition, "  - id: push");

  for (const signing of [true, false]) {
    test(`${name} capture signs delivery commits with configured SSH signing (${signing})`, () => {
      const repo = repository();
      try {
        const home = join(repo.root, "home");
        mkdirSync(home);
        const key = join(home, "signing-key");
        execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], { env: { ...process.env, DAGU_PARAMS_JSON: "{}", HOME: home } });
        const signers = join(home, "allowed-signers");
        writeFileSync(signers, `feature-test@example.com ${readFileSync(`${key}.pub`, "utf8")}`);
        git(repo.worktree, "config", "gpg.format", "ssh");
        git(repo.worktree, "config", "user.signingkey", `${key}.pub`);
        git(repo.worktree, "config", "gpg.ssh.allowedSignersFile", signers);
        git(repo.worktree, "config", "commit.gpgsign", String(signing));
        writeFileSync(join(repo.worktree, "README.txt"), "signed delivery\n");
        runScript(captureScript, repo, { HOME: home });
        assert.equal(git(repo.worktree, "log", "-1", "--format=%G?"), signing ? "G" : "N");
        if (signing) git(repo.worktree, "verify-commit", "HEAD");
        const candidate = JSON.parse(readFileSync(join(repo.state, "candidate.json"), "utf8"));
        assert.equal(candidate.sha, git(repo.worktree, "rev-parse", "HEAD"));
        runScript(gateScript, repo, { HOME: home });
        assert.equal(JSON.parse(readFileSync(join(repo.state, "gate.json"), "utf8")).sha, candidate.sha);
        const sha = git(repo.worktree, "rev-parse", "HEAD");
        const dates = git(repo.worktree, "show", "-s", "--format=%at:%ct", sha);
        const checksum = execFileSync("cksum", { input: "test-run:0", encoding: "utf8" }).split(" ")[0]!;
        const epoch = 1700000000 + Number(checksum) % 100000000;
        assert.equal(dates, `${epoch}:${epoch}`);
        runScript(captureScript, repo, { HOME: home });
        assert.equal(git(repo.worktree, "rev-parse", "HEAD"), sha);
        assert.equal(git(repo.worktree, "show", "-s", "--format=%at:%ct"), dates);
        assert.equal(git(repo.worktree, "rev-list", "--count", "origin/main..HEAD"), "1");
      } finally { rmSync(repo.root, { recursive: true, force: true }); }
    });
  }
  test(`${name} admits FAIL findings for same-run push-back and preserves the candidate`, () => {
    const repo = repository();
    try {
      runScript(gateScript, repo);
      const before = git(repo.worktree, "rev-parse", "HEAD");
      const { evidence } = admitQuality(repo, definition, "FAIL");
      assert.equal(evidence.action, "rewind");
      assert.equal(readFileSync(join(repo.state, "quality-action"), "utf8"), "rewind\n");
      assert.deepEqual(evidence.verdicts[0]!.findings, ["Fix acceptance regression"]);
      const result = spawnSync("bash", ["-c", pushScript], { encoding: "utf8", env: featureScriptEnv(repo) });
      assert.notEqual(result.status, 0);
      assert.equal(git(repo.worktree, "rev-parse", "HEAD"), before);
      const transition = extractStep(readFileSync(definition, "utf8"), "quality_transition");
      assert.match(transition, /rewind_to: implement/);
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });

  test(`${name} publication requires admitted, unchanged transcript-backed verdicts`, () => {
    const repo = repository();
    try {
      runScript(gateScript, repo);
      const fixture = admitQuality(repo, definition);
      changeTranscript(fixture.paths.qa!, rows => { rows.at(-1)!.message!.model = "tampered!"; });
      const result = spawnSync("bash", ["-c", extractScript(definition, "  - id: quality_admit")], {
        encoding: "utf8", env: { ...featureScriptEnv(repo), QA: "QATest", REVIEW: "ReviewTest", OMP_SESSION_ID: "parent-id" },
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /transcript changed/);
      const evidence = { ...fixture.evidence, action: "rewind" };
      writeFileSync(join(repo.state, "quality.json"), JSON.stringify(evidence));
      const rejected = spawnSync("bash", ["-c", pushScript], { encoding: "utf8", env: featureScriptEnv(repo) });
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /checksum did NOT match/);
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });

  test(`${name} every candidate publication follows gate and effective QA/review admission`, () => {
    const source = readFileSync(definition, "utf8");
    for (const [step, dependency] of [
      ["recover_gate", "gate"], ["quality_prepare", "recover_gate"], ["quality_review", "quality_prepare"],
      ["quality_admit", "quality_review"], ["quality_transition", "quality_admit"],
      ["validation", "quality_transition"], ["push", "validation"], ["auto_merge", "pr"],
    ]) assert.match(extractStep(source, step!), new RegExp(`depends: ${dependency}`));
    const publications = source.split("\n  - id:").filter(block => block.includes('push "--force-with-lease=$remote_ref:$expected" --set-upstream origin "$sha:$remote_ref"'));
    assert.equal(publications.length, 1);
    assert.match(publications[0]!, /^ push\n/);
    assert.match(extractStep(source, "await_merge"), /rewind_to: rebase/);
    assert.match(extractStep(source, "quality_transition"), /rewind_to: implement/);
  });

  test(`${name} terminal cleanup retains an uncaptured delivery whose HEAD is on the base`, () => {
    const repo = repository();
    try {
      writeFileSync(join(repo.worktree, "delivery"), "keep this\n");
      symlinkSync(join(repo.root, "outside"), join(repo.worktree, "escape"));
      const before = git(repo.worktree, "rev-parse", "HEAD");
      const rejected = spawnSync("bash", ["-c", captureScript], { encoding: "utf8", env: featureScriptEnv(repo) });
      assert.notEqual(rejected.status, 0);
      assert.match(runScript(exitScript, repo), /dirty worktree; files retained/);
      assert.equal(git(repo.worktree, "rev-parse", "HEAD"), before);
      assert.equal(readFileSync(join(repo.worktree, "delivery"), "utf8"), "keep this\n");
      assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), true);
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });

  test(`${name} captures every file kind exactly and repeats with the same candidate`, () => {
    const repo = repository();
    try {
      const base = git(repo.worktree, "rev-parse", "HEAD");
      renameSync(join(repo.worktree, "README.txt"), join(repo.worktree, "renamed.txt"));
      rmSync(join(repo.worktree, "packages/first/package.json"));
      writeFileSync(join(repo.worktree, "packages/second/package.json"), '{"name":"changed"}\n');
      const binary = Buffer.from([0, 255, 1, 10, 0, 128]);
      writeFileSync(join(repo.worktree, "new binary\nfile"), binary);
      writeFileSync(join(repo.worktree, "executable"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(repo.worktree, "executable"), 0o755);
      symlinkSync("renamed.txt", join(repo.worktree, "internal-link"));
      runScript(captureScript, repo);
      const sha = git(repo.worktree, "rev-parse", "HEAD");
      const candidate = JSON.parse(readFileSync(join(repo.state, "candidate.json"), "utf8"));
      assert.equal(candidate.sha, sha);
      assert.equal(candidate.base, base);
      assert.equal(candidate.summary, "Delivered files");
      assert.equal(candidate.message, "feat: delivered change");
      assert.equal(git(repo.worktree, "rev-list", "--count", `${base}..HEAD`), "1");
      assert.equal(git(repo.worktree, "status", "--porcelain"), "");
      assert.deepEqual(execFileSync("git", ["-C", repo.worktree, "show", `${sha}:new binary\nfile`]), binary);
      assert.equal(git(repo.worktree, "show", `${sha}:packages/second/package.json`), '{"name":"changed"}');
      assert.equal(git(repo.worktree, "show", `${sha}:renamed.txt`), "base");
      assert.equal(git(repo.worktree, "show", `${sha}:internal-link`), "renamed.txt");
      assert.match(git(repo.worktree, "ls-tree", sha, "executable"), /^100755 /);
      const changes = git(repo.worktree, "diff", "--name-status", "-M", base, sha);
      assert.match(changes, /R100\s+README.txt\s+renamed.txt/);
      assert.match(changes, /D\s+packages\/first\/package.json/);
      assert.match(readFileSync(join(repo.state, "diff.patch"), "utf8"), /GIT binary patch/);
      runScript(checkpointScript, repo);
      const count = git(repo.worktree, "rev-list", "--count", "HEAD");
      const date = git(repo.worktree, "show", "-s", "--format=%at:%ct", sha);
      assert.match(runScript(captureScript, repo), new RegExp(`candidate_sha=${sha}`));
      assert.equal(git(repo.worktree, "rev-list", "--count", "HEAD"), count);
      assert.equal(git(repo.worktree, "show", "-s", "--format=%at:%ct", sha), date);
      runScript(gateScript, repo);
      admitQuality(repo, definition);
      runScript(pushScript, repo);
      assert.equal(git(repo.primary, "rev-parse", `origin/${repo.branch}`), sha);
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });

  for (const rejection of ["external worktree", "other run", "owner", "branch", "linked primary", "symlink", "dangling symlink", "directory symlink"] as const) {
    test(`${name} rejects ${rejection} while preserving deliveries, refs and both run states`, () => {
      const repo = repository();
      try {
        writeFileSync(join(repo.worktree, "delivery"), "keep this\n");
        git(repo.worktree, "add", "delivery");
        const other = join(repo.primary, ".workspace/worktrees/issue-190");
        git(repo.primary, "worktree", "add", "-b", "dagu/issue-190", other, "origin/main");
        writeFileSync(join(other, "other-delivery"), "keep other\n");
        const otherState = join(dirname(repo.state), "other-run");
        mkdirSync(otherState);
        writeFileSync(join(otherState, "identity"), "other owner\n");
        const env = featureScriptEnv(repo);
        if (rejection === "external worktree") env.WORKTREE = other;
        if (rejection === "other run") env.RUN = "other-run";
        if (rejection === "owner") env.OMP_SESSION_ID = "different-session";
        if (rejection === "branch") env.BRANCH = "dagu/issue-190";
        if (rejection === "linked primary") env.PRIMARY = repo.worktree;
        if (rejection === "symlink") symlinkSync(join(other, "other-delivery"), join(repo.worktree, "escape"));
        if (rejection === "dangling symlink") symlinkSync("../../../../outside/missing", join(repo.worktree, "escape"));
        if (rejection === "directory symlink") symlinkSync(other, join(repo.worktree, "escape"), "dir");
        const snapshot = () => ({
          refs: git(repo.primary, "show-ref"),
          delivery: readFileSync(join(repo.worktree, "delivery"), "utf8"),
          other: readFileSync(join(other, "other-delivery"), "utf8"),
          index: readFileSync(git(repo.worktree, "rev-parse", "--path-format=absolute", "--git-path", "index")).toString("base64"),
          states: readdirSync(dirname(repo.state), { recursive: true, withFileTypes: true })
            .filter(entry => entry.isFile()).map(entry => [join(entry.parentPath, entry.name), readFileSync(join(entry.parentPath, entry.name), "utf8")]),
        });
        const before = snapshot();
        const result = spawnSync("bash", ["-c", captureScript], { encoding: "utf8", env });
        assert.notEqual(result.status, 0, result.stdout);
        assert.deepEqual(snapshot(), before);
      } finally { rmSync(repo.root, { recursive: true, force: true }); }
    });
  }

  test(`${name} corrections replace one candidate and require current SHA evidence for publication`, () => {
    const repo = repository();
    try {
      writeFileSync(join(repo.worktree, "README.txt"), "first\n");
      runScript(captureScript, repo);
      const first = git(repo.worktree, "rev-parse", "HEAD");
      runScript(gateScript, repo);
      const evidence = readFileSync(join(repo.state, "gate.json"), "utf8");
      writeFileSync(join(repo.worktree, "README.txt"), "corrected\n");
      runScript(captureScript, repo);
      const second = git(repo.worktree, "rev-parse", "HEAD");
      assert.notEqual(first, second);
      assert.equal(git(repo.worktree, "rev-list", "--count", "origin/main..HEAD"), "1");
      assert.equal(readFileSync(join(repo.state, "historical", first, "gate.json"), "utf8"), evidence);
      writeFileSync(join(repo.state, "gate.json"), evidence);
      const refused = spawnSync("bash", ["-c", pushScript], { encoding: "utf8", env: featureScriptEnv(repo) });
      assert.notEqual(refused.status, 0);
      assert.equal(hasRef(repo.primary, `refs/remotes/origin/${repo.branch}`), false);
      runScript(gateScript, repo);
      admitQuality(repo, definition);
      runScript(pushScript, repo);
      assert.equal(git(repo.primary, "rev-parse", `origin/${repo.branch}`), second);
      const evidenceNow = readFileSync(join(repo.state, "gate.json"), "utf8");
      runScript(captureScript, repo);
      assert.equal(git(repo.worktree, "rev-parse", "HEAD"), second);
      assert.equal(readFileSync(join(repo.state, "gate.json"), "utf8"), evidenceNow);
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });

  for (const conflict of [false, true]) {
    test(`${name} ${conflict ? "conflict correction stays in the same run and branch" : "clean rebase renews candidate evidence"}`, () => {
      const repo = repository();
      try {
        writeFileSync(join(repo.worktree, "README.txt"), "feature\n");
        writeFileSync(join(repo.worktree, "other-feature-file"), "preserved delivery\n");
        runScript(captureScript, repo);
        const first = git(repo.worktree, "rev-parse", "HEAD");
        runScript(gateScript, repo);
        writeFileSync(join(repo.primary, conflict ? "README.txt" : "upstream"), "upstream\n");
        git(repo.primary, "add", ".");
        git(repo.primary, "commit", "-m", "upstream change");
        git(repo.primary, "push", "origin", "main");
        const base = git(repo.primary, "rev-parse", "HEAD");
        runScript(extractScript(definition, "  - id: rebase"), repo);
        assert.equal(readFileSync(join(repo.state, "base"), "utf8").trim(), base);
        assert.ok(existsSync(join(repo.state, "historical", first, "gate.json")));
        if (conflict) {
          assert.equal(readFileSync(join(repo.state, "conflict-action"), "utf8"), "rewind\n");
          assert.match(readFileSync(join(repo.worktree, "README.txt"), "utf8"), /<<<<<<< HEAD/);
          writeFileSync(join(repo.worktree, "README.txt"), "resolved delivery\n");
          runScript(captureScript, repo);
          assert.equal(git(repo.worktree, "show", "HEAD:README.txt"), "resolved delivery");
        }
        assert.equal(git(repo.worktree, "branch", "--show-current"), repo.branch);
        assert.equal(git(repo.worktree, "rev-list", "--count", `${base}..HEAD`), "1");
        assert.equal(git(repo.worktree, "status", "--porcelain"), "");
        assert.equal(git(repo.worktree, "show", "HEAD:other-feature-file"), "preserved delivery");
        const result = spawnSync("bash", ["-c", pushScript], { encoding: "utf8", env: featureScriptEnv(repo) });
        assert.notEqual(result.status, 0);
        runScript(gateScript, repo);
        admitQuality(repo, definition);
        runScript(pushScript, repo);
      } finally { rmSync(repo.root, { recursive: true, force: true }); }
    });
  }

  test(`${name} checkpoint leases preserve the PR head and push publishes only a fresh gated SHA`, () => {
    const repo = repository();
    try {
      stubGh(repo, "", 1);
      const remote = join(repo.root, "remote.git");
      const ref = "refs/dagu/checkpoints/issue-189";
      git(repo.worktree, "push", "origin", `HEAD:refs/heads/${repo.branch}`);
      const original = git(remote, "rev-parse", `refs/heads/${repo.branch}`);
      commit(repo, "README.txt", "candidate\n");
      const candidate = git(repo.worktree, "rev-parse", "HEAD");
      runScript(checkpointScript, repo);
      assert.equal(git(remote, "rev-parse", ref), candidate);
      assert.equal(readFileSync(join(repo.state, "checkpoint-sha"), "utf8"), `${candidate}\n`);
      assert.equal(git(remote, "rev-parse", `refs/heads/${repo.branch}`), original);
      const push = extractScript(definition, "  - id: push");
      const attempt = () => spawnSync("bash", ["-c", push], { encoding: "utf8", env: featureScriptEnv(repo) });
      assert.match(attempt().stderr, /no gated candidate/);
      const gateScript = extractScript(definition, "  - id: gate");
      const gateOptions = { encoding: "utf8", env: { ...featureScriptEnv(repo), GATE: "true" } } as const;
      assert.equal(spawnSync("bash", ["-c", gateScript], gateOptions).status, 0);
      commit(repo, "README.txt", "changed after gate\n");
      const stale = attempt();
      assert.equal(stale.status, 1);
      assert.match(stale.stderr, /stale candidate.*revalidation required/);
      assert.equal(git(remote, "rev-parse", `refs/heads/${repo.branch}`), original);
      git(remote, "update-ref", ref, original);
      const rejected = spawnSync("bash", ["-c", checkpointScript], { encoding: "utf8", env: featureScriptEnv(repo) });
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /stale info/);
      assert.equal(git(remote, "rev-parse", ref), original);
      assert.equal(readFileSync(join(repo.state, "checkpoint-sha"), "utf8"), `${candidate}\n`);
      git(remote, "update-ref", ref, candidate);
      runScript(checkpointScript, repo);
      assert.equal(spawnSync("bash", ["-c", gateScript], gateOptions).status, 0);
      admitQuality(repo, definition);
      runScript(push, repo);
      assert.equal(git(remote, "rev-parse", `refs/heads/${repo.branch}`), git(repo.worktree, "rev-parse", "HEAD"));
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  for (const [kind, gate, statusLine] of [
    ["tracked", "printf 'changed\\n' >> README.txt", " M README.txt"],
    ["untracked", "touch generated.txt", "?? generated.txt"],
  ] as const) {
    test(`${name} gate diagnoses ${kind} changes left by GATE`, () => {
      const repo = repository();
      try {
        const result = spawnSync("bash", ["-c", extractScript(definition, "  - id: gate")], {
          encoding: "utf8",
          env: { ...featureScriptEnv(repo), GATE: gate },
        });
        assert.equal(result.status, 1);
        assert.ok(result.stderr.includes(`gate: worktree ${repo.worktree} has changes after GATE:\n${statusLine}\n`), result.stderr);
        if (kind === "tracked") assert.match(result.stderr, /README\.txt \| 1 \+/);
      } finally {
        rmSync(repo.root, { recursive: true, force: true });
      }
    });
  }

  test(`${name} gate prints the tested SHA after a clean GATE`, () => {
    const repo = repository();
    try {
      const result = spawnSync("bash", ["-c", extractScript(definition, "  - id: gate")], {
        encoding: "utf8",
        env: { ...featureScriptEnv(repo), GATE: "true" },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `tested_sha=${git(repo.worktree, "rev-parse", "HEAD")}\n`);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} rebase retries a held index lock without changing the conflict action`, () => {
    const repo = repository();
    try {
      commit(repo, "feature.txt", "feature\n");
      writeFileSync(join(repo.primary, "upstream.txt"), "upstream\n");
      git(repo.primary, "add", ".");
      git(repo.primary, "commit", "-m", "upstream");
      git(repo.primary, "push", "origin", "main");
      writeFileSync(join(repo.state, "conflict-action"), "preserved\n");
      writeFileSync(git(repo.worktree, "rev-parse", "--git-path", "index.lock"), "");
      const result = spawnSync("bash", ["-c", extractScript(definition, "  - id: rebase")], {
        encoding: "utf8", env: featureScriptEnv(repo),
      });
      assert.equal(result.status, 75, result.stderr);
      assert.ok(result.stderr.includes(`rebase: index.lock held in ${repo.worktree}`));
      assert.equal(readFileSync(join(repo.state, "conflict-action"), "utf8"), "preserved\n");
      assert.match(readFileSync(definition, "utf8"), /- id: rebase\n    depends: dependency_review\n    retry_policy:\n      limit: 3\n      interval_sec: 5\n      exit_code: \[75\]/);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} rebase records a real conflict and rewinds`, () => {
    const repo = repository();
    try {
      commit(repo, "README.txt", "feature\n");
      writeFileSync(join(repo.primary, "README.txt"), "upstream\n");
      git(repo.primary, "add", ".");
      git(repo.primary, "commit", "-m", "upstream");
      git(repo.primary, "push", "origin", "main");
      const output = runScript(extractScript(definition, "  - id: rebase"), repo);
      assert.match(output, /conflict_files=README.txt/);
      assert.equal(readFileSync(join(repo.state, "conflict-action"), "utf8"), "rewind\n");
      assert.equal(git(repo.worktree, "status", "--porcelain"), "M README.txt");
      assert.match(readFileSync(join(repo.worktree, "README.txt"), "utf8"), /<<<<<<<[\s\S]*upstream[\s\S]*=======[\s\S]*feature[\s\S]*>>>>>>>/);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });
  test(`${name} start_gate creates and reuses a worktree through a symlinked primary`, () => {
    const repo = repository();
    try {
      git(repo.primary, "worktree", "remove", repo.worktree);
      git(repo.primary, "branch", "-D", repo.branch);
      writeFileSync(join(repo.primary, ".git", "info", "exclude"), "/.workspace/\n");
      const alias = join(repo.root, "primary-link");
      symlinkSync(repo.primary, alias, "dir");
      repo.primary = alias;
      repo.worktree = join(alias, ".workspace", "worktrees", "issue-189");
      const script = extractScript(definition, "  - id: start_gate");
      const env = { ...featureScriptEnv(repo), DAGU_FEATURE_BUNDLE: "test" };
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = spawnSync("bash", ["-c", script], { encoding: "utf8", env });
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.ok(existsSync(repo.worktree));
        assert.equal(git(repo.worktree, "branch", "--show-current"), repo.branch);
        assert.ok(result.stdout.includes("worktree="));
      }
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  for (const scenario of [
    { label: "CLEAN", mergeStateStatus: "CLEAN", merge: "immediate" },
    { label: "auto-merge enabled", mergeStateStatus: "CLEAN", autoMergeRequest: { enabledAt: "2026-10-16" } },
    ...["BEHIND", "BLOCKED", "UNSTABLE", "DIRTY", "UNKNOWN"].map((mergeStateStatus) => ({
      label: mergeStateStatus, mergeStateStatus, merge: "auto",
    })),
    { label: "MERGED same head", state: "MERGED", mergeCommit: { oid: "a".repeat(40) } },
    { label: "MERGED different head", state: "MERGED", mergeCommit: { oid: "a".repeat(40) }, wrongHead: true, failure: true },
    { label: "gh observation error", ghError: true, failure: true },
    { label: "gh merge error", mergeStateStatus: "CLEAN", merge: "immediate", mergeError: true, failure: true },
  ]) {
  test(`${name} auto_merge ${scenario.label} preserves the tested body and head`, () => {
    const repo = repository();
    try {
      const trailers = [
        "Dagu-Feature-Bundle: 0.2.0",
        `Dagu-Feature-Source: pablontiv/a4s@${"a".repeat(40)}`,
        "Dagu-Feature-Bootstrap: bootstrap-test",
      ].join("\n");
      const commitBody = `Tested body, not the PR description.\nA second line with "quotes" and $variables.\n\n${trailers}`;
      git(repo.worktree, "commit", "--allow-empty", "-m", "feat: tested change", "-m", commitBody);
      const sha = git(repo.worktree, "rev-parse", "HEAD");
      recordCandidate(repo);
      runScript(extractScript(definition, "  - id: gate"), repo);
      admitQuality(repo, definition);
      const bin = join(repo.root, "bin");
      mkdirSync(bin, { recursive: true });
      const executable = join(bin, "gh");
      const argsFile = join(repo.root, "merge-args");
      writeFileSync(executable, `#!/bin/sh
case "$*" in
  "pr view ${repo.branch} --json headRefOid --jq .headRefOid") printf '${sha}\\n' ;;
  "pr view ${repo.branch} --json state,mergeStateStatus,autoMergeRequest,mergeCommit,headRefOid")
    ${"ghError" in scenario ? "printf 'gh failure\\n' >&2; exit 17" : `printf '%s\\n' '${JSON.stringify({
      state: "state" in scenario ? scenario.state : "OPEN",
      mergeStateStatus: "mergeStateStatus" in scenario ? scenario.mergeStateStatus : "UNKNOWN",
      autoMergeRequest: "autoMergeRequest" in scenario ? scenario.autoMergeRequest : null,
      mergeCommit: "mergeCommit" in scenario ? scenario.mergeCommit : null,
      headRefOid: "wrongHead" in scenario ? "b".repeat(40) : sha,
    })}'`} ;;
  "pr view ${repo.branch} --json number --jq .number") printf '190\\n' ;;
  "pr view ${repo.branch} --json body --jq .body") printf 'Closes #189\\n' ;;
  "pr merge "*) printf '%s\\0' "$@" > "${argsFile}"; ${"mergeError" in scenario ? "exit 18" : ":"} ;;
  *) printf 'unexpected gh invocation: %s\\n' "$*" >&2; exit 1 ;;
esac
`);
      chmodSync(executable, 0o755);
      if ("failure" in scenario) {
        const result = spawnSync("bash", ["-c", autoMergeScript], {
          encoding: "utf8", env: featureScriptEnv(repo),
        });
        assert.notEqual(result.status, 0);
        if ("ghError" in scenario || "wrongHead" in scenario) assert.equal(existsSync(argsFile), false);
        return;
      }
      assert.match(runScript(autoMergeScript, repo), new RegExp(`pr=190\\nhead_sha=${sha}`));
      if (!("merge" in scenario)) {
        assert.equal(existsSync(argsFile), false);
        return;
      }
      const mergeBody = `Closes #189\n\n${commitBody}`;
      assert.deepEqual(readFileSync(argsFile, "utf8").split("\0"), [
        "pr", "merge", repo.branch, ...(scenario.merge === "auto" ? ["--auto"] : []),
        "--squash", "--match-head-commit", sha, "--body", mergeBody, "",
      ]);
      assert.ok(mergeBody.endsWith(trailers));
      const parsed = execFileSync("git", ["interpret-trailers", "--parse"], {
        input: mergeBody,
        encoding: "utf8",
      });
      assert.equal(parsed.trim(), trailers);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });
  }

  for (const converges of [true, false]) {
    test(`${name} auto_merge ${converges ? "waits for the pushed head" : "reports expected and last observed heads on expiry"}`, () => {
      const repo = repository();
      try {
        const sha = git(repo.worktree, "rev-parse", "HEAD");
        recordCandidate(repo);
        runScript(extractScript(definition, "  - id: gate"), repo);
        admitQuality(repo, definition);
        const oldSha = "b".repeat(40);
        const bin = join(repo.root, "bin");
        mkdirSync(bin, { recursive: true });
        const reads = join(repo.root, "head-reads");
        const sleeps = join(repo.root, "sleeps");
        const merged = join(repo.root, "merged");
        writeFileSync(join(bin, "gh"), `#!/bin/sh
case "$*" in
  "pr view ${repo.branch} --json headRefOid --jq .headRefOid")
    n=0; test ! -f "${reads}" || n=$(cat "${reads}")
    n=$((n + 1)); printf '%s' "$n" > "${reads}"
    if ${converges ? "true" : "false"} && test "$n" -ge 3; then
      printf '${sha}\\n'
    else
      printf '${oldSha}\\n'
    fi ;;
  "pr view ${repo.branch} --json state,mergeStateStatus,autoMergeRequest,mergeCommit,headRefOid")
    printf '%s\\n' '${JSON.stringify({ state: "OPEN", mergeStateStatus: "BLOCKED", autoMergeRequest: null, mergeCommit: null, headRefOid: sha })}' ;;
  "pr view ${repo.branch} --json number --jq .number") printf '190\\n' ;;
  "pr merge "*) printf '%s\\n' "$*" > "${merged}" ;;
  *) exit 1 ;;
esac
`);
        writeFileSync(join(bin, "sleep"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${sleeps}"\n`);
        chmodSync(join(bin, "gh"), 0o755);
        chmodSync(join(bin, "sleep"), 0o755);
        const result = spawnSync("bash", ["-c", autoMergeScript], {
          encoding: "utf8", env: featureScriptEnv(repo),
        });
        assert.equal(readFileSync(reads, "utf8"), converges ? "3" : "13");
        assert.deepEqual(readFileSync(sleeps, "utf8").trim().split("\n"), Array(converges ? 2 : 12).fill("5"));
        if (converges) {
          assert.equal(result.status, 0, result.stderr);
          assert.match(readFileSync(merged, "utf8"), new RegExp(`--auto --squash --match-head-commit ${sha}`));
        } else {
          assert.notEqual(result.status, 0);
          assert.match(result.stderr, new RegExp(`auto_merge: PR head did not converge after 60s: expected ${sha}, last observed ${oldSha}`));
        }
      } finally {
        rmSync(repo.root, { recursive: true, force: true });
      }
    });
  }

  test(`${name} close_gate reports a PRIMARY outside BASE_BRANCH`, () => {
    const repo = repository();
    try {
      stubSuccessfulCloseGateGh(repo);
      git(repo.primary, "checkout", "-b", "feature-x");
      const result = runFailingCloseGate(closeGateScript, repo);
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        new RegExp(`close_gate: PRIMARY ${repo.primary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} on branch feature-x, expected main`),
      );
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} close_gate reports PRIMARY local changes and porcelain status`, () => {
    const repo = repository();
    try {
      stubSuccessfulCloseGateGh(repo);
      writeFileSync(join(repo.primary, "README.txt"), "dirty\n");
      const result = runFailingCloseGate(closeGateScript, repo);
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        new RegExp(`close_gate: PRIMARY ${repo.primary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} has local changes, expected clean`),
      );
      assert.match(result.stderr, / M README\.txt/);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} exit keeps a never-pushed branch when no PR exists and prints recovery locations`, () => {
    const repo = repository();
    try {
      commit(repo, "README.txt", "unpublished\n");
      stubGh(repo, "", 1, "no pull requests found\n");
      const output = runScript(exitScript, repo);
      assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), true);
      assert.equal(existsSync(repo.worktree), true);
      assert.match(output, new RegExp(`branch ${repo.branch.replace("/", "\\/")}`));
      assert.match(output, new RegExp(`worktree ${repo.worktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.match(output, /Recovery: preserve/);
      assert.match(output, /suffixed run ID/);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} exit cleans a squash-merged head when invoked outside the repository`, () => {
    const repo = repository();
    try {
      commit(repo, "README.txt", "squash merged\n");
      const head = git(repo.worktree, "rev-parse", "HEAD");
      git(repo.worktree, "push", "origin", `HEAD:${repo.branch}`);
      writeFileSync(join(repo.primary, "README.txt"), "squash merged\n");
      git(repo.primary, "add", "README.txt");
      git(repo.primary, "commit", "-m", "squash feature change");
      git(repo.primary, "push", "origin", "main");
      git(repo.worktree, "push", "origin", "--delete", repo.branch);
      stubGh(repo, `${JSON.stringify({ state: "MERGED", headRefOid: head, mergeCommit: { oid: git(repo.primary, "rev-parse", "HEAD") } })}\n`, 0);
      runScript(exitScript, repo);
      assert.equal(existsSync(repo.worktree), false);
      assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), false);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} exit keeps local commits newer than a merged PR head`, () => {
    const repo = repository();
    try {
      commit(repo, "README.txt", "published head\n");
      const mergedHead = git(repo.worktree, "rev-parse", "HEAD");
      git(repo.worktree, "push", "origin", `HEAD:${repo.branch}`);
      commit(repo, "README.txt", "new local head\n");
      git(repo.worktree, "push", "origin", "--delete", repo.branch);
      stubGh(repo, `${JSON.stringify({ state: "MERGED", headRefOid: mergedHead })}\n`, 0);
      const output = runScript(exitScript, repo);
      assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), true);
      assert.equal(existsSync(repo.worktree), true);
      assert.match(output, /PR head SHA differs/);
      assert.match(output, /Recovery: preserve/);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} exit keeps unpublished work and succeeds when gh fails`, () => {
    const repo = repository();
    try {
      commit(repo, "README.txt", "unpublished\n");
      stubGh(repo, "", 2, "GitHub unavailable\n");
      const output = runScript(exitScript, repo);
      assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), true);
      assert.equal(existsSync(repo.worktree), true);
      assert.match(output, /PR integration query failed/);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} checkpoint recovery retains the exact failed-gate candidate after exit`, () => {
    const repo = repository();
    try {
      stubGh(repo, "", 1);
      commit(repo, "README.txt", "recoverable candidate\n");
      const head = git(repo.worktree, "rev-parse", "HEAD");
      runScript(checkpointScript, repo);
      const failed = spawnSync("bash", ["-c", gateScript], {
        encoding: "utf8", env: { ...featureScriptEnv(repo), GATE: "false" },
      });
      assert.notEqual(failed.status, 0);
      runScript(exitScript, repo);
      assert.equal(existsSync(repo.worktree), true);
      assert.equal(git(repo.worktree, "rev-parse", "HEAD"), head);
      const recovery = join(repo.root, "recovery");
      execFileSync("git", ["clone", join(repo.root, "remote.git"), recovery], { stdio: "pipe" });
      git(recovery, "fetch", "origin", "refs/dagu/checkpoints/issue-189");
      assert.equal(git(recovery, "rev-parse", "FETCH_HEAD"), head);
      git(recovery, "cat-file", "-e", `${head}^{commit}`);
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });

  test(`${name} close_gate removes its recorded checkpoint after the integrated candidate advances`, () => {
    const repo = repository();
    try {
      commit(repo, "README.txt", "checkpoint candidate\n");
      runScript(checkpointScript, repo);
      commit(repo, "README.txt", "integrated correction\n");
      git(repo.primary, "merge", "--ff-only", repo.branch);
      git(repo.primary, "push", "origin", "main");
      stubSuccessfulCloseGateGh(repo);
      runScript(closeGateScript, repo);
      assert.equal(git(repo.primary, "ls-remote", "origin", "refs/dagu/checkpoints/issue-189"), "");
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });

  test(`${name} exit preserves a merely published head with integration diagnostics`, () => {
    const repo = repository();
    try {
      commit(repo, "README.txt", "published\n");
      git(repo.worktree, "push", "origin", `HEAD:${repo.branch}`);
      stubGh(repo, JSON.stringify({ state: "OPEN" }), 0);
      const output = runScript(exitScript, repo);
      assert.equal(existsSync(repo.worktree), true);
      assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), true);
      assert.match(output, /publication alone is not integration/);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} exit cleans a head merged into the base branch`, () => {
    const repo = repository();
    try {
      commit(repo, "README.txt", "merged\n");
      git(repo.primary, "merge", "--ff-only", repo.branch);
      git(repo.primary, "push", "origin", "main");
      runScript(exitScript, repo);
      assert.equal(existsSync(repo.worktree), false);
      assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), false);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} checkpoint reviews an existing dependency added to a second package`, () => {
    const repo = repository();
    try {
      commit(repo, "packages/second/package.json", '{"dependencies":{"shared":"1.0.0"}}\n');
      runScript(checkpointScript, repo);
      assert.equal(readFileSync(join(repo.state, "dependency-action"), "utf8"), "rewind\n");
      assert.equal(readFileSync(join(repo.state, "dependencies"), "utf8"), "dependency\tpackages/second/package.json\tshared\n");
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test(`${name} checkpoint completes when dependency relationships are unchanged`, () => {
    const repo = repository();
    try {
      commit(repo, "README.txt", "dependency relationships unchanged\n");
      runScript(checkpointScript, repo);
      assert.equal(readFileSync(join(repo.state, "dependency-action"), "utf8"), "complete\n");
      assert.equal(readFileSync(join(repo.state, "dependencies"), "utf8"), "");
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });
  for (const [step, downstream] of [["start_gate", "implement"], ["gate", "quality_prepare"], ["push", "pr"]]) {
    test(`${name} ${step} routes failure through its recovery checkpoint`, () => {
      const source = readFileSync(definition, "utf8");
      assert.match(extractStep(source, step!), /continue_on:\n      failure: true/);
      const recovery = extractStep(source, `recover_${step}`);
      assert.ok(recovery.includes(`condition: "\${${step}.exit_code}"`));
      assert.ok(recovery.includes(`rewind_to: ${step === "gate" ? "implement" : step}`));
      assert.match(recovery, /continue_on: skipped/);
      assert.ok(extractStep(source, downstream!).includes(`depends: recover_${step}`));
    });
  }
}

for (const [name, definition] of [
  ...definitions,
  ["PoC template", fileURLToPath(new URL("../skills/dagu-feature/poc.yaml", import.meta.url))],
  ["PoC rendered DAG", fileURLToPath(new URL("../../../.workspace/dagu/dags/poc.yaml", import.meta.url))],
] as const) {
  const phases = name.startsWith("PoC") ? ["base"] : ["start", "close"];
  for (const phase of phases) {
    const detector = `detect_${phase}_primary`;
    const checkpoint = `${phase}_primary_unavailable`;
    test(`${name} ${phase} detects concrete causes, rechecks ready and wires the checkpoint`, () => {
      const repo = repository();
      try {
        const source = readFileSync(definition, "utf8");
        const block = source.split(`  - id: ${checkpoint}\n`)[1]!.split("\n  - id:")[0]!;
        assert.ok(block.includes(`depends: ${detector}`));
        assert.ok(block.includes("continue_on: skipped"));
        assert.ok(block.includes('expected: "re:^primary "'));
        assert.ok(block.includes("action: human.task"));
        assert.ok(block.includes(`rewind_to: ${detector}`));
        assert.ok(block.includes(`\${steps.${detector}.outputs.reason}`));
        const script = extractScript(definition, `  - id: ${detector}`);
        const output = join(repo.root, "outputs");
        const detect = () => {
          writeFileSync(output, "");
          const result = spawnSync("bash", ["-c", script], {
            encoding: "utf8", env: { ...featureScriptEnv(repo), DAGU_OUTPUT_FILE: output },
          });
          assert.equal(result.status, 0, result.stderr);
          return { cause: readFileSync(output, "utf8").trim(), stderr: result.stderr };
        };
        assert.equal(detect().cause, "reason=ready");
        writeFileSync(join(repo.primary, "README.txt"), "operator changes\n");
        const dirty = detect();
        assert.match(dirty.cause, /^reason=primary dirty: .*README.txt$/);
        assert.match(dirty.stderr, /primary dirty: .*README.txt/);
        git(repo.primary, "restore", "README.txt");
        git(repo.primary, "switch", "-c", "operator");
        const branch = detect();
        assert.equal(branch.cause, "reason=primary on operator, expected main");
        assert.match(branch.stderr, /primary on operator, expected main/);
        git(repo.primary, "switch", "main");
        assert.equal(detect().cause, "reason=ready");
      } finally {
        rmSync(repo.root, { recursive: true, force: true });
      }
    });
  }
}

for (const [name, definition] of [
  ...definitions,
  ["PoC template", fileURLToPath(new URL("../skills/dagu-feature/poc.yaml", import.meta.url))],
  ["PoC rendered DAG", fileURLToPath(new URL("../../../.workspace/dagu/dags/poc.yaml", import.meta.url))],
] as const) {
  const gate = name.startsWith("PoC") ? "base" : "start_gate";
  for (const failure of ["fetch", "ff-only"] as const) {
    test(`${name} ${gate} diagnoses ${failure} and preserves operator commits`, () => {
      const repo = repository();
      try {
        const managed = join(repo.primary, ".workspace", "worktrees", "issue-189");
        writeFileSync(join(repo.primary, ".git", "info", "exclude"), "/.workspace/\n");
        if (failure === "fetch") git(repo.primary, "remote", "set-url", "origin", join(repo.root, "unavailable.git"));
        else {
          commit(repo, "remote.txt", "remote commit\n");
          git(repo.worktree, "push", "origin", "HEAD:main");
          writeFileSync(join(repo.primary, "operator.txt"), "operator commit\n");
          git(repo.primary, "add", "operator.txt");
          git(repo.primary, "commit", "-m", "operator commit");
        }
        const head = git(repo.primary, "rev-parse", "HEAD");
        const result = spawnSync("bash", ["-c", extractScript(definition, `  - id: ${gate}`)], {
          encoding: "utf8",
          env: { ...featureScriptEnv(repo), WORKTREE: managed, DAGU_FEATURE_BUNDLE: "test" },
        });
        assert.equal(result.status, 1);
        const diagnostic = gate === "base" && failure === "ff-only" ? "cause=primary_ahead" : `${gate}: ${failure}`;
        assert.ok(result.stderr.includes(diagnostic), result.stderr);
        assert.match(result.stderr, /restore origin access|reconcile primary/);
        assert.equal(git(repo.primary, "rev-parse", "HEAD"), head);
      } finally {
        rmSync(repo.root, { recursive: true, force: true });
      }
    });
  }
}

function extractStep(source: string, id: string): string {
  const start = source.indexOf(`  - id: ${id}\n`);
  assert.ok(start >= 0, `missing step ${id}`);
  const end = source.indexOf("\n  - id:", start + 1);
  return source.slice(start, end < 0 ? source.length : end).split("\nhandler_on:")[0]! + "\n";
}

for (const [name, definition] of definitions) {
  test(`${name} real Dagu reenqueue adopts retained worktree from terminal owner`, {
    ...liveDagu,
    timeout: 115_000,
  }, async (t) => {
    const repo = repository();
    git(repo.primary, "worktree", "remove", repo.worktree);
    git(repo.primary, "branch", "-D", repo.branch);
    rmSync(join(repo.primary, ".git", "dagu-feature", "resources"), { recursive: true });
    rmSync(join(repo.root, "bin", "dagu"));
    stubGh(repo, "OPEN\n", 0);
    const home = join(repo.root, "dagu-home");
    mkdirSync(join(home, "dags"), { recursive: true });
    const listener = createServer();
    await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>(resolve => listener.close(() => resolve()));
    writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\nscheduler:\n  port: 0\n`);
    const env: NodeJS.ProcessEnv = { ...process.env, ...featureScriptEnv(repo), DAGU_HOME: home, DAGU_PORT: String(port), DAGU_COORDINATOR_ENABLED: "false", OMP_SESSION_ID: "retained-owner" };
    let serviceLog = "";
    const service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(port)], {
      cwd: repo.root, env, stdio: ["ignore", "pipe", "pipe"],
    });
    service.stdout.on("data", data => { serviceLog += data; });
    service.stderr.on("data", data => { serviceLog += data; });
    const api = `http://127.0.0.1:${port}/api/v1`;
    const dagu = (...args: string[]) => execFileSync("dagu", args, { env, cwd: repo.root, encoding: "utf8" }).trim();
    type Detail = { statusLabel: string; nodes: Array<{ step: { name: string }; statusLabel: string; stdout?: string; stderr?: string }>; onExit?: { statusLabel: string; stdout?: string; stderr?: string } };
    async function until<T>(description: string, probe: () => Promise<T | undefined>): Promise<T> {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const value = await probe();
        if (value !== undefined) return value;
        await delay(150);
      }
      throw new Error(`Timed out: ${description}\n${serviceLog}`);
    }
    async function state(id: string, status: string): Promise<Detail> {
      return until(`${id} ${status}`, async () => {
        const response = await fetch(`${api}/dag-runs/feature/${id}`);
        if (!response.ok) return undefined;
        const run = (await response.json() as { dagRunDetails: Detail }).dagRunDetails;
        if (run.statusLabel === status && (status !== "failed" || run.onExit?.statusLabel === "succeeded")) return run;
        if (run.nodes.some(node => node.step.name === "recover_start_gate" && node.statusLabel === "waiting")) {
          throw new Error(run.nodes.map(node => `${node.step.name}: ${node.stderr && existsSync(node.stderr) ? readFileSync(node.stderr, "utf8") : node.statusLabel}`).join("\n"));
        }
        return undefined;
      });
    }
    try {
      await until("isolated Dagu ready", async () => {
        try { return (await fetch(`${api}/dag-runs`)).ok ? true : undefined; } catch { return undefined; }
      });
      const source = readFileSync(definition, "utf8");
      const file = join(home, "dags", "feature.yaml");
      writeFileSync(file, [
        "type: graph\nshell: bash\nmax_active_steps: 1\n",
        `params:\n  - ISSUE: "189"\n  - BASE_BRANCH: main\n  - PR_NUMBER: ""\n  - OMP_SESSION_ID: retained-owner\n`,
        `env:\n  - PRIMARY: ${JSON.stringify(repo.primary)}\n  - BRANCH: dagu/issue-\${ISSUE}\n  - GATE: "true"\n  - REQUIRED_CHECK: validate\n  - PATH: ${env.PATH}\n  - WORKTREE: ${repo.worktree}\n  - RUN: \${context.run.id}\n  - DAGU_FEATURE_BUNDLE: test\n`,
        source.slice(source.indexOf("  - DAGU_RESOURCE_GUARD: |"), source.indexOf("steps:\n")),
        "steps:\n", extractStep(source, "admission"), extractStep(source, "admit"),
        "  - id: triage\n    depends: admit\n    run: echo POC=no >> \"$DAGU_OUTPUT_FILE\"\n    outputs:\n      - name: POC\n",
        "  - id: triage_decision\n    depends: triage\n    run: echo reviewed\n",
        ...["detect_start_primary", "start_primary_unavailable", "start_gate", "recover_start_gate", "implement", "capture"].map(id => extractStep(source, id)),
        "handler_on:\n  exit:\n    run: |\n" + extractScript(definition, "  exit:").split("\n").map(line => "      " + line).join("\n") + "\n",
      ].join(""));
      dagu("validate", file);
      const first = `retained-189-${randomUUID()}`, second = `${first}-v2`;
      dagu("enqueue", "--run-id", first, file);
      await state(first, "waiting");
      writeFileSync(join(repo.worktree, "retained.txt"), "retained candidate\n");
      git(repo.worktree, "add", ".");
      git(repo.worktree, "commit", "-m", "precommitted candidate");
      const head = git(repo.worktree, "rev-parse", "HEAD");
      dagu("human-task", "complete", "feature", "--run-id", first, "--step", "implement",
        "--input", "MESSAGE=fix: retained candidate", "--input", "SUMMARY=Retained candidate", "--input", "IMPLEMENTER=ImplementTest");
      const failed = await state(first, "failed");
      const capture = failed.nodes.find(node => node.step.name === "capture")!;
      assert.equal(capture.statusLabel, "failed");
      assert.match(readFileSync(capture.stderr!, "utf8"), /HEAD differs from Dagu candidate/);
      const owner = git(repo.worktree, "rev-parse", "--path-format=absolute", "--git-path", "dagu-feature-owner");
      assert.equal(JSON.parse(readFileSync(owner, "utf8")).run, first);
      dagu("enqueue", "--run-id", second, file);
      const adopted = await state(second, "waiting");
      for (const id of ["admit", "start_gate"]) assert.equal(adopted.nodes.find(node => node.step.name === id)?.statusLabel, "succeeded");
      assert.equal(adopted.nodes.find(node => node.step.name === "implement")?.statusLabel, "waiting");
      const stateDir = join(repo.primary, ".git", "dagu-feature", "runs", second);
      assert.equal(readFileSync(join(stateDir, "previous-owner"), "utf8").trim(), first);
      assert.equal(readFileSync(join(repo.primary, ".git", "dagu-feature", "owners", "issue-189"), "utf8"), `${second}\t${repo.branch}\n`);
      assert.equal(JSON.parse(readFileSync(owner, "utf8")).run, second);
      assert.equal(readFileSync(owner, "utf8"), readFileSync(join(stateDir, "identity"), "utf8"));
      assert.equal(git(repo.worktree, "rev-parse", "HEAD"), head);
      assert.equal(readFileSync(join(repo.worktree, "retained.txt"), "utf8"), "retained candidate\n");
      const retry = spawnSync("bash", ["-c", extractScript(definition, "  - id: start_gate")], {
        env: { ...env, RUN: second, DAGU_FEATURE_BUNDLE: "test" }, encoding: "utf8",
      });
      assert.equal(retry.status, 0, retry.stderr);
      const valid = readFileSync(owner, "utf8");
      writeFileSync(owner, JSON.stringify({ ...JSON.parse(valid), session: "different-session" }));
      const mismatch = spawnSync("bash", ["-c", extractScript(definition, "  - id: start_gate")], {
        env: { ...env, RUN: second, DAGU_FEATURE_BUNDLE: "test" }, encoding: "utf8",
      });
      assert.equal(mismatch.status, 1);
      assert.match(mismatch.stderr, new RegExp(`ownership identity mismatch.*requesting_run=${second}.*observed=.*expected=`));
      writeFileSync(owner, valid);
      const active = spawnSync("bash", ["-c", extractScript(definition, "  - id: admit")], {
        env: { ...env, RUN: `${second}-other` }, encoding: "utf8",
      });
      assert.equal(active.status, 1);
      assert.ok(active.stderr.includes(`belongs to active run ${second}`));
      assert.equal(git(repo.worktree, "rev-parse", "HEAD"), head);
      const evidence = [...failed.nodes, ...adopted.nodes].filter(node => ["admit", "start_gate", "capture"].includes(node.step.name))
        .map(node => ({ step: node.step.name, status: node.statusLabel,
          stdout: node.stdout && readFileSync(node.stdout, "utf8"), stderr: node.stderr && readFileSync(node.stderr, "utf8") }));
      t.diagnostic(`Dagu ${liveDaguVersion}; runs=${first}:failed/capture,${second}:waiting/implement; HEAD=${head}; owner=${valid.trim()}; logs=${JSON.stringify(evidence)}; onExit=${failed.onExit?.stdout ? readFileSync(failed.onExit.stdout, "utf8") : JSON.stringify(failed.onExit)}`);
    } finally {
      service.kill("SIGTERM");
      await new Promise<void>(resolve => service.once("exit", () => resolve()));
      rmSync(repo.root, { recursive: true, force: true });
    }
  });
}
test("real Dagu retries rebase after a six-second index lock", {
  ...liveDagu,
  timeout: 150_000,
}, async () => {
  const repo = repository();
  rmSync(join(repo.root, "bin", "dagu"));
  const home = join(repo.root, "dagu-home");
  mkdirSync(join(home, "dags"), { recursive: true });
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\n`);
  const env = { ...process.env, ...featureScriptEnv(repo), DAGU_HOME: home, DAGU_COORDINATOR_ENABLED: "false" };
  let serviceLog = "";
  const service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: repo.root, env, stdio: ["ignore", "pipe", "pipe"],
  });
  service.stdout.on("data", data => { serviceLog += data; });
  service.stderr.on("data", data => { serviceLog += data; });
  const id = `lock-retry-${randomUUID()}`;
  async function until<T>(description: string, probe: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const value = await probe();
      if (value !== undefined) return value;
      await delay(150);
    }
    throw new Error(`Timed out: ${description}\n${serviceLog}`);
  }
  let unlock: NodeJS.Timeout | undefined;
  try {
    commit(repo, "feature.txt", "feature\n");
    writeFileSync(join(repo.primary, "upstream.txt"), "upstream\n");
    git(repo.primary, "add", ".");
    git(repo.primary, "commit", "-m", "upstream");
    git(repo.primary, "push", "origin", "main");
    const lock = git(repo.worktree, "rev-parse", "--git-path", "index.lock");
    writeFileSync(lock, "");
    const source = readFileSync(definitions[0][1], "utf8");
    const step = extractStep(source, "rebase").replace("    depends: dependency_review\n", "");
    const file = join(home, "dags", "lock-retry.yaml");
    const dagEnv = Object.entries(featureScriptEnv(repo)).map(([key, value]) => `  ${key}: ${JSON.stringify(value ?? "")}`).join("\n");
    writeFileSync(file, `name: lock-retry\nenv:\n${dagEnv}\nsteps:\n${step}`);
    const api = `http://127.0.0.1:${port}/api/v1`;
    await until("isolated Dagu ready", async () => {
      try { return (await fetch(`${api}/dag-runs`)).ok ? true : undefined; } catch { return undefined; }
    });
    execFileSync("dagu", ["enqueue", "--run-id", id, file], { env });
    // Real Dagu retry scheduling crosses a process boundary and requires platform time.
    unlock = setTimeout(() => rmSync(lock, { force: true }), 6000);
    let succeeded = false;
    let evidence = "";
    for (let i = 0; i < 400; i++) {
      const response = await fetch(`${api}/dag-runs/lock-retry/${id}`);
      if (response.ok) {
        const run = (await response.json() as { dagRunDetails: {
          statusLabel: string;
          nodes: Array<{ statusLabel: string; stderr?: string }>;
        } }).dagRunDetails;
        assert.notEqual(run.statusLabel, "failed", JSON.stringify(run));
        if (run.statusLabel === "succeeded") {
          assert.equal(run.nodes[0]!.statusLabel, "succeeded");
          evidence = readFileSync(run.nodes[0]!.stderr!, "utf8");
          succeeded = true;
          break;
        }
      }
      await delay(150);
    }
    assert.ok(succeeded, "isolated retry run did not succeed");
    assert.ok(evidence.includes(`rebase: index.lock held in ${repo.worktree}`), evidence);
    assert.equal(readFileSync(join(repo.state, "conflict-action"), "utf8"), "complete\n");
  } finally {
    clearTimeout(unlock);
    if (service.exitCode === null && service.signalCode === null) {
      await new Promise<void>(resolve => {
        service.once("exit", () => resolve());
        service.kill("SIGTERM");
      });
    }
    rmSync(repo.root, { recursive: true, force: true });
  }
});

type LiveDetail = Omit<RunDetails, "nodes"> & {
  nodes: Array<{ step: { name: string }; statusLabel: string; stdout?: string; stderr?: string }>;
  onExit?: { statusLabel: string };
};

type RecoveryFixture = {
  suffix: string;
  root: string;
  home: string;
  port: number;
  env: NodeJS.ProcessEnv;
  until: <T>(description: string, probe: () => Promise<T | undefined>) => Promise<T>;
  state: (id: string, expected: string) => Promise<LiveDetail>;
  close: () => Promise<void>;
};

async function recoveryFixture(): Promise<RecoveryFixture> {
  const suffix = randomUUID();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-dagu-triage-close-")));
  const home = join(root, "dagu-home");
  mkdirSync(join(home, "dags"), { recursive: true });
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const env = { ...process.env, DAGU_PARAMS_JSON: "{}", DAGU_HOME: home, DAGU_PORT: String(port), DAGU_COORDINATOR_ENABLED: "false" };
  writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\nscheduler:\n  port: 0\n`);
  let serviceLog = "";
  const service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: root, env, stdio: ["ignore", "pipe", "pipe"],
  });
  service.stdout.on("data", data => { serviceLog += data; });
  service.stderr.on("data", data => { serviceLog += data; });
  const api = `http://127.0.0.1:${port}/api/v1`;
  async function until<T>(description: string, probe: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const value = await probe();
      if (value !== undefined) return value;
      await delay(150);
    }
    throw new Error(`Timed out: ${description}\n${serviceLog}`);
  }
  async function state(id: string, expected: string): Promise<LiveDetail> {
    return until(`${id} ${expected}`, async () => {
      const response = await fetch(`${api}/dag-runs/feature/${id}`);
      if (!response.ok) return undefined;
      const run = (await response.json() as { dagRunDetails: LiveDetail }).dagRunDetails;
      assert.equal(run.name, "feature");
      assert.equal(run.dagRunId, id);
      if (["failed", "aborted"].includes(run.statusLabel)) {
        const logs = run.nodes.filter(node => node.stderr).map(node => `${node.step.name}: ${readFileSync(node.stderr!, "utf8")}`).join("\n");
        const log = (run as LiveDetail & { log?: string }).log;
        throw new Error(`${JSON.stringify(run)}\n${logs}\n${log && existsSync(log) ? readFileSync(log, "utf8") : ""}\n${serviceLog}`);
      }
      return run.statusLabel === expected ? run : undefined;
    });
  }
  async function close(): Promise<void> {
    if (service.exitCode === null && service.signalCode === null) {
      await new Promise<void>(resolve => {
        service.once("exit", () => resolve());
        service.kill("SIGTERM");
      });
    }
    rmSync(root, { recursive: true, force: true });
  }
  try {
    await until("isolated Dagu ready", async () => {
      try { return (await fetch(`${api}/dag-runs`)).ok ? true : undefined; } catch { return undefined; }
    });
    return { suffix, root, home, port, env, until, state, close };
  } catch (error) {
    await close();
    throw error;
  }
}

type RecoveryMode = "healthy" | "gate" | "start_gate" | "push";
type RecoveryResult = {
  dag: string;
  id: string;
  checkpoints: Array<{ step: string; iteration: number }>;
  iteration: number;
  candidateSHA: string;
  socket: string;
  repositoryRoot: string;
};

async function runRecovery(fixture: RecoveryFixture, definition: string, mode: RecoveryMode): Promise<RecoveryResult> {
  const { suffix, root, home, env, until, state } = fixture;
  const id = `recovery-${mode}-${suffix}`;
  const repo = repository();
  repo.state = join(repo.primary, ".git", "dagu-feature", "runs", id);
  const checkpoints: Array<{ step: string; iteration: number }> = [];
  try {
    git(repo.primary, "worktree", "remove", repo.worktree);
    git(repo.primary, "branch", "-D", repo.branch);
    rmSync(join(repo.primary, ".git", "dagu-feature", "resources"), { recursive: true });
    repo.worktree = join(repo.primary, ".workspace", "worktrees", "issue-189");
    writeFileSync(join(repo.primary, ".git", "info", "exclude"), "/.workspace/\n");
    const remote = git(repo.primary, "remote", "get-url", "origin");
    if (mode === "start_gate") git(repo.primary, "remote", "set-url", "origin", join(repo.root, "unavailable.git"));
    const bin = join(repo.root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gh"), `#!/bin/sh
printf '%s\\n' "$*" >> '${repo.root}/gh.log'
case "$*" in
  *"--jq .state"*) printf 'OPEN\\n' ;;
  *"--jq .headRefName"*) printf '%s\\n' '${repo.branch}' ;;
  *"--jq .headRefOid"*) git -C '${repo.worktree}' rev-parse HEAD ;;
  *) printf '{"number":189,"url":"https://example.test/pr/189"}\\n' ;;
esac
`);
    chmodSync(join(bin, "gh"), 0o755);
    if (mode === "push") {
      const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" push "*refs/heads/*)\nif ! test -f '${repo.root}/allow-push'; then echo 'push: simulated remote access failure' >&2; exit 1; fi\n;;\nesac\nexec '${realGit}' "$@"\n`);
      chmodSync(join(bin, "git"), 0o755);
    }
    const source = readFileSync(definition, "utf8");
    const script = [
      "type: graph\nshell: bash\nmax_active_steps: 1\n",
      `params:\n  - ISSUE: "189"\n  - BASE_BRANCH: main\n  - PR_NUMBER: ""\n  - VALIDATION: ""\n  - OMP_SESSION_ID: recovery-owner\n`,
      `env:\n  - PRIMARY: ${JSON.stringify(repo.primary)}\n  - BRANCH: dagu/issue-\${ISSUE}\n  - GATE: test -f required.txt\n  - REQUIRED_CHECK: validate\n  - PATH: ${bin}:${process.env.PATH}\n  - WORKTREE: ${repo.worktree}\n  - RUN: \${context.run.id}\n  - DAGU_FEATURE_BUNDLE: test\n  - DAGU_PORT: "${fixture.port}"\n`,
      source.slice(source.indexOf("  - DAGU_RESOURCE_GUARD: |"), source.indexOf("steps:\n")),
      "steps:\n",
      `  - id: triage\n    run: |\n      mkdir -p "$(git -C "$PRIMARY" rev-parse --path-format=absolute --git-path "dagu-feature/runs/$RUN")"\n      echo POC=no >> "$DAGU_OUTPUT_FILE"\n    outputs:\n      - name: POC\n`,
      "  - id: triage_decision\n    depends: triage\n    run: echo reviewed\n",
      ...["detect_start_primary", "start_primary_unavailable", "start_gate", "recover_start_gate", "implement",
        "capture", "checkpoint_push", "dependency_review", "rebase", "conflict_review", "gate", "recover_gate",
        "quality_prepare", "quality_review", "quality_admit", "quality_transition", "validation", "push", "recover_push", "pr"]
        .map(step => extractStep(source, step)),
      "  - id: await_merge\n    depends: pr\n    action: human.task\n    with:\n      prompt: Isolated merge boundary\n",
      source.slice(source.indexOf("handler_on:\n"), source.indexOf("  exit:\n")),
    ].join("");
    rmSync(join(repo.root, "bin", "dagu"));
    const dag = join(home, "dags", "feature.yaml");
    writeFileSync(dag, script);
    const dagu = (...args: string[]) => execFileSync("dagu", args, {
      cwd: root, env: { ...env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const iteration = () => Number(dagu("status", "feature", "--run-id", id).match(/push-back iteration: (\d+)/)?.[1] ?? 0);
    async function waiting(step: string): Promise<LiveDetail> {
      const run = await until(`${id} waiting ${step}`, async () => {
        const run = await state(id, "waiting");
        if (step === "implement" && run.nodes.some(node => node.step.name === "recover_start_gate" && node.statusLabel === "waiting")) {
          throw new Error(run.nodes.filter(node => node.stderr).map(node => `${node.step.name}: ${readFileSync(node.stderr!, "utf8")}`).join("\n"));
        }
        return run.nodes.some(node => node.step.name === step && node.statusLabel === "waiting") ? run : undefined;
      });
      checkpoints.push({ step, iteration: iteration() });
      return run;
    }
    function transition(step: string, pushBack = false): void {
      const observed = iteration();
      dagu("human-task", pushBack ? "push-back" : "complete", "feature", "--run-id", id, "--step", step,
        ...(pushBack ? ["--expected-iteration", String(observed)] : []),
        ...(!pushBack && step === "implement" ? ["--input", "SUMMARY=Recovery candidate", "--input", "MESSAGE=fix: recover candidate",
          "--input", "IMPLEMENTER=ImplementTest"] : []),
        ...(!pushBack && step === "quality_review" ? ["--input", "QA=QATest", "--input", "REVIEW=ReviewTest"] : []));
    }
    const candidate = () => JSON.parse(readFileSync(join(repo.state, "candidate.json"), "utf8")) as { sha: string };
    dagu("validate", dag);
    dagu("enqueue", "--run-id", id, dag);
    if (mode === "start_gate") {
      const run = await waiting("recover_start_gate");
      assert.equal(run.nodes.find(node => node.step.name === "start_gate")?.statusLabel, "failed");
      assert.match(new Transitions("recovery-owner").observe(run).wakeMessage ?? "", /step=recover_start_gate.*cause=start_gate failed/);
      git(repo.primary, "remote", "set-url", "origin", remote);
      transition("recover_start_gate", true);
    }
    await waiting("implement");
    const delivery = mode === "gate" ? "candidate.txt" : "required.txt";
    writeFileSync(join(repo.worktree, delivery), `candidate ${id}\n`);
    const before = iteration();
    assert.equal(before, mode === "start_gate" ? 1 : 0);
    transition("implement");
    let previousCandidate: string | undefined;
    if (mode === "gate") {
      const failed = await waiting("recover_gate");
      assert.equal(failed.nodes.find(node => node.step.name === "gate")?.statusLabel, "failed");
      const notice = new Transitions("recovery-owner").observe(failed).wakeMessage;
      assert.match(notice ?? "", /step=recover_gate.*cause=gate failed/);
      previousCandidate = candidate().sha;
      transition("recover_gate", true);
      await waiting("implement");
      assert.equal(iteration(), before + 1);
      assert.equal(git(repo.worktree, "rev-parse", "HEAD"), previousCandidate);
      writeFileSync(join(repo.worktree, "required.txt"), "fixed\n");
      transition("implement");
    }
    await waiting("quality_review");
    const request: QualityRequest = JSON.parse(readFileSync(join(repo.state, "quality-request.json"), "utf8"));
    const quality = qualityFixture(repo, "PASS", request);
    writeFileSync(join(repo.state, "quality.json"), JSON.stringify(verifyQuality(quality.parent, request, "QATest", "ReviewTest", quality.models)));
    transition("quality_review");
    if (mode === "push") {
      const failed = await waiting("recover_push");
      assert.equal(failed.nodes.find(node => node.step.name === "push")?.statusLabel, "failed");
      assert.match(new Transitions("recovery-owner").observe(failed).wakeMessage ?? "", /step=recover_push.*cause=push failed/);
      previousCandidate = candidate().sha;
      writeFileSync(join(repo.root, "allow-push"), "");
      transition("recover_push", true);
    }
    const done = await waiting("await_merge");
    for (const step of ["start_gate", "gate", "push"]) {
      assert.equal(done.nodes.find(node => node.step.name === step)?.statusLabel, "succeeded");
      assert.equal(done.nodes.find(node => node.step.name === `recover_${step}`)?.statusLabel, "skipped");
    }
    const candidateSHA = candidate().sha;
    assert.equal(git(repo.worktree, "rev-parse", "HEAD"), candidateSHA);
    assert.equal(git(repo.primary, "rev-parse", `origin/${repo.branch}`), candidateSHA);
    assert.equal(JSON.parse(readFileSync(join(repo.state, "gate.json"), "utf8")).sha, candidateSHA);
    assert.equal(git(repo.worktree, "show", `${candidateSHA}:${delivery}`), `candidate ${id}`);
    if (mode === "gate") {
      assert.notEqual(candidateSHA, previousCandidate);
      assert.equal(JSON.parse(readFileSync(join(repo.state, "historical", previousCandidate!, "candidate.json"), "utf8")).sha, previousCandidate);
    } else if (mode === "push") assert.equal(candidateSHA, previousCandidate);
    const finalIteration = iteration();
    assert.equal(finalIteration, mode === "healthy" ? 0 : 1);
    assert.equal(git(repo.worktree, "branch", "--show-current"), repo.branch);
    assert.equal(git(repo.worktree, "status", "--porcelain"), "");
    assert.match(readFileSync(join(repo.root, "gh.log"), "utf8"), /pr view/);
    return {
      dag: done.name, id: done.dagRunId, checkpoints, iteration: finalIteration, candidateSHA,
      socket: `/tmp/@dagu_feature_${createHash("md5").update(`feature${id}`).digest("hex").slice(0, 6)}.sock`,
      repositoryRoot: repo.root,
    };
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}

for (const [name, definition] of definitions) {
  test(`${name} real Dagu closes implementation runs and succeeds after enqueuing a PoC`, {
    ...liveDagu,
    timeout: 360_000,
  }, async (t) => {
    assert.match(liveDaguVersion, /2\.20\.1/);
    const fixture = await recoveryFixture();
    const { root, home, port, env, until, state } = fixture;
    const api = `http://127.0.0.1:${port}/api/v1`;
    try {
      for (const mode of ["healthy", "gate", "start_gate", "push"] as const) {
        await t.test(`integrated recovery ${mode}`, async () => {
          await runRecovery(fixture, definition, mode);
        });
      }
      for (const mode of ["poc", "implementation-ready", "implementation-blocked"] as const) {
        await t.test(mode, async () => {
          const repo = repository();
          try {
            if (mode === "poc") {
              // The only GitHub effect on this path is the triage comment.
              const gh = join(repo.root, "bin", "gh");
              mkdirSync(dirname(gh), { recursive: true });
              writeFileSync(gh, '#!/bin/sh\ncase "$*" in\n  "issue comment 189 --body-file "*) exit 0 ;;\n  *) echo "unexpected gh $*" >&2; exit 1 ;;\nesac\n');
              chmodSync(gh, 0o755);
              // Admission is exercised against real Dagu in bundle-cli.test.ts;
              // this fixture isolates the lifecycle's post-admission routing.
              const admission = join(repo.root, "bin", "dagu-feature-bundle");
              writeFileSync(admission, '#!/bin/sh\ntest "$1" = enqueue || exit 1\nexec dagu "$@"\n');
              chmodSync(admission, 0o755);
            } else stubSuccessfulCloseGateGh(repo);
            git(repo.primary, "worktree", "remove", repo.worktree);
            git(repo.primary, "branch", "-D", repo.branch);
            rmSync(join(repo.primary, ".git", "dagu-feature"), { recursive: true, force: true });
            repo.worktree = join(repo.primary, ".workspace", "worktrees", "issue-189");
            writeFileSync(join(repo.primary, ".git", "info", "exclude"), "/.workspace/\n");
            const pocDefinition = join(repo.primary, ".workspace", "dagu", "dags", "poc.yaml");
            mkdirSync(dirname(pocDefinition), { recursive: true });
            writeFileSync(pocDefinition, "steps:\n  - id: experiment\n    run: echo isolated-poc\n");
            const source = readFileSync(definition, "utf8");
            const triage = mode === "poc" ? extractStep(source, "triage") : `  - id: triage\n    run: |\n      printf 'POC=no\\nQUESTION=runtime behavior\\nBASIS=regression test\\nREVIEW=fixture\\n' >> "$DAGU_OUTPUT_FILE"\n    outputs:\n      - name: POC\n      - name: QUESTION\n      - name: BASIS\n      - name: REVIEW\n`;
            // Reviewer verification and implementation/merge are outside this routing test.
            // Keep the production start/close gates, conditional checkpoints and exit handler.
            const decision = mode === "poc" ? extractStep(source, "triage_decision")
              : "  - id: triage_decision\n    depends: triage\n    run: echo reviewed-implementation\n";
            const implementation = mode === "poc"
              ? extractStep(source, "implement") + "  - id: await_merge\n    depends: implement\n    run: echo merged\n  - id: authorize_ci\n    depends: await_merge\n    run: echo authorized-candidate\n"
              : `  - id: implement\n    depends: start_gate\n    run: |\n      git -C "$WORKTREE" rev-parse HEAD > "$(git -C "$PRIMARY" rev-parse --path-format=absolute --git-path "dagu-feature/runs/$RUN")/tested-sha"\n      ${mode === "implementation-blocked" ? 'printf "operator changes\\n" > "$PRIMARY/README.txt"' : "echo implementation"}\n  - id: await_merge\n    depends: implement\n    run: echo merged\n  - id: authorize_ci\n    depends: await_merge\n    run: echo authorized-candidate\n`;
            const script = [
              "type: graph\nshell: bash\nmax_active_steps: 1\n",
              `params:\n  - ISSUE: "189"\n  - BASE_BRANCH: main\n  - PR_NUMBER: ""\n  - OMP_SESSION_ID: close-owner\n`,
              `env:\n  - PRIMARY: ${JSON.stringify(repo.primary)}\n  - BRANCH: dagu/issue-\${ISSUE}\n  - GATE: "true"\n  - REQUIRED_CHECK: validate\n  - PATH: ${join(repo.root, "bin")}:${process.env.PATH}\n  - WORKTREE: ${repo.worktree}\n  - RUN: \${context.run.id}\n  - DAGU_FEATURE_BUNDLE: test\n`,
              source.slice(source.indexOf("  - DAGU_RESOURCE_GUARD: |"), source.indexOf("steps:\n")),
              "steps:\n", ...(mode === "poc" ? ["admission", "admit"].map(id => extractStep(source, id)) : []), triage, decision,
              ...["detect_start_primary", "start_primary_unavailable", "start_gate", ...(mode === "poc" ? ["recover_start_gate"] : [])].map(id => extractStep(source, id)),
              implementation,
              ...["detect_close_primary", "close_primary_unavailable", "close_gate"].map(id => extractStep(source, id)),
              "handler_on:\n", source.slice(source.indexOf("  exit:\n")),
            ].join("");
            const dag = join(home, "dags", "feature.yaml");
            writeFileSync(dag, script);
            rmSync(join(repo.root, "bin", "dagu"));
            const runEnv = { ...env, PATH: `${join(repo.root, "bin")}:${process.env.PATH}` };
            const dagu = (...args: string[]) => execFileSync("dagu", args, {
              cwd: root, env: runEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
            }).trim();
            const id = `${mode}-${randomUUID()}`;
            dagu("enqueue", "--run-id", id, dag);
            if (mode === "poc") {
              await state(id, "waiting");
              dagu("human-task", "complete", "feature", "--run-id", id, "--step", "triage",
                "--input", "POC=yes", "--input", "QUESTION=runtime behavior", "--input", "BASIS=regression test");
              const routed = await until("PoC parent finishes instead of waiting at implement", async () => {
                const response = await fetch(`${api}/dag-runs/feature/${id}`);
                if (!response.ok) return undefined;
                const detail = (await response.json() as { dagRunDetails: LiveDetail }).dagRunDetails;
                assert.notEqual(detail.nodes.find(node => node.step.name === "implement")?.statusLabel, "waiting",
                  "POC=yes parent must skip implement");
                return detail.statusLabel === "succeeded" ? detail : undefined;
              });
              assert.equal(routed.nodes.find(node => node.step.name === "implement")?.statusLabel, "skipped");
              const replacement = `replacement-${randomUUID()}`;
              dagu("enqueue", "--run-id", replacement, dag);
              const admitted = await state(replacement, "waiting");
              assert.equal(admitted.nodes.find(node => node.step.name === "admit")?.statusLabel, "succeeded");
              assert.equal(admitted.nodes.find(node => node.step.name === "triage")?.statusLabel, "waiting");
              dagu("human-task", "complete", "feature", "--run-id", replacement, "--step", "triage",
                "--input", "POC=yes", "--input", "QUESTION=runtime behavior", "--input", "BASIS=regression test");
              await state(replacement, "succeeded");
            }
            if (mode === "implementation-blocked") {
              const waiting = await state(id, "waiting");
              assert.equal(waiting.nodes.find(node => node.step.name === "close_primary_unavailable")?.statusLabel, "waiting");
              assert.equal(waiting.nodes.find(node => node.step.name === "close_gate")?.statusLabel, "not_started");
              assert.equal(existsSync(repo.worktree), true);
              git(repo.primary, "restore", "README.txt");
              dagu("human-task", "push-back", "feature", "--run-id", id, "--step", "close_primary_unavailable", "--expected-iteration", "0");
            }
            const done = await state(id, "succeeded");
            const status = (step: string) => done.nodes.find(node => node.step.name === step)?.statusLabel;
            assert.equal(status("triage_decision"), "succeeded");
            assert.equal(status("await_merge"), mode === "poc" ? "skipped" : "succeeded");
            assert.equal(status("detect_close_primary"), mode === "poc" ? "skipped" : "succeeded");
            assert.equal(status("close_primary_unavailable"), "skipped");
            assert.equal(status("close_gate"), mode === "poc" ? "skipped" : "succeeded");
            assert.equal(done.onExit?.statusLabel, "succeeded", JSON.stringify(done));
            assert.equal(existsSync(repo.worktree), false);
            assert.equal(hasRef(repo.primary, `refs/heads/${repo.branch}`), false);
            done.resolvedPrimary = repo.primary;
            const transitions = new Transitions("close-owner");
            transitions.observe({ ...done, statusLabel: "running" }, { baseline: true });
            assert.deepEqual(transitions.observe(done), {
              notification: { message: "dagu · feature #189 succeeded", type: "info" },
              wakeMessage: `[DAGU STATE] run=${id} status=succeeded issue=189 bundle=unstamped extension=${BUNDLE_VERSION} main=n/a compat=unstamped`,
            });
            if (mode === "poc") {
              assert.match(dagu("history", "poc", "--run-id", `poc-${id}`), new RegExp(`poc-${id}`));
            }
          } finally {
            rmSync(repo.root, { recursive: true, force: true });
          }
        });
      }
    } finally {
      await fixture.close();
    }
  });
}

test("concurrent recovery fixtures keep distinct run identities", {
  ...liveDagu,
  timeout: 360_000,
}, async (t) => {
  const active = new Set<RecoveryFixture>();
  try {
    const started = await Promise.allSettled(definitions.map(async () => {
      const fixture = await recoveryFixture();
      active.add(fixture);
      return fixture;
    }));
    for (const result of started) {
      if (result.status === "rejected") throw result.reason;
    }
    const [first, second] = [...active];
    assert.ok(first && second);
    assert.notEqual(first.home, second.home);
    assert.notEqual(first.port, second.port);
    assert.notEqual(first.suffix, second.suffix);
    let lastId = "";
    for (const mode of ["healthy", "gate", "start_gate", "push"] as const) {
      const runs: PromiseSettledResult<RecoveryResult>[] = await Promise.allSettled([
        runRecovery(first, definitions[0][1], mode),
        runRecovery(second, definitions[1][1], mode),
      ]);
      const [left, right] = runs.map(result => {
        if (result.status === "rejected") throw result.reason;
        return result.value;
      });
      assert.ok(left && right);
      assert.equal(left.dag, "feature");
      assert.equal(right.dag, "feature");
      assert.notEqual(`${left.dag}/${left.id}`, `${right.dag}/${right.id}`);
      assert.notEqual(left.socket, right.socket);
      assert.notEqual(left.candidateSHA, right.candidateSHA);
      const expected = mode === "healthy"
        ? [{ step: "implement", iteration: 0 }, { step: "quality_review", iteration: 0 }, { step: "await_merge", iteration: 0 }]
        : mode === "start_gate"
          ? [{ step: "recover_start_gate", iteration: 0 }, { step: "implement", iteration: 1 },
            { step: "quality_review", iteration: 1 }, { step: "await_merge", iteration: 1 }]
          : mode === "gate"
            ? [{ step: "implement", iteration: 0 }, { step: "recover_gate", iteration: 0 },
              { step: "implement", iteration: 1 }, { step: "quality_review", iteration: 1 },
              { step: "await_merge", iteration: 1 }]
            : [{ step: "implement", iteration: 0 }, { step: "quality_review", iteration: 0 },
              { step: "recover_push", iteration: 0 }, { step: "await_merge", iteration: 1 }];
      const outcomes: Array<[RecoveryFixture, RecoveryResult]> = [[first, left], [second, right]];
      for (const [fixture, result] of outcomes) {
        assert.equal(result.id, `recovery-${mode}-${fixture.suffix}`);
        assert.deepEqual(result.checkpoints, expected);
        assert.equal(result.iteration, mode === "healthy" ? 0 : 1);
        assert.equal(existsSync(result.repositoryRoot), false);
        t.diagnostic(JSON.stringify({ home: fixture.home, port: fixture.port, ...result }));
      }
      lastId = right.id;
    }
    await first.close();
    active.delete(first);
    assert.equal(existsSync(first.root), false);
    assert.equal(existsSync(second.home), true);
    const surviving = await second.state(lastId, "waiting");
    assert.equal(surviving.nodes.find(node => node.step.name === "await_merge")?.statusLabel, "waiting");
    execFileSync("dagu", ["human-task", "complete", "feature", "--run-id", lastId, "--step", "await_merge"], {
      cwd: second.root, env: second.env, stdio: ["ignore", "pipe", "pipe"],
    });
    await second.state(lastId, "succeeded");
    await second.close();
    active.delete(second);
    assert.equal(existsSync(second.root), false);
  } finally {
    await Promise.all([...active].map(fixture => fixture.close()));
  }
});

for (const [name, definition] of definitions) {
  test(`${name} real Dagu checks primary freshness before admission and enqueues bootstrap after merge`, {
    ...liveDagu,
    timeout: 115_000,
  }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "omp-dagu-freshness-"));
    const home = join(root, "dagu-home");
    mkdirSync(join(home, "dags"), { recursive: true });
    const listener = createServer();
    await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>(resolve => listener.close(() => resolve()));
    writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\nscheduler:\n  port: 0\n`);
    const env = { ...process.env, DAGU_PARAMS_JSON: "{}", DAGU_HOME: home, DAGU_COORDINATOR_ENABLED: "false" };
    const binary = execFileSync("which", ["dagu"], { encoding: "utf8" }).trim();
    let serviceLog = "";
    const service = spawn(binary, ["start-all", "--host", "127.0.0.1", "--port", String(port)], {
      cwd: root, env, stdio: ["ignore", "pipe", "pipe"],
    });
    service.stdout.on("data", data => { serviceLog += data; });
    service.stderr.on("data", data => { serviceLog += data; });
    const api = `http://127.0.0.1:${port}/api/v1`;
    async function until<T>(description: string, probe: () => Promise<T | undefined>): Promise<T> {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const value = await probe();
        if (value !== undefined) return value;
        await delay(100);
      }
      throw new Error(`Timed out: ${description}\n${serviceLog}`);
    }
    const source = readFileSync(definition, "utf8");
    async function execute(repo: Repository, step: string) {
      const id = `freshness-${randomUUID()}`;
      const file = join(home, "dags", "probe.yaml");
      const scriptEnv = { ...featureScriptEnv(repo), RUN: step === "close_gate" ? "test-run" : id };
      writeFileSync(file, [
        "type: graph\nshell: bash\nenv:\n",
        ...Object.entries(scriptEnv).filter((entry): entry is [string, string] => entry[1] !== undefined)
          .map(([key, value]) => `  - ${key}: ${JSON.stringify(value)}\n`),
        source.slice(source.indexOf("  - DAGU_RESOURCE_GUARD: |"), source.indexOf("steps:\n")),
        "steps:\n", extractStep(source, step).replace(/^    depends:.*\n/m, ""),
      ].join(""));
      execFileSync(binary, ["enqueue", "--run-id", id, file], { cwd: root, env });
      const result = await until(`${id} terminal`, async () => {
        const response = await fetch(`${api}/dag-runs/probe/${id}`);
        if (!response.ok) return undefined;
        const run = (await response.json() as { dagRunDetails: { statusLabel: string; nodes: Array<{ statusLabel: string; stdout?: string; stderr?: string }> } }).dagRunDetails;
        return ["succeeded", "failed"].includes(run.statusLabel) ? run : undefined;
      });
      const node = result.nodes[0]!;
      const stdout = node.stdout ? readFileSync(node.stdout, "utf8") : "";
      const stderr = node.stderr ? readFileSync(node.stderr, "utf8") : "";
      return { id, status: result.statusLabel, stdout, stderr };
    }
    try {
      await until("isolated Dagu ready", async () => {
        try { return (await fetch(`${api}/dag-runs`)).ok ? true : undefined; } catch { return undefined; }
      });
      for (const scenario of ["equal", "behind", "fast-forward", "ahead", "version"] as const) {
        const repo = repository();
        try {
          const manifest = join(repo.primary, "packages/omp-dagu/package.json");
          mkdirSync(dirname(manifest), { recursive: true });
          writeFileSync(manifest, JSON.stringify({ version: BUNDLE_VERSION }));
          git(repo.primary, "add", ".");
          git(repo.primary, "commit", "-m", "install bundle manifest");
          git(repo.primary, "push", "origin", "main");
          git(repo.worktree, "merge", "--ff-only", "main");
          if (scenario === "behind" || scenario === "fast-forward") {
            commit(repo, "upstream.txt", "origin advanced\n");
            git(repo.worktree, "push", "origin", "HEAD:main");
            if (scenario === "behind") writeFileSync(join(repo.primary, "README.txt"), "operator changes\n");
          } else if (scenario === "ahead") {
            writeFileSync(join(repo.primary, "ahead.txt"), "local commit\n");
            git(repo.primary, "add", ".");
            git(repo.primary, "commit", "-m", "unpublished main");
          } else if (scenario === "version") {
            writeFileSync(manifest, JSON.stringify({ version: "0.3.8" }));
          }
          const result = await execute(repo, "admit");
          const cause = { behind: "primary_behind", ahead: "primary_ahead", version: "version_stale" }[scenario as "behind" | "ahead" | "version"];
          if (cause) {
            assert.equal(result.status, "failed", JSON.stringify(result));
            assert.match(result.stderr, new RegExp(`cause=${cause} observed_sha=[a-f0-9]{40} expected_sha=[a-f0-9]{40} observed_version=\\S+ expected_version=${BUNDLE_VERSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
            assert.equal(existsSync(join(repo.primary, ".git", "dagu-feature", "owners", "issue-189")), false);
          } else {
            assert.equal(result.status, "succeeded", JSON.stringify(result));
            assert.equal(git(repo.primary, "rev-parse", "HEAD"), git(repo.primary, "rev-parse", "origin/main"));
            assert.equal(readFileSync(join(repo.primary, ".git", "dagu-feature", "owners", "issue-189"), "utf8"), `${result.id}\t${repo.branch}\n`);
          }
          t.diagnostic(`${scenario}: ${result.id} ${result.status} ${result.stderr.trim()}`);
        } finally { rmSync(repo.root, { recursive: true, force: true }); }
      }
      for (const changed of ["packages/omp-dagu/skills/dagu-feature/feature.yaml", "packages/omp-dagu/CHANGELOG.md", "README.txt"]) {
        const repo = repository();
        try {
          commit(repo, "packages/omp-dagu/package.json", JSON.stringify({ version: BUNDLE_VERSION }));
          commit(repo, changed, "merged change\n");
          git(repo.primary, "merge", "--ff-only", repo.branch);
          git(repo.primary, "push", "origin", "main");
          stubSuccessfulCloseGateGh(repo, changed);
          const log = join(repo.root, "bootstrap.args");
          const stub = join(repo.root, "bin", "dagu");
          writeFileSync(stub, `#!/bin/sh\ncase "$1" in\n  history) printf '[]\\n' ;;\n  enqueue) printf '%s\\n' "$@" > ${JSON.stringify(log)} ;;\n  *) exit 1 ;;\nesac\n`);
          chmodSync(stub, 0o755);
          const result = await execute(repo, "close_gate");
          assert.equal(result.status, "succeeded", JSON.stringify(result));
          if (changed.startsWith("packages/omp-dagu/")) {
            const skill = join(repo.primary, "packages/omp-dagu/skills/dagu-feature");
            assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
              "enqueue", "--run-id", `bootstrap-a4s-v${BUNDLE_VERSION.replace(/\./g, "-")}`,
              join(skill, "dagu-feature-bootstrap.yaml"), "--", `PRIMARY=${repo.primary}`, `SKILL_DIR=${skill}`,
            ]);
          } else {
            assert.match(result.stdout, /cleanup worktree=.*remote=absent/);
          }
          t.diagnostic(`close_gate ${changed}: ${result.id} ${result.status}`);
        } finally { rmSync(repo.root, { recursive: true, force: true }); }
      }
    } finally {
      service.kill("SIGTERM");
      if (service.exitCode === null) await new Promise<void>(resolve => service.once("exit", () => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
  test(`${name} optional validation uses native skip, SHA approval and iterative rejection`, {
    ...liveDagu,
    timeout: 180_000,
  }, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-dagu-validation-")));
    const home = join(root, "home");
    mkdirSync(join(home, "dags"), { recursive: true });
    async function freePort(): Promise<number> {
      const server = createServer();
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      return address.port;
    }
    const port = await freePort();
    const schedulerPort = await freePort();
    writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\nscheduler:\n  port: ${schedulerPort}\n`);
    const env = { ...process.env, DAGU_HOME: home, DAGU_COORDINATOR_ENABLED: "false" };
    let logs = "";
    const service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
    service.stdout.on("data", data => { logs += data; });
    service.stderr.on("data", data => { logs += data; });
    const api = `http://127.0.0.1:${port}/api/v1`;
    type Detail = RunDetails & { nodes: Array<{ step: { id: string; name: string; humanTask?: { prompt?: string } }; statusLabel: string; approvalIteration?: number; approvalInputs?: Record<string, string> }> };
    async function until<T>(probe: () => Promise<T | undefined>): Promise<T> {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const result = await probe();
        if (result !== undefined) return result;
        await delay(100);
      }
      throw new Error(`Validation transition timed out\n${logs}`);
    }
    async function state(id: string, status: string, step?: string): Promise<Detail> {
      return until(async () => {
        const response = await fetch(`${api}/dag-runs/feature/${id}`);
        if (!response.ok) return undefined;
        const run = (await response.json() as { dagRunDetails: Detail }).dagRunDetails;
        if (status !== "failed") assert.notEqual(run.statusLabel, "failed", JSON.stringify(run));
        return run.statusLabel === status && (!step || run.nodes.some(node => node.step.id === step && node.statusLabel === "waiting")) ? run : undefined;
      });
    }
    const dagu = (...args: string[]) => spawnSync("dagu", args, { env, encoding: "utf8", timeout: 10_000 });
    const command = (...args: string[]) => {
      const result = dagu(...args);
      assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
      return result.stdout;
    };
    try {
      await until(async () => { try { return (await fetch(`${api}/dag-runs`)).ok ? true : undefined; } catch { return undefined; } });
      for (const mode of ["empty", "gate-fail", "poc", "wrong-sha", "declared"] as const) {
        const repo = repository();
        try {
          const id = `validation-${randomUUID()}`;
          const oldState = repo.state;
          repo.state = join(dirname(oldState), id);
          renameSync(oldState, repo.state);
          const procedure = ["declared", "wrong-sha", "poc"].includes(mode) ? "Run isolated smoke over the tested binary" : "";
          const source = readFileSync(definition, "utf8");
          const validationParam = source.match(/    VALIDATION:\n[\s\S]*?(?=    OMP_SESSION_ID:)/)![0]!
            .replace(/      default: .+\n/, `      default: ${JSON.stringify(procedure)}\n`)
            .replace(/      enum: .+\n/, `      enum: [${JSON.stringify(procedure)}]\n`);
          const params = `params:\n  type: object\n  properties:\n${validationParam}`;
          const gate = extractStep(source, "gate").replace("depends: conflict_review", "depends: implement")
            .replace(/    retry_policy:\n      limit: 1\n      interval_sec: 5\n/, "")
            .replace("    run: |", "    preconditions:\n      - condition: '${steps.triage.outputs.POC}'\n        expected: 'no'\n    run: |");
          const vars = { ...featureScriptEnv(repo), RUN: id, OMP_SESSION_ID: "parent-id", DAGU_PORT: String(port), GATE: mode === "gate-fail" ? "exit 1" : `printf 'gate\\n' >> ${JSON.stringify(join(root, id + ".gates"))}` };
          const dag = join(home, "dags", "feature.yaml");
          writeFileSync(dag, `type: graph\nshell: bash\nmax_active_steps: 1\n${params}env:\n`
            + Object.entries(vars).filter(([, value]) => value !== undefined).map(([key, value]) => `  - ${key}: ${JSON.stringify(value)}\n`).join("")
            + `steps:\n  - id: triage\n    run: printf 'POC=${mode === "poc" ? "yes" : "no"}\\n' >> "$DAGU_OUTPUT_FILE"\n    outputs:\n      - name: POC\n  - id: implement\n    depends: triage\n    action: human.task\n    with:\n      prompt: Implement candidate\n`
            + gate + extractStep(source, "recover_gate")
            + extractStep(source, "quality_prepare").replace("    run: |", "    preconditions:\n      - condition: '${steps.triage.outputs.POC}'\n        expected: 'no'\n    run: |")
            + ["quality_review", "quality_admit", "quality_transition", "validation", "push", "recover_push"].map(step => extractStep(source, step)).join(""));
          const completeQuality = async () => {
            await state(id, "waiting", "quality_review");
            const request: QualityRequest = JSON.parse(readFileSync(join(repo.state, "quality-request.json"), "utf8"));
            const fixture = qualityFixture(repo, "PASS", request);
            writeFileSync(join(repo.state, "quality.json"), JSON.stringify(verifyQuality(fixture.parent, request, "QATest", "ReviewTest", fixture.models)));
            command("human-task", "complete", "feature", "--run-id", id, "--step", "quality_review", "--input", "QA=QATest", "--input", "REVIEW=ReviewTest");
            await state(id, "waiting", "quality_transition");
            command("human-task", "complete", "feature", "--run-id", id, "--step", "quality_transition");
          };
          command("validate", dag);
          const overrideId = `override-${randomUUID()}`;
          const override = dagu("enqueue", "--run-id", overrideId, dag, "--", "VALIDATION=changed");
          assert.notEqual(override.status, 0, override.stdout + override.stderr);
          assert.equal((await fetch(`${api}/dag-runs/feature/${overrideId}`)).status, 404);
          command("enqueue", "--run-id", id, dag);
          await state(id, "waiting", "implement");
          command("human-task", "complete", "feature", "--run-id", id, "--step", "implement");
          if (mode !== "gate-fail" && mode !== "poc") await completeQuality();
          if (mode === "gate-fail") {
            const blocked = await state(id, "waiting", "recover_gate");
            assert.equal(blocked.nodes.find(node => node.step.id === "gate")?.statusLabel, "failed");
            assert.equal(blocked.nodes.find(node => node.step.id === "validation")?.statusLabel, "not_started");
            assert.equal(blocked.nodes.find(node => node.step.id === "push")?.statusLabel, "not_started");
            assert.equal(hasRef(repo.primary, `refs/remotes/origin/${repo.branch}`), false);
          } else if (mode === "wrong-sha") {
            await state(id, "waiting", "validation");
            command("human-task", "complete", "feature", "--run-id", id, "--step", "validation", "--input", "APPROVED=yes", "--input", `TESTED_SHA=${"0".repeat(40)}`);
            const rejected = await state(id, "waiting", "recover_push");
            assert.equal(rejected.nodes.find(node => node.step.id === "push")?.statusLabel, "failed");
            assert.equal(hasRef(repo.primary, `refs/remotes/origin/${repo.branch}`), false);
          } else if (mode === "declared") {
            const first = await state(id, "waiting", "validation");
            const sha = git(repo.worktree, "rev-parse", "HEAD");
            assert.match(first.nodes.find(node => node.step.id === "validation")!.step.humanTask!.prompt!, new RegExp(sha));
            const iteration = first.nodes.find(node => node.step.id === "validation")!.approvalIteration ?? 0;
            command("human-task", "push-back", "feature", "--run-id", id, "--step", "validation", "--expected-iteration", String(iteration), "--input", "REASON=smoke failed");
            const rewind = await state(id, "waiting", "implement");
            assert.equal(rewind.nodes.find(node => node.step.id === "implement")!.approvalIteration, iteration + 1);
            assert.match(JSON.stringify(rewind), /smoke failed/);
            commit(repo, "README.txt", "corrected smoke\n");
            const corrected = git(repo.worktree, "rev-parse", "HEAD");
            command("human-task", "complete", "feature", "--run-id", id, "--step", "implement");
            await completeQuality();
            await state(id, "waiting", "validation");
            const stale = spawnSync("bash", ["-c", extractScript(definition, "  - id: push")], {
              encoding: "utf8", env: { ...vars, VALIDATION: procedure, APPROVED: "yes", TESTED_SHA: sha },
            });
            assert.notEqual(stale.status, 0, stale.stdout + stale.stderr);
            assert.match(stale.stderr, /approval SHA .* differs from tested candidate/);
            command("human-task", "complete", "feature", "--run-id", id, "--step", "validation", "--input", "APPROVED=yes", "--input", `TESTED_SHA=${corrected}`);
            await state(id, "succeeded");
            assert.equal(git(repo.primary, "rev-parse", `origin/${repo.branch}`), corrected);
            assert.equal(readFileSync(join(root, id + ".gates"), "utf8"), "gate\ngate\n");
            assert.deepEqual(JSON.parse(readFileSync(join(repo.state, "validation.json"), "utf8")), { sha: corrected, procedure, approved: "yes" });
          } else {
            const done = await state(id, "succeeded");
            const status = (step: string) => done.nodes.find(node => node.step.id === step)?.statusLabel;
            assert.equal(status("validation"), "skipped");
            assert.equal(status("push"), mode === "empty" ? "succeeded" : "skipped");
            assert.equal(hasRef(repo.primary, `refs/remotes/origin/${repo.branch}`), mode === "empty");
          }
        } finally { rmSync(repo.root, { recursive: true, force: true }); }
      }
    } finally {
      service.kill("SIGTERM");
      if (service.exitCode === null) await new Promise<void>(resolve => service.once("exit", () => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const [name, definition] of [
  ["PoC template", fileURLToPath(new URL("../skills/dagu-feature/poc.yaml", import.meta.url))],
  ["PoC rendered DAG", fileURLToPath(new URL("../../../.workspace/dagu/dags/poc.yaml", import.meta.url))],
] as const) {
  test(`${name} base compares the primary manifest with origin before recording its base`, () => {
    const repo = repository();
    try {
      const manifest = join(repo.primary, "packages/omp-dagu/package.json");
      mkdirSync(dirname(manifest), { recursive: true });
      writeFileSync(manifest, JSON.stringify({ version: BUNDLE_VERSION }));
      git(repo.primary, "add", ".");
      git(repo.primary, "commit", "-m", "bundle manifest");
      git(repo.primary, "push", "origin", "main");
      const state = join(repo.primary, ".git/poc/runs/test-run");
      mkdirSync(state, { recursive: true });
      const output = join(repo.root, "base.outputs");
      const script = extractScript(definition, "  - id: base");
      const env = { ...featureScriptEnv(repo), DAGU_FEATURE_BUNDLE: "test", DAGU_OUTPUT_FILE: output };
      writeFileSync(manifest, JSON.stringify({ version: "0.3.8" }));
      const stale = spawnSync("bash", ["-c", script], { env, encoding: "utf8" });
      assert.equal(stale.status, 1);
      assert.match(stale.stderr, /cause=version_stale.*observed_version=0\.3\.8 expected_version=/);
      writeFileSync(manifest, JSON.stringify({ version: BUNDLE_VERSION }));
      const equal = spawnSync("bash", ["-c", script], { env, encoding: "utf8" });
      assert.equal(equal.status, 0, equal.stderr);
      assert.equal(readFileSync(join(state, "base.sha"), "utf8").trim(), git(repo.primary, "rev-parse", "origin/main"));
      assert.match(readFileSync(output, "utf8"), /BASE_SHA=[a-f0-9]{40}/);
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  });
}

for (const [name, definition] of definitions) {
  test(`${name} isolated Dagu rejects FAIL then gates corrections and rebases before PR-head updates`, {
    ...liveDagu,
    timeout: 180_000,
  }, async () => {
    const repo = repository();
    const home = join(repo.root, "dagu-home");
    mkdirSync(join(home, "dags"), { recursive: true });
    const listener = createServer();
    await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    const run = `quality-${randomUUID()}`;
    const state = join(dirname(repo.state), run);
    renameSync(repo.state, state);
    repo.state = state;
    const identity = JSON.stringify({ primary: repo.primary, worktree: repo.worktree, branch: repo.branch, run, session: "parent-id" }) + "\n";
    writeFileSync(join(state, "identity"), identity);
    writeFileSync(git(repo.worktree, "rev-parse", "--path-format=absolute", "--git-path", "dagu-feature-owner"), identity);
    const env = { ...process.env, DAGU_PARAMS_JSON: "{}", DAGU_HOME: home, DAGU_PORT: String(port), DAGU_COORDINATOR_ENABLED: "false" };
    writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\n`);
    const source = readFileSync(definition, "utf8");
    const steps = ["implement", "capture", "rebase", "conflict_review", "gate", "recover_gate", "quality_prepare",
      "quality_review", "quality_admit", "quality_transition", "validation", "push"].map(step =>
      extractStep(source, step).replace("    depends: recover_start_gate\n", "    depends: triage\n").replace("    depends: dependency_review\n", "    depends: capture\n")).join("\n");
    const dag = join(home, "dags", "feature.yaml");
    writeFileSync(dag, `name: feature\ntype: graph\nshell: bash\nmax_active_steps: 1\nenv:\n${Object.entries({
      ISSUE: "189", PRIMARY: repo.primary, WORKTREE: repo.worktree, BRANCH: repo.branch,
      BASE_BRANCH: "main", GATE: "true", VALIDATION: "", OMP_SESSION_ID: "parent-id", RUN: "${context.run.id}", DAGU_PORT: String(port),
    }).map(([key, value]) => `  - ${key}: ${JSON.stringify(value)}`).join("\n")}\nsteps:\n  - id: triage\n    run: echo POC=no >> "$DAGU_OUTPUT_FILE"\n    outputs:\n      - name: POC\n${steps}\n  - id: after_push\n    depends: push\n    action: human.task\n    with:\n      prompt: "Observe published candidate or rebase in this same run."\n      push_back:\n        rewind_to: rebase\nhandler_on:\n  wait:\n    run: |\n${extractScript(definition, "  wait:").split("\n").map(line => `      ${line}`).join("\n")}\n`);
    let serviceLog = "";
    const service = spawn("dagu", ["start-all", "--host", "127.0.0.1", "--port", String(port)], {
      cwd: repo.root, env, stdio: ["ignore", "pipe", "pipe"],
    });
    service.stdout.on("data", data => { serviceLog += data; });
    service.stderr.on("data", data => { serviceLog += data; });
    const dagu = (...args: string[]) => execFileSync("dagu", args, { cwd: repo.root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    type Detail = { statusLabel: string; nodes: Array<{ step: { name: string }; statusLabel: string; approvalIteration?: number }> };
    async function untilStep(step: string, iteration?: number): Promise<Detail> {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/v1/dag-runs/feature/${run}`);
          if (response.ok) {
            const detail = (await response.json() as { dagRunDetails: Detail }).dagRunDetails;
            assert.ok(!["failed", "aborted"].includes(detail.statusLabel), JSON.stringify(detail));
            if (detail.statusLabel === "waiting" && detail.nodes.some(node => node.step.name === step && node.statusLabel === "waiting" &&
              (iteration === undefined || (node.approvalIteration ?? 0) === iteration))) return detail;
          }
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
        }
        await delay(100);
      }
      throw new Error(`Timed out at ${step}\n${serviceLog}`);
    }
    const completeImplementation = () => dagu("human-task", "complete", "feature", "--run-id", run,
      "--step", "implement", "--input", "SUMMARY=Quality candidate", "--input", "MESSAGE=feat: quality candidate",
      "--input", "IMPLEMENTER=ImplementTest");
    const completeQuality = (verdict: "PASS" | "FAIL") => {
      const request: QualityRequest = JSON.parse(readFileSync(join(state, "quality-request.json"), "utf8"));
      const fixture = qualityFixture(repo, verdict, request);
      writeFileSync(join(state, "quality.json"), JSON.stringify(verifyQuality(fixture.parent, request, "QATest", "ReviewTest", fixture.models)));
      dagu("human-task", "complete", "feature", "--run-id", run, "--step", "quality_review",
        "--input", "QA=QATest", "--input", "REVIEW=ReviewTest");
      return request.sha;
    };
    try {
      const deadline = Date.now() + 30_000;
      while (true) {
        try { if ((await fetch(`http://127.0.0.1:${port}/api/v1/dag-runs`)).ok) break; } catch { /* Service startup. */ }
        assert.ok(Date.now() < deadline, serviceLog);
        await delay(100);
      }
      writeFileSync(join(repo.worktree, "README.txt"), "initial candidate\n");
      dagu("enqueue", "--run-id", run, dag);
      await untilStep("implement", 0);
      completeImplementation();
      await untilStep("quality_review", 0);
      const refsBefore = git(repo.primary, "ls-remote", "--heads", "origin");
      const failed = completeQuality("FAIL");
      await untilStep("implement", 1);
      assert.equal(git(repo.primary, "ls-remote", "--heads", "origin"), refsBefore);
      assert.equal(git(repo.worktree, "rev-parse", "HEAD"), failed);
      assert.match(readFileSync(join(state, "quality.json"), "utf8"), /Fix acceptance regression/);
      writeFileSync(join(repo.worktree, "README.txt"), "fixed candidate\n");
      completeImplementation();
      await untilStep("quality_review", 1);
      assert.equal(git(repo.primary, "ls-remote", "--heads", "origin"), refsBefore);
      const fixed = completeQuality("PASS");
      await untilStep("after_push", 1);
      assert.equal(git(repo.primary, "rev-parse", `origin/${repo.branch}`), fixed);
      assert.notEqual(failed, fixed);
      writeFileSync(join(repo.primary, "upstream"), "upstream after publication\n");
      git(repo.primary, "add", "upstream");
      git(repo.primary, "commit", "-m", "upstream change");
      git(repo.primary, "push", "origin", "main");
      dagu("human-task", "push-back", "feature", "--run-id", run, "--step", "after_push", "--expected-iteration", "1");
      const rebasedWaiting = await untilStep("quality_review", 2);
      assert.equal(rebasedWaiting.nodes.find(node => node.step.name === "gate")?.statusLabel, "succeeded");
      assert.equal(git(repo.primary, "rev-parse", `origin/${repo.branch}`), fixed);
      const rebased = completeQuality("PASS");
      assert.notEqual(rebased, fixed);
      await untilStep("after_push", 2);
      assert.equal(git(repo.primary, "rev-parse", `origin/${repo.branch}`), rebased);
      dagu("human-task", "complete", "feature", "--run-id", run, "--step", "after_push");
    } finally {
      service.kill("SIGTERM");
      await new Promise<void>(resolve => {
        if (service.exitCode !== null) resolve();
        else service.once("exit", () => resolve());
      });
      rmSync(repo.root, { recursive: true, force: true });
    }
  });
}

test("adopted policy rejects run overrides before repository writes and admits operational inputs", liveDagu, async () => {
  const repo = repository();
  const home = join(repo.root, "dagu-home");
  const stage = join(repo.root, "staged", "feature.yaml");
  const skillDir = fileURLToPath(new URL("../skills/dagu-feature/", import.meta.url));
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const env = {
    ...process.env, DAGU_PARAMS_JSON: "{}", DAGU_HOME: home, DAGU_PORT: String(port), PRIMARY: repo.primary, SKILL_DIR: skillDir,
    GATE: "printf adopted-gate", REQUIRED_CHECK: "adopted-check", REPO: "fixture", BASE_BRANCH: "main",
    REBASE_RESOLVER: "printf adopted-resolver",
    STAGE: stage, TEST_PATHS: "test/", BUNDLE_NAME: "@a4s/omp-dagu", BUNDLE_VERSION,
    DAGU_VERSION: "2.20.1", SOURCE_NWO: "fixture/repo", SOURCE_SHA: "1".repeat(40), DAG_RUN_ID: "bootstrap-fixture",
  };
  mkdirSync(join(home, "dags"), { recursive: true });
  writeFileSync(join(home, "config.yaml"), `host: 127.0.0.1\nport: ${port}\nauth:\n  mode: none\ncoordinator:\n  enabled: false\n`);
  // Standalone starts still run the exit ownership guard, which reads enqueued
  // policy snapshots through the API. Serve them without consuming the queue.
  const service = spawn("dagu", ["server", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: repo.root, env, stdio: ["ignore", "pipe", "pipe"],
  });
  let serviceLog = "";
  service.stdout.on("data", data => { serviceLog += data; });
  service.stderr.on("data", data => { serviceLog += data; });
  const snapshot = (): string => {
    const hash = createHash("sha256");
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(directory, entry.name);
        hash.update(path);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile()) hash.update(readFileSync(path));
      }
    };
    visit(repo.primary);
    visit(repo.worktree);
    return hash.digest("hex");
  };
  try {
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/api/v1/dag-runs`)).ok; } catch {}
      if (ready) break;
      await delay(150);
    }
    assert.ok(ready, `isolated Dagu API ready\n${serviceLog}`);
    const rendered = spawnSync("bash", ["-c", extractScript(join(skillDir, "dagu-feature-bootstrap.yaml"), "  - id: render")], { encoding: "utf8", env });
    assert.equal(rendered.status, 0, rendered.stdout + rendered.stderr);
    for (const name of ["feature", "poc"]) {
      const definition = join(repo.root, "staged", `${name}.yaml`);
      for (const [parameter, value] of [["GATE", "true"], ["REBASE_RESOLVER", "true"], ["REQUIRED_CHECK", "arbitrary"], ["PRIMARY", "/foreign/clone"], ["BRANCH", "off-pattern"], ["GATE", ""], ["PRIMARY", repo.primary]] as const) {
        const before = snapshot();
        const result = spawnSync("dagu", ["start", "--run-id", `${name}-${parameter.toLowerCase()}-${value.length}`, definition, "--", "ISSUE=189", `${parameter}=${value}`], { encoding: "utf8", env, timeout: 30_000 });
        assert.notEqual(result.status, 0, result.stdout);
        assert.match(result.stdout + result.stderr, new RegExp(`admission rejected run parameter: ${parameter}`));
        assert.match(result.stdout + result.stderr, /adopted policy PRIMARY=/);
        assert.equal(snapshot(), before, `${name} ${parameter} changed repository state`);
      }
    }
    const accepted = spawnSync("dagu", ["start", "--only", "admission", "--run-id", "operational", stage, "--", "ISSUE=274", "PR_NUMBER=275", "OMP_SESSION_ID=owner-session"], { encoding: "utf8", env, timeout: 30_000 });
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
    assert.match(accepted.stdout, /admission.*succeeded/);
    const enqueued = spawnSync("dagu", ["enqueue", "--run-id", "operational-queued", stage, "--", "ISSUE=274", "PR_NUMBER=275", "OMP_SESSION_ID=owner-session"], { encoding: "utf8", env, timeout: 30_000 });
    assert.equal(enqueued.status, 0, enqueued.stdout + enqueued.stderr);
    const adopted = readFileSync(stage, "utf8");
    assert.match(adopted, /- GATE: "printf adopted-gate"/);
    assert.match(adopted, /- REBASE_RESOLVER: "printf adopted-resolver"/);
    assert.match(adopted, /- REQUIRED_CHECK: "adopted-check"/);
    assert.ok(adopted.includes(`- PRIMARY: ${JSON.stringify(repo.primary)}`));
    assert.match(adopted, /- BRANCH: dagu\/issue-\$\{ISSUE\}/);
    const promotion = extractScript(join(skillDir, "poc.yaml"), "  - id: dispose");
    assert.match(promotion, /ISSUE="\$ISSUE" \\\n\s+BASE_BRANCH="\$BASE_BRANCH" OMP_SESSION_ID="\$OMP_SESSION_ID"/);
    const pocState = git(repo.primary, "rev-parse", "--path-format=absolute", "--git-path", "poc/runs/promote-policy");
    mkdirSync(pocState, { recursive: true });
    const record = extractScript(join(skillDir, "poc.yaml"), "  - id: record");
    writeFileSync(join(pocState, "sections.jq"), record.split("<<'JQ'\n")[1]!.split("\nJQ")[0]!);
    for (const [file, value] of Object.entries({ "issue.number": "274", repo: "fixture/repo", verdict: "PASS", scope: "OK", created: "" })) writeFileSync(join(pocState, file), value);
    const result = "<!-- poc-verdict:PASS scope:OK run:promote-policy attempt:1 base:" + "1".repeat(40) + " -->\n" +
      ["Pregunta", "Proposición demostrada", "Ruta ejercitada", "Comandos y salida", "Después del PASS"].map(heading => `## ${heading}\npolicy proof\n`).join("\n");
    writeFileSync(join(repo.root, "issue.json"), JSON.stringify({ body: "## PoC\npolicy proof\n\n## Después del PASS\nversioned policy\n" }));
    writeFileSync(join(repo.root, "comments.json"), JSON.stringify([[{ body: result, html_url: "https://example.test/pass" }]]));
    const bin = join(repo.root, "promotion-bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), '#!/bin/sh\ncase "$1" in issue) cat "$POLICY_FIXTURE/issue.json";; api) cat "$POLICY_FIXTURE/comments.json";; *) exit 1;; esac\n');
    chmodSync(join(bin, "gh"), 0o755);
    writeFileSync(join(bin, "dagu-feature-bundle"), '#!/bin/sh\nexec dagu "$@"\n');
    chmodSync(join(bin, "dagu-feature-bundle"), 0o755);
    const adoptedDirectory = join(repo.primary, ".workspace", "dagu", "dags");
    mkdirSync(adoptedDirectory, { recursive: true });
    writeFileSync(join(adoptedDirectory, "feature.yaml"), adopted);
    const promoted = spawnSync("bash", ["-c", promotion], { encoding: "utf8", env: {
      ...env, RUN: "promote-policy", PROMOTE: "yes", OMP_SESSION_ID: "owner-session",
      POLICY_FIXTURE: repo.root, PATH: `${bin}:${process.env.PATH}`,
    } });
    assert.equal(promoted.status, 0, promoted.stdout + promoted.stderr);
    const history = spawnSync("dagu", ["history", "feature", "--format", "json", "--status", "queued"], { encoding: "utf8", env });
    assert.equal(history.status, 0, history.stdout + history.stderr);
    const promotedRun = (JSON.parse(history.stdout) as Array<{ dagRunId: string; params: string }>).find(run => run.dagRunId === "feature-promote-policy");
    assert.ok(promotedRun);
    assert.equal(promotedRun.params, "BASE_BRANCH=main ISSUE=274 OMP_SESSION_ID=owner-session POC_BASIS=https://example.test/pass PR_NUMBER= VALIDATION=");
  } finally {
    service.kill("SIGTERM");
    await new Promise<void>(resolve => {
      if (service.exitCode !== null || service.signalCode !== null) resolve();
      else service.once("exit", () => resolve());
    });
    rmSync(repo.root, { recursive: true, force: true });
  }
});
