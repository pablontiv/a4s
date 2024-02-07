import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Job } from "./role-jobs.ts";

interface Definition { name: string; source: string; model?: string | string[]; systemPrompt: string; [key: string]: unknown }
interface Settings { [key: string]: unknown }
interface Selection { patterns: string[]; role?: string }
interface Result { exitCode: number; output: string; error?: string; aborted?: boolean }
interface Input {
  mode: "detect" | "run"; cwd: string; agentFile: string;
  runtime: { binary: string; version: string; digest: string };
  job?: Job; assignment?: string; outputSchema?: Record<string, unknown>;
}
export const HOST_MODULES = ["task/discovery", "task/executor", "task/settings", "config/settings", "config/model-resolver"] as const;
export type HostLoader = (id: string) => Promise<unknown>;
// Literal, external import edges are required by the compiled host's module rewriter.
const hostLoader: HostLoader = id => {
  switch (id) {
    case "@oh-my-pi/pi-coding-agent/task/discovery": return import("@oh-my-pi/pi-coding-agent/task/discovery");
    case "@oh-my-pi/pi-coding-agent/task/executor": return import("@oh-my-pi/pi-coding-agent/task/executor");
    case "@oh-my-pi/pi-coding-agent/task/settings": return import("@oh-my-pi/pi-coding-agent/task/settings");
    case "@oh-my-pi/pi-coding-agent/config/settings": return import("@oh-my-pi/pi-coding-agent/config/settings");
    case "@oh-my-pi/pi-coding-agent/config/model-resolver": return import("@oh-my-pi/pi-coding-agent/config/model-resolver");
    default: return Promise.reject(new Error(`Unknown OMP host module: ${id}`));
  }
};
function save(directory: string, name: string, value: unknown): void {
  const path = join(directory, name);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
/** Dynamic external imports let export-surface failures name the exact host module. */
export async function runRoleRunner(directory: string, load: HostLoader = hostLoader): Promise<void> {
  const input = JSON.parse(readFileSync(join(directory, "runner-input.json"), "utf8")) as Input;
  const modules = await Promise.all(HOST_MODULES.map(async path => {
    const id = `@oh-my-pi/pi-coding-agent/${path}`;
    try { return await load(id); }
    catch (error) { throw new Error(`Required OMP host module ${id} is unavailable: ${String(error)}; ask the station operator to select a compatible omp on PATH.`); }
  }));
  const [discovery, executor, taskSettings, configSettings, resolver] = modules as [
    { discoverAgents(cwd: string): Promise<{ agents: Definition[] }> },
    { runSubprocess(options: unknown): Promise<Result> },
    { cfgTaskAgentModelOverrides: { get(settings: Settings): Record<string, string[]> } },
    { Settings: { loadReadOnly(options: { cwd: string }): Promise<Settings> } },
    { resolveAgentModelSelection(options: unknown): Selection },
  ];
  for (const [index, available] of [typeof discovery.discoverAgents === "function", typeof executor.runSubprocess === "function",
    typeof taskSettings.cfgTaskAgentModelOverrides?.get === "function", typeof configSettings.Settings?.loadReadOnly === "function",
    typeof resolver.resolveAgentModelSelection === "function"].entries()) {
    if (!available) throw new Error(`Required OMP host module @oh-my-pi/pi-coding-agent/${HOST_MODULES[index]} lacks its required export; select a compatible omp on PATH.`);
  }
  let text: string;
  try { text = readFileSync(input.agentFile, "utf8"); }
  catch (error) { throw new Error(`Pinned OMP agent triage-reviewer is required at ${input.agentFile}: ${String(error)}; restore the run's verified a4s release.`); }
  const parts = text.split(/^---\s*$/m);
  const fields = parts.length === 3 ? parse(parts[1]!) : undefined;
  if (!fields || fields.name !== "triage-reviewer" || !parts[2]?.trim()) throw new Error(`Invalid pinned OMP agent triage-reviewer at ${input.agentFile}; restore the run's verified a4s release.`);
  const triage: Definition = { ...fields, systemPrompt: parts[2].trim(), source: "project" };
  let discovered: { agents: Definition[] };
  try { discovered = await discovery.discoverAgents(input.cwd); }
  catch (error) {
    throw new Error(`Required OMP host module @oh-my-pi/pi-coding-agent/task/discovery could not discover agents: ${String(error)}; select a compatible omp on PATH.`);
  }
  if (!Array.isArray(discovered?.agents)) throw new Error("Required OMP host module @oh-my-pi/pi-coding-agent/task/discovery returned an incompatible agent registry; select a compatible omp on PATH.");
  const task = discovered.agents.find(agent => agent.name === "task");
  if (!task) throw new Error(`Registered OMP agent task is required but was not discoverable from ${input.cwd}; ask the station operator to select an omp providing the shared task agent.`);
  if (input.mode === "detect") {
    save(directory, "detect.json", { root: input.runtime.binary, agents: [
      { name: triage.name, source: input.agentFile }, { name: task.name, source: task.source },
    ] });
    return;
  }
  const job = input.job!;
  const settings = await configSettings.Settings.loadReadOnly({ cwd: input.cwd });
  const definition = job.binding.role === "triage" ? triage : task;
  const overrides = taskSettings.cfgTaskAgentModelOverrides.get(settings)[definition.name];
  const selection = resolver.resolveAgentModelSelection({ settingsOverride: overrides, agentModel: definition.model, settings });
  if (!selection.patterns.length) throw new Error(`Registered role ${definition.name} has no effective model routing`);
  const routing = { runtime: input.runtime,
    agent: { name: definition.name, source: job.binding.role === "triage" ? input.agentFile : definition.source,
      ...(job.binding.role === "triage" ? { digest: createHash("sha256").update(text).digest("hex") } : {}), model: definition.model }, overrides, selection };
  save(directory, "routing.json", routing);
  const result = await executor.runSubprocess({ cwd: input.cwd, agent: definition,
    id: job.id, index: 0, task: input.assignment, description: `Dagu ${job.binding.role} ${job.binding.run}`,
    settings, modelOverride: selection.patterns, modelRole: selection.role,
    structured: true, outputSchema: input.outputSchema, outputSchemaMode: "strict",
    outputSchemaSource: "caller", outputSchemaOverridesAgent: true,
    artifactsDir: directory, persistArtifacts: true,
    keepAlive: false, enableIrc: false, enableMCP: false });
  save(directory, "native-result.json", result);
}

let workOwnerClaimed = false;
/** PoC-3: work is awaited by the factory, NOT the time-limited session_start hook.
 * Subagent rebinds neither repeat work nor exit. The loader restores its exit guard
 * before starting the main session; exit there prevents the host's own model turn. */
export default async function roleRunner(pi: { on(event: "session_start", callback: (event: unknown, context: { agent: { kind: string } }) => void): void }): Promise<void> {
  if (workOwnerClaimed) return;
  workOwnerClaimed = true;
  let code = 1;
  const directory = process.argv.at(-1)!;
  pi.on("session_start", (_event, context) => {
    if (context.agent.kind === "main") process.exit(code);
  });
  try { await runRoleRunner(directory); code = 0; }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    save(directory, "runner-error.json", { error: message });
    console.error(message);
  }
}
