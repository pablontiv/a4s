import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUNDLE_VERSION,
  bundleVersionFromLabels,
  classifyCompatibility,
} from "../bundle.ts";
import type { Compatibility } from "../bundle.ts";

export interface RunDetails {
  name: string;
  dagRunId: string;
  statusLabel: string;
  labels?: string[];
  params?: string;
  nodes?: RunNode[];
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
  return run.params?.match(new RegExp(
    `(?:^|[\\s"{,])${escaped}(?:["']?\\s*[:=]\\s*["']?)([^\\s"',}]+)(?=$|[\\s"',}])`,
  ))?.[1];
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
const workflowTypes: Record<string, string> = { feature: "feat" };

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
  const primary = runParam(run, "PRIMARY");
  let mainVersion = "unknown";
  if (primary) {
    try {
      const manifest: unknown = JSON.parse(readFileSync(join(primary, "packages/omp-dagu/package.json"), "utf8"));
      if (manifest && typeof manifest === "object" && "version" in manifest && typeof manifest.version === "string") {
        mainVersion = manifest.version;
      }
    } catch { /* An unreadable primary cannot establish exact version equality. */ }
  }
  const compatibility = classifyCompatibility(version, BUNDLE_VERSION);
  return {
    version,
    displayVersion: version ?? "unstamped",
    extensionVersion: BUNDLE_VERSION,
    mainVersion,
    compat: primary && (version !== BUNDLE_VERSION || mainVersion !== BUNDLE_VERSION) ? "stale" : compatibility,
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
  abortMessage?: string;
}

interface State {
  status: string;
  step: string | undefined;
}

export class Transitions {
  private states = new Map<string, State>();
  private notices = new Set<string>();

  constructor(private readonly sessionId?: string) {}

  observe(run: RunDetails, options: { baseline?: boolean; slug?: string; checkpoints?: boolean } = {}): TransitionEffects {
    const key = topicFor(run);
    const previous = this.states.get(key);
    const terminalStep = run.nodes?.find(node => node.statusLabel === run.statusLabel)?.step.name;
    this.states.set(key, { status: run.statusLabel, step: currentStep(run) });
    const effects: TransitionEffects = {};
    const issue = issueNumber(run);
    const owned = this.sessionId !== undefined && runParam(run, "OMP_SESSION_ID") === this.sessionId;
    const supported = ["feature", "poc", "discovery"].includes(run.name);
    const bundle = runBundleState(run);
    const identity = issue ? ` issue=${issue}` : ` dag=${plain(run.name)}`;
    const bundleNotice = ` bundle=${plain(bundle.displayVersion)} extension=${bundle.extensionVersion} main=${plain(bundle.mainVersion)} compat=${bundle.compat}`;
    const messages: string[] = [];
    const notice = (id: string, text: string): void => {
      if (this.notices.has(id)) return;
      this.notices.add(id);
      if (!options.baseline && owned && supported) messages.push(text);
    };
    if (options.checkpoints !== false) {
      for (const node of run.nodes ?? []) {
        if (!node.step.humanTask || node.statusLabel !== "waiting") continue;
        const step = node.step.id ?? node.step.name;
        const iteration = node.approvalIteration ?? 0;
        const cause = (step.endsWith("_primary_unavailable") || step.startsWith("recover_")) && node.step.humanTask.prompt
          ? ` cause=${plain(node.step.humanTask.prompt)}` : "";
        notice(JSON.stringify([key, step, iteration]),
          `[DAGU STATE] run=${plain(run.dagRunId)} status=waiting step=${plain(step)}${identity}${bundleNotice} iteration=${iteration}${cause}`);
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
        && ["feature", "discovery"].includes(run.name)) {
        notice(JSON.stringify([key, run.statusLabel]),
          `[DAGU STATE] run=${plain(run.dagRunId)} status=${run.statusLabel} step=${plain(step)}${identity}${bundleNotice}`);
      }
    }
    if (messages.length === 1) effects.wakeMessage = messages[0]!;
    else if (messages.length) effects.wakeMessages = messages;
    if (messages.length && bundle.compat === "stale") {
      effects.abortMessage = "Restart the OMP session to load main, then run the bootstrap re-seal (dagu-feature-bootstrap.yaml) and adopt its stamped renders before resuming.";
    }
    return effects;
  }
}
