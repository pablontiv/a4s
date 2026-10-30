import { execFileSync } from "node:child_process";
import { appendFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { computationCommand } from "../long-computation.ts";
import { dispatchStage, verifyTriageResult } from "../role-dispatch.ts";
import { RoleJobStore } from "../role-jobs.ts";
import { detectRoleRuntime } from "../role-runtime.ts";

interface RoleJobIO {
  log: (...values: unknown[]) => void;
  error: (...values: unknown[]) => void;
  exit: (code: number) => void;
}
interface RoleJobDependencies {
  execFileSync: typeof execFileSync;
  dispatchStage: typeof dispatchStage;
}
async function run(argv: string[], io: RoleJobIO, deps: RoleJobDependencies): Promise<void> {
  const [command, stage, ...extra] = argv;
  if (command === "computation") {
    if (!stage) throw new Error("Usage: dagu-role-jobs detect | stage triage|implement | verify-triage | capacity <positive-integer> | computation sample|open|run|supervise|decide");
    await computationCommand([stage, ...extra]);
    return;
  }
  if (extra.length) throw new Error("Unexpected role-job command arguments");
  if (command === "detect" && !stage) {
    try { io.log(JSON.stringify(await detectRoleRuntime(realpathSync(process.env.PRIMARY || process.cwd())))); }
    catch (error) { throw new Error(`bootstrap detect: ${error instanceof Error ? error.message : String(error)}`); }
  } else if (command === "stage" && stage) {
    // Only a4s owns the step sink; the spawned host and its tools never inherit it.
    const outputFile = process.env.DAGU_OUTPUT_FILE;
    await deps.dispatchStage(stage, (name, value) => {
      const line = `${name}=${value.replace(/[\r\n]+/g, " ")}\n`;
      if (!outputFile) throw new Error("Dagu output file is required");
      appendFileSync(outputFile, line);
    });
  } else if (command === "verify-triage" && !stage) {
    const primary = realpathSync(process.env.PRIMARY || "");
    const run = process.env.RUN || "";
    const id = process.env.REVIEW || "";
    io.log(`primary.canonical=${primary}\nrole_job.id=${id}`);
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid triage role-job id");
    const state = deps.execFileSync("git", ["-C", primary, "rev-parse", "--path-format=absolute", "--git-path", `dagu-feature/runs/${run}`], { encoding: "utf8" }).trim();
    io.log(`result.path=${join(state, "role-jobs", id, "result.json")}`);
    const result = verifyTriageResult(primary, run, id);
    io.log(`transcript.path=${result.native!.transcript}`);
    const iteration = Number(process.env.DAG_PUSHBACK_ITERATION ?? "0");
    if (result.binding.iteration !== iteration) throw new Error("Triage result belongs to another native iteration");
    const output = (value: unknown) => String(value).replace(/[\r\n]+/g, " ");
    if (result.output?.poc !== process.env.POC || output(result.output?.question) !== process.env.QUESTION || output(result.output?.reason) !== process.env.BASIS) throw new Error("Triage outputs differ from the native role result");
    io.log(`VERIFIER=PASS role_job=${result.id} session=${result.native!.session}`);
  } else if (command === "capacity" && stage) {
    if (!/^[1-9][0-9]*$/.test(stage)) throw new Error("Role-job capacity must be a positive integer");
    const capacity = Number(stage);
    if (!Number.isSafeInteger(capacity)) throw new Error("Role-job capacity must be a positive integer");
    const home = realpathSync(process.env.DAGU_HOME || "");
    const store = new RoleJobStore(home, Number(process.env.A4S_ROLE_JOB_CAPACITY || "4"));
    try { io.log(JSON.stringify({ home, ...store.changeCapacity(capacity) })); }
    finally { store.close(); }
  } else throw new Error("Usage: dagu-role-jobs detect | stage triage|implement | verify-triage | capacity <positive-integer> | computation sample|open|run|supervise|decide");
}

export async function main(argv: string[],
  io: RoleJobIO = { log: console.log, error: console.error, exit: code => process.exit(code) },
  deps: RoleJobDependencies = { execFileSync, dispatchStage }): Promise<void> {
try {
  await run(argv, io, deps);
  // Always terminate this command at a terminal outcome. Native host/tool bridges
  // are isolated in the child and must also exit without keeping a step alive.
  io.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  io.error(`DAGU_ROLE_JOB_BLOCKED: ${message}`);
  if (argv[0] === "verify-triage") io.error("VERIFIER=FAIL");
  io.exit(1);
}
}
