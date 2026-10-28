import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicJson, type Job, type JobBinding, type NativeEvidence } from "./role-jobs.ts";
import { effectiveTranscriptIdentity, type TranscriptRow } from "./transcript-identity.ts";
import { REVIEW_SCHEMA } from "./triage/schema.ts";

interface Definition { name: string; source: string; model?: string[]; systemPrompt: string; tools?: string[] }
interface Settings { [key: string]: unknown }
interface Selection { patterns: string[]; role?: string }
interface NativeResult { exitCode: number; output: string; error?: string; aborted?: boolean; [key: string]: unknown }
/** Dagu preserves DAGU_* variables; never infer a package from an unrelated omp binary. */
export function ompRuntimeRoot(): string {
  const selected = process.env.DAGU_OMP_ROLE_RUNTIME;
  const tried = selected ? `DAGU_OMP_ROLE_RUNTIME=${JSON.stringify(selected)}` : "DAGU_OMP_ROLE_RUNTIME is unset";
  try {
    if (!selected || !isAbsolute(selected)) throw new Error("an absolute package root is required");
    const root = realpathSync(selected);
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (manifest.name !== "@oh-my-pi/pi-coding-agent") throw new Error("package is not @oh-my-pi/pi-coding-agent");
    for (const relative of ["config/settings.ts", "task/discovery.ts", "task/settings.ts", "config/model-resolver.ts", "task/executor.ts"]) {
      if (!existsSync(join(root, "src", relative))) throw new Error(`missing src/${relative}`);
    }
    return root;
  } catch (error) {
    throw new Error(`Installed OMP task runtime not found; tried ${tried}: ${error instanceof Error ? error.message : String(error)}. Set DAGU_OMP_ROLE_RUNTIME to the installed @oh-my-pi/pi-coding-agent package root in the Dagu service environment; PATH/compiled omp binaries are not used.`);
  }
}
  // OMP is an operator-installed Bun plugin runtime, selected at launch; it is
  // deliberately not a second npm dependency or a fixed build-time module path.
async function nativeModule<T>(root: string, relative: string): Promise<T> {
  return await import(pathToFileURL(join(root, "src", relative)).href) as T;
}
async function runtimeAgents(root: string, cwd: string): Promise<Definition[]> {
  const { discoverAgents } = await nativeModule<{ discoverAgents(cwd: string): Promise<{ agents: Definition[] }> }>(root, "task/discovery.ts");
  return (await discoverAgents(cwd)).agents;
}
function requiredAgent(agents: Definition[], name: string, cwd: string): Definition {
  const definition = agents.find(agent => agent.name === name);
  if (!definition) throw new Error(`Registered OMP agent ${name} is required but was not discoverable from ${cwd}; link @a4s/issue-lifecycle with omp plugin link <package-directory> for the Dagu service user and ensure the installed runtime provides task.`);
  return definition;
}
/** Bootstrap uses the same runtime and native discovery as role execution, without launching a session. */
export async function detectRoleRuntime(cwd: string): Promise<{ root: string; agents: Array<{ name: string; source: string }> }> {
  const root = ompRuntimeRoot();
  const agents = await runtimeAgents(root, cwd);
  return { root, agents: ["triage-reviewer", "task"].map(name => {
    const definition = requiredAgent(agents, name, cwd);
    return { name, source: definition.source };
  }) };
}
export function roleSchema(binding: JobBinding): Record<string, unknown> {
  if (binding.role === "triage") return REVIEW_SCHEMA;
  return { type: "object", properties: {
    summary: { type: "string", minLength: 1 }, message: { type: "string", minLength: 1 },
  }, required: ["summary", "message"], additionalProperties: false };
}
export function nativeEvidence(transcript: string, routing: unknown): NativeEvidence {
  const bytes = readFileSync(transcript);
  const rows = bytes.toString("utf8").trim().split("\n").map(line => JSON.parse(line) as TranscriptRow);
  const identity = effectiveTranscriptIdentity(rows);
  return { session: identity.session, transcript, bytes: bytes.length,
    digest: createHash("sha256").update(bytes).digest("hex"), event: identity.event,
    provider: identity.provider, model: identity.model, routing,
    attempts: identity.attempts, fallbacks: identity.fallbacks };
}
export async function executeNativeJob(job: Job, assignment: string): Promise<{ output: Record<string, unknown>; native: NativeEvidence }> {
  const root = ompRuntimeRoot();
  const [{ Settings: NativeSettings }, agents, { cfgTaskAgentModelOverrides }, { resolveAgentModelSelection }, { runSubprocess }] = await Promise.all([
    nativeModule<{ Settings: { loadReadOnly(options: { cwd: string }): Promise<Settings> } }>(root, "config/settings.ts"),
    runtimeAgents(root, job.binding.worktree),
    nativeModule<{ cfgTaskAgentModelOverrides: { get(settings: Settings): Record<string, string[]> } }>(root, "task/settings.ts"),
    nativeModule<{ resolveAgentModelSelection(options: unknown): Selection }>(root, "config/model-resolver.ts"),
    nativeModule<{ runSubprocess(options: unknown): Promise<NativeResult> }>(root, "task/executor.ts"),
  ]);
  const settings = await NativeSettings.loadReadOnly({ cwd: job.binding.worktree });
  const name = job.binding.role === "triage" ? "triage-reviewer" : "task";
  const definition = requiredAgent(agents, name, job.binding.worktree);
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
