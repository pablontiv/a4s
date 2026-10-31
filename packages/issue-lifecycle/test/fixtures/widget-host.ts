import type { WidgetComponent, WidgetContent } from "../../src/status/widget.ts";

/** Minimal mounted array path; capture assertions always read factory render(). */
export class WidgetHost {
  component: WidgetComponent | undefined;
  arrays: string[][] = [];
  mounts = 0;
  root: { children: unknown[] } = { children: [] };
  private readonly rendered: (lines: string[] | undefined) => void;
  constructor(rendered: (lines: string[] | undefined) => void = () => {}) {
    this.rendered = rendered;
  }

  setWidget = (_key: string, content: WidgetContent): void => {
    if (!content) {
      this.component = undefined;
      this.root.children = [];
      this.rendered(undefined);
    } else if (Array.isArray(content)) {
      this.arrays.push(content);
      this.mounts++;
      const children = content.map(text => ({ text, render: (_width: number) => [text] }));
      this.root.children = [{ children, render: (width: number) => children.flatMap(child => child.render(width)) }];
    } else {
      this.component = content(this.root, undefined);
      this.root.children = [this.component];
      this.rendered([...this.component.render(220)]);
    }
  };
}
