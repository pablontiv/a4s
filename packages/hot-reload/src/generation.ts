/// <reference lib="es2024.promise" />
export type Callback = (...args: unknown[]) => unknown;
export interface Registration { [key: string]: unknown }
export interface Host {
  on(event: string, callback: Callback): void;
  registerCommand(name: string, command: Registration): void;
  registerTool(tool: Registration): void;
}
export interface ReloadContext {
  isIdle(): boolean;
  ui: { notify(message: string, level: "warning" | "error"): void };
}
/** Switch-owned state survives rollback and module retirement; never put tasks in it. */
export interface GenerationScope {
  readonly signal: AbortSignal;
  readonly state: Map<string, unknown>;
  readonly ready: boolean;
  onCommit(callback: () => void): void;
  onAbort(cleanup: () => void): void;
}
export type Factory<API extends object> = (api: API, scope: GenerationScope) => void | Promise<void>;

export class Generation {
  readonly events = new Map<string, Callback[]>();
  readonly commands = new Map<string, Registration>();
  readonly tools = new Map<string, Registration>();
  private controller = new AbortController();
  private effects: (() => void)[] = [];
  private committed = false;
  private sealed = false;
  private commits: (() => void)[] = [];
  readonly scope: GenerationScope;
  readonly state: Map<string, unknown>;
  private changed: () => void;
  constructor(state: Map<string, unknown>, changed: () => void = () => {}) {
    this.state = state;
    this.changed = changed;
    const self = this;
    this.scope = { get signal() { return self.controller.signal; }, state,
      get ready() { return self.committed; },
      onCommit(callback) { self.commits.push(callback); },
      onAbort(cleanup) {
        if (self.controller.signal.aborted) cleanup();
        else self.controller.signal.addEventListener("abort", cleanup, { once: true });
      } };
  }
  begin(): void { if (this.controller.signal.aborted) this.controller = new AbortController(); }
  commit(): void {
    if (this.controller.signal.aborted) throw new Error("Stale generation cannot publish");
    this.committed = true;
    const effects = this.effects; this.effects = [];
    for (const effect of effects) effect();
    for (const callback of this.commits) callback();
  }
  abort(): void {
    this.committed = false;
    this.controller.abort();
    this.effects = [];
  }
  private effect(signal: AbortSignal, callback: () => void): void {
    if (signal.aborted) return;
    if (this.committed) callback(); else this.effects.push(() => { if (!signal.aborted) callback(); });
  }
  context<T extends object>(ctx: T): T {
    const signal = this.controller.signal;
    const ui = "ui" in ctx && typeof ctx.ui === "object" && ctx.ui !== null
      ? ctx.ui as Record<PropertyKey, unknown> : undefined;
    if (!ui) return ctx;
    // Define, never assign: hosts may expose `ui` as a getter-only or readonly
    // property, and assigning through such a prototype throws in strict mode.
    return Object.create(ctx, { ui: { value: new Proxy(ui, { get: (target, key) => {
      const value = target[key];
      if (typeof value !== "function") return value;
      if (!["notify", "setWidget", "setStatus"].includes(String(key))) return value.bind(target);
      return (...args: unknown[]) => this.effect(signal, () => value.apply(target, args));
    } }), enumerable: true, writable: true, configurable: true } });
  }
  async record<API extends object>(api: API, factory: Factory<API>): Promise<void> {
    const facade = Object.create(api);
    const register = (callback: () => void) => {
      if (this.sealed) throw new Error("Registration after manifest validation requires restart OMP");
      if (!this.controller.signal.aborted) { callback(); this.changed(); }
    };
    Object.defineProperties(facade, {
      on: { value: (name: string, callback: Callback) => register(() => {
        const callbacks = this.events.get(name) ?? []; callbacks.push(callback); this.events.set(name, callbacks);
      }) },
      registerCommand: { value: (name: string, command: Registration) => register(() => {
        if (this.commands.has(name)) throw new Error(`Duplicate command ${name}`);
        this.commands.set(name, command);
      }) },
      registerTool: { value: (tool: Registration) => register(() => {
        const name = String(tool.name);
        if (this.tools.has(name)) throw new Error(`Duplicate tool ${name}`);
        this.tools.set(name, tool);
      }) },
      sendMessage: { value: (...args: unknown[]) => this.effect(this.controller.signal, () => {
        if ("sendMessage" in api && typeof api.sendMessage === "function") api.sendMessage(...args);
      }) },
    });
    await factory(facade, this.scope);
  }
  seal(): void { this.sealed = true; }
  async lifecycle(name: "session_start" | "session_shutdown", ctx: ReloadContext, timeout: number): Promise<void> {
    const signal = this.controller.signal;
    let timer: NodeJS.Timeout | undefined;
    try {
      const expired = Promise.withResolvers<never>();
      timer = setTimeout(() => expired.reject(new Error(`${name} exceeded ${timeout} ms`)), timeout);
      await Promise.race([
        (async () => {
          for (const callback of this.events.get(name) ?? []) {
            if (signal.aborted && name === "session_start") return;
            await callback({ type: name, signal }, this.context(ctx));
          }
        })(),
        expired.promise,
      ]);
      if (signal.aborted && name === "session_start") throw new Error("Stale generation lifecycle");
    } finally { clearTimeout(timer); }
  }
}

/** All extensions share this one pointer. Host registrations are installed only once. */
export class Dispatcher {
  active: Generation | undefined;
  private events = new Map<string, number>();
  private commands = new Set<string>();
  private tools = new Set<string>();
  private host: Host;
  constructor(host: Host) { this.host = host; }
  publish(generation: Generation): void {
    for (const [name, callbacks] of generation.events) {
      for (let index = this.events.get(name) ?? 0; index < callbacks.length; index++) {
        const slot = index;
        this.host.on(name, (...args) => {
          const active = this.active;
          if (!active || active.scope.signal.aborted) return;
          const contextIndex = args.length - 1;
          if (args[contextIndex] && typeof args[contextIndex] === "object") args[contextIndex] = active.context(args[contextIndex]);
          return active.events.get(name)?.[slot]?.(...args);
        });
        this.events.set(name, index + 1);
      }
    }
    const install = (registrations: Map<string, Registration>, slots: Set<string>, tool: boolean) => {
      for (const [name, definition] of registrations) {
        if (slots.has(name)) continue;
        const registered = { ...definition };
        for (const [key, value] of Object.entries(definition)) if (typeof value === "function") {
          registered[key] = (...args: unknown[]) => {
            const active = this.active;
            const current = (tool ? active?.tools : active?.commands)?.get(name);
            if (active?.scope.signal.aborted || typeof current?.[key] !== "function") {
              if (tool && key === "execute") throw new Error(`Tool ${name} was removed. Restart omp to unregister it.`);
              if (!tool && key === "handler") (args[1] as ReloadContext).ui.notify(`Command /${name} was removed. Restart omp to unregister it.`, "warning");
              return;
            }
            if (key === "handler" || key === "execute") {
              const index = tool ? 4 : 1;
              if (args[index] && typeof args[index] === "object") args[index] = active!.context(args[index] as object);
            }
            return current[key](...args);
          };
        }
        if (tool) this.host.registerTool(registered); else this.host.registerCommand(name, registered);
        slots.add(name);
      }
    };
    install(generation.commands, this.commands, false);
    install(generation.tools, this.tools, true);
  }
}

export async function switchGeneration(dispatcher: Dispatcher, next: Generation, ctx: ReloadContext, timeout: number): Promise<void> {
  const previous = dispatcher.active;
  // Abort first: shutdown hooks are bounded, but abort listeners are synchronous.
  previous?.abort();
  if (previous) {
    try { await previous.lifecycle("session_shutdown", ctx, timeout); }
    catch (error) { ctx.ui.notify(`Hot reload shutdown: ${String(error)}`, "error"); }
  }
  if (dispatcher.active !== previous) { next.abort(); throw new Error("Generation switch was cancelled"); }
  dispatcher.active = next;
  try {
    next.begin();
    await next.lifecycle("session_start", ctx, timeout);
    dispatcher.publish(next);
    next.commit();
  } catch (error) {
    next.abort();
    try { await next.lifecycle("session_shutdown", ctx, timeout); }
    catch { /* Synchronous abort owns cancellation even if shutdown rejects. */ }
    if (dispatcher.active !== next) throw error;
    dispatcher.active = previous;
    if (previous) {
      previous.begin();
      await previous.lifecycle("session_start", ctx, timeout);
      previous.commit();
    }
    throw error;
  }
}
