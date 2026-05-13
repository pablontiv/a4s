import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Receipt } from "../src/admission.ts";
import { nativeEvidence } from "../src/role-runtime.ts";
import type { Job } from "../src/role-jobs.ts";
import { fixtureArtifact } from "./fixtures/artifact.ts";
import { identity } from "../src/identity.ts";
import { USED_CONTRACTS } from "../src/artifact-receipt.ts";
import { artifactToken, type ArtifactTuple } from "../../launcher/src/release.ts";
import { compiledArtifact } from "./fixtures/admission.ts";
import { packageDirectory } from "./fixtures/artifact.ts";
import { exampleConfig } from "../../launcher/src/config.ts";
import { materializeDag } from "../src/materialize.ts";

export function reconcileSnapshot(artifact: ArtifactTuple, ciBlocked = 2): string {
  const config = exampleConfig();
  config.escalation.ciBlocked = ciBlocked;
  return materializeDag(packageDirectory, "feature.yaml", config, {
    version: artifact.version, source: `fixture/repo@${artifact.commit}`,
  });
}

/** Materialize real admitted artifacts before timing receipt-bound reconcile work. */
export function reconcileEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const rows: Array<{ PRIMARY: string; RUN: string }> = env.RUNS ? JSON.parse(env.RUNS) : [];
  if (env.PRIMARY && env.RUN) rows.push({ PRIMARY: env.PRIMARY, RUN: env.RUN });
  const available = rows.filter(row => row.PRIMARY && row.RUN && existsSync(row.PRIMARY));
  if (!available.length) return env;
  const homePath = env.DAGU_HOME || join(env.TMPDIR || dirname(available[0]!.PRIMARY), "dagu-home");
  mkdirSync(homePath, { recursive: true });
  const home = realpathSync(homePath);
  const artifact = compiledArtifact(home);
  const snapshot = reconcileSnapshot(artifact, Number(env.ESCALATION_CI_BLOCKED ?? 2));
  for (const row of available) {
    const primary = realpathSync(row.PRIMARY);
    const state = execFileSync("git", ["-C", primary, "rev-parse", "--path-format=absolute", "--git-path", `dagu-feature/runs/${row.RUN}`], { encoding: "utf8" }).trim();
    const path = join(state, "receipt.json");
    if (existsSync(path)) continue;
    mkdirSync(state, { recursive: true });
    writeFileSync(path, JSON.stringify(roleAdmission(primary, home, row.RUN, snapshot, artifact)));
  }
  return { A4S_ARTIFACT: artifactToken(artifact), ...env, DAGU_HOME: home };
}

export function roleAdmission(primary: string, home: string, run: string, snapshot: string, artifact?: ArtifactTuple): Receipt {
  const { version, commit, digest } = artifact ?? fixtureArtifact(home);
  return { schemaVersion: 2, artifact: { version, commit, digest }, artifactSupport: identity.support, contracts: USED_CONTRACTS,
    sourceVersion: { version, commit, origin: "fixture/repo" },
    deploymentFingerprint: "fixture", initial: { admittedAt: new Date().toISOString(),
      deployment: { config: { schemaVersion: 1, commit: "b".repeat(40), digest: "c".repeat(64) } }, runtimeAndModels: { daguHome: home },
      execution: { primary, head: execFileSync("git", ["-C", primary, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        ompSession: "parent-id", parameters: ["ISSUE=189"], dagSnapshot: snapshot.replaceAll("dagu-role-jobs", '"$A4S_BIN" role-jobs') }, eventsAndExternalState: {} },
    runReceipt: { dag: "feature", run, attempt: 1, observations: [] } };
}

export async function roleExecution(job: Job, assignment: string) {
  const output = job.binding.role === "triage"
    ? { poc: "no", behavior: "demonstrated", question: "Existing behavior?", reason: "Prior PASS" }
    : { summary: "Gated candidate", message: "feat: gated candidate" };
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
