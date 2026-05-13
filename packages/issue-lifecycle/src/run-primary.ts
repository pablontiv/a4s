import type { RunDetails } from "./status/progress.ts";
import { primaryFromSpec } from "../../launcher/src/primary.ts";

export function runParam(run: RunDetails, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Dagu CLI history delimits values by the next parameter, so paths may contain spaces.
  const cli = run.params?.match(new RegExp(`(?:^| )${escaped}=(.*?)(?= [A-Z_]+=|$)`))?.[1];
  if (cli !== undefined) return cli.replace(/^(['"])(.*)\1$/, "$2");
  return run.params?.match(new RegExp(
    `(?:^|[\\s"{,])${escaped}(?:["']?\\s*[:=]\\s*["']?)([^\\s"',}]+)(?=$|[\\s"',}])`,
  ))?.[1];
}

/** Rendered policy comes from the enqueued snapshot, never the current DAG file. */
export async function resolveRunPrimary(base: string, run: RunDetails, signal: AbortSignal): Promise<string | undefined> {
  const historical = run.resolvedPrimary ?? runParam(run, "PRIMARY");
  if (historical) return historical;
  const response = await fetch(`${base}/api/v1/dag-runs/${encodeURIComponent(run.name)}/${encodeURIComponent(run.dagRunId)}/spec`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });
  if (!response.ok) throw new Error(`Dagu spec HTTP ${response.status}`);
  const { spec } = await response.json() as { spec: string };
  return primaryFromSpec(spec);
}
