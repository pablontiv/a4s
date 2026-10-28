#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { stationExecutors } from "../src/station-executors.ts";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    "dagu-home": { type: "string" },
    "admission-close": { type: "string" },
    "admission-open": { type: "string" },
    "executor-action": { type: "string" },
    source: { type: "string" },
    commit: { type: "string" },
    executor: { type: "string" },
    "launcher-dir": { type: "string" },
    evidence: { type: "string" },
    help: { type: "boolean", default: false },
  } });
  if (values.help) {
    console.log("dagu-station-install --executor-action install|inventory|migrate|prune --evidence FILE [--dagu-home DIR] [--source REPO --commit SHA --launcher-dir DIR | --executor PATH --source REPO --admission-close CMD --admission-open CMD]. Executor operations do not change station configuration or restart services. Station setup and capacity are operator-owned; use dagu-feature-bundle readiness <config> for read-only diagnostics.");
    return;
  }
  if (!values["executor-action"]) throw new Error("Require --executor-action; station configuration and service activation are operator-owned. Use dagu-feature-bundle readiness <config> to inspect readiness without writes.");
  if (!values.evidence) throw new Error("Executor operations require --evidence FILE");
  const home = resolve(values["dagu-home"] || process.env.DAGU_HOME || join(homedir(), ".dagu"));
  mkdirSync(home, { recursive: true });
  await stationExecutors({
    action: values["executor-action"], home, evidence: values.evidence,
    ...(values.source === undefined ? {} : { source: values.source }),
    ...(values.commit === undefined ? {} : { commit: values.commit }),
    ...(values.executor === undefined ? {} : { executor: values.executor }),
    ...(values["launcher-dir"] === undefined ? {} : { launcherDir: values["launcher-dir"] }),
    ...(values["admission-close"] === undefined ? {} : { admissionClose: values["admission-close"] }),
    ...(values["admission-open"] === undefined ? {} : { admissionOpen: values["admission-open"] }),
  });
}

try { await main(); }
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
