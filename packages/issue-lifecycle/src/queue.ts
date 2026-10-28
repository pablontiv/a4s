import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { isRecord } from "./type-guard.ts";

export interface ReadinessReport { ready: boolean; checks: string[] }

/** Inspect station-owned capacity without deriving or changing its value. */
export function queueReadiness(home: string, lane: string): string {
  try {
    const doc = parseDocument(readFileSync(join(home, "config.yaml"), "utf8"));
    if (doc.errors.length) throw new Error(doc.errors.map(String).join("; "));
    const config: unknown = doc.toJS();
    if (!isRecord(config)) throw new Error("expected a YAML mapping");
    const queues = config.queues;
    if (!isRecord(queues) || queues.enabled === false || !Array.isArray(queues.config)) throw new Error(`missing enabled lane queue ${lane}`);
    const matches = queues.config.filter((entry: unknown) => isRecord(entry) && entry.name === lane);
    if (matches.length !== 1) throw new Error(`${matches.length ? "duplicate" : "missing"} lane queue ${lane}`);
    const capacity = matches[0].max_concurrency;
    if (typeof capacity !== "number" || !Number.isSafeInteger(capacity) || capacity < 1) throw new Error(`lane queue ${lane} requires positive max_concurrency`);
    return `queue=${lane} source=config.yaml max_concurrency=${capacity} ready=yes`;
  } catch (error) {
    return `queue=${lane} source=config.yaml ready=no cause=${JSON.stringify(String(error))} action=ask-station-operator`;
  }
}

const serviceTools = [
  "bash", "git", "gh", "jq", "node", "bun", "python3", "omp", "dagu",
  "dagu-codeql", "dagu-feature-bundle", "dagu-feature-protect", "dagu-gate", "dagu-poc-scope",
  "dagu-pr-body", "dagu-role-jobs", "dagu-stale-recovery",
];
function missingTools(path: string): string[] {
  const directories = path.split(delimiter);
  return serviceTools.filter(tool => !directories.some(directory => {
    if (!directory) return false;
    try { accessSync(join(directory, tool), constants.X_OK); return true; } catch { return false; }
  }));
}

/** Read the scheduler's environment, not the interactive shell's PATH. */
export function serviceEnvironmentReadiness(home: string): string {
  try {
    let environment: Record<string, string> | undefined;
    if (process.platform === "linux") {
      for (const pid of readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
        let args: string[];
        try { args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"); } catch { continue; }
        if (basename(args[0] ?? "") !== "dagu" || !args.some(arg => arg === "start-all" || arg === "scheduler")) continue;
        const candidate = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map(entry => {
          const index = entry.indexOf("=");
          return [entry.slice(0, index), entry.slice(index + 1)];
        }));
        if (resolve(candidate.DAGU_HOME || join(homedir(), ".dagu")) === resolve(home)) { environment = candidate; break; }
      }
    } else if (process.platform === "darwin") {
      const service = execFileSync("launchctl", ["print", `gui/${process.getuid!()}/local.dagu.server`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const path = /^\s*path = (.+)$/m.exec(service)?.[1];
      if (!path || !/^\s*state = running$/m.test(service)) throw new Error("local.dagu.server is not running");
      const plist: unknown = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf8" }));
      if (isRecord(plist) && isRecord(plist.EnvironmentVariables)) {
        environment = Object.fromEntries(Object.entries(plist.EnvironmentVariables).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
        if (resolve(environment.DAGU_HOME || join(homedir(), ".dagu")) !== resolve(home)) throw new Error("service DAGU_HOME does not match");
      }
    } else throw new Error(`service environment inspection is unavailable on ${process.platform}`);
    if (!environment) throw new Error(`no readable running Dagu scheduler environment for DAGU_HOME=${resolve(home)}`);
    const missing = missingTools(environment.PATH || "");
    if (missing.length) throw new Error(`scheduler PATH is missing ${missing.join(", ")}`);
    return "service-environment ready=yes";
  } catch (error) {
    return `service-environment ready=no cause=${JSON.stringify(String(error))} action=ask-station-operator`;
  }
}

/** GET-only diagnostics: never run Dagu CLI initialization, install files or restart a service. */
export async function stationReadiness(home: string, lane: string): Promise<ReadinessReport> {
  const checks = [queueReadiness(home, lane), serviceEnvironmentReadiness(home)];
  const endpoint = (process.env.DAGU_URL || `http://127.0.0.1:${process.env.DAGU_PORT || "8080"}`).replace(/\/+$/, "");
  for (const resource of ["queues", "services/scheduler"]) {
    try {
      const response = await fetch(`${endpoint}/api/v1/${resource}`, { signal: AbortSignal.timeout(5000), redirect: "error" });
      if (!response.ok) throw new Error(`HTTP ${response.status}${[401, 403].includes(response.status) ? "; endpoint/auth problem: a4s requires an unauthenticated loopback Dagu API" : ""}`);
      const value: unknown = await response.json();
      if (resource === "queues") {
        if (!isRecord(value) || !Array.isArray(value.queues)) throw new Error("unexpected queues response");
        const queue = value.queues.find((entry: unknown) => isRecord(entry) && entry.name === lane && entry.type === "global");
        if (!queue) throw new Error(`missing lane queue ${lane} in running Dagu API; ask the station operator to configure/reload it`);
        checks.push(`queue=${lane} source=api ready=yes`);
      } else {
        if (!isRecord(value) || !Array.isArray(value.schedulers) || !value.schedulers.some((entry: unknown) => isRecord(entry) && entry.status === "active")) throw new Error("no active Dagu scheduler; inspect service environment and station configuration");
        checks.push("scheduler source=api ready=yes");
      }
    } catch (error) {
      checks.push(`endpoint=${endpoint} resource=${resource} ready=no cause=${JSON.stringify(String(error))} action=ask-station-operator`);
    }
  }
  return { ready: checks.every(check => check.includes("ready=yes")), checks };
}
