import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicJson, type Job, type JobBinding, type NativeEvidence } from "./role-jobs.ts";
import { REVIEW_SCHEMA } from "./triage/schema.ts";

interface Definition { name: string; source: string; model?: string[]; systemPrompt: string; tools?: string[] }
interface Settings { [key: string]: unknown }
interface Selection { patterns: string[]; role?: string }
interface NativeResult { exitCode: number; output: string; error?: string; aborted?: boolean; [key: string]: unknown }
interface Row {
  type?: string; id?: string; timestamp?: string; model?: string; resolvedModelIsFallback?: boolean;
  message?: { role?: string; provider?: string; model?: string; stopReason?: string; content?: unknown; errorMessage?: string };
}
/** Resolve the installed runtime, not an independent model/client implementation. */
export function ompRuntimeRoot(): string {
  let root = process.env.OMP_ROLE_RUNTIME ? realpathSync(process.env.OMP_ROLE_RUNTIME) :
    dirname(realpathSync(execFileSync("which", ["omp"], { encoding: "utf8" }).trim()));
  for (;;) {
    const manifest = join(root, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "@oh-my-pi/pi-coding-agent") return root;
    const parent = dirname(root);
    if (parent === root) throw new Error("Installed OMP task runtime not found; set OMP_ROLE_RUNTIME to its package root");
    root = parent;
  }
}
  // OMP is an operator-installed Bun plugin runtime, selected at launch; it is
  // deliberately not a second npm dependency or a fixed build-time module path.
async function nativeModule<T>(root: string, relative: string): Promise<T> {
  return await import(pathToFileURL(join(root, "src", relative)).href) as T;
}
export function roleSchema(binding: JobBinding): Record<string, unknown> {
  if (binding.role === "triage") return REVIEW_SCHEMA;
  if (binding.role === "implement" || binding.role === "conflict-resolution") return { type: "object", properties: {
    summary: { type: "string", minLength: 1 }, message: { type: "string", minLength: 1 },
  }, required: ["summary", "message"], additionalProperties: false };
  const properties = Object.fromEntries(["repo", "run", "sha", "iteration", "attempt", "role"].map(key =>
    [key, { const: binding[key as keyof JobBinding] }]));
  return { type: "object", properties: { ...properties, verdict: { type: "string", enum: ["PASS", "FAIL"] },
    findings: { type: "array", items: { type: "string" } } },
    required: [...Object.keys(properties), "verdict", "findings"], additionalProperties: false };
}
export function nativeEvidence(transcript: string, routing: unknown): NativeEvidence {
  const bytes = readFileSync(transcript);
  const rows = bytes.toString("utf8").trim().split("\n").map(line => JSON.parse(line) as Row);
  const sessions = rows.filter(row => row.type === "session");
  const assistants = rows.filter(row => row.type === "message" && row.message?.role === "assistant");
  const final = assistants.filter(row => row.message?.stopReason === "stop" || row.message?.stopReason === "toolUse").at(-1);
  if (sessions.length !== 1 || !sessions[0]?.id || !final?.id || !final.message?.provider || !final.message.model) throw new Error("Missing native session/effective assistant identity");
  return { session: sessions[0].id, transcript, bytes: bytes.length,
    digest: createHash("sha256").update(bytes).digest("hex"), event: final.id,
    provider: final.message.provider, model: final.message.model, routing,
    attempts: assistants.map(row => ({ event: row.id, timestamp: row.timestamp, provider: row.message?.provider,
      model: row.message?.model, stopReason: row.message?.stopReason, error: row.message?.errorMessage })),
    fallbacks: rows.filter(row => row.type === "model_change").map(row => ({ event: row.id, timestamp: row.timestamp,
      model: row.model, resolvedModelIsFallback: row.resolvedModelIsFallback === true })) };
}
export async function executeNativeJob(job: Job, assignment: string): Promise<{ output: Record<string, unknown>; native: NativeEvidence }> {
  const root = ompRuntimeRoot();
  const [{ Settings: NativeSettings }, { discoverAgents }, { cfgTaskAgentModelOverrides }, { resolveAgentModelSelection }, { runSubprocess }] = await Promise.all([
    nativeModule<{ Settings: { loadReadOnly(options: { cwd: string }): Promise<Settings> } }>(root, "config/settings.ts"),
    nativeModule<{ discoverAgents(cwd: string): Promise<{ agents: Definition[] }> }>(root, "task/discovery.ts"),
    nativeModule<{ cfgTaskAgentModelOverrides: { get(settings: Settings): Record<string, string[]> } }>(root, "task/settings.ts"),
    nativeModule<{ resolveAgentModelSelection(options: unknown): Selection }>(root, "config/model-resolver.ts"),
    nativeModule<{ runSubprocess(options: unknown): Promise<NativeResult> }>(root, "task/executor.ts"),
  ]);
  const settings = await NativeSettings.loadReadOnly({ cwd: job.binding.worktree });
  const { agents } = await discoverAgents(job.binding.worktree);
  const name = job.binding.role === "triage" ? "triage-reviewer" :
    ["implement", "conflict-resolution"].includes(job.binding.role) ? "task" : job.binding.role;
  const definition = agents.find(agent => agent.name === name);
  if (!definition) throw new Error(`Registered OMP agent ${name} is required`);
  const overrides = cfgTaskAgentModelOverrides.get(settings)[name];
  const selection = resolveAgentModelSelection({ settingsOverride: overrides, agentModel: definition.model, settings });
  if (!selection.patterns.length) throw new Error(`Registered role ${name} has no effective model routing`);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  const routing = { runtime: { root, version: manifest.version,
    executorDigest: createHash("sha256").update(readFileSync(join(root, "src/task/executor.ts"))).digest("hex") },
    agent: { name, source: definition.source, model: definition.model }, overrides, selection };
  mkdirSync(job.directory, { recursive: true, mode: 0o700 });
  atomicJson(join(job.directory, "routing.json"), routing);
  atomicJson(join(job.directory, "assignment.json"), { binding: job.binding, assignment });
  // runSubprocess owns registry identity, strict structured yield, complete configured
  // arrays and subagent:<id> retry chains. No synthetic parent task lineage is supplied.
  const result = await runSubprocess({ cwd: job.binding.worktree, agent: definition,
    id: job.id, index: 0, task: assignment, description: `Dagu ${job.binding.role} ${job.binding.run}`,
    settings, modelOverride: selection.patterns, modelRole: selection.role,
    structured: true, outputSchema: roleSchema(job.binding), outputSchemaMode: "strict",
    outputSchemaSource: "caller", outputSchemaOverridesAgent: true,
    artifactsDir: job.directory, persistArtifacts: true,
    keepAlive: false, enableIrc: false, enableMCP: false });
  atomicJson(join(job.directory, "native-result.json"), result);
  if (result.exitCode !== 0 || result.aborted) throw new Error(`Native role execution failed: ${result.error ?? result.output}`);
  const output = JSON.parse(result.output) as Record<string, unknown>;
  if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error("Native role result must be a structured object");
  return { output, native: nativeEvidence(join(job.directory, `${job.id}.jsonl`), routing) };
}
