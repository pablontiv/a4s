import assert from "node:assert/strict";
import test from "node:test";
import { renderOffline, renderWidget } from "../src/status/progress.ts";
import type { WidgetRun, WidgetTheme } from "../src/status/progress.ts";
import { WorkflowsWidget } from "../src/status/widget.ts";
import type { WidgetComponent, WidgetContent, WidgetView } from "../src/status/widget.ts";
import { WidgetHost } from "./fixtures/widget-host.ts";

const theme: WidgetTheme = {
  fg: (_color, text) => text, bold: text => text, tree: { branch: "├─", last: "└─" },
};
const now = Date.parse("2026-10-31T00:00:37Z");
const entries: WidgetRun[] = ["running", "waiting", "queued", "succeeded"].map((statusLabel, i) => ({
  run: { name: "feature", dagRunId: `run-${i}`, statusLabel, params: `ISSUE=${837 + i}`,
    startedAt: "2026-10-31T00:00:00Z", nodes: [{ step: { name: "implement" }, statusLabel }] },
  slug: "wide 界 👩‍💻 title", activity: "reading changes",
}));

for (const expanded of [false, true]) {
  for (const connection of ["online", "offline", "slow"]) {
    test(`native ${connection}, expanded=${expanded}: card state and cached run rows`, () => {
      const host = new WidgetHost();
      const widget = new WorkflowsWidget();
      const view: WidgetView = { expanded, hidden: false };
      const active = entries.slice(0, 3);
      const lines = connection === "offline" ? renderOffline(theme, 8) : renderWidget(active, theme, expanded)!;
      widget.publish({ theme, setWidget: host.setWidget }, lines, {
        entries, expanded, now, slow: connection === "slow", ...(connection === "online" ? {} : { retrySeconds: 8 }),
      }, view);
      const component = host.component!;
      assert.deepEqual(component.render(40), lines);
      const card = component.describe();
      assert.strictEqual(component.describe(), card, "repeated native frames reuse the described tree");
      assert.equal(card.k, "card");
      assert.equal(card.p!.role, "a4s.widget.workflows");
      assert.equal(card.p!.collapsible, true);
      assert.equal(card.p!.collapsed, !expanded);
      assert.deepEqual(card.p!.preview, { lines: 3 });
      assert.equal(card.p!.status, connection === "offline" ? "error" : "pending");
      assert.equal(card.p!.tone, connection === "offline" ? "error" : "warning");
      const head = card.p!.head as { t: string; s: string }[];
      assert.ok(head.some(span => span.s.includes("icon")));
      assert.ok(head.some(span => span.t.includes("3 active")));
      if (connection === "online") assert.ok(head.some(span => span.t.includes("1 running · 1 waiting · 1 queued")));
      else assert.match(String(card.p!.title), /reintentando en 8s/);
      const rows = card.c![0]!.c!;
      assert.equal(rows.length, 3, "terminal fold never truncates native run data");
      assert.equal(rows[0]!.c![0]!.k, "spinner");
      assert.equal(rows[1]!.c![0]!.k, "icon");
      assert.equal(rows[2]!.c![0]!.p!.name, "clock");
      assert.match(String(rows[0]!.c![1]!.p!.text), /#837 wide 界 👩‍💻 title.*implement.*reading changes/);
      assert.equal(rows[0]!.c![2]!.p!.text, "37s");
      assert.equal(rows[0]!.key, "dagrun:feature/run-0");
    });
  }
}

test("native toggles rerender shared view; unrelated events and hidden controls are ignored", () => {
  const widget = new WorkflowsWidget();
  const host = new WidgetHost();
  let renders = 0;
  const view: WidgetView = { expanded: false, hidden: false };
  const publish = () => {
    renders++;
    widget.publish({ theme, setWidget: host.setWidget }, renderWidget(entries, theme, view.expanded), {
      entries, expanded: view.expanded, now, slow: false,
    }, view);
  };
  view.render = publish;
  publish();
  host.component!.handleNativeEvent({ type: "click", key: "" });
  host.component!.handleNativeEvent({ type: "toggle", key: "run-0" });
  assert.equal(renders, 1);
  host.component!.handleNativeEvent({ type: "toggle", key: "" });
  assert.equal(view.expanded, true);
  assert.equal(host.component!.describe().p!.collapsed, false);
  host.component!.handleNativeEvent({ type: "toggle", key: "", collapsed: true });
  assert.equal(view.expanded, false);
  assert.equal(host.component!.describe().p!.collapsed, true);
  const previous = host.component!;
  view.hidden = true;
  publish();
  assert.equal(host.component, undefined);
  previous.handleNativeEvent({ type: "toggle", key: "" });
  assert.equal(view.expanded, false);
  view.hidden = false;
  widget.publish({ theme, setWidget: host.setWidget }, undefined, { entries: [], expanded: false, now, slow: false }, view);
  assert.equal(host.component, undefined);
});

test("RPC leaves the factory uninvoked and receives one original line array per update", () => {
  const calls: { key: string; content: WidgetContent; options: unknown }[] = [];
  const ui = { theme, setWidget(key: string, content: WidgetContent, options?: unknown) { calls.push({ key, content, options }); } };
  const widget = new WorkflowsWidget();
  const lines = renderWidget(entries, theme)!;
  const view = { expanded: false, hidden: false };
  for (let i = 0; i < 2; i++) widget.publish(ui, lines, { entries, expanded: false, now, slow: false }, view);
  const arrays = calls.filter(call => Array.isArray(call.content));
  assert.equal(arrays.length, 2);
  assert.equal(calls.filter(call => typeof call.content === "function").length, 2);
  for (const call of arrays) {
    assert.equal(call.key, "dagu-status");
    assert.strictEqual(call.content, lines);
    assert.deepEqual(call.options, { placement: "aboveEditor" });
  }
});

test("unchanged source reuses host layout, changed source remounts and native state refreshes", () => {
  const widget = new WorkflowsWidget();
  const host = new WidgetHost();
  const ui = { theme, setWidget: host.setWidget };
  const view = { expanded: false, hidden: false };
  const lines = renderWidget(entries, theme)!;
  widget.publish(ui, lines, { entries, expanded: false, now, slow: false }, view);
  const original = host.component!.describe();
  widget.publish(ui, [...lines], { entries, expanded: true, now, slow: false }, view);
  assert.equal(host.mounts, 1);
  assert.notStrictEqual(host.component!.describe(), original);
  assert.equal(host.component!.describe().p!.collapsed, false);
  const changed = [...lines];
  changed[1] += " updated";
  widget.publish(ui, changed, { entries, expanded: true, now, slow: false }, view);
  assert.equal(host.mounts, 2);
  assert.deepEqual(host.component!.render(80), changed);
});

for (const cap of [2, 5, 10]) test(`delegation preserves host cap=${cap}, templates, width and invalidation`, () => {
  const widget = new WorkflowsWidget();
  const source = Array.from({ length: 12 }, (_, i) => `\u001b[31m${i} long 界 👩‍💻 ${"text ".repeat(60)}\u001b[0m`);
  let component: WidgetComponent | undefined;
  let expected: readonly string[] = [];
  let invalidations = 0;
  let delegated: { render(width: number): readonly string[] };
  const root = { children: [] as unknown[] };
  const ui = { theme, setWidget(_key: string, content: WidgetContent) {
    if (Array.isArray(content)) {
      const children = [...content.slice(0, cap), "host-specific truncation"].map(text => ({ text, render: () => [text] }));
      delegated = { render(width) { expected = [`host width=${width}`, ...children.map(child => child.text)]; return expected; } };
      root.children = [{ children, render: delegated.render, invalidate() { invalidations++; } }];
    } else if (typeof content === "function") component = content(root, undefined);
  } };
  widget.publish(ui, source, { entries, expanded: true, now, slow: false }, { expanded: true, hidden: false });
  for (const width of [220, 150, 80, 40]) {
    const result = component!.render(width);
    assert.strictEqual(result, expected, "returns actual host rows without copying, trimming or repadding");
    assert.equal(result.at(-1), "host-specific truncation");
    assert.equal(result.length, cap + 2);
  }
  component!.invalidate!();
  assert.equal(invalidations, 1);
});

for (const unavailable of ["absent", "ambiguous"]) test(`unsupported ${unavailable} host retains arrays without approximate rendering`, () => {
  const widget = new WorkflowsWidget();
  const source = renderWidget(entries, theme)!;
  const calls: WidgetContent[] = [];
  const children = source.map(text => ({ text, render: () => [text] }));
  const root = { children: unavailable === "absent" ? [] : [
    { children, render: () => source }, { children, render: () => source },
  ] };
  const ui = { theme, setWidget(_key: string, content: WidgetContent) {
    calls.push(content);
    if (typeof content === "function") content(root, undefined);
  } };
  const presentation = { entries, expanded: false, now, slow: false };
  const view = { expanded: false, hidden: false };
  widget.publish(ui, source, presentation, view);
  assert.strictEqual(calls.at(-1), source);
  const before = calls.length;
  widget.publish(ui, source, presentation, view);
  assert.equal(calls.length, before + 1, "unsupported host is not reprobed on every observer frame");
  assert.strictEqual(calls.at(-1), source);
});
