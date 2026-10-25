#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  decideStaleRecoveries, emptyLedger, readAdminEvents, recoveryLog,
  type RecoveryLedger,
} from "../src/stale-recovery.ts";

function stationHome(): string {
  return process.env.DAGU_HOME || join(homedir(), ".dagu");
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
  const result = spawnSync("dagu", ["status", "feature", "--run-id", run], { encoding: "utf8" });
  const line = (result.stdout ?? "").split("\n")[0] ?? "";
  if (line.startsWith("Failed")) return true;
  const detail = line || (result.stderr ?? "").trim() || result.error?.message || `exit ${result.status ?? "signal"}`;
  log(`stale-process recovery skipped: run=${run} status=${detail}`);
  if (result.error || result.status !== 0) process.exitCode = 1;
  return false;
}

function main(): void {
  const [command, ...extra] = process.argv.slice(2);
  if (command !== "recover-scheduled" || extra.length) throw new Error("Usage: dagu-stale-recovery recover-scheduled");
  const home = stationHome();
  const ledgerPath = join(home, "stale-recovery.json");
  const ledger = loadLedger(ledgerPath);
  const decisions = decideStaleRecoveries(readAdminEvents(join(home, "logs", "admin", "events")), ledger);
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
    const retried = spawnSync("dagu", ["retry", "--run-id", decision.run, "--step", decision.step, "--downstream", "feature"], { stdio: "inherit" });
    if (retried.status !== 0) {
      log(`stale-process recovery failed: run=${decision.run} attempt=${decision.attempt} step=${decision.step} exit=${retried.status ?? retried.error?.message ?? "signal"}`);
      process.exitCode = 1;
    }
  }
}

try {
  main();
} catch (error) {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
