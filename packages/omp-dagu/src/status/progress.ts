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
  step: { id?: string; name: string };
  statusLabel: string;
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

export function runLabel(run: RunDetails, slug?: string): string {
  const issue = issueNumber(run);
  const identity = issue ? `#${issue}${slug ? ` ${slug}` : ""}` : plain(run.dagRunId);
  return `${plain(run.name)} ${identity}`;
}

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
  compat: Compatibility;
} {
  const version = bundleVersionFromLabels(run.labels);
  return {
    version,
    displayVersion: version ?? "unstamped",
    extensionVersion: BUNDLE_VERSION,
    compat: classifyCompatibility(version, BUNDLE_VERSION),
  };
}


export function renderRun(run: RunDetails, slug?: string, activity?: string): string {
  const nodes = run.nodes ?? [];
  const done = nodes.filter(node => ["succeeded", "skipped"].includes(node.statusLabel)).length;
  const filled = nodes.length ? Math.floor(done / nodes.length * 6) : 0;
  const bar = "▰".repeat(filled) + "▱".repeat(6 - filled);
  const step = currentStep(run);
  const bundle = runBundleState(run);
  const compatibility = bundle.compat === "ok"
    ? ""
    : ` · bundle=${plain(bundle.displayVersion)} extension=${bundle.extensionVersion} compat=${bundle.compat}`;
  const status = `dagu · ${runLabel(run, slug)} ${bar} ${done}/${nodes.length}${step ? ` ${plain(step)}` : ""} ${plain(run.statusLabel)}${compatibility}`;
  return activity ? `${status} · ${plain(activity)}` : status;
}

export interface Notification {
  message: string;
  type: "info" | "warning" | "error";
}

export interface TransitionEffects {
  notification?: Notification;
  wakeMessage?: string;
}

interface State {
  status: string;
  step: string | undefined;
  silentUnresolvedWaiting: boolean;
}

export class Transitions {
  private states = new Map<string, State>();

  constructor(private readonly sessionId?: string) {}

  observe(run: RunDetails, options: { baseline?: boolean; slug?: string } = {}): TransitionEffects {
    const key = topicFor(run);
    const activeStep = currentStep(run);
    const terminalStep = ["failed", "aborted"].includes(run.statusLabel)
      ? run.nodes?.find(node => node.statusLabel === run.statusLabel)?.step.name
      : undefined;
    const step = terminalStep ?? activeStep;
    const previous = this.states.get(key);
    const baseline = options.baseline === true;
    const suppressResolvedBaseline = previous?.silentUnresolvedWaiting === true
      && previous.status === "waiting" && previous.step === undefined && step !== undefined;
    this.states.set(key, {
      status: run.statusLabel,
      step,
      silentUnresolvedWaiting: baseline && run.statusLabel === "waiting" && step === undefined,
    });

    const firstAfterStartup = !previous && !baseline;
    const enteredWaiting = run.statusLabel === "waiting" && (
      firstAfterStartup
      || (previous !== undefined && !suppressResolvedBaseline
        && (previous.status !== "waiting" || previous.step !== step))
    );
    const effects: TransitionEffects = {};
    const issue = issueNumber(run);
    const targeted = this.sessionId !== undefined && run.name === "feature" && issue !== undefined
      && runParam(run, "OMP_SESSION_ID") === this.sessionId;
    const bundle = runBundleState(run);
    const bundleNotice = ` bundle=${plain(bundle.displayVersion)} extension=${bundle.extensionVersion} compat=${bundle.compat}`;

    if (enteredWaiting) {
      if (targeted && (step === "triage" || step === "implement")) {
        effects.wakeMessage = `[DAGU STATE] run=${plain(run.dagRunId)} status=waiting step=${step} issue=${issue}${bundleNotice}`;
      }
      return effects;
    }

    if (previous && previous.status !== run.statusLabel
      && ["succeeded", "failed", "aborted"].includes(run.statusLabel)) {
      effects.notification = {
        message: `dagu · ${runLabel(run, options.slug)} ${run.statusLabel}`,
        type: run.statusLabel === "succeeded" ? "info" : run.statusLabel === "failed" ? "error" : "warning",
      };
      const noticeStep = terminalStep ?? previous.step;
      if (targeted && (run.statusLabel === "failed" || run.statusLabel === "aborted") && noticeStep) {
        effects.wakeMessage = `[DAGU STATE] run=${plain(run.dagRunId)} status=${run.statusLabel} step=${plain(noticeStep)} issue=${issue}${bundleNotice}`;
      }
    }
    return effects;
  }
}
