import { realpath } from "node:fs/promises";

/** Host-facing helper contract, included in each payload's registration manifest. */
export const HELPER_API_VERSION = 1;

export const RELOAD_INPUT = /^\s*\/reload-plugins(?:\s|$)/;
export const LIFECYCLE_TIMEOUT_MS = 2000;

// Registrations are deliberately host-neutral: a4s uses both native OMP and Pi APIs.
// Their event overloads, command contexts and tool schemas differ, but dispatch
// preserves each call's arguments and return value without interpreting them.
type Callback = (...args: unknown[]) => unknown;
interface Command {
  handler: Callback;
  [key: string]: unknown;
}
interface Tool {
  name: string;
  execute: Callback;
  [key: string]: unknown;
}
interface Host {
  on<Event, Ctx>(event: string, handler: (event: Event, ctx: Ctx) => unknown): void;
  registerCommand(name: string, command: Command): void;
  registerTool(tool: Tool): void;
}
interface Context {
  isIdle(): boolean;
  ui: { notify(message: string, level: "warning" | "error"): void };
}
interface Generation {
  events: Map<string, Callback[]>;
  commands: Map<string, Command>;
  tools: Map<string, Tool>;
}

let lastTag = 0;

/** Install a stable host-facing dispatcher around a reloadable extension factory. */
export async function hotReload<API extends object>(
  pi: API,
  factory: (pi: API) => void | Promise<void>,
  implementation: URL,
  options: { importModule?: (url: string) => Promise<{ default: (pi: API) => void | Promise<void> }> } = {},
): Promise<void> {
  const host = pi as unknown as Host;
  const eventSlots = new Map<string, number>();
  const commandSlots = new Set<string>();
  const toolSlots = new Set<string>();
  let active: Generation | undefined;
  let inFlight: Promise<void> | undefined;
  let pending: Context | undefined;
  let deferred: NodeJS.Timeout | undefined;

  function publish(generation: Generation): void {
    for (const [name, handlers] of generation.events) {
      for (let index = eventSlots.get(name) ?? 0; index < handlers.length; index++) {
        const slot = index;
        host.on(name, (...args) => active?.events.get(name)?.[slot]?.(...args));
        eventSlots.set(name, index + 1);
      }
    }
    for (const [name, command] of generation.commands) {
      if (commandSlots.has(name)) continue;
      const registered = { ...command };
      for (const [key, value] of Object.entries(command)) {
        if (typeof value !== "function") continue;
        registered[key] = (...args: unknown[]) => {
          const current = active?.commands.get(name);
          const callback = current?.[key];
          if (typeof callback === "function") return callback.apply(current, args);
          if (key === "handler") {
            const ctx = args[1] as Context;
            ctx.ui.notify(`Command /${name} was removed. Restart omp to unregister it.`, "warning");
          }
          return undefined;
        };
      }
      host.registerCommand(name, registered);
      commandSlots.add(name);
    }
    for (const [name, tool] of generation.tools) {
      if (toolSlots.has(name)) continue;
      const registered = { ...tool };
      for (const [key, value] of Object.entries(tool)) {
        if (typeof value !== "function") continue;
        registered[key] = (...args: unknown[]) => {
          const current = active?.tools.get(name);
          const callback = current?.[key];
          if (typeof callback === "function") return callback.apply(current, args);
          if (key === "execute") throw new Error(`Tool ${name} was removed. Restart omp to unregister it.`);
          return undefined;
        };
      }
      host.registerTool(registered);
      toolSlots.add(name);
    }
  }

  async function record(nextFactory: (pi: API) => void | Promise<void>): Promise<Generation> {
    const generation: Generation = { events: new Map(), commands: new Map(), tools: new Map() };
    const facade = Object.create(pi) as API & Host;
    Object.defineProperties(facade, {
      on: { value: (name: string, handler: Callback) => {
        const handlers = generation.events.get(name) ?? [];
        handlers.push(handler);
        generation.events.set(name, handlers);
        if (active === generation) publish(generation);
      } },
      registerCommand: { value: (name: string, command: Command) => {
        generation.commands.set(name, command);
        if (active === generation) publish(generation);
      } },
      registerTool: { value: (tool: Tool) => {
        generation.tools.set(tool.name, tool);
        if (active === generation) publish(generation);
      } },
    });
    await nextFactory(facade);
    return generation;
  }

  async function lifecycle(generation: Generation, name: "session_shutdown" | "session_start", ctx: Context): Promise<void> {
    for (const handler of generation.events.get(name) ?? []) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => handler({ type: name }, ctx)),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${name} exceeded ${LIFECYCLE_TIMEOUT_MS} ms`)), LIFECYCLE_TIMEOUT_MS);
          }),
        ]);
      } catch (error) {
        ctx.ui.notify(`Hot reload ${name}: ${String(error)}`, "error");
      } finally {
        clearTimeout(timer);
      }
    }
  }

  function reload(ctx: Context): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const modulePath = await realpath(implementation);
        lastTag = Math.max(Date.now(), lastTag + 1);
        // Runtime-selected raw paths preserve query identity in Bun; file:// queries do not.
        const specifier = `${modulePath}?mtime=${lastTag}`;
        const imported = await (options.importModule ?? (path => import(path)))(specifier);
        const next = await record(imported.default);
        publish(next);
        if (active) await lifecycle(active, "session_shutdown", ctx);
        active = next;
        await lifecycle(next, "session_start", ctx);
      } catch (error) {
        ctx.ui.notify(`Hot reload failed: ${String(error)}`, "error");
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  }

  host.on("input", async (event: { text: string; source: string }, ctx: Context) => {
    if (event.source === "extension" || !RELOAD_INPUT.test(event.text)) return;
    if (ctx.isIdle()) {
      pending = undefined;
      await reload(ctx);
    } else pending = ctx;
    // Preserve the builtin /reload-plugins and its resource rediscovery.
    return undefined;
  });
  host.on("agent_end", () => {
    if (!pending || deferred) return;
    deferred = setTimeout(() => {
      deferred = undefined;
      if (!pending?.isIdle()) return;
      const ctx = pending;
      pending = undefined;
      void reload(ctx);
    }, 0);
  });

  const initial = await record(factory);
  publish(initial);
  active = initial;
}
