import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUNDLE_VERSION } from "../src/bundle.ts";
import { loadedExtensionDigest, type Receipt } from "../src/admission.ts";
import { nativeEvidence } from "../src/role-runtime.ts";
import type { Job } from "../src/role-jobs.ts";

export function roleAdmission(primary: string, home: string, run: string, snapshot: string): Receipt {
  return { schemaVersion: 1, sourceVersion: { version: BUNDLE_VERSION, commit: "a".repeat(40), origin: "fixture/repo" },
    deploymentFingerprint: "fixture", initial: { admittedAt: new Date().toISOString(),
      deployment: { loadedExtension: { digest: loadedExtensionDigest } }, runtimeAndModels: { daguHome: home },
      execution: { primary, head: execFileSync("git", ["-C", primary, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        ompSession: "parent-id", parameters: ["ISSUE=189"], dagSnapshot: snapshot }, eventsAndExternalState: {} },
    runReceipt: { dag: "feature", run, attempt: 1, observations: [] } };
}

export async function roleExecution(job: Job, assignment: string) {
  const output = job.binding.role === "triage"
    ? { poc: "no", behavior: "demonstrated", question: "Existing behavior?", reason: "Prior PASS" }
    : { summary: "Quality candidate", message: "feat: quality candidate" };
  const rows = [{ type: "session", id: `native-${job.id}` },
    { type: "session_init", agent: job.binding.role === "triage" ? "triage-reviewer" : "task", task: assignment, timestamp: new Date().toISOString() },
    { type: "message", id: "response", message: { role: "assistant", provider: "openai-codex", model: "effective", stopReason: "toolUse",
      content: [{ type: "toolCall", name: "yield", id: "yield-1", arguments: { data: output } }] } },
    { type: "message", message: { role: "toolResult", toolName: "yield", toolCallId: "yield-1", details: { status: "success", data: output } } }];
  mkdirSync(job.directory, { recursive: true });
  const transcript = join(job.directory, `${job.id}.jsonl`);
  writeFileSync(transcript, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  return { output, native: nativeEvidence(transcript, { fixture: true }) };
}
