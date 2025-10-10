import { stripVTControlCharacters } from "node:util";
import { isActive, renderRun, topicFor } from "./progress.ts";
import type { WidgetRun, WidgetTheme } from "./progress.ts";

/** Structural host boundary: no runtime dependency on the extension's TUI version. */
export interface NativeNode {
  k: string;
  p?: Record<string, unknown> | undefined;
  c?: NativeNode[] | undefined;
  key?: string | undefined;
}
export interface WidgetComponent {
  render(width: number): readonly string[];
  invalidate?(): void;
  describe(cx?: unknown): NativeNode;
  handleNativeEvent(event: { type: string; key: string; collapsed?: boolean }): void;
}
export type WidgetFactory = (tui: unknown, theme: unknown) => WidgetComponent;
export type WidgetContent = string[] | WidgetFactory | undefined;
export interface WidgetUI {
  readonly theme: WidgetTheme;
  setWidget(key: string, content: WidgetContent, options?: { placement: "aboveEditor" }): void;
}
export interface WidgetView {
  expanded: boolean;
  hidden: boolean;
  render?: () => void;
}
interface Presentation {
  entries: WidgetRun[];
  expanded: boolean;
  retrySeconds?: number;
  slow: boolean;
  now: number;
}

type HostObject = Record<string, unknown>;
type HostLayout = { render(width: number): readonly string[]; invalidate?(): void };
const object = (value: unknown): HostObject | undefined =>
  value !== null && typeof value === "object" ? value as HostObject : undefined;

function sourceText(value: HostObject): string | undefined {
  const own = Object.getOwnPropertyDescriptor(value, "text");
  if (typeof own?.value === "string") return own.value;
  if (typeof value.getText === "function") {
    const text: unknown = value.getText();
    if (typeof text === "string") return text;
  }
  return undefined;
}

/**
 * Capability observed on OMP 18.14.1, not a public constructor contract. Keep the
 * actual mounted array-path container, including its host-created cap template.
 * Never guess padding, wrapping, ANSI reset sequences, or a host line limit.
 */
function mountedLayout(tui: unknown, source: readonly string[]): HostLayout | undefined {
  const root = object(tui);
  if (!root || !Array.isArray(root.children) || !source.length) return undefined;
  const stack = [root];
  const seen = new Set<HostObject>();
  let best: HostLayout | undefined;
  let longest = 0;
  let ambiguous = false;
  while (stack.length) {
    const value = stack.pop()!;
    if (seen.has(value)) continue;
    seen.add(value);
    if (!Array.isArray(value.children)) continue;
    const children = value.children.map(object);
    if (typeof value.render === "function" && children.length && children.every(child => child
      && typeof child.render === "function" && (!Array.isArray(child.children) || !child.children.length))) {
      let prefix = 0;
      while (prefix < Math.min(children.length, source.length)
        && sourceText(children[prefix]!) === source[prefix]) prefix++;
      if (prefix > longest) {
        best = value as HostObject & HostLayout;
        longest = prefix;
        ambiguous = false;
      } else if (prefix && prefix === longest) ambiguous = true;
    }
    for (const child of children) if (child) stack.push(child);
  }
  return ambiguous ? undefined : best;
}

const node = (k: string, p?: Record<string, unknown>, c?: NativeNode[], key?: string): NativeNode => ({ k, p, c, key });

function elapsed(startedAt: string | undefined, now: number): string {
  const start = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(start)) return "—";
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}

function describe(presentation: Presentation): NativeNode {
  const { entries, expanded, retrySeconds, slow, now } = presentation;
  const active = entries.filter(({ run }) => isActive(run));
  const running = active.filter(({ run }) => run.statusLabel === "running").length;
  const waiting = active.filter(({ run }) => run.statusLabel === "waiting").length;
  const queued = active.length - running - waiting;
  const offline = retrySeconds !== undefined && !slow;
  const state = [running && `${running} running`, waiting && `${waiting} waiting`, queued && `${queued} queued`]
    .filter(Boolean).join(" · ");
  const retry = retrySeconds === undefined ? undefined
    : `${slow ? "lento" : "sin conexión"} · reintentando en ${retrySeconds}s`;
  const tone = offline ? "error" : retry || waiting ? "warning" : "accent";
  return node("card", {
    role: "a4s.widget.workflows", collapsible: true, collapsed: !expanded, preview: { lines: 3 },
    status: offline ? "error" : slow || waiting ? "pending" : running ? "running" : "pending", tone,
    head: [{ t: "\uf126", s: "icon accent" }, { t: "Workflows", s: "strong" },
      { t: ` · ${active.length} active`, s: "num" },
      { t: offline ? "\uf12a" : running ? "\uf110" : "\uf04c", s: `icon ${tone}` },
      { t: retry ?? state, s: tone }],
    ...(retry ? { title: retry } : {}),
  }, [node("col", { gap: "xs" }, active.map(({ run, slug, activity }) => node("row", {
    role: "a4s.widget.workflows.run", gap: "sm", align: "center",
  }, [run.statusLabel === "running"
    ? node("spinner", { style: "dots", label: "running" }, undefined, "state")
    : node("icon", { name: run.statusLabel === "waiting" ? "pause" : "clock", tone: "warning", aria: run.statusLabel }, undefined, "state"),
  node("text", { text: stripVTControlCharacters(renderRun(run, slug, activity)), wrap: "none", truncate: "end", grow: 1 }, undefined, "text"),
  node("text", { text: elapsed(run.startedAt, now), tone: "muted" }, undefined, "elapsed"),
  ], topicFor(run))), "runs")]);
}

class UnsupportedLayout extends Error {}

/** One presenter per observer; source changes must remount the array seed. */
export class WorkflowsWidget {
  private source: string[] | undefined;
  private layout: HostLayout | undefined;
  private unsupported = false;

  publish(ui: WidgetUI, lines: string[] | undefined, presentation: Presentation, view: WidgetView): void {
    if (!lines?.length || view.hidden) {
      this.source = undefined;
      this.layout = undefined;
      ui.setWidget("dagu-status", undefined);
      return;
    }
    const sameSource = this.source?.length === lines.length && lines.every((line, index) => line === this.source![index]);
    const options = { placement: "aboveEditor" as const };
    if (this.unsupported) {
      ui.setWidget("dagu-status", lines, options);
      return;
    }
    // This seed is also the SINGLE string[] fallback in RPC. Never emit a second
    // copy just because RPC intentionally does not invoke the factory.
    const seeded = !sameSource || !this.layout;
    if (seeded) {
      this.layout = undefined;
      this.source = [...lines];
      ui.setWidget("dagu-status", lines, options);
    }
    let invoked = false;
    let unavailable = false;
    const factory: WidgetFactory = tui => {
      invoked = true;
      const layout = this.layout ?? mountedLayout(tui, lines);
      if (!layout) {
        unavailable = true;
        throw new UnsupportedLayout("Workflows: mounted host array layout is unavailable or ambiguous");
      }
      this.layout = layout;
      let described: NativeNode | undefined;
      return {
        render: width => layout.render(width),
        invalidate: () => layout.invalidate?.(),
        describe: () => described ??= describe(presentation),
        handleNativeEvent: event => {
          if (event.type !== "toggle" || event.key !== "" || view.hidden) return;
          view.expanded = typeof event.collapsed === "boolean" ? !event.collapsed : !view.expanded;
          view.render?.();
        },
      };
    };
    try { ui.setWidget("dagu-status", factory, options); }
    catch (error) { if (!(error instanceof UnsupportedLayout)) throw error; }
    if (unavailable) {
      // Unsupported hosts retain their original array path, never approximate
      // terminal output. Probe only once per observer to avoid repeated errors.
      this.unsupported = true;
      this.layout = undefined;
      ui.setWidget("dagu-status", lines, options);
    } else if (!invoked && !seeded) ui.setWidget("dagu-status", lines, options);
  }
}
