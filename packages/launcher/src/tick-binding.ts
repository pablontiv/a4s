import { join } from "node:path";
import { readJsonFile, realDirectory, stationRoot, tupleFromJson, writeJsonDurable } from "./station-state.ts";
import { isRecord } from "./type-guard.ts";
import type { ArtifactTuple } from "./release.ts";

export const TICK_DAG = "reconcile";
export interface TickBinding { dagRunId: string; tuple: ArtifactTuple; createdAt: string }
export type Attempt = "first" | "retry" | "unknown";
export function tickBindingPath(home: string, dagRunId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(dagRunId)) throw new Error("tick requires a valid DAG_RUN_ID");
  return join(stationRoot(home), "ticks", `${dagRunId}.json`);
}
export function validateTickBinding(value: unknown, dagRunId: string): TickBinding {
  if (!isRecord(value) || value.dagRunId !== dagRunId || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) throw new Error(`Invalid tick binding ${dagRunId}`);
  return { dagRunId, tuple: tupleFromJson(value.tuple), createdAt: value.createdAt };
}
/** PoC #790: only positive native trigger evidence authorizes a new binding.
 * Missing history, 404, unreadable details and unknown triggers are not first attempts. */
export async function confirmFirstAttempt(dagRunId: string, env = process.env): Promise<Attempt> {
  const dag = env.DAG_NAME || TICK_DAG;
  try {
    const response = await fetch(`${(env.DAGU_URL || "http://127.0.0.1:8080").replace(/\/+$/, "")}/api/v1/dag-runs/${encodeURIComponent(dag)}/${encodeURIComponent(dagRunId)}`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return "unknown";
    const value: unknown = await response.json();
    if (!isRecord(value) || !isRecord(value.dagRunDetails) || value.dagRunDetails.dagRunId !== dagRunId || value.dagRunDetails.name !== dag) return "unknown";
    const trigger = value.dagRunDetails.triggerType;
    if (trigger === "retry") return "retry";
    return trigger === "manual" || trigger === "scheduler" ? "first" : "unknown";
  } catch { return "unknown"; }
}
/** Caller holds .state.lock. Binding identity is not cache retention. */
export async function bindTickLocked(home: string, dagRunId: string, current: ArtifactTuple, confirm = confirmFirstAttempt): Promise<TickBinding> {
  const path = tickBindingPath(home, dagRunId);
  try { return validateTickBinding(readJsonFile(path), dagRunId); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const attempt = await confirm(dagRunId);
  if (attempt !== "first") throw new Error(`Missing tick binding for ${dagRunId}; attempt=${attempt}; refusing to repin`);
  realDirectory(join(stationRoot(home), "ticks"));
  const binding = { dagRunId, tuple: current, createdAt: new Date().toISOString() };
  writeJsonDurable(path, binding);
  return binding;
}
