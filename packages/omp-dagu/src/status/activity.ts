import { open, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agentDirectory } from "../agent-directory.ts";
import { currentNode, issueNumber, resolveRunPrimary, runParam, topicFor } from "./progress.ts";
import type { RunDetails } from "./progress.ts";

const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
export const ACTIVITY_MAX_LENGTH = 120;
const AGENT_PREFIX_BY_STEP: Record<string, string> = {
  triage: "TriageReview",
  run_poc: "Poc",
  implement: "Implement",
};
const PRINCIPAL_ARGUMENTS = ["path", "command", "query", "url", "task", "pattern"] as const;

export interface ActivityTarget {
  key: string;
  kind: "command" | "agent";
  step: string;
  agentName?: string;
}

export interface ActivityOptions {
  sessionDir?: string;
  now?: () => number;
}

export function sanitizeActivity(text: string, maxLength = ACTIVITY_MAX_LENGTH): string {
  const clean = text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function activityTarget(run: RunDetails): ActivityTarget | undefined {
  const node = currentNode(run);
  if (!node) return undefined;
  const step = node.step.id || node.step.name;
  if (node.statusLabel === "running") {
    return { key: `${topicFor(run)}:command:${step}`, kind: "command", step };
  }
  const issue = issueNumber(run);
  const prefix = node.statusLabel === "waiting" ? AGENT_PREFIX_BY_STEP[node.step.name] : undefined;
  if (!issue || !prefix) return undefined;
  const agentName = `${prefix}${issue}`;
  return { key: `${topicFor(run)}:agent:${agentName}`, kind: "agent", step, agentName };
}

async function commandActivity(
  base: string,
  run: RunDetails,
  step: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const dag = encodeURIComponent(run.name);
  const runId = encodeURIComponent(run.dagRunId);
  const stepId = encodeURIComponent(step);
  const response = await fetch(`${base}/api/v1/dag-runs/${dag}/${runId}/steps/${stepId}/log?tail=3`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });
  if (!response.ok) return undefined;
  const payload = await response.json() as { content?: unknown };
  if (typeof payload.content !== "string") return undefined;
  let end = payload.content.length;
  while (end > 0) {
    while (end > 0 && (payload.content[end - 1] === "\n" || payload.content[end - 1] === "\r")) end--;
    const start = payload.content.lastIndexOf("\n", end - 1) + 1;
    const line = payload.content.slice(start, end);
    if (line.trim()) return sanitizeActivity(`> ${line}`) || undefined;
    end = Math.max(0, start - 1);
  }
  return undefined;
}

async function encodedCwd(cwd: string): Promise<string> {
  const resolved = await realpath(path.resolve(cwd)).catch(() => path.resolve(cwd));
  const home = await realpath(os.homedir()).catch(() => path.resolve(os.homedir()));
  const relative = path.relative(home, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return relative ? `-${relative.replace(/[/\\:]/g, "-")}` : "-";
  }
  return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

async function defaultSessionDir(primary: string): Promise<string> {
  return path.join(agentDirectory(), "sessions", await encodedCwd(primary));
}

async function newestFile(directory: string, names: string[], accepts: (name: string) => boolean): Promise<string | undefined> {
  let newest: { file: string; mtime: number } | undefined;
  for (const name of names) {
    if (!accepts(name)) continue;
    const file = path.join(directory, name);
    const mtime = (await stat(file)).mtimeMs;
    if (!newest || mtime > newest.mtime) newest = { file, mtime };
  }
  return newest?.file;
}

async function locateTranscript(
  base: string,
  signal: AbortSignal,
  run: RunDetails,
  agentName: string,
  preferredSessionDir?: string,
): Promise<string | undefined> {
  const primary = await resolveRunPrimary(base, run, signal);
  const sessionId = runParam(run, "OMP_SESSION_ID");
  if (!primary || !sessionId) return undefined;
  const sessionDir = preferredSessionDir || await defaultSessionDir(primary);
  const coordinatorNames = await readdir(sessionDir);
  const coordinator = await newestFile(
    sessionDir,
    coordinatorNames,
    name => name.endsWith(`_${sessionId}.jsonl`),
  );
  if (!coordinator) return undefined;
  const artifactDir = coordinator.slice(0, -".jsonl".length);
  const escaped = agentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const taskPattern = new RegExp(`^${escaped}(?:v\\d+)?\\.jsonl$`);
  return newestFile(artifactDir, await readdir(artifactDir), name => taskPattern.test(name));
}

async function completeTranscript(file: string, signal: AbortSignal): Promise<string> {
  if (signal.aborted) return "";
  const handle = await open(file, "r");
  try {
    const size = (await handle.stat()).size;
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.allocUnsafe(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    if (signal.aborted) return "";
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline < 0 ? "" : text.slice(firstNewline + 1);
    }
    const lastNewline = text.lastIndexOf("\n");
    return lastNewline < 0 ? "" : text.slice(0, lastNewline);
  } finally {
    await handle.close();
  }
}

function principalArgument(args: Record<string, unknown>): string | undefined {
  for (const key of PRINCIPAL_ARGUMENTS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

async function agentActivity(
  base: string,
  run: RunDetails,
  agentName: string,
  options: ActivityOptions,
  signal: AbortSignal,
): Promise<string | undefined> {
  const transcript = await locateTranscript(base, signal, run, agentName, options.sessionDir);
  if (!transcript) return undefined;
  const transcriptText = await completeTranscript(transcript, signal);
  let lineEnd = transcriptText.length;
  while (lineEnd > 0) {
    const previousNewline = transcriptText.lastIndexOf("\n", lineEnd - 1);
    const line = transcriptText.slice(previousNewline + 1, lineEnd);
    lineEnd = previousNewline;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { timestamp?: unknown; message?: { role?: unknown; content?: unknown } };
    if (record.message?.role !== "assistant" || !Array.isArray(record.message.content)) continue;
    for (let itemIndex = record.message.content.length - 1; itemIndex >= 0; itemIndex--) {
      const item = record.message.content[itemIndex];
      if (!item || typeof item !== "object") continue;
      const call = item as { type?: unknown; name?: unknown; arguments?: unknown };
      if (call.type !== "toolCall" || typeof call.name !== "string") continue;
      const args = call.arguments && typeof call.arguments === "object"
        ? call.arguments as Record<string, unknown>
        : {};
      const intent = typeof args.i === "string" && args.i.trim() ? args.i
        : typeof args.title === "string" && args.title.trim() ? args.title
          : principalArgument(args);
      const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
      if (!Number.isFinite(timestamp)) continue;
      const age = Math.max(0, Math.round(((options.now?.() ?? Date.now()) - timestamp) / 1000));
      return sanitizeActivity(`${call.name}${intent ? ` ${intent}` : ""} (${age}s)`) || undefined;
    }
  }
  return undefined;
}

export async function readActivity(
  base: string,
  run: RunDetails,
  target: ActivityTarget,
  options: ActivityOptions,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    return target.kind === "command"
      ? await commandActivity(base, run, target.step, signal)
      : await agentActivity(base, run, target.agentName!, options, signal);
  } catch {
    return undefined;
  }
}
