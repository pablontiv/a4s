import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EnvironmentRecord, RunSummary } from "./evidence.ts";

export interface ReportInput {
  testedCommit: string;
  environment: EnvironmentRecord;
  summary: RunSummary;
  hashes: Record<"environment.json" | "events.jsonl" | "summary.json", string>;
  anomalies: string[];
  failedRuns: string[];
  protocolErrors: string[];
}

export function renderE0Report(input: ReportInput): string {
  const lines = [
    "# E0 Attach and Transport Experiment Report",
    "",
    "## Verdict",
    `- ${input.summary.verdict}`,
    "",
    "## Tested revision and environment",
    `- Tested commit: ${input.testedCommit}`,
    `- Run ID: ${input.environment.run_id}`,
    `- Started at: ${input.environment.started_at}`,
    `- OS: ${input.environment.os_version}`,
    `- Architecture: ${input.environment.architecture}`,
    `- Node: ${input.environment.node_version}`,
    `- Pi: ${input.environment.pi_version}`,
    `- Transport: ${input.environment.transport}`,
    `- Endpoint pattern: ${input.environment.endpoint_pattern}`,
    `- Trials per scenario: ${input.environment.trials_per_scenario}`,
    "",
    "## Procedure",
    "- Recorded environment, events, and summary artifacts for the selected run.",
    "- Verified scenario verdicts and platform coverage from the generated summary.",
    "",
    "## Results by scenario",
    ...scenarioLines(input.summary),
    "",
    "## Delivery invariants",
    ...invariantLines(input.summary),
    "",
    "## Protocol-error results",
    ...protocolErrorLines(input.protocolErrors),
    "",
    "## Artifacts and SHA-256 hashes",
    `- environment.json: ${input.hashes["environment.json"]}`,
    `- events.jsonl: ${input.hashes["events.jsonl"]}`,
    `- summary.json: ${input.hashes["summary.json"]}`,
    "",
    "## Anomalies and failed prior runs",
    ...listLines("Anomalies", input.anomalies),
    ...listLines("Failed prior runs", input.failedRuns),
    "",
    "## Platform coverage",
    `- macOS: ${input.summary.platforms.macOS}`,
    `- linux: ${input.summary.platforms.linux}`,
    `- Windows: ${input.summary.platforms.windows}`,
    "",
    "## Decision",
    `- ${input.summary.verdict === "PASS-macOS" ? "PASS" : "FAIL"}`,
    "",
  ];
  return `${lines.join("\n")}`;
}

export async function writeE0Report(runDir: string, outputPath: string, anomalies: string[] = []): Promise<void> {
  const environmentPath = join(runDir, "environment.json");
  const eventsPath = join(runDir, "events.jsonl");
  const summaryPath = join(runDir, "summary.json");
  const [environmentRaw, eventsRaw, summaryRaw] = await Promise.all([
    readFile(environmentPath, "utf8"),
    readFile(eventsPath, "utf8"),
    readFile(summaryPath, "utf8"),
  ]);

  const environment = JSON.parse(environmentRaw) as EnvironmentRecord;
  const summary = JSON.parse(summaryRaw) as RunSummary;
  if (environment.run_id !== summary.run_id) {
    throw new Error(`run ID mismatch: environment=${environment.run_id} summary=${summary.run_id}`);
  }

  const failedRuns = await scanFailedSiblingRuns(runDir, summary.run_id);
  const markdown = renderE0Report({
    testedCommit: environment.a4s_commit,
    environment,
    summary,
    hashes: {
      "environment.json": sha256(environmentRaw),
      "events.jsonl": sha256(eventsRaw),
      "summary.json": sha256(summaryRaw),
    },
    anomalies,
    failedRuns,
    protocolErrors: parseProtocolErrors(eventsRaw),
  });
  await writeFile(outputPath, `${markdown}\n`, "utf8");
}

async function scanFailedSiblingRuns(runDir: string, currentRunId: string): Promise<string[]> {
  const parentDir = join(runDir, "..");
  const entries = await readdir(parentDir, { withFileTypes: true });
  const failed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === currentRunId) continue;
    const summaryPath = join(parentDir, entry.name, "summary.json");
    try {
      const summary = JSON.parse(await readFile(summaryPath, "utf8")) as RunSummary;
      if (typeof summary.verdict === "string" && summary.verdict.startsWith("FAIL-")) failed.push(entry.name);
    } catch {
      continue;
    }
  }
  return failed.sort();
}

function parseProtocolErrors(eventsRaw: string): string[] {
  return eventsRaw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event.event === "protocol_error")
    .map((event) => typeof event.detail === "string" ? event.detail : `${String(event.component)} protocol_error`);
}

function protocolErrorLines(errors: string[]): string[] {
  if (errors.length === 0) return ["- No protocol errors were observed in the recorded run artifacts."];
  const counts = new Map<string, number>();
  for (const error of errors) counts.set(error, (counts.get(error) ?? 0) + 1);
  return [
    `- Observed protocol errors: ${errors.length}`,
    ...[...counts].map(([error, count]) => `  - ${error}: ${count}`),
  ];
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function scenarioLines(summary: RunSummary): string[] {
  return Object.entries(summary.scenarios).flatMap(([name, scenario]) => [
    `- ${name}: planned=${scenario.planned}, executed=${scenario.executed}, passed=${scenario.passed}, failed=${scenario.failed}`,
  ]);
}

function invariantLines(summary: RunSummary): string[] {
  return Object.entries(summary.scenarios).flatMap(([name, scenario]) => [
    `- ${name}: deliveries=${scenario.deliveriesCreated}, logicalProcesses=${scenario.logicalProcesses}, acknowledgements=${scenario.acknowledged}, duplicateFrames=${scenario.duplicateFrames}, unhandledErrors=${scenario.unhandledErrors}`,
  ]);
}

function listLines(label: string, values: string[]): string[] {
  if (values.length === 0) return [`- ${label}: none`];
  return [`- ${label}:`, ...values.map((value) => `  - ${value}`)];
}

if (import.meta.main) {
  const [runDir, outputPath, ...anomalies] = process.argv.slice(2);
  if (!runDir || !outputPath) {
    process.exitCode = 2;
  } else {
    await writeE0Report(runDir, outputPath, anomalies);
  }
}
