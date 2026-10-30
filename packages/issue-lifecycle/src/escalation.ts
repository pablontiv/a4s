import { readServiceEnvironment } from "../../launcher/src/service-environment.ts";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { writeAtomicJson } from "./atomic-json.ts";
import { withFileLockAsync } from "../../launcher/src/file-lock.ts";
import { receiptArtifact } from "./artifact-receipt.ts";
import { isRecord } from "../../launcher/src/type-guard.ts";

interface Finding {
  event: string; kind: string; iteration: number; fingerprint: string; text: string; evidence: string; at: string;
}
interface Trigger {
  id: string; reasons: string[]; iteration: number; sha: string; elapsedSeconds: number;
  spend: { state: string; cause: string }; latestFindings: Finding[]; ownerSession: string; at: string; options: string[];
}
interface Decision {
  action: string; iteration: number; at: string; request: string; reason: string;
  provenance: { mechanism: string; run: string; iteration: number; ownerSession: string; nativeAudit: unknown; attributedTo: string };
}
interface EscalationState {
  schemaVersion: 1; run: string; admittedAt: string; windowStartedAt: string; windowIteration: number;
  iteration: number; findings: Finding[]; trigger: Trigger | null; decisions: Decision[]; sha?: string; stopped?: boolean;
}
function positive(name: string, fallback: string): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be positive`);
  return value;
}

export async function main(args: string[]): Promise<void> {
  const [action, kind, evidence] = args;
  const run = process.env.RUN ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(run)) throw new Error("Invalid run identity");
  const common = execFileSync("git", ["-C", process.env.PRIMARY ?? "", "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
  const root = join(common, "dagu-feature", "runs", run);
  const receipt = join(root, "receipt.json");
  const { receipt: value } = await receiptArtifact(readServiceEnvironment().DAGU_HOME, receipt);
  if (!isRecord(value.initial) || typeof value.initial.admittedAt !== "string") throw new Error("Invalid admission receipt initial.admittedAt");
  let admitted = value.initial.admittedAt;
  await withFileLockAsync(join(root, "escalation.lock"), async () => {
    const rawIteration = process.env.DAG_PUSHBACK_ITERATION ?? "0";
    const iteration = Number(rawIteration);
    if (!/^[+]?\d+$/.test(rawIteration.trim()) || !Number.isInteger(iteration) || iteration < 0) throw new Error("Invalid native push-back iteration");
    const path = join(root, "escalation.json");
    const now = new Date().toISOString();
    admitted ||= now;
    const state: EscalationState = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {
      schemaVersion: 1, run, admittedAt: admitted, windowStartedAt: admitted, windowIteration: 0,
      iteration, findings: [], trigger: null, decisions: [],
    };
    if (iteration < state.iteration) throw new Error("Native iteration moved backwards");
    state.iteration = iteration;
    if (state.stopped) { process.exitCode = 77; return; }
    const candidate = join(root, "candidate.json");
    if (existsSync(candidate)) state.sha = JSON.parse(readFileSync(candidate, "utf8")).sha;
    else state.sha ??= "unavailable";
    const started = Date.parse(state.windowStartedAt);
    if (!Number.isFinite(started)) throw new Error("Invalid escalation window timestamp");
    const elapsed = Math.max(0, Math.trunc((Date.now() - started) / 1000));
    if (action === "finding") {
      if (!kind || !evidence) throw new Error("escalation finding requires a kind and evidence path");
      let text = readFileSync(evidence, "utf8");
      if (kind === "conflict") text = [...new Set(text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/).filter((line, index, lines) => index !== lines.length - 1 || line !== ""))].sort().join("\n");
      const fingerprint = createHash("sha256").update(`${kind}:${text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/gu, " ").trim().toLowerCase()}`).digest("hex");
      const event = `${kind}:${iteration}`;
      if (!state.findings.some(finding => finding.event === event)) {
        let start = text.length;
        for (let remaining = 12000; start > 0 && remaining > 0; remaining--) {
          start--;
          const unit = text.charCodeAt(start);
          if (start > 0 && unit >= 0xdc00 && unit <= 0xdfff && text.charCodeAt(start - 1) >= 0xd800 && text.charCodeAt(start - 1) <= 0xdbff) start--;
        }
        state.findings.push({ event, kind, iteration, fingerprint, text: text.slice(start), evidence: normalize(evidence), at: now });
      }
    } else if (action === "decision" || action === "route") {
      const trigger = state.trigger;
      let decision: string;
      let nativeAudit: unknown = null;
      if (action === "route") {
        if (!trigger || iteration <= trigger.iteration) return;
        decision = "change-route";
        const base = readServiceEnvironment().DAGU_URL;
        const response = await fetch(`${base}/api/v1/dag-runs/feature/${encodeURIComponent(run)}`, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error(`Dagu run details: HTTP ${response.status}`);
        const details = await response.json() as { dagRunDetails: { nodes?: { pushBackHistory?: { iteration?: number }[] }[] } };
        nativeAudit = details.dagRunDetails.nodes?.flatMap(node => node.pushBackHistory ?? []).find(event => event.iteration === iteration) ?? null;
      } else {
        decision = process.env.ACTION ?? "";
        if (decision !== "continue" && decision !== "stop") throw new Error("Invalid escalation decision");
        if (!process.env.REASON?.trim() || !process.env.DECIDED_BY?.trim()) throw new Error("Escalation decision requires REASON and DECIDED_BY");
        if (!trigger) {
          if (state.decisions.some(item => item.iteration === iteration && item.action === decision)) return;
          throw new Error("No active escalation request");
        }
      }
      state.decisions.push({ action: decision, iteration, at: now, request: trigger!.id,
        reason: process.env.REASON ?? "Native escalation push-back to triage",
        provenance: { mechanism: `native-human-task-${action === "route" ? "push-back" : "complete"}`, run, iteration,
          ownerSession: process.env.OMP_SESSION_ID ?? "", nativeAudit,
          attributedTo: process.env.DECIDED_BY ?? "OS-attributed native push-back; identity not authenticated" } });
      if (decision === "stop") state.stopped = true;
      else Object.assign(state, { windowStartedAt: now, windowIteration: iteration, findings: [], trigger: null });
    } else if (action === "check") {
      const reasons: string[] = [];
      if (iteration - state.windowIteration >= positive("ESCALATION_PUSHBACKS", "3")) reasons.push("push-back budget exhausted");
      const counts = new Map<string, number>();
      for (const finding of state.findings) counts.set(finding.fingerprint, (counts.get(finding.fingerprint) ?? 0) + 1);
      if ([...counts.values()].some(count => count >= positive("ESCALATION_FINDINGS", "2"))) reasons.push("repeated finding fingerprint");
      if (elapsed >= positive("ESCALATION_SECONDS", "3600")) reasons.push("elapsed budget exhausted");
      if (reasons.length && !state.trigger) state.trigger = { id: createHash("sha256").update(`${run}:${iteration}:${state.windowStartedAt}`).digest("hex"), reasons,
        iteration, sha: state.sha!, elapsedSeconds: elapsed,
        spend: { state: "unknown", cause: "No authoritative run-wide cost receipt is available" }, latestFindings: state.findings.slice(-3),
        ownerSession: process.env.OMP_SESSION_ID ?? "", at: now, options: ["continue with renewed budget", "change scope or delivery route", "stop"] };
      const output = process.env.DAGU_OUTPUT_FILE;
      if (!output) throw new Error("DAGU_OUTPUT_FILE is required");
      appendFileSync(output, `ESCALATE=${state.trigger ? "yes" : "no"}\nREQUEST=${JSON.stringify(state.trigger)}\n`);
    } else throw new Error("Unknown escalation action");
    writeAtomicJson(path, state);
    console.log(JSON.stringify(state));
    if (state.stopped) process.exitCode = 77;
  });
}
