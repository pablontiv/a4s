import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { qualityMarker } from "../src/triage/quality.ts";
import type { QualityRequest, TranscriptRow } from "../src/triage/quality.ts";
import { jobId, type JobBinding, type JobResult } from "../src/role-jobs.ts";
import { nativeEvidence } from "../src/role-runtime.ts";
import { roleAdmission } from "./role-job-fixtures.ts";

export function readQualityPolicies() {
  return {
    qa: { fallbackRoles: ["@slow", "@default", "@task"], excludeTaskFamily: true },
    reviewer: { fallbackRoles: ["@slow", "@default", "@task"], excludeTaskFamily: true },
  };
}

type Repository = { root: string; primary: string; worktree: string; state: string };
export function qualityFixture(repo: Repository, verdict: "PASS" | "FAIL" = "PASS", current?: QualityRequest) {
  const candidate = JSON.parse(readFileSync(join(repo.state, "candidate.json"), "utf8"));
  const request: QualityRequest = current ?? {
    repo: repo.primary, worktree: repo.worktree, run: basename(repo.state), sha: candidate.sha, iteration: candidate.iteration,
    attempt: "2026-10-16T01:00:00Z", implementer: "ImplementTest", session: "parent-id",
    implementStartedAt: "2026-10-16T00:00:00Z",
  };
  const parent = join(repo.root, "sessions", "test_parent-id.jsonl");
  mkdirSync(parent.slice(0, -6), { recursive: true });
  const messages: TranscriptRow[] = [{ type: "session", id: request.session }];
  const paths: Record<string, string> = {};
  const attemptTime = /^\d/.test(request.attempt) && !request.attempt.includes("T") ? Number(request.attempt) * 1000 : Date.parse(request.attempt);
  const invoked = new Date(attemptTime + 1000).toISOString();
  const started = new Date(attemptTime + 2000).toISOString();
  for (const [id, role, provider, model] of [
    ["ImplementTest", "implementer", "openai-codex", "effective"],
    ["QATest", "qa", "anthropic", "alternate"],
    ["ReviewTest", "reviewer", "anthropic", "alternate"],
  ] as const) {
    const marker = role === "implementer" ? `FEATURE_IMPLEMENT RUN=${request.run}` : qualityMarker(request, role);
    const agent = role === "implementer" ? "task" : role;
    const report = { repo: request.repo, run: request.run, sha: request.sha, iteration: request.iteration,
      attempt: request.attempt, role, verdict, findings: verdict === "FAIL" ? ["Fix acceptance regression"] : ["Acceptance checked"] };
    messages.push({ type: "message", timestamp: invoked, message: {
      role: "assistant", content: [{ type: "toolCall", id: `invoke-${id}`, name: "task",
        arguments: { tasks: [{ name: id, ...(role === "implementer" ? {} : { agent }), task: marker }] } }],
    } });
    const child: TranscriptRow[] = [
      { type: "session", id: `child-${id}`, parentSession: parent },
      { type: "session_init", agent, task: marker, timestamp: started },
      { type: "model_change", role: `subagent:${id}`, model: `${provider}/${model}` },
      { type: "message", id: `read-${id}`, message: { role: "assistant", provider, model, stopReason: "toolUse",
        content: [{ type: "toolCall", id: `sha-${id}`, name: "bash", arguments: { command: `git -C "${repo.worktree}" rev-parse HEAD` } }] } },
      { type: "message", message: { role: "toolResult", toolName: "bash", toolCallId: `sha-${id}`,
        content: [{ type: "text", text: request.sha }] } },
      { type: "message", id: `final-${id}`, message: { role: "assistant", provider, model, stopReason: "stop",
        content: [{ type: "text", text: JSON.stringify(report) }] } },
    ];
    const path = join(parent.slice(0, -6), `${id}.jsonl`);
    paths[role] = path;
    writeFileSync(path, child.map(row => JSON.stringify(row)).join("\n") + "\n");
  }
  writeFileSync(parent, messages.map(row => JSON.stringify(row)).join("\n") + "\n");
  const models = {
    current: () => ({ provider: "openai-codex", id: "effective", lineage: "canonical-openai" }),
    resolve: (spec: string) => {
      if (["openai-codex/effective", "anthropic/alternate"].includes(spec)) {
        const [provider, id] = spec.split("/");
        return { provider: provider!, id: id!, lineage: provider === "openai-codex" ? "canonical-openai" : "canonical-anthropic" };
      }
      if (["@slow", "@default"].includes(spec)) return { provider: "anthropic", id: "alternate", lineage: "canonical-anthropic" };
      if (spec === "@task") return { provider: "openai-codex", id: "effective", lineage: "canonical-openai" };
      return undefined;
    },
    family: (model: { provider: string }) => {
      assert.ok("lineage" in model && typeof model.lineage === "string", "canonical API requires the original catalog object");
      return model.lineage;
    },
  };
  writeFileSync(join(repo.state, "quality-request.json"), JSON.stringify(request));
  return { parent, paths, request, models };
}

export function nativeQualityFixture(repo: Repository, verdict: "PASS" | "FAIL" = "PASS", current?: QualityRequest) {
  const fixture = qualityFixture(repo, verdict, current);
  const { request } = fixture;
  const receipt = roleAdmission(repo.primary, repo.root, request.run,
    "dagu-role-jobs stage implement\ndagu-role-jobs stage quality_review");
  const ids: Record<string, string> = {};
  const results: Record<string, JobResult> = {};
  for (const role of ["implement", "qa", "reviewer"] as const) {
    const binding: JobBinding = { repo: repo.primary, worktree: repo.worktree, lane: "feature", dag: "feature",
      run: request.run, stage: role === "implement" ? "implement" : "quality_review", role,
      sha: request.sha, iteration: request.iteration, attempt: role === "implement" ? "implementation" : request.attempt };
    const id = jobId(binding);
    const directory = join(repo.state, "role-jobs", id);
    mkdirSync(directory, { recursive: true });
    const provider = role === "implement" ? "openai-codex" : "anthropic";
    const model = role === "implement" ? "effective" : "alternate";
    const output = role === "implement" ? { summary: "Candidate", message: "feat: candidate" } :
      { repo: request.repo, run: request.run, sha: request.sha, iteration: request.iteration,
        attempt: request.attempt, role, verdict, findings: verdict === "FAIL" ? ["Fix acceptance regression"] : ["Acceptance checked"] };
    const transcript = join(directory, `${id}.jsonl`);
    const marker = role === "implement" ? `FEATURE_IMPLEMENT RUN=${request.run}` : qualityMarker(request, role);
    const rows = [{ type: "session", id: `native-${id}` },
      { type: "session_init", agent: role === "implement" ? "task" : role,
        task: `Authorized Dagu role job ${id}.\n${marker}`, timestamp: "2026-10-16T02:00:00Z" },
      { type: "message", id: "read", message: { role: "assistant", provider, model, stopReason: "toolUse",
        content: [{ type: "toolCall", id: "sha", name: "bash", arguments: { command: `git -C "${repo.worktree}" rev-parse HEAD` } }] } },
      { type: "message", message: { role: "toolResult", toolName: "bash", toolCallId: "sha", content: request.sha } },
      { type: "message", id: "response", message: { role: "assistant", provider, model, stopReason: "toolUse",
        content: [{ type: "toolCall", name: "yield", id: "verdict", arguments: { data: output } }] } },
      { type: "message", message: { role: "toolResult", toolName: "yield", toolCallId: "verdict",
        details: { status: "success", data: output } } }];
    writeFileSync(transcript, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const result: JobResult = { schemaVersion: 1, id, binding, executor: { host: "fixture", pid: 1, processStartedAt: "fixture" },
      state: "completed", readyAt: request.attempt, startedAt: "2026-10-16T02:00:00Z", finishedAt: "2026-10-16T02:00:01Z",
      readyToStartMs: 1, output, native: nativeEvidence(transcript, { fixture: true }) };
    const path = join(directory, "result.json");
    writeFileSync(path, JSON.stringify(result));
    writeFileSync(join(directory, "job.json"), JSON.stringify({ schemaVersion: 1, id, binding, directory,
      executor: result.executor, readyAt: result.readyAt, startedAt: result.startedAt, state: "completed" }));
    receipt.runReceipt.observations.push({ at: result.finishedAt, dag: "feature", run: request.run, attempt: 1, category: "runtimeAndModels",
      kind: "role-job", data: { id, state: "completed", result: path, native: result.native } });
    ids[role] = id;
    results[role] = result;
  }
  request.implementer = ids.implement!;
  writeFileSync(join(repo.state, "quality-request.json"), JSON.stringify(request));
  const implementation = join(repo.state, "role-jobs", ids.implement!, "result.json");
  writeFileSync(join(repo.state, "candidate.json"), JSON.stringify({ sha: request.sha, iteration: request.iteration,
    implementer: request.implementer, implementation: { inputSha: request.sha,
      resultDigest: createHash("sha256").update(readFileSync(implementation)).digest("hex") } }));
  writeFileSync(join(repo.state, "receipt.json"), JSON.stringify(receipt));
  return { ...fixture, ids, results };
}
