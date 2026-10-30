import { readServiceEnvironment } from "../../launcher/src/service-environment.ts";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { packageRoot } from "./executable.ts";
import { classifyRuns } from "./reconcile-classify.ts";
import { invokeRun } from "./run-artifact.ts";
import { promote, gc } from "../../launcher/src/station.ts";
import { isRecord } from "../../launcher/src/type-guard.ts";

/** This process stays on the launcher's tick tuple even when promote commits a successor. */
export async function tick(args: string[]): Promise<void> {
  if (args.length || !process.env.DAG_RUN_ID || !process.env.A4S_BIN || !process.env.A4S_ARTIFACT) throw new Error("tick requires a launcher-bound Dagu run");
  const service = readServiceEnvironment();
  Object.assign(process.env, service);
  const home = service.DAGU_HOME;
  process.env.CI_OBSERVATION_ID = process.env.DAG_RUN_ID;
  console.log(`tick=${process.env.DAG_RUN_ID} artifact=${process.env.A4S_ARTIFACT}`);
  console.log(JSON.stringify(await promote(home)));
  const directory = mkdtempSync(join(tmpdir(), "a4s-tick-"));
  try {
    const recovered = spawnSync(process.env.A4S_BIN, ["stale-recovery", "recover-scheduled"], { stdio: "inherit" });
    if (recovered.error) throw recovered.error;
    if (recovered.status !== 0) throw new Error(`Scheduled stale recovery failed: ${recovered.status}`);
    // Reuse the receipt artifact's bounded native discovery implementation.
    const template: unknown = parseAllDocuments(readFileSync(join(packageRoot, "skills", "issue-execution", "reconcile.yaml"), "utf8"))[0]?.toJSON();
    if (!isRecord(template) || !Array.isArray(template.steps)) throw new Error("Tick payload has no discovery template");
    const discover = template.steps.find((step: unknown) => isRecord(step) && step.id === "discover");
    if (!isRecord(discover) || typeof discover.run !== "string") throw new Error("Tick payload lacks discovery implementation");
    const discovery = spawnSync("bash", ["-euo", "pipefail", "-c", discover.run], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    process.stderr.write(discovery.stderr || "");
    if (discovery.error) throw discovery.error;
    if (discovery.status !== 0) throw new Error(`Tick discovery failed: ${discovery.status}`);
    process.env.RUNS = discovery.stdout.trim();
    const output = join(directory, "classify");
    await classifyRuns(output);
    const values = new Map(readFileSync(output, "utf8").trim().split("\n").map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    const children: unknown = JSON.parse(values.get("children") || "[]");
    const failures: unknown = JSON.parse(values.get("failures") || "[]");
    if (!Array.isArray(children) || !Array.isArray(failures)) throw new Error("Invalid tick classification outputs");
    let cursor = 0;
    const errors: string[] = failures.map(value => JSON.stringify(value));
    await Promise.all(Array.from({ length: Math.min(4, children.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= children.length) return;
        const row: unknown = children[index];
        if (!isRecord(row) || typeof row.PRIMARY !== "string" || typeof row.RUN !== "string") throw new Error("Invalid tick run action");
        const env = Object.fromEntries(Object.entries(row).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
        env.DAGU_OUTPUT_FILE = join(directory, `run-${index}.outputs`);
        try {
          for (const step of ["observe", "transition"]) {
            const result = await invokeRun(row.PRIMARY, row.RUN, ["reconcile", "step", step], { env });
            if (result.status !== 0) throw new Error(`${step} exited ${result.status}`);
          }
        } catch (error) { errors.push(`${row.RUN}: ${error instanceof Error ? error.message : String(error)}`); }
      }
    }));
    if (errors.length) throw new Error(`Tick actions failed: ${errors.join("; ")}`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
  console.log(JSON.stringify(await gc(home)));
}
