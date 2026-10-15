export interface RunDetails {
  name: string;
  dagRunId: string;
  statusLabel: string;
  labels?: string[];
  params?: string;
  nodes?: { step: { name: string }; statusLabel: string }[];
}

export const isActive = (run: RunDetails): boolean =>
  ["running", "queued", "waiting"].includes(run.statusLabel);

export const topicFor = (run: RunDetails): string => `dagrun:${run.name}/${run.dagRunId}`;

// Terminal control characters from DAG names/params must remain plain widget text.
const plain = (text: string): string => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

export function runLabel(run: RunDetails): string {
  const issue = run.params?.match(/(?:^|[\s"{,])ISSUE(?:["']?\s*[:=]\s*["']?)(\d+)(?=$|[\s"'},])/);
  return issue ? `#${issue[1]}` : plain(run.dagRunId);
}

export function currentStep(run: RunDetails): string | undefined {
  const nodes = run.nodes ?? [];
  // A waiting run can still contain parallel running nodes: show the blocking gate.
  const preferred = run.statusLabel === "waiting" ? "waiting" : "running";
  return (nodes.find(node => node.statusLabel === preferred)
    ?? nodes.find(node => ["running", "waiting"].includes(node.statusLabel)))?.step.name;
}

export function renderRun(run: RunDetails): string {
  const nodes = run.nodes ?? [];
  const done = nodes.filter(node => ["succeeded", "skipped"].includes(node.statusLabel)).length;
  const filled = nodes.length ? Math.floor(done / nodes.length * 6) : 0;
  const bar = "▰".repeat(filled) + "▱".repeat(6 - filled);
  const step = currentStep(run);
  return `dagu · ${runLabel(run)} ${bar} ${done}/${nodes.length}${step ? ` ${plain(step)}` : ""} ${plain(run.statusLabel)}`;
}

export interface Notification {
  message: string;
  type: "info" | "warning" | "error";
}

export class Transitions {
  private states = new Map<string, { status: string; step: string | undefined }>();

  observe(run: RunDetails): Notification | undefined {
    const key = topicFor(run);
    const step = currentStep(run);
    const previous = this.states.get(key);
    this.states.set(key, { status: run.statusLabel, step });
    // The first snapshot establishes a baseline, including already-terminal runs.
    // A REST summary can omit nodes: filling in its initial waiting step is not
    // a transition, but a later change between known waiting steps is.
    if (!previous || (previous.status === run.statusLabel
      && (run.statusLabel !== "waiting" || previous.step === undefined || previous.step === step))) return;
    if (run.statusLabel === "waiting") {
      return { message: `dagu · ${runLabel(run)} waiting · ${plain(step ?? "sin paso")}`, type: "warning" };
    }
    if (["succeeded", "failed", "aborted"].includes(run.statusLabel)) {
      return {
        message: `dagu · ${runLabel(run)} ${run.statusLabel}`,
        type: run.statusLabel === "succeeded" ? "info" : run.statusLabel === "failed" ? "error" : "warning",
      };
    }
  }
}
