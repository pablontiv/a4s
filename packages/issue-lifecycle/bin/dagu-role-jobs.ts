#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { appendFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { dispatchStage, verifyTriageResult } from "../src/role-dispatch.ts";
import { RoleJobStore } from "../src/role-jobs.ts";

try {
  const [command, stage, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error("Unexpected role-job command arguments");
  if (command === "stage" && stage) {
    await dispatchStage(stage, (name, value) => {
      const line = `${name}=${value.replace(/[\r\n]+/g, " ")}\n`;
      if (!process.env.DAGU_OUTPUT_FILE) throw new Error("Dagu output file is required");
      appendFileSync(process.env.DAGU_OUTPUT_FILE, line);
    });
  } else if (command === "verify-triage" && !stage) {
    const primary = realpathSync(process.env.PRIMARY || "");
    const run = process.env.RUN || "";
    const id = process.env.REVIEW || "";
    console.log(`primary.canonical=${primary}\nrole_job.id=${id}`);
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid triage role-job id");
    const state = execFileSync("git", ["-C", primary, "rev-parse", "--path-format=absolute", "--git-path", `dagu-feature/runs/${run}`], { encoding: "utf8" }).trim();
    console.log(`result.path=${join(state, "role-jobs", id, "result.json")}`);
    const result = verifyTriageResult(primary, run, id);
    console.log(`transcript.path=${result.native!.transcript}`);
    const status = execFileSync("dagu", ["status", "feature", "--run-id", process.env.RUN || ""], { encoding: "utf8" });
    const iteration = Number(/push-back iteration: ([0-9]+)/.exec(status)?.[1] ?? "0");
    if (result.binding.iteration !== iteration) throw new Error("Triage result belongs to another native iteration");
    const output = (value: unknown) => String(value).replace(/[\r\n]+/g, " ");
    if (result.output?.poc !== process.env.POC || output(result.output?.question) !== process.env.QUESTION || output(result.output?.reason) !== process.env.BASIS) throw new Error("Triage outputs differ from the native role result");
    console.log(`VERIFIER=PASS role_job=${result.id} session=${result.native!.session}`);
  } else if (command === "capacity" && stage) {
    if (!/^[1-9][0-9]*$/.test(stage)) throw new Error("Role-job capacity must be a positive integer");
    const capacity = Number(stage);
    if (!Number.isSafeInteger(capacity)) throw new Error("Role-job capacity must be a positive integer");
    const home = realpathSync(process.env.DAGU_HOME || "");
    const store = new RoleJobStore(home, Number(process.env.A4S_ROLE_JOB_CAPACITY || "4"));
    try { console.log(JSON.stringify({ home, ...store.changeCapacity(capacity) })); }
    finally { store.close(); }
  } else throw new Error("Usage: dagu-role-jobs stage triage|implement | verify-triage | capacity <positive-integer>");
} catch (error) {
  console.error(`DAGU_ROLE_JOB_BLOCKED: ${error instanceof Error ? error.message : String(error)}`);
  if (process.argv[2] === "verify-triage") console.error("VERIFIER=FAIL");
  process.exitCode = 1;
}
