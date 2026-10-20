import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { qualityMarker } from "../src/triage/quality.ts";
import type { QualityRequest, TranscriptRow } from "../src/triage/quality.ts";

type Repository = { root: string; primary: string; worktree: string; state: string };
export function qualityFixture(repo: Repository, verdict: "PASS" | "FAIL" = "PASS", current?: QualityRequest) {
  const candidate = JSON.parse(readFileSync(join(repo.state, "candidate.json"), "utf8"));
  const request: QualityRequest = current ?? {
    repo: repo.primary, worktree: repo.worktree, run: "test-run", sha: candidate.sha, iteration: candidate.iteration,
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
        arguments: { tasks: [{ name: id, agent, task: marker }] } }],
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
