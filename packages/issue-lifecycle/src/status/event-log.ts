import type { RunDetails } from "./progress.ts";

interface Entry {
  id: string;
  type: string;
  data?: { dag_run_status?: { nodes?: Array<{
    step_id?: string; step_name: string; status?: number; approval_iteration?: number;
  }> } };
}

// A cursor traverses older entries, never tails new ones. Each sweep starts at
// the head and consumes every page before emitting in persistence order.
export class EventLog {
  private seen = new Set<string>();

  async read(base: string, run: RunDetails, signal: AbortSignal): Promise<RunDetails[]> {
    const url = new URL(`${base}/api/v1/event-logs`);
    url.searchParams.set("dagName", run.name);
    url.searchParams.set("dagRunId", run.dagRunId);
    url.searchParams.set("paginationMode", "cursor");
    url.searchParams.set("limit", "500");
    const entries = new Map<string, Entry>();
    let restarted = false;
    do {
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
      if (response.status === 400 && url.searchParams.has("cursor") && !restarted) {
        url.searchParams.delete("cursor");
        entries.clear();
        restarted = true;
        continue;
      }
      if (!response.ok) throw new Error(`Event log HTTP ${response.status}`);
      const page = await response.json() as { entries: Entry[]; nextCursor?: string };
      for (const entry of page.entries) entries.set(entry.id, entry);
      if (!page.nextCursor) break;
      url.searchParams.set("cursor", page.nextCursor);
    } while (!signal.aborted);
    if (signal.aborted) return [];
    const snapshots: RunDetails[] = [];
    // Preserve the server's persistence order, including sub-millisecond ties.
    for (const entry of [...entries.values()].reverse()) {
      if (this.seen.has(entry.id)) continue;
      const nodes = entry.data?.dag_run_status?.nodes ?? [];
      if (entry.type === "dag.run.waiting") {
        snapshots.push({ ...run, receiptEvent: { id: entry.id, type: entry.type, source: "dagu-persisted-event-log", cursorReset: restarted }, statusLabel: "waiting", nodes: nodes.filter(node => node.status === 7).flatMap(node => {
          const metadata = run.nodes?.find(candidate => (candidate.step.id ?? candidate.step.name) === (node.step_id ?? node.step_name)
            && candidate.statusLabel === "waiting"
            && (candidate.approvalIteration ?? 0) === (node.approval_iteration ?? 0));
          return ["waiting", "running"].includes(run.statusLabel) && metadata?.step.humanTask ? [{
            step: metadata.step, statusLabel: "waiting", approvalIteration: node.approval_iteration ?? 0,
          }] : [];
        }) });
      } else if (entry.type === "dag.run.succeeded" && run.statusLabel === "succeeded") {
        snapshots.push({ ...run, receiptEvent: { id: entry.id, type: entry.type, source: "dagu-persisted-event-log", cursorReset: restarted }, statusLabel: "succeeded", nodes: [] });
      }
      this.seen.add(entry.id);
    }
    return snapshots;
  }
}
