import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileDigest } from "../../launcher/src/artifact-cache.ts";
import { compiled, packageRoot } from "./executable.ts";
import { atomicJson, type Job, type JobBinding, type NativeEvidence } from "./role-jobs.ts";
import { effectiveTranscriptIdentity, type TranscriptRow } from "./transcript-identity.ts";
import { REVIEW_SCHEMA } from "./triage/schema.ts";

interface ProcessResult { code: number | null; signal?: string | null; stdout: string; stderr: string }
export interface RoleProcessBoundary {
  run(file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<ProcessResult>;
}
const processes: RoleProcessBoundary = {
  run(file, args, options) {
    const { promise, resolve, reject } = Promise.withResolvers<ProcessResult>();
    const child = spawn(file, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const terminate = () => child.kill("SIGTERM");
    process.on("SIGTERM", terminate);
    process.on("SIGINT", terminate);
    const cleanup = () => { process.off("SIGTERM", terminate); process.off("SIGINT", terminate); };
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", (code, signal) => { cleanup(); resolve({ code, signal, stdout, stderr }); });
    return promise;
  },
};
/** Preserve ordinary tool/provider settings, but allow only explicit Dagu run context.
 * In particular, host startup (not merely native tools) must never see step sinks. */
export function roleEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([name, value]) => value !== undefined &&
    (!/^(DAGU_|DAG_RUN_|DAG_)/.test(name) || name === "DAGU_HOME" || name === "DAG_PUSHBACK_ITERATION")));
}
function ompBinary(environment: NodeJS.ProcessEnv): string {
  for (const directory of (environment.PATH ?? "").split(delimiter)) {
    try {
      const binary = resolve(directory || ".", "omp");
      accessSync(binary, constants.X_OK);
      return realpathSync(binary);
    } catch { /* Try the next PATH entry, just as executable lookup does. */ }
  }
  throw new Error("OMP role host not found: no executable omp on PATH; ask the station operator to provision the Dagu service PATH (and the bootstrap shell PATH).");
}
async function launch(directory: string, cwd: string, input: Record<string, unknown>, boundary: RoleProcessBoundary): Promise<void> {
  const env = roleEnvironment(process.env);
  const binary = ompBinary(env);
  const version = await boundary.run(binary, ["--version"], { cwd, env });
  if (version.code !== 0) throw new Error(`OMP role host --version failed (${version.code ?? version.signal}): ${version.stderr.trim()}`);
  const runtime = { binary, version: version.stdout.trim(), digest: await fileDigest(binary) };
  atomicJson(join(directory, "runner-input.json"), { ...input, cwd, runtime, agentFile: join(packageRoot, "agents/triage-reviewer.md") });
  const runner = join(packageRoot, compiled ? "role-runner.ts" : "src/role-runner.ts");
  const result = await boundary.run(binary, ["-p", "--no-session", "-e", runner, directory], { cwd, env });
  if (result.code !== 0) {
    let detail = result.stderr.trim();
    try { detail = JSON.parse(readFileSync(join(directory, "runner-error.json"), "utf8")).error; } catch { /* Host loader failures are on stderr. */ }
    throw new Error(`OMP role runner exited ${result.code ?? result.signal}: ${detail || "no diagnostic; check the station omp host modules"}`);
  }
}
/** The same headless extension host checks every required module and both definitions. */
export async function detectRoleRuntime(cwd: string, boundary: RoleProcessBoundary = processes): Promise<{ root: string; agents: Array<{ name: string; source: string }> }> {
  const directory = mkdtempSync(join(tmpdir(), "a4s-role-detect-"));
  try {
    await launch(directory, cwd, { mode: "detect" }, boundary);
    try { return JSON.parse(readFileSync(join(directory, "detect.json"), "utf8")); }
    catch (error) { throw new Error(`OMP role runner exited without a valid detect.json: ${String(error)}`); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
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
export async function executeNativeJob(job: Job, assignment: string, boundary: RoleProcessBoundary = processes): Promise<{ output: Record<string, unknown>; native: NativeEvidence }> {
  mkdirSync(job.directory, { recursive: true, mode: 0o700 });
  atomicJson(join(job.directory, "assignment.json"), { binding: job.binding, assignment });
  await launch(job.directory, job.binding.worktree, { mode: "run", job, assignment, outputSchema: roleSchema(job.binding) }, boundary);
  let result: { exitCode: number; aborted?: boolean; error?: string; output: string };
  try { result = JSON.parse(readFileSync(join(job.directory, "native-result.json"), "utf8")); }
  catch (error) { throw new Error(`OMP role runner exited without a valid native-result.json: ${String(error)}`); }
  if (result.exitCode !== 0 || result.aborted) throw new Error(`Native role execution failed: ${result.error ?? result.output}`);
  const output = JSON.parse(result.output) as Record<string, unknown>;
  if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error("Native role result must be a structured object");
  const routing = JSON.parse(readFileSync(join(job.directory, "routing.json"), "utf8"));
  return { output, native: nativeEvidence(join(job.directory, `${job.id}.jsonl`), routing) };
}
