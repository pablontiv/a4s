import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { hotReload, LIFECYCLE_TIMEOUT_MS, RELOAD_INPUT } from "../src/index.ts";

type Event = { type?: string; text?: string; source?: string };
type Handler = (event: Event, ctx: FakeContext) => unknown;
type Callback = (...args: unknown[]) => unknown;
interface FakeContext {
  isIdle(): boolean;
  ui: { notify(message: string, level: "warning" | "error"): void };
}
interface Command {
  description?: string;
  handler(args: string, ctx: FakeContext): unknown;
  getArgumentCompletions?(prefix: string): unknown;
}
interface Tool {
  name: string;
  description?: string;
  execute: Callback;
  renderResult?: Callback;
}
class FakeHost {
  readonly inherited = "real host member";
  readonly handlers = new Map<string, Handler[]>();
  readonly commands = new Map<string, Command>();
  readonly tools = new Map<string, Tool>();
  readonly commandRegistrations = new Map<string, number>();
  readonly toolRegistrations = new Map<string, number>();
  on(event: string, handler: Handler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }
  registerCommand(name: string, command: Command): void {
    this.commands.set(name, command);
    this.commandRegistrations.set(name, (this.commandRegistrations.get(name) ?? 0) + 1);
  }
  registerTool(tool: Tool): void {
    this.tools.set(tool.name, tool);
    this.toolRegistrations.set(tool.name, (this.toolRegistrations.get(tool.name) ?? 0) + 1);
  }
  async emit(name: string, event: Event, ctx: FakeContext): Promise<unknown[]> {
    const results = [];
    for (const handler of this.handlers.get(name) ?? []) results.push(await handler(event, ctx));
    return results;
  }
}
const implementation = new URL("../src/index.ts", import.meta.url);
function context() {
  let idle = true;
  const notices: { message: string; level: string }[] = [];
  const ctx: FakeContext = {
    isIdle: () => idle,
    ui: { notify: (message, level) => { notices.push({ message, level }); } },
  };
  return { ctx, notices, setIdle(value: boolean) { idle = value; } };
}
async function reload(host: FakeHost, ctx: FakeContext, text = "/reload-plugins") {
  return host.emit("input", { text, source: "rpc" }, ctx);
}
function factory(label: string, log: string[] = [], contexts: FakeContext[] = []) {
  return (pi: FakeHost) => {
    pi.on("tool_call", () => label);
    for (const name of ["session_start", "session_shutdown"]) {
      pi.on(name, (event, ctx) => {
        assert.equal(event.type, name);
        log.push(`${label}:${name}`);
        contexts.push(ctx);
      });
    }
  };
}

test("normal input, extension input and other slash commands preserve the builtin without importing", async () => {
  const host = new FakeHost();
  const { ctx } = context();
  let imports = 0;
  await hotReload(host, factory("A"), implementation, {
    importModule: async () => { imports++; return { default: factory("B") }; },
  });
  for (const text of ["hello", "/reload-plugins-other", "/reload-plugin"]) {
    assert.deepEqual(await reload(host, ctx, text), [undefined]);
  }
  await host.emit("input", { text: "/reload-plugins", source: "extension" }, ctx);
  assert.equal(imports, 0);
  assert.equal(RELOAD_INPUT.test("  /reload-plugins extra"), true);
});

test("idle reload dispatches only B and orders lifecycle handlers with the triggering context", async () => {
  const host = new FakeHost();
  const { ctx } = context();
  const log: string[] = [];
  const contexts: FakeContext[] = [];
  await hotReload(host, factory("A", log, contexts), implementation, {
    importModule: async () => ({ default: factory("B", log, contexts) }),
  });
  assert.deepEqual(await host.emit("tool_call", {}, ctx), ["A"]);
  assert.deepEqual(await reload(host, ctx, "  /reload-plugins extra"), [undefined]);
  assert.deepEqual(await host.emit("tool_call", {}, ctx), ["B"]);
  assert.deepEqual(log, ["A:session_shutdown", "B:session_start"]);
  assert.equal(contexts.length, 2);
  assert.ok(contexts.every(context => context.isIdle === ctx.isIdle));
  assert.equal(host.handlers.get("tool_call")?.length, 1);
});

test("busy reload waits until the zero-delay callback after agent_end sees idle", async () => {
  const host = new FakeHost();
  const { ctx, setIdle } = context();
  let imports = 0;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  await hotReload(host, factory("A"), implementation, {
    importModule: async () => {
      imports++;
      return { default: (pi: FakeHost) => { factory("B")(pi); pi.on("session_start", started); } };
    },
  });
  setIdle(false);
  await reload(host, ctx);
  await reload(host, ctx);
  assert.equal(imports, 0);
  await host.emit("agent_end", {}, ctx);
  assert.equal(imports, 0);
  setIdle(true);
  await ready;
  assert.equal(imports, 1);
  assert.deepEqual(await host.emit("tool_call", {}, ctx), ["B"]);
});

test("failed import retains A and reports error", async () => {
  const host = new FakeHost();
  const { ctx, notices } = context();
  const log: string[] = [];
  await hotReload(host, factory("A", log), implementation, {
    importModule: async () => { throw new Error("broken import"); },
  });
  await reload(host, ctx);
  assert.deepEqual(await host.emit("tool_call", {}, ctx), ["A"]);
  assert.deepEqual(log, []);
  assert.equal(notices[0]?.level, "error");
  assert.match(notices[0]?.message ?? "", /broken import/);
});

test("failed asynchronous factory keeps A and publishes none of its registrations", async () => {
  const host = new FakeHost();
  const { ctx, notices } = context();
  await hotReload(host, factory("A"), implementation, {
    importModule: async () => ({ default: async (pi: FakeHost) => {
      pi.on("tool_call", () => "broken");
      pi.on("new_event", () => "broken");
      pi.registerCommand("broken", { handler: () => "broken" });
      pi.registerTool({ name: "broken", execute: () => "broken" });
      await Promise.resolve();
      throw new Error("broken factory");
    } }),
  });
  await reload(host, ctx);
  assert.deepEqual(await host.emit("tool_call", {}, ctx), ["A"]);
  assert.equal(host.handlers.get("new_event"), undefined);
  assert.equal(host.commands.get("broken"), undefined);
  assert.equal(host.tools.get("broken"), undefined);
  assert.match(notices[0]?.message ?? "", /broken factory/);
  assert.equal(notices[0]?.level, "error");
});

test("removed registrations warn or throw; new commands and tools occupy one host slot", async () => {
  const host = new FakeHost();
  const { ctx, notices } = context();
  const first = (pi: FakeHost) => {
    pi.registerCommand("removed", { handler: () => "A" });
    pi.registerTool({ name: "removed", execute: () => "A" });
  };
  let generation = 0;
  await hotReload(host, first, implementation, {
    importModule: async () => {
      const label = ++generation;
      return { default: (pi: FakeHost) => {
        pi.registerCommand("new", { handler: () => label, getArgumentCompletions: () => [label] });
        pi.registerTool({ name: "new", execute: () => label, renderResult: () => `render-${label}` });
      } };
    },
  });
  await reload(host, ctx);
  await host.commands.get("removed")!.handler("", ctx);
  assert.equal(notices[0]?.level, "warning");
  assert.match(notices[0]?.message ?? "", /Restart omp/);
  assert.throws(() => host.tools.get("removed")!.execute(), /removed.*Restart omp/);
  await reload(host, ctx);
  assert.equal(host.commands.get("new")!.handler("", ctx), 2);
  assert.deepEqual(host.commands.get("new")!.getArgumentCompletions!(""), [2]);
  assert.equal(host.tools.get("new")!.execute(), 2);
  assert.equal(host.tools.get("new")!.renderResult!(), "render-2");
  assert.equal(host.commandRegistrations.get("new"), 1);
  assert.equal(host.toolRegistrations.get("new"), 1);
});

test("event indices stay stable as generations add and remove handlers", async () => {
  const host = new FakeHost();
  const { ctx } = context();
  let count = 0;
  await hotReload(host, pi => {
    pi.on("tool_call", () => "A0");
    pi.on("tool_call", () => "A1");
  }, implementation, {
    importModule: async () => ({ default: (pi: FakeHost) => {
      pi.on("tool_call", () => "B0");
      if (++count === 2) {
        pi.on("tool_call", () => "B1");
        pi.on("tool_call", () => "B2");
      }
    } }),
  });
  await reload(host, ctx);
  assert.deepEqual(await host.emit("tool_call", {}, ctx), ["B0", undefined]);
  await reload(host, ctx);
  assert.deepEqual(await host.emit("tool_call", {}, ctx), ["B0", "B1", "B2"]);
  assert.equal(host.handlers.get("tool_call")?.length, 3);
});

test("handlers receive the host context when its ui is a getter-only accessor", async () => {
  const host = new FakeHost();
  const notices: string[] = [];
  class GetterContext implements FakeContext {
    isIdle() { return true; }
    get ui() { return { notify: (message: string) => { notices.push(message); } }; }
  }
  const ctx = new GetterContext();
  await hotReload(host, pi => {
    pi.on("tool_call", (_event: Event, handlerContext: FakeContext) => {
      handlerContext.ui.notify("allowed", "warning");
      return handlerContext.isIdle();
    });
  }, implementation, { importModule: async () => ({ default: () => {} }) });
  assert.deepEqual(await host.emit("tool_call", {}, ctx), [true]);
  assert.deepEqual(notices, ["allowed"]);
});

test("factories inherit the real API and can register late within the active generation", async () => {
  const host = new FakeHost();
  const { ctx } = context();
  await hotReload(host, pi => {
    assert.equal(Object.getPrototypeOf(pi), host);
    assert.equal(pi.inherited, "real host member");
    pi.on("session_start", () => { pi.on("tool_call", () => "late A"); });
  }, implementation, {
    importModule: async () => ({ default: (pi: FakeHost) => {
      pi.on("session_start", () => { pi.on("tool_call", () => "late B"); });
    } }),
  });
  await host.emit("session_start", { type: "session_start" }, ctx);
  assert.deepEqual(await host.emit("tool_call", {}, ctx), ["late A"]);
  await reload(host, ctx);
  assert.deepEqual(await host.emit("tool_call", {}, ctx), ["late B"]);
  assert.equal(host.handlers.get("tool_call")?.length, 1);
});

test("concurrent requests are single-flight and subsequent imports use increasing numeric mtime tags", async () => {
  const host = new FakeHost();
  const { ctx } = context();
  const urls: string[] = [];
  let importing!: () => void;
  const imported = new Promise<void>(resolve => { importing = resolve; });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  await hotReload(host, factory("A"), implementation, {
    importModule: async url => {
      urls.push(url);
      importing();
      await blocked;
      return { default: factory("B") };
    },
  });
  const first = reload(host, ctx);
  await imported;
  const second = reload(host, ctx);
  release();
  await Promise.all([first, second]);
  assert.equal(urls.length, 1);
  await reload(host, ctx);
  assert.equal(urls.length, 2);
  assert.match(urls[0]!, /^\/.*\?mtime=\d+$/);
  const tags = urls.map(url => new URL(url, "file://").searchParams.get("mtime")!);
  assert.equal(tags.every(tag => /^\d+$/.test(tag)), true);
  assert.ok(Number(tags[1]) > Number(tags[0]));
});

test("shutdown is bounded and rejected startup rolls both dispatchers back", async () => {
  const host = new FakeHost();
  const { ctx, notices } = context();
  const log: string[] = [];
  await hotReload(host, pi => {
    pi.on("session_shutdown", () => new Promise<void>(() => {}));
    pi.on("session_shutdown", () => { log.push("second shutdown"); throw new Error("shutdown rejected"); });
  }, implementation, {
    importModule: async () => ({ default: (pi: FakeHost) => {
      factory("B", log)(pi);
      pi.on("session_start", () => { throw new Error("start rejected"); });
    } }),
  });
  assert.equal(LIFECYCLE_TIMEOUT_MS, 2000);
  await reload(host, ctx);
  assert.deepEqual(log, ["B:session_start", "B:session_shutdown"]);
  assert.deepEqual(await host.emit("tool_call", {}, ctx), []);
  assert.equal(notices.length, 2);
  assert.equal(notices.every(notice => notice.level === "error"), true);
  assert.match(notices[0]?.message ?? "", /2000 ms/);
});

test("default importer reads rewritten modules from their real path", async t => {
  const directory = await mkdtemp(join(tmpdir(), "a4s-hot-reload-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "implementation.mjs");
  const link = join(directory, "entry.mjs");
  await writeFile(file, 'export default pi => pi.on("tool_call", () => "v1");\n');
  await symlink(file, link);
  const url = pathToFileURL(link);
  // This temporary module intentionally exercises the runtime module-loading boundary.
  const initial = await import(url.href) as { default: (pi: FakeHost) => void };
  const host = new FakeHost();
  const { ctx } = context();
  await hotReload(host, initial.default, url);
  assert.deepEqual(await host.emit("tool_call", {}, ctx), ["v1"]);
  await writeFile(file, 'export default pi => pi.on("tool_call", () => "v2");\n');
  await reload(host, ctx);
  assert.deepEqual(await host.emit("tool_call", {}, ctx), ["v2"]);
  await writeFile(file, 'export default pi => pi.on("tool_call", () => "v1");\n');
  await reload(host, ctx);
  assert.deepEqual(await host.emit("tool_call", {}, ctx), ["v1"]);
});
