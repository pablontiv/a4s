import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  BUNDLE_VERSION,
  bundleVersionFromLabels,
  classifyCompatibility,
  isReleaseVersion,
} from "../bundle.ts";
import type { Compatibility } from "../bundle.ts";
import { packageRoot } from "../executable.ts";
import { WORKFLOWS_COMMAND } from "../registration.ts";
import type { StallNotice } from "../long-computation.ts";
import { runParam } from "../run-primary.ts";

export interface RunDetails {
  name: string;
  dagRunId: string;
  statusLabel: string;
  labels?: string[];
  params?: string;
  resolvedPrimary?: string;
  nodes?: RunNode[];
  scopeFailureCause?: string;
  artifactError?: string;
  receiptEvent?: { id: string; type: string; source: string; cursorReset: boolean };
}

export interface RunNode {
  step: { id?: string; name: string; humanTask?: { prompt?: string } };
  statusLabel: string;
  approvalIteration?: number;
  error?: string;
}

export const isActive = (run: RunDetails): boolean =>
  ["running", "queued", "waiting"].includes(run.statusLabel);

export const topicFor = (run: RunDetails): string => `dagrun:${run.name}/${run.dagRunId}`;

// Terminal control characters from Dagu data must remain plain widget text.
const plain = (text: string): string => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

// Dagu prefixes command failures with an exit status, then the captured stderr.
function failureCause(node: RunNode | undefined): string | undefined {
  const tail = node?.error?.split(/recent stderr \(tail\):\r?\n/)[1];
  const lines = tail?.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines?.find(line => line.startsWith("rule=")) ?? lines?.[0];
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
interface ReleaseIdentity {
  version: string;
  commit: string;
}

function readReleaseIdentity(root: string): ReleaseIdentity | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const identity = JSON.parse(readFileSync(join(root, "identity.json"), "utf8"));
    if (typeof manifest?.version !== "string" || !isReleaseVersion(manifest.version)
      || identity?.version !== manifest.version
      || typeof identity?.commit !== "string" || !/^[a-f0-9]{40}$/.test(identity.commit)) return undefined;
    return { version: manifest.version, commit: identity.commit };
  } catch {
    return undefined;
  }
}

// Capture this module generation's release identity once, never through the managed link.
const loadedIdentity = readReleaseIdentity(packageRoot);
const loadedCommit = loadedIdentity?.version === BUNDLE_VERSION ? loadedIdentity.commit : undefined;

// Re-read the selected registration at notice time, resolving both manifests from one root.
function installedBundleIdentity(): ReleaseIdentity | undefined {
  try {
    return readReleaseIdentity(realpathSync(join(homedir(), ".omp/plugins/node_modules/@a4s/issue-lifecycle")));
  } catch {
    // One-off package loading or an invalid registration has no known selected identity.
    return undefined;
  }
}

export function runBundleState(run: RunDetails, extensionVersion = BUNDLE_VERSION, extensionCommit = loadedCommit): {
  version: string | undefined;
  displayVersion: string;
  extensionVersion: string;
  installedVersion: string;
  restartPending: boolean;
  mainVersion: string;
  compat: Compatibility;
} {
  const version = bundleVersionFromLabels(run.labels);
  const primary = run.resolvedPrimary ?? runParam(run, "PRIMARY");
  let mainVersion = "unknown";
  if (primary) {
    try {
      const manifest: unknown = JSON.parse(readFileSync(join(primary, "packages/issue-lifecycle/package.json"), "utf8"));
      if (manifest && typeof manifest === "object" && "version" in manifest
        && typeof manifest.version === "string" && isReleaseVersion(manifest.version)) {
        mainVersion = manifest.version;
      }
    } catch (error) {
      // An absent manifest marks a consumer repository; other failures leave the source version unknown.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        mainVersion = "n/a";
      }
    }
  }
  const compatibility = classifyCompatibility(version, extensionVersion);
  const installed = installedBundleIdentity();
  const installedVersion = installed?.version ?? "unknown";
  const restartPending = installed !== undefined && extensionCommit !== undefined
    && (installed.version !== extensionVersion || installed.commit !== extensionCommit);
  return {
    version,
    displayVersion: version ?? "unstamped",
    extensionVersion,
    installedVersion,
    restartPending,
    mainVersion,
    compat: restartPending ? "stale" : compatibility,
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
  const compatibility = run.artifactError ? `${status} [unsupported: ${plain(run.artifactError)}]` : status;
  return activity ? `${compatibility} · ${plain(activity)}` : compatibility;
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

export const TOGGLE_COMMAND = WORKFLOWS_COMMAND.name;
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

  private readonly sessionId: string | undefined;
  private readonly extensionVersion: string;
  private readonly extensionCommit: string | undefined;
  constructor(sessionId?: string, extensionVersion = BUNDLE_VERSION, extensionCommit = loadedCommit) {
    this.sessionId = sessionId;
    this.extensionVersion = extensionVersion;
    this.extensionCommit = extensionCommit;
  }

  observe(run: RunDetails, options: {
    baseline?: boolean; slug?: string; checkpoints?: boolean; ciDiagnostic?: CiDiagnostic; escalationDiagnostic?: string;
    stalls?: StallNotice[];
    integrationProtection?: { protectedRun: string; issue: string; held: readonly string[]; recordedAt: string };
  } = {}): TransitionEffects {
    const key = topicFor(run);
    const previous = this.states.get(key);
    const terminalNode = run.nodes?.find(node => node.statusLabel === run.statusLabel);
    const terminalStep = terminalNode?.step.name;
    this.states.set(key, { status: run.statusLabel, step: currentStep(run) });
    const effects: TransitionEffects = {};
    const issue = issueNumber(run);
    const owned = this.sessionId !== undefined && runParam(run, "OMP_SESSION_ID") === this.sessionId;
    const supported = ["feature", "poc", "discovery", "planning"].includes(run.name);
    const bundle = runBundleState(run, this.extensionVersion, this.extensionCommit);
    const identity = issue ? ` issue=${issue}` : ` dag=${plain(run.name)}`;
    const bundleNotice = ` bundle=${plain(bundle.displayVersion)} extension=${bundle.extensionVersion} main=${plain(bundle.mainVersion)} compat=${bundle.compat} installed=${plain(bundle.installedVersion)}`;
    const messages: string[] = [];
    const notice = (id: string, text: string, durable = false): void => {
      if (this.notices.has(id)) return;
      this.notices.add(id);
      if ((durable || !options.baseline) && owned && supported) messages.push(text);
    };
    for (const stall of options.stalls ?? []) {
      if (runParam(run, "OMP_SESSION_ID") !== stall.session) continue;
      const last = stall.progress.lastShard;
      const range = last ? `${last.range.start}-${last.range.end}` : "none";
      notice(JSON.stringify([key, "stall", stall.notifiedAt]),
        `[DAGU STALL] run=${plain(run.dagRunId)}${identity}${bundleNotice} session=${plain(stall.session)} computation=${plain(stall.computation)} completed=${stall.progress.completed}/${stall.progress.total} lastShard=${last ? String(last.index) : "none"} range=${range} completedAt=${plain(last?.completedAt ?? "none")} directory=${plain(stall.directory)} options=continue; resize; stop. Completed shards are preserved.`);
    }
    if (options.checkpoints !== false) {
      const protection = options.integrationProtection;
      if (protection && owned && supported) {
        const held = protection.held.length ? protection.held.map(plain).join(",") : "none";
        notice(JSON.stringify(["integration-protection", protection.protectedRun, protection.recordedAt, held]),
          `[DAGU STATE] integration-protection protected_run=${plain(protection.protectedRun)} issue=${plain(protection.issue)} held=${held}`,
          true);
      }
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
        if (!["waiting", "running"].includes(run.statusLabel) || !node.step.humanTask || node.statusLabel !== "waiting") continue;
        const step = node.step.id ?? node.step.name;
        const iteration = node.approvalIteration ?? 0;
        const ci = options.ciDiagnostic;
        const returned = step === "implement" && ci?.class === "CODE_FAIL" && ci.iteration + 1 === iteration;
        const diagnosed = ["await_ci", "await_merge"].includes(step) && ["BLOCKED", "PENDING"].includes(ci?.class ?? "") && ci?.iteration === iteration;
        const ciCause = returned || diagnosed
          ? ` ci=${plain(ci!.class)}${ci!.class === "PENDING" ? " action=WAIT" : ""} sha=${plain(ci!.sha)} check=${plain(ci!.check)} cause=${plain(ci!.cause)} logs=${plain(ci!.log)}` : "";
        // mark_success retains the command error but reports a succeeded node.
        const failedNode = step.startsWith("recover_")
          ? run.nodes?.find(candidate => (candidate.step.id ?? candidate.step.name) === step.slice("recover_".length))
          : undefined;
        const causeText = step.startsWith("recover_") ? failureCause(failedNode)
          : step.endsWith("_primary_unavailable") ? node.step.humanTask.prompt
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
        const noticeKey = diagnosed ? [key, step, "ci", ci!.class, ci!.sha, iteration, ci!.cause]
          : [key, step, iteration, ...(escalation ? [escalation] : [])];
        notice(JSON.stringify(noticeKey),
          `[DAGU STATE] run=${plain(run.dagRunId)} status=waiting step=${plain(step)}${identity}${bundleNotice} iteration=${iteration}${cause}${validationNotice}`);
      }
      if (["succeeded", "failed", "aborted"].includes(run.statusLabel)) {
        const step = terminalStep ?? previous?.step;
        const cause = run.statusLabel === "failed" ? failureCause(terminalNode) : undefined;
        notice(JSON.stringify([key, run.statusLabel]),
          `[DAGU STATE] run=${plain(run.dagRunId)} status=${run.statusLabel}${run.statusLabel !== "succeeded" && step ? ` step=${plain(step)}` : ""}${identity}${bundleNotice}${cause ? ` cause=${plain(cause)}` : ""}`);
      }
    }
    if (previous && previous.status !== run.statusLabel
      && ["succeeded", "failed", "aborted"].includes(run.statusLabel)) {
      effects.notification = {
        message: `dagu · ${runLabel(run, options.slug)} ${run.statusLabel}`,
        type: run.statusLabel === "succeeded" ? "info" : run.statusLabel === "failed" ? "error" : "warning",
      };
    }
    if (messages.length === 1) effects.wakeMessage = messages[0]!;
    else if (messages.length) effects.wakeMessages = messages;
    if (messages.length && bundle.restartPending) {
      effects.warningMessage = "Restart OMP to load the selected @a4s/issue-lifecycle release. /reload-plugins does not switch an already-loaded package binding. In-flight runs keep their admitted snapshots.";
    }
    return effects;
  }
}
