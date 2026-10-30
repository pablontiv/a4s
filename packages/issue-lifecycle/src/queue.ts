import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { isRecord } from "../../launcher/src/type-guard.ts";
import { readServiceEnvironment } from "../../launcher/src/service-environment.ts";

export interface ReadinessReport { ready: boolean; checks: string[] }

function stationConfigReadiness(home: string): string {
  const file = join(home, "config.yaml");
  const action = `action=ask-station-operator: merge auth.mode: none and coordinator.enabled: true into ${file}, preserving unrelated settings, then restart the Dagu service`;
  try {
    const doc = parseDocument(readFileSync(file, "utf8"));
    if (doc.errors.length) throw new Error(doc.errors.map(String).join("; "));
    const config: unknown = doc.toJS();
    if (!isRecord(config)) throw new Error("expected a YAML mapping");
    const missing: string[] = [];
    if (!isRecord(config.auth) || config.auth.mode !== "none") missing.push("auth.mode: none");
    if (!isRecord(config.coordinator) || config.coordinator.enabled !== true) missing.push("coordinator.enabled: true");
    if (missing.length) throw new Error(`missing or incorrect required leaves: ${missing.join(", ")}`);
    return "station-config source=config.yaml auth.mode=none coordinator.enabled=true ready=yes";
  } catch (error) {
    return `station-config source=config.yaml ready=no cause=${JSON.stringify(String(error))} ${action}`;
  }
}

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


/** GET-only diagnostics: never run Dagu CLI initialization, install files or restart a service. */
export async function stationReadiness(home: string | undefined, lane: string, env: NodeJS.ProcessEnv = process.env): Promise<ReadinessReport> {
  let service;
  try { service = readServiceEnvironment({ ...env, ...(home === undefined ? {} : { DAGU_HOME: home }) }); }
  catch (error) { return { ready: false, checks: [error instanceof Error ? error.message : String(error)] }; }
  const checks = [stationConfigReadiness(service.DAGU_HOME), queueReadiness(service.DAGU_HOME, lane), "service-environment ready=yes"];
  const endpoint = service.DAGU_URL;
  for (const resource of ["queues", "services/scheduler"]) {
    try {
      const response = await fetch(`${endpoint}/api/v1/${resource}`, { signal: AbortSignal.timeout(5000), redirect: "error" });
      if (!response.ok) throw new Error(`HTTP ${response.status}${[401, 403].includes(response.status) ? "; endpoint/auth problem: a4s requires an unauthenticated loopback Dagu API; ask the station operator to check auth.mode: none and coordinator.enabled: true in config.yaml and restart the Dagu service" : ""}`);
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
