import { closeSync, fstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { diagnostic, known, observeLocks, unknown, type Observation } from "./health-locks.ts";
import { probeProcess } from "./process-identity.ts";
import { github, releaseRepository } from "./release.ts";
import { isRecord } from "./type-guard.ts";
import { stationCacheRoot } from "./station-paths.ts";

export interface HealthOptions { home: string; url: string; now: string; from?: string; cpuMeasurement?: string }
export interface HealthDependencies {
  fetch?: typeof fetch;
  github?: (path: string) => unknown;
  probe?: typeof probeProcess;
  locks?: typeof observeLocks;
}
type Row = Record<string, unknown>;
function timestamp(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT/.test(value) || value.startsWith("0001-")) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function text(value: unknown, field: string): Observation<string> {
  return typeof value === "string" && value.length > 0 ? known(value) : unknown(`Missing or invalid ${field}`);
}
function quantile(sorted: number[], fraction: number): number {
  const index = (sorted.length - 1) * fraction, lower = Math.floor(index), upper = Math.ceil(index);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}
/** Canonical JSON uses Unicode code-unit key order, not environment-dependent locale sorting. */
export function healthJson(value: unknown): string {
  function sorted(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(sorted);
    if (isRecord(input)) return Object.fromEntries(Object.keys(input).sort().map(key => [key, sorted(input[key])]));
    return input;
  }
  return `${JSON.stringify(sorted(value), null, 2)}\n`;
}
function tickMetrics(runs: Row[]) {
  const ticks = runs.filter(row => row.name === "reconcile");
  const starts = ticks.map(row => timestamp(row.startedAt)).filter((value): value is number => value !== null).sort((a, b) => a - b);
  const durations: number[] = [];
  const samples = ticks.map(row => {
    const start = timestamp(row.startedAt), finish = timestamp(row.finishedAt);
    const duration = start !== null && finish !== null && finish >= start ? known(finish - start) : unknown<number>("Missing/invalid start or finish timestamp (possibly still running)");
    if (duration.value !== null) durations.push(duration.value);
    return { run: row.dagRunId, startedAt: start === null ? unknown("Missing tick start") : known(new Date(start).toISOString()), durationMs: duration };
  });
  durations.sort((a, b) => a - b);
  let skipped = 0;
  const gaps = [];
  for (let i = 1; i < starts.length; i++) {
    const gap = starts[i]! - starts[i - 1]!;
    // Nearest schedule slot avoids counting subsecond scheduler jitter as a skipped minute.
    const count = Math.max(0, Math.round(gap / 60000) - 1);
    if (count) { skipped += count; gaps.push({ from: new Date(starts[i - 1]!).toISOString(), to: new Date(starts[i]!).toISOString(), skipped: count }); }
  }
  return { scheduleIntervalMs: 60000, retainedRunsObserved: ticks.length, durationSamples: durations.length, samples,
    durationMs: durations.length ? known({ p50: quantile(durations, .5), p90: quantile(durations, .9), p95: quantile(durations, .95), p99: quantile(durations, .99) }) : unknown("No completed tick with both timestamps"),
    skipped: starts.length < 2 || starts.length !== ticks.length ? unknown("Need consecutive starts with no missing start timestamps") : known(skipped), gaps,
    inference: "round(start gap / 60 seconds) - 1, minimum zero; gaps can include scheduler downtime, not just overlap-policy skips; no inference before first/after last start" };
}
function runMetrics(runs: Row[], details: Map<string, Observation<Row>>, now: number) {
  const groups = new Map<string, { dag: unknown; step: Observation<string>; status: string; entries: Array<{ run: unknown; ageMs: Observation<number> }> }>();
  for (const run of runs) {
    if (!["waiting", "failed", "partially_succeeded"].includes(String(run.statusLabel).toLowerCase())) continue;
    const detail = details.get(runKey(run))!;
    const nodes = detail.value && Array.isArray(detail.value.nodes) ? detail.value.nodes.filter(isRecord) : null;
    const matching = nodes?.filter(node => ["waiting", "failed"].includes(String(node.statusLabel).toLowerCase()));
    const entries: Row[] = matching?.length ? matching : [{ statusLabel: run.statusLabel, missingStep: detail.reason ?? "No waiting/failed step in detail" }];
    for (const node of entries) {
      const status = String(node.statusLabel).toLowerCase();
      const step = isRecord(node.step) ? text(node.step.name, "step.name") : unknown<string>(String(node.missingStep ?? "Missing step definition"));
      // Waiting age is time since step start; failure age is time since step finish.
      const source = status === "failed" ? node.finishedAt : node.startedAt;
      const time = timestamp(source);
      const ageMs = time === null || time > now ? unknown<number>(`Missing/invalid ${status === "failed" ? "step.finishedAt" : "step.startedAt"}; age cannot be inferred from run age`) : known(now - time);
      const key = JSON.stringify([run.name, step.value, status]);
      const group = groups.get(key) ?? { dag: run.name, step, status, entries: [] };
      group.entries.push({ run: run.dagRunId, ageMs }); groups.set(key, group);
    }
  }
  return [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, group]) => {
    const ages = group.entries.map(entry => entry.ageMs.value).filter((v): v is number => v !== null).sort((a, b) => a - b);
    return { ...group, count: group.entries.length, ageBasis: group.status === "failed" ? "step.finishedAt" : "step.startedAt",
      ageMs: ages.length === group.entries.length ? known({ oldest: ages[ages.length - 1]!, median: quantile(ages, .5) }) : unknown("One or more step ages are unavailable; aggregate would be incomplete") };
  });
}
function runKey(row: Row): string { return JSON.stringify([row.workspace ?? "", row.name, row.dagRunId]); }
function leases(home: string, probe: typeof probeProcess) {
  const directory = join(stationCacheRoot(home), "leases");
  try {
    return known(readdirSync(directory).sort().map(name => {
      try {
        const lease: unknown = JSON.parse(readFileSync(join(directory, name), "utf8"));
        if (!isRecord(lease)) throw new Error("Lease must be an object");
        const pid = Number.isSafeInteger(lease.pid) && Number(lease.pid) > 0 ? known(Number(lease.pid)) : unknown<number>("Missing/invalid lease pid");
        const host = text(lease.host, "lease.host"), startedAt = text(lease.processStartedAt, "lease.processStartedAt");
        let liveness: Observation<string>;
        if (!pid.value || !host.value || !startedAt.value) liveness = unknown("Lease identity is incomplete");
        else {
          const result = probe(pid.value, startedAt.value);
          liveness = { value: result, reason: result === "unknown" ? "Local PID/start-time identity could not be read reliably" : null };
        }
        return { file: name, holder: text(lease.holder, "lease.holder"), host, pid, processStartedAt: startedAt, liveness };
      } catch (error) { return { file: name, holder: unknown(diagnostic(error)), host: unknown(diagnostic(error)), pid: unknown(diagnostic(error)), processStartedAt: unknown(diagnostic(error)), liveness: unknown(diagnostic(error)) }; }
    }));
  } catch (error) { return unknown(diagnostic(error)); }
}
function stateObservation(home: string) {
  const path = join(stationCacheRoot(home), "state.json");
  try {
    // Read contents and mtime from the SAME inode despite concurrent atomic replacement.
    const fd = openSync(path, "r");
    try {
      const info = fstatSync(fd), value: unknown = JSON.parse(readFileSync(fd, "utf8"));
      if (!info.isFile() || !isRecord(value) || value.schema !== 1 || !isRecord(value.current) || typeof value.current.version !== "string") throw new Error("Missing/unsupported station state current");
      return known({ current: value.current.version, mtime: info.mtime.toISOString() });
    } finally { closeSync(fd); }
  } catch (error) { return unknown<{ current: string; mtime: string }>(diagnostic(error)); }
}
const defaultGithub = (path: string): unknown => JSON.parse(github(["api", "--method", "GET", path]));

export async function stationHealth(options: HealthOptions, dependencies: HealthDependencies = {}) {
  const now = timestamp(options.now), from = timestamp(options.from ?? "1970-01-01T00:00:00Z");
  if (now === null || from === null || from > now) throw new Error("--now and --from require valid ordered ISO timestamps");
  const begin = new Date(from).toISOString(), end = new Date(now).toISOString();
  const range = { fromDate: String(Math.floor(from / 1000)), toDate: String(Math.floor(now / 1000) + 1) };
  const fetcher = dependencies.fetch ?? fetch, gh = dependencies.github ?? defaultGithub;
  async function get(path: string): Promise<unknown> {
    const response = await fetcher(`${options.url}/api/v1/${path}`, { method: "GET", redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Dagu GET ${path} HTTP ${response.status}`);
    return response.json();
  }
  let version: Observation<string>;
  try { const health = await get("health"); version = isRecord(health) ? text(health.version, "Dagu version") : unknown("Malformed Dagu health response"); }
  catch (error) { version = unknown(diagnostic(error)); }
  let history: Observation<Row[]>;
  try {
    const rows: Row[] = [], cursors = new Set<string>(), ids = new Set<string>();
    let cursor = "";
    for (;;) {
      const params = new URLSearchParams({ ...range, limit: "500" });
      if (cursor) params.set("cursor", cursor);
      const page = await get(`dag-runs?${params}`);
      if (!isRecord(page) || !Array.isArray(page.dagRuns)) throw new Error("Malformed Dagu history page");
      for (const row of page.dagRuns) {
        if (!isRecord(row) || typeof row.name !== "string" || typeof row.dagRunId !== "string" || typeof row.statusLabel !== "string") throw new Error("Malformed Dagu history row");
        const id = runKey(row);
        if (ids.has(id)) continue;
        ids.add(id); rows.push(row);
      }
      if (page.nextCursor === undefined) break;
      if (typeof page.nextCursor !== "string" || !page.nextCursor || cursors.has(page.nextCursor)) throw new Error("Repeated/invalid history cursor; partial metrics refused");
      cursors.add(page.nextCursor); cursor = page.nextCursor;
    }
    rows.sort((a, b) => runKey(a) < runKey(b) ? -1 : runKey(a) > runKey(b) ? 1 : 0);
    history = known(rows);
  } catch (error) { history = unknown(diagnostic(error)); }
  const details = new Map<string, Observation<Row>>(), promotions = new Map<string, Array<{ at: string; run: unknown }>>();
  const promotionErrors: string[] = [];
  for (const row of history.value ?? []) {
    const base = `dag-runs/${encodeURIComponent(String(row.name))}/${encodeURIComponent(String(row.dagRunId))}`;
    const workspace = typeof row.workspace === "string" ? { workspace: row.workspace } : {};
    if (["waiting", "failed", "partially_succeeded"].includes(row.statusLabel as string)) {
      try {
        const detail = await get(`${base}?${new URLSearchParams(workspace)}`);
        if (!isRecord(detail) || !isRecord(detail.dagRunDetails)) throw new Error("Malformed Dagu run detail");
        details.set(runKey(row), known(detail.dagRunDetails));
      } catch (error) { details.set(runKey(row), unknown(diagnostic(error))); }
    }
    if (row.name !== "reconcile") continue;
    try {
      // tick.ts emits promotion JSON on stdout line 2, before reconciliation. Never read arbitrary full logs.
      const log = await get(`${base}/steps/tick/log?${new URLSearchParams({ ...workspace, head: "4", limit: "4", ...range })}`);
      if (!isRecord(log) || typeof log.content !== "string") throw new Error("Missing tick stdout content");
      let report: Row | undefined;
      for (const line of log.content.split("\n")) {
        try { const parsed: unknown = JSON.parse(line); if (isRecord(parsed) && typeof parsed.promoted === "boolean" && isRecord(parsed.current)) { report = parsed; break; } } catch { /* Ordinary non-JSON tick header. */ }
      }
      if (!report) throw new Error("No promotion report in tick stdout head");
      if (report.promoted === true && isRecord(report.current) && typeof report.current.version === "string") {
        const at = timestamp(row.startedAt);
        if (at === null) throw new Error("Promoting tick has no start time");
        const values = promotions.get(report.current.version) ?? [];
        values.push({ at: new Date(at).toISOString(), run: row.dagRunId }); promotions.set(report.current.version, values);
      }
    } catch (error) { promotionErrors.push(`${row.dagRunId}: ${diagnostic(error)}`); }
  }
  const state = stateObservation(options.home);
  let releases: Observation<unknown[]>;
  try {
    const values: Row[] = [];
    for (let page = 1; ; page++) {
      const response = gh(`repos/${releaseRepository()}/releases?per_page=100&page=${page}`);
      if (!Array.isArray(response) || response.some(row => !isRecord(row))) throw new Error("Malformed GitHub releases");
      values.push(...response as Row[]);
      if (response.length < 100) break;
    }
    releases = known(values.filter(row => row.draft === false && row.prerelease === false && /^a4s-r\d+$/.test(String(row.tag_name))).sort((a, b) => Number(String(b.tag_name).slice(5)) - Number(String(a.tag_name).slice(5))).slice(0, 10).map(row => {
      const version = String(row.tag_name).slice(4), published = timestamp(row.created_at);
      const recorded = promotions.get(version)?.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0)[0];
      const active = recorded ? known(recorded.at) : state.value?.current === version ? known(state.value.mtime) : unknown<string>(`No retained promotion tick for release; ${state.reason ?? "not state.current"}`);
      const source = recorded ? known("promoting-tick-start") : state.value?.current === version ? known("state.json-mtime") : unknown<string>("No promotion timestamp source");
      const lag = published !== null && active.value !== null && Date.parse(active.value) >= published ? known(Date.parse(active.value) - published) : unknown<number>("Publish/active time missing or inconsistent; negative lag is not reported as zero");
      return { version, publishTime: published === null ? unknown("Missing GitHub release created_at (createdAt)") : known(new Date(published).toISOString()), activeTime: active,
        source, promotionRun: recorded ? known(recorded.run) : unknown("No recorded promoting tick"), lagMs: lag,
        precision: recorded ? "Tick start is a proxy, not an exact promotion instant" : "state.json mtime is an approximation: later state writes/rollback can change it" };
    }));
  } catch (error) { releases = unknown(diagnostic(error)); }
  let cpuMeasurement: Observation<string>;
  if (options.cpuMeasurement) cpuMeasurement = known(options.cpuMeasurement);
  else {
    try {
      const comments: Row[] = [];
      for (let page = 1; ; page++) {
        const response = gh(`repos/${releaseRepository()}/issues/786/comments?per_page=100&page=${page}`);
        if (!Array.isArray(response) || response.some(row => !isRecord(row))) throw new Error("Malformed #786 comments");
        comments.push(...response as Row[]); if (response.length < 100) break;
      }
      const latest = comments.filter(row => typeof row.body === "string" && row.body.includes("poc-verdict:") && /CPU-seconds|CPU-s|cpu_seconds/.test(row.body) && (timestamp(row.created_at) ?? Infinity) <= now).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
      cpuMeasurement = text(latest?.html_url, "#786 measured PoC comment; use --cpu-measurement to pin a different measurement");
    } catch (error) { cpuMeasurement = unknown(diagnostic(error)); }
  }
  return { schemaVersion: 1, now: end, window: { from: begin, to: end, source: "Dagu retained history; fixed epoch lower bound by default, explicit upper bound; optional --from narrows coverage" },
    daguVersion: version, cpuMeasurement: { issue: `https://github.com/${releaseRepository()}/issues/786`, reference: cpuMeasurement, measuredHere: false },
    tick: history.value ? known(tickMetrics(history.value)) : unknown(history.reason!),
    runs: history.value ? known(runMetrics(history.value, details, now)) : unknown(history.reason!),
    locks: (dependencies.locks ?? observeLocks)([join(stationCacheRoot(options.home), ".state.lock"), join(options.home, "a4s", "heavy-slot.lock")]),
    leases: leases(options.home, dependencies.probe ?? probeProcess), state,
    releases, promotionObservationErrors: promotionErrors,
    limitations: ["Read-only, non-atomic snapshot across Dagu, GitHub, procfs and station files", "No CPU measurement; GitHub createdAt is the requested publish-time proxy", "Recent releases means ten highest immutable a4s build IDs; unpromoted or pruned promotion history stays unknown"] };
}
