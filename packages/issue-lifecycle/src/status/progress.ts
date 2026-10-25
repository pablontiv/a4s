import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUNDLE_VERSION,
  bundleVersionFromLabels,
  classifyCompatibility,
  parseVersion,
} from "../bundle.ts";
import type { Compatibility } from "../bundle.ts";
import type { StallNotice } from "../long-computation.ts";

export interface RunDetails {
  name: string;
  dagRunId: string;
  statusLabel: string;
  labels?: string[];
  params?: string;
  resolvedPrimary?: string;
  nodes?: RunNode[];
  scopeFailureCause?: string;
  receiptEvent?: { id: string; type: string; source: string; cursorReset: boolean };
}

export interface RunNode {
  step: { id?: string; name: string; humanTask?: { prompt?: string } };
  statusLabel: string;
  approvalIteration?: number;
}

export const isActive = (run: RunDetails): boolean =>
  ["running", "queued", "waiting"].includes(run.statusLabel);

export const topicFor = (run: RunDetails): string => `dagrun:${run.name}/${run.dagRunId}`;

// Terminal control characters from Dagu data must remain plain widget text.
const plain = (text: string): string => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

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
  const literal = /^  - PRIMARY: (.+)$/m.exec(spec)?.[1];
  if (!literal) return undefined;
  const primary: unknown = JSON.parse(literal);
  return typeof primary === "string" ? primary : undefined;
}

export function issueNumber(run: RunDetails): string | undefined {
  const issue = runParam(run, "ISSUE");
  return issue && /^\d+$/.test(issue) ? issue : undefined;
}

const identity = (run: RunDetails, slug?: string): string => {
  const issue = issueNumber(run);
  return issue ? `#${issue}${slug ? ` ${slug}` : ""}` : plain(run.dagRunId);
};

export function runLabel(run: RunDetails, slug?: string): string {
  return `${plain(run.name)} ${identity(run, slug)}`;
}

// The widget title names the domain; each line keeps a compact workflow type.
const workflowTypes: Record<string, string> = { feature: "feat", planning: "plan" };

export function currentNode(run: RunDetails): RunNode | undefined {
  const nodes = run.nodes ?? [];
  // A waiting run can still contain parallel running nodes: show the blocking gate.
  const preferred = run.statusLabel === "waiting" ? "waiting" : "running";
  return nodes.find(node => node.statusLabel === preferred)
    ?? nodes.find(node => ["running", "waiting"].includes(node.statusLabel));
}

export function currentStep(run: RunDetails): string | undefined {
  return currentNode(run)?.step.name;
}
export function runBundleState(run: RunDetails): {
  version: string | undefined;
  displayVersion: string;
  extensionVersion: string;
  mainVersion: string;
  compat: Compatibility;
} {
  const version = bundleVersionFromLabels(run.labels);
  const primary = run.resolvedPrimary ?? runParam(run, "PRIMARY");
  let mainVersion = "unknown";
  let mainApplicable = true;
  if (primary) {
    try {
      const manifest: unknown = JSON.parse(readFileSync(join(primary, "packages/issue-lifecycle/package.json"), "utf8"));
      if (manifest && typeof manifest === "object" && "version" in manifest
        && typeof manifest.version === "string" && parseVersion(manifest.version)) {
        mainVersion = manifest.version;
      }
    } catch (error) {
      // An absent manifest marks a consumer repository; any other failure cannot establish exact version equality.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        mainApplicable = false;
        mainVersion = "n/a";
      }
    }
  }
  const compatibility = classifyCompatibility(version, BUNDLE_VERSION);
  return {
    version,
    displayVersion: version ?? "unstamped",
    extensionVersion: BUNDLE_VERSION,
    mainVersion,
    compat: primary && mainApplicable && mainVersion !== BUNDLE_VERSION ? "stale" : compatibility,
  };
}


const progress = (run: RunDetails): { done: number; total: number } => {
  const nodes = run.nodes ?? [];
  return { done: nodes.filter(node => ["succeeded", "skipped"].includes(node.statusLabel)).length, total: nodes.length };
};

const completion = (run: RunDetails): number => {
  const { done, total } = progress(run);
  return total ? done / total : 0;
};

export function renderRun(run: RunDetails, slug?: string, activity?: string): string {
  const { done, total } = progress(run);
  const filled = total ? Math.floor(done / total * 6) : 0;
  const bar = "▰".repeat(filled) + "▱".repeat(6 - filled);
  const step = currentStep(run);
  const type = plain(workflowTypes[run.name] ?? run.name);
  const status = `${type} ${identity(run, slug)} ${bar} ${done}/${total}${step ? ` ${plain(step)}` : ""} ${plain(run.statusLabel)}`;
  return activity ? `${status} · ${plain(activity)}` : status;
}

export interface WidgetRun {
  run: RunDetails;
  slug?: string;
  activity?: string;
}

/** Subset of OMP's theme used to draw the pinned HUD layout. */
export interface WidgetTheme {
  fg(color: "accent" | "dim", text: string): string;
  bold(text: string): string;
  tree: { branch: string; last: string };
}

export const TOGGLE_COMMAND = "workflows";
// Same fold as OMP's Subagents HUD: a few rows collapsed, an expander row to unfold.
const COLLAPSED_ROWS = 3;
// OMP paints at most 10 lines per extension widget: title, rows and expander.
const EXPANDED_ROWS = 8;

const title = (theme: WidgetTheme): string => theme.bold(theme.fg("accent", "Workflows"));

// Unindented title, then tree rows with dim connectors shifted right by one space.
const treeRows = (lines: string[], theme: WidgetTheme): string[] => lines.map((line, index) =>
  ` ${theme.fg("dim", index === lines.length - 1 ? theme.tree.last : theme.tree.branch)} ${line}`);

// Runs closest to finishing come first; equal completion keeps discovery order.
export function renderWidget(entries: WidgetRun[], theme: WidgetTheme, expanded = false): string[] | undefined {
  if (!entries.length) return undefined;
  const sorted = [...entries].sort((a, b) => completion(b.run) - completion(a.run));
  const shown = sorted.slice(0, expanded ? EXPANDED_ROWS : COLLAPSED_ROWS);
  const hidden = sorted.length - shown.length;
  const more = hidden ? `… ${hidden} more` : "…";
  const toggle = !expanded
    ? hidden ? `${more} — /${TOGGLE_COMMAND}` : undefined
    : sorted.length > COLLAPSED_ROWS ? `${more}${hidden ? " ·" : ""} show less — /${TOGGLE_COMMAND}` : undefined;
  return [
    title(theme),
    ...treeRows(shown.map(({ run, slug, activity }) => renderRun(run, slug, activity)), theme),
    ...(toggle ? [` ${theme.fg("dim", toggle)}`] : []),
  ];
}

export function renderOffline(theme: WidgetTheme, retrySeconds: number): string[] {
  return [title(theme), ...treeRows([`sin conexión · reintentando en ${retrySeconds}s`], theme)];
}

export interface Notification {
  message: string;
  type: "info" | "warning" | "error";
}

export interface TransitionEffects {
  notification?: Notification;
  wakeMessage?: string;
  wakeMessages?: string[];
  warningMessage?: string;
}

export interface CiDiagnostic {
  iteration: number;
  sha: string;
  class: string;
  check: string;
  log: string;
  cause: string;
  decisionRequest?: { id: string; observations: number };
}

interface State {
  status: string;
  step: string | undefined;
}

export class Transitions {
  private states = new Map<string, State>();
  private notices = new Set<string>();

  constructor(private readonly sessionId?: string) {}

  observe(run: RunDetails, options: { baseline?: boolean; slug?: string; checkpoints?: boolean; ciDiagnostic?: CiDiagnostic; escalationDiagnostic?: string; stalls?: StallNotice[] } = {}): TransitionEffects {
    const key = topicFor(run);
    const previous = this.states.get(key);
    const terminalStep = run.nodes?.find(node => node.statusLabel === run.statusLabel)?.step.name;
    this.states.set(key, { status: run.statusLabel, step: currentStep(run) });
    const effects: TransitionEffects = {};
    const issue = issueNumber(run);
    const owned = this.sessionId !== undefined && runParam(run, "OMP_SESSION_ID") === this.sessionId;
    const supported = ["feature", "poc", "discovery", "planning"].includes(run.name);
    const bundle = runBundleState(run);
    const identity = issue ? ` issue=${issue}` : ` dag=${plain(run.name)}`;
    const bundleNotice = ` bundle=${plain(bundle.displayVersion)} extension=${bundle.extensionVersion} main=${plain(bundle.mainVersion)} compat=${bundle.compat}`;
    const messages: string[] = [];
    const notice = (id: string, text: string): void => {
      if (this.notices.has(id)) return;
      this.notices.add(id);
      if (!options.baseline && owned && supported) messages.push(text);
    };
    for (const stall of options.stalls ?? []) {
      if (runParam(run, "OMP_SESSION_ID") !== stall.session) continue;
      const last = stall.progress.lastShard;
      const range = last ? `${last.range.start}-${last.range.end}` : "none";
      notice(JSON.stringify([key, "stall", stall.notifiedAt]),
        `[DAGU STALL] run=${plain(run.dagRunId)}${identity}${bundleNotice} session=${plain(stall.session)} computation=${plain(stall.computation)} completed=${stall.progress.completed}/${stall.progress.total} lastShard=${last ? String(last.index) : "none"} range=${range} completedAt=${plain(last?.completedAt ?? "none")} directory=${plain(stall.directory)} options=continue; resize; stop. Completed shards are preserved.`);
    }
    if (options.checkpoints !== false) {
      const ci = options.ciDiagnostic;
      if (ci?.class === "BLOCKED" && ci.decisionRequest && run.nodes?.some(node =>
        node.statusLabel === "waiting" && ["await_ci", "await_merge"].includes(node.step.id ?? node.step.name)
        && (node.approvalIteration ?? 0) === ci.iteration)) {
        notice(JSON.stringify([key, "ci-decision", ci.decisionRequest.id]),
          `[DAGU DECISION] run=${plain(run.dagRunId)}${identity}${bundleNotice} iteration=${ci.iteration} sha=${plain(ci.sha)}`
          + ` ci=BLOCKED check=${plain(ci.check)} cause=${plain(ci.cause)} logs=${plain(ci.log)} observations=${ci.decisionRequest.observations}`
          + " options=continue with a renewed budget; change scope or delivery route; stop. Reconciler retains transition ownership.");
      }
      for (const node of run.nodes ?? []) {
        if (!node.step.humanTask || node.statusLabel !== "waiting") continue;
        const step = node.step.id ?? node.step.name;
        const iteration = node.approvalIteration ?? 0;
        const ci = options.ciDiagnostic;
        const returned = step === "implement" && ci?.class === "CODE_FAIL" && ci.iteration + 1 === iteration;
        const diagnosed = ["await_ci", "await_merge"].includes(step) && ci?.class === "BLOCKED" && ci.iteration === iteration;
        const ciCause = returned || diagnosed
          ? ` ci=${plain(ci!.class)} sha=${plain(ci!.sha)} check=${plain(ci!.check)} cause=${plain(ci!.cause)} logs=${plain(ci!.log)}` : "";
        const causeText = (step.endsWith("_primary_unavailable") || step.startsWith("recover_")) ? node.step.humanTask.prompt
          : run.name === "poc" && step === "run_poc" && iteration > 0 ? run.scopeFailureCause : undefined;
        const escalation = ["escalation", "rebase_escalation"].includes(step) ? options.escalationDiagnostic : undefined;
        const cause = escalation ? ` ${plain(escalation)}` : causeText ? ` cause=${plain(causeText)}` : ciCause;
        const validation = run.name === "feature" && step === "validation";
        const prompt = node.step.humanTask.prompt ?? "";
        const sha = prompt.match(/Tested SHA: ([a-f0-9]{40})\b/)?.[1];
        const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
        const validationNotice = validation
          ? ` repo=${plain(run.labels?.find(label => label.startsWith("workspace="))?.slice(10) ?? run.resolvedPrimary ?? runParam(run, "PRIMARY") ?? "unknown")}\n${prompt}\n`
            + `Approve: dagu human-task complete feature --run-id ${quote(run.dagRunId)} --step validation --input APPROVED=yes --input TESTED_SHA=${quote(sha ?? "<tested-sha unavailable; inspect dagu status>")}\n`
            + `Push back: dagu human-task push-back feature --run-id ${quote(run.dagRunId)} --step validation --expected-iteration ${iteration} --input REASON='<operator reason>'`
          : "";
        const noticeKey = diagnosed ? [key, step, "ci", ci!.sha, iteration, ci!.cause]
          : [key, step, iteration, ...(escalation ? [escalation] : [])];
        notice(JSON.stringify(noticeKey),
          `[DAGU STATE] run=${plain(run.dagRunId)} status=waiting step=${plain(step)}${identity}${bundleNotice} iteration=${iteration}${cause}${validationNotice}`);
      }
      if (run.statusLabel === "succeeded") {
        notice(JSON.stringify([key, "succeeded"]),
          `[DAGU STATE] run=${plain(run.dagRunId)} status=succeeded${identity}${bundleNotice}`);
      }
    }
    if (previous && previous.status !== run.statusLabel
      && ["succeeded", "failed", "aborted"].includes(run.statusLabel)) {
      effects.notification = {
        message: `dagu · ${runLabel(run, options.slug)} ${run.statusLabel}`,
        type: run.statusLabel === "succeeded" ? "info" : run.statusLabel === "failed" ? "error" : "warning",
      };
      const step = terminalStep ?? previous.step;
      if (run.statusLabel !== "succeeded" && step && owned
        && ["feature", "discovery", "planning"].includes(run.name)) {
        notice(JSON.stringify([key, run.statusLabel]),
          `[DAGU STATE] run=${plain(run.dagRunId)} status=${run.statusLabel} step=${plain(step)}${identity}${bundleNotice}`);
      }
    }
    if (messages.length === 1) effects.wakeMessage = messages[0]!;
    else if (messages.length) effects.wakeMessages = messages;
    if (messages.length && bundle.compat === "stale") {
      effects.warningMessage = "Restart OMP to load the adopted @a4s/issue-lifecycle modules, then run its bootstrap (dagu-feature-bootstrap.yaml) and adopt freshly generated stamped renders.";
    }
    return effects;
  }
}
