#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { appendFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { admitQuality, dispatchStage, verifyTriageResult } from "../src/role-dispatch.ts";

try {
  const [command, stage] = process.argv.slice(2);
  if (command === "stage" && stage) {
    await dispatchStage(stage, (name, value) => {
      const line = `${name}=${value.replace(/[\r\n]+/g, " ")}\n`;
      if (!process.env.DAGU_OUTPUT_FILE) throw new Error("Dagu output file is required");
      appendFileSync(process.env.DAGU_OUTPUT_FILE, line);
    });
  } else if (command === "admit-quality" && !stage) {
    const evidence = await admitQuality(process.env.PRIMARY || "", process.env.RUN || "", process.env.QA || "", process.env.REVIEW || "");
    console.log(JSON.stringify(evidence));
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
  } else throw new Error("Usage: dagu-role-jobs stage triage|implement|quality_review | verify-triage | admit-quality");
} catch (error) {
  console.error(`DAGU_ROLE_JOB_BLOCKED: ${error instanceof Error ? error.message : String(error)}`);
  if (process.argv[2] === "verify-triage") console.error("VERIFIER=FAIL");
  process.exitCode = 1;
}
