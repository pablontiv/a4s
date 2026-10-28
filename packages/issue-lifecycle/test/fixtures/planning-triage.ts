import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicJson, jobId, type JobBinding, type JobResult } from "../../src/role-jobs.ts";
import { nativeEvidence } from "../../src/role-runtime.ts";

export { fixture };
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-dagu-triage-role-")));
  execFileSync("git", ["init", "--quiet", root]);
  const binding: JobBinding = { repo: root, worktree: root, lane: "feature", dag: "feature", run: "fixture-run", stage: "triage", role: "triage", sha: "a".repeat(40), iteration: 0, attempt: "0" };
  const id = jobId(binding);
  const directory = join(root, ".git", "dagu-feature", "runs", binding.run, "role-jobs", id);
  mkdirSync(directory, { recursive: true });
  const transcript = join(directory, `${id}.jsonl`);
  const output = { poc: "no", behavior: "demonstrated", question: "Already proven runtime?", reason: "PoC PASS" };
  const rows = [{ type: "session", id: "native-triage" }, { type: "session_init", agent: "triage-reviewer", task: `Authorized Dagu role job ${id}.` },
    { type: "message", id: "response", message: { role: "assistant", provider: "actual-provider", model: "actual-model", stopReason: "toolUse", content: [{ type: "toolCall", id: "yield-1", name: "yield", arguments: { data: output } }] } },
    { type: "message", id: "outcome", message: { role: "toolResult", toolCallId: "yield-1", toolName: "yield", details: { status: "success", data: output } } }];
  const seal = () => {
    writeFileSync(transcript, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    return nativeEvidence(transcript, { agent: "triage-reviewer", patterns: ["@slow", "provider/fallback"] });
  };
  const result: JobResult = { schemaVersion: 1, id, binding, executor: { host: "fixture-host", pid: 123, processStartedAt: "fixture-process-start" }, state: "completed", readyAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), readyToStartMs: 0, output, native: seal() };
  const path = join(directory, "result.json");
  const save = () => atomicJson(path, result);
  save();
  return { root, id, path, result, transcript, rows, seal, save, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
