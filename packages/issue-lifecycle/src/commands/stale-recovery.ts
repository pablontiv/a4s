import { readServiceEnvironment } from "../../../launcher/src/service-environment.ts";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";

import { join } from "node:path";
import {
  decideStaleRecoveries, emptyLedger, readAdminEvents, recoveryLog,
  type RecoveryLedger,
} from "../stale-recovery.ts";
import { invokeRun, executingRunArtifact } from "../run-artifact.ts";
import { primaryFromSpec } from "../../../launcher/src/primary.ts";
import { STALE_PROCESS_ERROR } from "../stale-recovery.ts";
import { withFileLock } from "../../../launcher/src/file-lock.ts";

function stationHome(): string {
  return readServiceEnvironment().DAGU_HOME;
}

function loadLedger(path: string): RecoveryLedger {
  if (!existsSync(path)) return emptyLedger();
  const parsed = JSON.parse(readFileSync(path, "utf8")) as RecoveryLedger;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.recoveries)) throw new Error("Invalid stale-recovery ledger");
  return parsed;
}

function storeLedger(path: string, ledger: RecoveryLedger): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`);
  renameSync(temporary, path);
}

function log(line: string): void {
  writeSync(2, `${line}\n`);
}

function featureFailed(run: string): boolean {
  const result = spawnSync("dagu", ["status", "feature", "--run-id", run], { encoding: "utf8", env: { ...process.env, ...readServiceEnvironment() } });
  const line = (result.stdout ?? "").split("\n")[0] ?? "";
  if (line.startsWith("Failed")) return true;
  const detail = line || (result.stderr ?? "").trim() || result.error?.message || `exit ${result.status ?? "signal"}`;
  log(`stale-process recovery skipped: run=${run} status=${detail}`);
  if (result.error || result.status !== 0) process.exitCode = 1;
  return false;
}

async function run(argv: string[]): Promise<void> {
  const [command, selected, ...extra] = argv;
  const home = stationHome();
  const events = readAdminEvents(join(home, "logs", "admin", "events"));
  if (command === "recover-scheduled" && !selected && !extra.length) {
    // Listing is station-wide. Planning, status checks, ledger writes and retries
    // belong to each run's artifact, including its own checkpoint vocabulary.
    const runs = new Set(events.filter(event => event.dag_name === "feature" && event.type === "dag.run.failed" &&
      event.data?.dag_run_status?.error?.includes(STALE_PROCESS_ERROR)).map(event => event.dag_run_id).filter((id): id is string => Boolean(id)));
    for (const id of runs) {
      try {
        const base = readServiceEnvironment().DAGU_URL;
        const response = await fetch(`${base}/api/v1/dag-runs/feature/${encodeURIComponent(id)}/spec`, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`Dagu spec HTTP ${response.status}`);
        const { spec } = await response.json() as { spec: string };
        const primary = primaryFromSpec(spec);
        if (!primary) throw new Error("Admitted PRIMARY unavailable");
        const result = await invokeRun(primary, id, ["stale-recovery", "recover-run", id]);
        if (result.status !== 0) throw new Error(`run artifact exited ${result.status}`);
      } catch (error) {
        log(`reconcile-failure run=${id} status=1 cause=${JSON.stringify(error instanceof Error ? error.message : String(error))}`);
      }
    }
    return;
  }
  if (command !== "recover-run" || !selected || extra.length || selected !== process.env.RUN || !executingRunArtifact()) throw new Error("Usage: a4s stale-recovery recover-scheduled | recover-run <receipt-bound-run>");
  const ledgerPath = join(home, "stale-recovery.json");
  withFileLock(`${ledgerPath}.lock`, () => {
    const ledger = loadLedger(ledgerPath);
    const decisions = decideStaleRecoveries(events.filter(event => event.dag_run_id === selected), ledger);
    for (const decision of decisions) {
      if (decision.action !== "retry") {
        log(recoveryLog(decision));
        continue;
      }
      if (!featureFailed(decision.run)) continue;
      ledger.recoveries.push({
        run: decision.run, attempt: decision.attempt, step: decision.step,
        command: decision.command, at: new Date().toISOString(),
      });
      mkdirSync(home, { recursive: true });
      storeLedger(ledgerPath, ledger);
      log(recoveryLog(decision));
      const retried = spawnSync("dagu", ["retry", "--run-id", decision.run, "--step", decision.step, "--downstream", "feature"], { stdio: "inherit", env: { ...process.env, ...readServiceEnvironment() } });
      if (retried.status !== 0) {
        log(`stale-process recovery failed: run=${decision.run} attempt=${decision.attempt} step=${decision.step} exit=${retried.status ?? retried.error?.message ?? "signal"}`);
        process.exitCode = 1;
      }
    }
  });
}

export async function main(argv: string[]): Promise<void> {
try {
  await run(argv);
} catch (error) {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
}
