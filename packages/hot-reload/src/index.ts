import { realpath } from "node:fs/promises";
import { Dispatcher, Generation, switchGeneration, type Factory, type Host, type ReloadContext } from "./generation.ts";
export { Dispatcher, Generation, switchGeneration } from "./generation.ts";
export type { Factory, GenerationScope, Host, ReloadContext } from "./generation.ts";

/** Host-facing helper contract, included in each payload's registration manifest. */
export const HELPER_API_VERSION = 2;
export const RELOAD_INPUT = /^\s*\/reload-plugins(?:\s|$)/;
export const LIFECYCLE_TIMEOUT_MS = 2000;
let lastTag = 0;

/** Existing source-linked consumers use the same abort/rollback boundary as the stable loader. */
export async function hotReload<API extends object>(
  pi: API, factory: Factory<API>, implementation: URL,
  options: { importModule?: (url: string) => Promise<{ default: Factory<API> }> } = {},
): Promise<void> {
  const host = pi as unknown as Host;
  const dispatcher = new Dispatcher(host);
  const state = new Map<string, unknown>();
  let inFlight: Promise<void> | undefined;
  let pending: ReloadContext | undefined;
  let deferred: NodeJS.Timeout | undefined;
  let stopped = false;
  const record = async (factory: Factory<API>): Promise<Generation> => {
    const next = new Generation(state, () => { if (dispatcher.active === next) dispatcher.publish(next); });
    try { await next.record(pi, factory); return next; }
    catch (error) { next.abort(); throw error; }
  };
  const reload = (ctx: ReloadContext): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const path = await realpath(implementation);
        lastTag = Math.max(Date.now(), lastTag + 1);
        const imported = await (options.importModule ?? (path => import(path)))(`${path}?mtime=${lastTag}`);
        const next = await record(imported.default);
        if (stopped) { next.abort(); return; }
        await switchGeneration(dispatcher, next, ctx, LIFECYCLE_TIMEOUT_MS);
      } catch (error) { ctx.ui.notify(`Hot reload failed: ${String(error)}`, "error"); }
      finally { inFlight = undefined; }
    })();
    return inFlight;
  };
  host.on("input", async (...args) => {
    const [event, context] = args as [{ text: string; source: string }, ReloadContext];
    if (event.source === "extension" || !RELOAD_INPUT.test(event.text)) return;
    if (context.isIdle()) { pending = undefined; await reload(context); }
    else pending = context;
  });
  host.on("agent_end", () => {
    if (!pending || deferred) return;
    deferred = setTimeout(() => {
      deferred = undefined;
      if (!pending?.isIdle()) return;
      const ctx = pending; pending = undefined;
      void reload(ctx);
    }, 0);
  });
  const initial = await record(factory);
  dispatcher.publish(initial);
  dispatcher.active = initial;
  initial.commit();
  host.on("session_shutdown", () => {
    stopped = true;
    clearTimeout(deferred);
    pending = undefined;
    dispatcher.active?.abort();
    dispatcher.active = undefined;
  });
}
