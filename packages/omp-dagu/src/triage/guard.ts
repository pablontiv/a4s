import { fileURLToPath } from "node:url";
import { admit, enqueueArguments, loadedExtensionDigest } from "../admission.ts";
import { parseReview, REVIEW_SCHEMA } from "./schema.ts";

// Rewrite before shell evaluation so loops and quoted variable expansions are
// checked using their effective arguments immediately before Dagu creates a run.
export function admissionDecision(event: Event, session?: { transcriptRoot: string }, cwd = process.cwd()): CallDecision {
  const field = event.toolName === "bash" ? "command" : event.toolName === "eval" ? "code" : undefined;
  const text = field ? event.input[field] : undefined;
  if (!field || typeof text !== "string" || !/\bdagu\s+enqueue\b/.test(text)) return undefined;
  if (text.includes("dagu-feature-bootstrap.yaml") && (text.match(/\benqueue\b/g) ?? []).length === 1) return undefined;
  if (event.toolName !== "bash") return { block: true, reason: "DAGU_ADMISSION_REQUIRED: Enqueue distributed DAGs through bash or dagu-feature-bundle enqueue; admission must resolve effective arguments before creating a run." };
  if (/^\s*dagu\s+enqueue\s+/.test(text) && !/[$`\\;&|()<>\n]/.test(text)) {
    try {
      const words = text.match(/"[^"]*"|'[^']*'|[^\s]+/g)!.map(word => word.replace(/^["']|["']$/g, ""));
      const options = enqueueArguments(words.slice(2), typeof event.input.cwd === "string" ? event.input.cwd : cwd);
      admit({ ...options, ...(session ? { session: { ...session, extensionDigest: loadedExtensionDigest } } : {}) }, false);
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
  const cli = fileURLToPath(new URL("../../bin/dagu-feature-bundle.ts", import.meta.url));
  const prefix = `DAGU_ADMISSION_SESSION=${quote(JSON.stringify({ ...session, extensionDigest: loadedExtensionDigest }))} `;
  const command = text.replace(/\bdagu\s+enqueue\b/g, `${prefix}${quote(process.execPath)} ${quote(cli)} enqueue`);
  return { input: { ...event.input, command } };
}

type RecordValue = Record<string, any>;
export interface Event {
  toolName: string;
  toolCallId: string;
  input: RecordValue;
  details?: RecordValue;
  content?: { type: string; text?: string }[];
  isError?: boolean;
}
export type CallDecision = { block: true; reason: string } | { input: RecordValue } | undefined;
interface Target { key: string; dag: string; run: string; poc: string; reviewer?: string }
interface Review { id: string; output: string; poc: string; question: string; request: number }
interface Generation { target: Target; number: number; request: number; requested: boolean; review?: Review; invalid?: { request: number; reason: string } }
interface Binding { generation: Generation; number: number; request: number }
interface Pending { bindings: Map<number, Binding> }
interface Job { binding: Binding; agentId: string }

// Deliberately fail closed on literal triage completion text. This is not a
// shell parser: substitutions, separators and eval syntax must not hide the
// protected input. Removing quote delimiters preserves POC="no".
export function target(text: string): Target | undefined {
  const literal = text.replace(/\\\r?\n/g, "").replace(/["'`]/g, "");
  if (!/\bhuman-task\b/.test(literal) || !/\bcomplete\b/.test(literal) || !/\btriage\b/.test(literal)) return undefined;
  const poc = /\bPOC\s*=\s*(no|yes)\b/.exec(literal)?.[1];
  if (!poc) return undefined;
  const normalized = literal.replace(/[\[\](),;]/g, " ");
  const dag = /\bcomplete\s+([\w.-]+)/.exec(normalized)?.[1] ?? "unresolved";
  const run = /--run-id(?:\s+|=)([\w.-]+)/.exec(normalized)?.[1] ?? "unresolved";
  const reviewer = /\bREVIEW\s*=\s*([\w.-]+)/.exec(literal)?.[1];
  return { key: JSON.stringify([dag, run]), dag, run, poc, ...(reviewer ? { reviewer } : {}) };
}

const MARKER_WHITESPACE = /\s/;

export class TriageGuard {
  private generations = new Map<string, Generation>();
  private calls = new Map<string, Pending>();
  private jobs = new Map<string, Job>();
  private completions = new Map<string, { generation: Generation; number: number }>();

  toolCall(event: Event): CallDecision {
    if (event.toolName === "task") {
      const tasks: RecordValue[] = Array.isArray(event.input.tasks) ? event.input.tasks : [event.input];
      const bound = new Map<number, Generation>();
      const claimed = new Set<Generation>();
      for (const [index, task] of tasks.entries()) {
        const assignment = `${event.input.context ?? ""}\n${task.task ?? ""}`;
        for (const generation of this.generations.values()) {
          if (!generation.requested || claimed.has(generation)) continue;
          const marker = `TRIAGE_REVIEW DAG=${generation.target.dag} RUN=${generation.target.run} GENERATION=${generation.number} REQUEST=${generation.request}`;
          let matched = false;
          for (let start = assignment.indexOf(marker); start >= 0; start = assignment.indexOf(marker, start + marker.length)) {
            const end = start + marker.length;
            if ((start > 0 && !MARKER_WHITESPACE.test(assignment[start - 1]!))
              || (end < assignment.length && !MARKER_WHITESPACE.test(assignment[end]!))) continue;
            matched = true;
            break;
          }
          if (matched) {
            bound.set(index, generation);
            claimed.add(generation);
            break;
          }
        }
      }
      if (!bound.size) return undefined;
      const bindings = new Map<number, Binding>();
      const revised = tasks.map((task, index) => {
        const generation = bound.get(index);
        if (!generation) return task;
        bindings.set(index, { generation, number: generation.number, request: generation.request });
        generation.requested = false;
        return { ...task, outputSchema: REVIEW_SCHEMA };
      });
      this.calls.set(event.toolCallId, { bindings });
      return { input: Array.isArray(event.input.tasks) ? { ...event.input, tasks: revised } : revised[0]! };
    }
    const field = event.toolName === "bash" ? "command" : event.toolName === "eval" ? "code" : undefined;
    if (!field || typeof event.input[field] !== "string") return undefined;
    const text = event.input[field];
    const completion = target(text);
    if (!completion) return undefined;
    if ((text.match(/\bhuman-task\b/g) ?? []).length > 1) return { block: true, reason: "TRIAGE_SINGLE_COMPLETION: Submit each dagu human-task call in its own tool call." };
    let generation = this.generations.get(completion.key);
    if (!generation) {
      generation = { target: completion, number: 0, request: 0, requested: false };
      this.generations.set(completion.key, generation);
    }
    if (completion.poc === "no") {
      const review = generation.review;
      if (generation.invalid || !review || review.poc === "yes") {
        generation.requested = true;
        generation.request++;
        const reason = generation.invalid ? `${generation.invalid.reason}\n` : review ? `TRIAGE_POC_REQUIRED: ${review.question}\n` : "";
        return { block: true, reason: `${reason}TRIAGE_REVIEW_REQUIRED: Run a task for this triage with this marker in its assignment. Its output must satisfy this JSON Schema:\nTRIAGE_REVIEW DAG=${completion.dag} RUN=${completion.run} GENERATION=${generation.number} REQUEST=${generation.request}\n${JSON.stringify(REVIEW_SCHEMA)}` };
      }
      if (completion.reviewer !== review.id) return { block: true, reason: `TRIAGE_REVIEW_REQUIRED: Retry this completion with --input REVIEW=${review.id}; this is the completed reviewer for the current triage generation.` };
    }
    this.completions.set(event.toolCallId, { generation, number: generation.number });
    return undefined;
  }

  toolResult(event: Event): void {
    const completion = this.completions.get(event.toolCallId);
    if (completion) {
      this.completions.delete(event.toolCallId);
      if (!event.isError && (event.details?.exitCode === undefined || event.details.exitCode === 0) && completion.number === completion.generation.number) {
        completion.generation.number++;
        completion.generation.requested = false;
        delete completion.generation.review;
        delete completion.generation.invalid;
      }
      return;
    }
    if (event.toolName === "task") {
      for (const binding of this.calls.get(event.toolCallId)?.bindings.values() ?? []) {
        if (binding.number === binding.generation.number && binding.request === binding.generation.request) binding.generation.requested = true;
      }
    }
    if (event.isError) { this.calls.delete(event.toolCallId); return; }
    if (event.toolName === "wait") {
      for (const job of event.details?.jobs ?? []) this.finish(job.id, job.agentUrlId, job.status, job.type, job.resultText);
      return;
    }
    if (event.toolName !== "task") return;
    const pending = this.calls.get(event.toolCallId);
    if (!pending) return;
    this.calls.delete(event.toolCallId);
    for (const result of event.details?.results ?? []) {
      const binding = pending.bindings.get(result.index);
      if (!binding) continue;
      if (binding.number === binding.generation.number && binding.request === binding.generation.request) binding.generation.requested = false;
      if (result.exitCode === 0 && !result.aborted && !result.error) this.record(binding, result.id, result.output);
    }
    // Native task-spawn-feedback lists every started agent/job pair, whereas
    // details.async.jobId contains only the primary job of a batch.
    const feedback = (event.content ?? []).filter(item => item.type === "text").map(item => item.text ?? "").join("\n");
    const reviewers = new Map<string, Binding>();
    for (const item of event.details?.progress ?? []) {
      const binding = pending.bindings.get(item.index);
      if (binding) reviewers.set(item.id, binding);
    }
    for (const match of feedback.matchAll(/`([^`]+)` \(job `([^`]+)`\)/g)) {
      const binding = reviewers.get(match[1]!);
      if (!binding) continue;
      this.jobs.set(match[2]!, { binding, agentId: match[1]! });
      if (binding.number === binding.generation.number && binding.request === binding.generation.request) binding.generation.requested = false;
    }
  }

  messageEnd(message: RecordValue): void {
    if (message.role !== "custom" || message.customType !== "async-result") return;
    for (const job of message.details?.jobs ?? []) this.finish(job.jobId, job.agentId, job.status, job.type, message.content);
  }
  private record(binding: Binding, id: string, output: unknown): void {
    const generation = binding.generation;
    if (binding.number !== generation.number || binding.request !== generation.request) return;
    try {
      const review = parseReview(output);
      generation.review = { id, output: output as string, poc: review.poc, question: review.question, request: binding.request };
      delete generation.invalid;
    } catch (error) {
      generation.invalid = { request: binding.request, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  private finish(jobId: string, agentId: string, status: string, type: string, text: unknown): void {
    const job = this.jobs.get(jobId);
    if (!job || job.agentId !== agentId || status !== "completed" || type !== "task" || typeof text !== "string") return;
    for (const match of text.matchAll(/<task-result\b([^>]*)>([\s\S]*?)<\/task-result>/g)) {
      const attrs = Object.fromEntries(Array.from(match[1]!.matchAll(/([\w-]+)="([^"]*)"/g), m => [m[1], m[2]]));
      if (attrs.id !== agentId || attrs.status !== "completed") continue;
      this.record(job.binding, agentId, /<output>([\s\S]*?)<\/output>/.exec(match[2]!)?.[1]);
      this.jobs.delete(jobId);
    }
  }
}
