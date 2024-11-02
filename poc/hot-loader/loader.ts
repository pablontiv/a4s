import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Callback = (...args: unknown[]) => unknown;
type Definition = Record<string, unknown>;
type Extension = "status" | "triage";
type Fault = "manifest" | "import" | "factory2" | "lifecycle" | "timeout";
interface NativeContext {
  cwd: string;
  hasUI: boolean;
  isIdle(): boolean;
  agent: { kind: string };
  sessionManager: { getSessionId(): string };
  ui: { notify(message: string, level: "info" | "warning" | "error"): unknown; [key: string]: unknown };
  [key: string]: unknown;
}
interface Host {
  on(name: string, handler: Callback): void;
  registerCommand(name: string, definition: Definition): void;
  registerTool(definition: Definition): void;
  [key: string]: unknown;
}
interface RequestedState { generation: string; build: string; requestId: string; fault?: Fault }
interface Manifest { commands: Definition[]; tools: Definition[]; events: string[] }
interface Queue { messages: string[]; claimed: boolean }
type Queues = Map<string, Queue>;
interface StatusAdapter {
  stop(): void;
  start(event?: unknown, ctx?: NativeContext): void;
  takeQueue(): Queues;
  putQueue(queues: Queues): void;
  peekQueue?(): Queues;
  enqueue(message: string, queueOnly: boolean): void;
  releaseOne(): void;
}
interface OwnedCallback { extension: Extension; callback: Callback }
interface OwnedDefinition { extension: Extension; definition: Definition }
interface Token { serial: number; controller: AbortController }
interface Delivery { message: Definition; options: unknown; session: string; token: Token }
interface Generation {
  state: RequestedState;
  build: string;
  identity: Definition;
  manifest: Manifest;
  abi: string;
  token: Token;
  phase: "staging" | "starting" | "active" | "retired" | "failed";
  events: Map<string, OwnedCallback[]>;
  commands: Map<string, OwnedDefinition>;
  tools: Map<string, OwnedDefinition>;
  sentinels: Partial<Record<Extension, string>>;
  status?: StatusAdapter;
  finalized: boolean;
  importStarted: boolean;
  lease?: { file: string; fd: number };
  outbox: Delivery[];
}
interface Scope {
  generation: Generation;
  token: Token;
  extension: Extension;
  origin: string;
  ctx?: NativeContext;
}
interface Observer {
  generation: Generation;
  extension: Extension;
  signal: AbortSignal;
  startedAt: string;
  settled: boolean;
}
interface ProbeNotification { id: number; batch: string; message: string }

const LOADER_PROTOCOL = "poc-d11/1";
const LAUNCHER_PROTOCOL = "poc-launcher/1";
const QUEUE_HELD = Symbol.for("poc.queueHeld");
const FAULTS: Record<string, true> = { manifest: true, import: true, factory2: true, lifecycle: true, timeout: true };

function object(value: unknown): Definition {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Definition : {};
}
function canonical(value: unknown): unknown {
  if (typeof value === "function") return "<function>";
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.filter(item => item !== undefined).map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().flatMap(key => {
      const item = canonical((value as Definition)[key]);
      return item === undefined ? [] : [[key, item]];
    }));
  }
  return value;
}
function manifestOf(commands: Map<string, OwnedDefinition>, tools: Map<string, OwnedDefinition>, events: Map<string, OwnedCallback[]>): Manifest {
  return canonical({
    commands: [...commands].sort(([left], [right]) => left.localeCompare(right)).map(([name, entry]) => ({ name, ...entry.definition })),
    tools: [...tools].sort(([left], [right]) => left.localeCompare(right)).map(([, entry]) => entry.definition),
    events: [...events.keys()].sort(),
  }) as Manifest;
}
function manifestString(value: unknown): string {
  const manifest = object(value);
  if (!Array.isArray(manifest.commands) || !Array.isArray(manifest.tools) || !Array.isArray(manifest.events)
    || manifest.commands.some(item => typeof object(item).name !== "string")
    || manifest.tools.some(item => typeof object(item).name !== "string")
    || manifest.events.some(item => typeof item !== "string")) throw new Error("Missing or malformed pocRegistrationManifest");
  return JSON.stringify(canonical({
    commands: [...manifest.commands].sort((left, right) => String(object(left).name).localeCompare(String(object(right).name))),
    tools: [...manifest.tools].sort((left, right) => String(object(left).name).localeCompare(String(object(right).name))),
    events: [...new Set(manifest.events as string[])].sort(),
  }));
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function failure(error: unknown): string { return error instanceof Error ? `${error.name}: ${error.message}` : String(error); }
function queueSize(queues: Queues): number {
  let count = 0;
  for (const queue of queues.values()) count += queue.messages.length;
  return count;
}
function queueHeld(queues: Queues): boolean {
  return (queues as unknown as Record<symbol, unknown>)[QUEUE_HELD] === true;
}
function setQueueHeld(queues: Queues, held: boolean): void {
  (queues as unknown as Record<symbol, unknown>)[QUEUE_HELD] = held;
}
function readRequested(root: string): RequestedState {
  const state = object(JSON.parse(readFileSync(join(root, "state.json"), "utf8")));
  if (typeof state.generation !== "string" || !state.generation || typeof state.build !== "string" || !state.build
    || typeof state.requestId !== "string" || !state.requestId || (state.fault !== undefined && FAULTS[String(state.fault)] !== true)) {
    throw new Error("state.json requires generation, build, requestId and an optional supported fault");
  }
  return state as unknown as RequestedState;
}

/** Throwaway native D11 experiment. No command or input hook initiates a switch. */
export default function pocHotLoader(host: Host): void {
  const root = process.env.POC_HOT_ROOT;
  const evidence = process.env.POC_HOT_EVIDENCE;
  if (!root || !evidence) throw new Error("POC_HOT_ROOT and POC_HOT_EVIDENCE are required");
  const runtimeRoot = resolve(root);
  const evidenceRoot = resolve(evidence);
  const leaseRoot = join(runtimeRoot, "leases");
  const manifestPath = process.env.POC_HOT_MANIFEST;
  if (!manifestPath) throw new Error("POC_HOT_MANIFEST must name the source-generated installed registration manifest");
  const installedABI = manifestString(JSON.parse(readFileSync(manifestPath, "utf8")));
  const installedManifest = JSON.parse(installedABI) as Manifest;
  mkdirSync(evidenceRoot, { recursive: true });
  mkdirSync(leaseRoot, { recursive: true });
  const configuredTimeout = Number(process.env.POC_HOT_STARTUP_TIMEOUT_MS ?? 150);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 150;
  const scopes = new AsyncLocalStorage<Scope>();
  const generations = new Set<Generation>();
  const observers = new Map<AbortSignal, Observer>();
  const leaseDescriptors = new Map<string, number>();
  const eventSlots = new Set<string>();
  const commandSlots = new Set<string>();
  const toolSlots = new Set<string>();
  const enqueued: ProbeNotification[] = [];
  const delivered: Definition[] = [];
  const batches = new Set<string>();
  let nextNotificationId = 0;
  let serial = 0;
  let active: Generation | undefined;
  let currentContext: NativeContext | undefined;
  let inFlight: Promise<boolean> | undefined;
  let deferred: NodeJS.Timeout | undefined;
  let shuttingDown = false;
  let lastAttemptKey: string | undefined;
  let latestRequestId: string | null = null;
  let phase = "waiting_session_start";
  let turnStartedAt: number | undefined;
  let handoff: { queues: Queues; from: Generation } | undefined;

  function newToken(): Token { return { serial: ++serial, controller: new AbortController() }; }
  function authorized(generation: Generation, token: Token): boolean {
    return !shuttingDown && active === generation && generation.token === token && !token.controller.signal.aborted
      && (generation.phase === "starting" || generation.phase === "active");
  }
  function scopeFor(generation: Generation, extension: Extension, origin: string, ctx?: NativeContext, token = generation.token): Scope {
    return { generation, token, extension, origin, ctx };
  }
  function actualQueue(generation: Generation): Queues {
    if (!generation.status) return new Map();
    return scopes.run(scopeFor(generation, "status", "queue_inspection", currentContext), () => {
      if (generation.status!.peekQueue) return generation.status!.peekQueue!();
      const queues = generation.status!.takeQueue();
      generation.status!.putQueue(queues);
      return queues;
    });
  }
  function probe(message: unknown): ProbeNotification | undefined {
    return typeof message === "string" ? enqueued.find(item => item.message === message) : undefined;
  }
  function filesystemLeases(): Definition[] {
    return readdirSync(leaseRoot).filter(name => name.endsWith(".json")).sort().map(name => {
      const file = join(leaseRoot, name);
      try {
        const value = object(JSON.parse(readFileSync(file, "utf8")));
        const stat = statSync(file);
        const fd = leaseDescriptors.get(file);
        let descriptorOpen = false;
        if (fd !== undefined) {
          try { descriptorOpen = fstatSync(fd).ino === stat.ino; } catch { /* The observation reports the actual closed descriptor. */ }
        }
        let processAlive = false;
        if (typeof value.pid === "number") {
          try { process.kill(value.pid, 0); processAlive = true; }
          catch (error) { processAlive = object(error).code === "EPERM"; }
        }
        return { ...value, file, bytes: stat.size, descriptorOpen, processAlive };
      } catch (error) { return { file, error: failure(error) }; }
    });
  }
  function snapshot(): Definition {
    const outstanding: Definition[] = [];
    const queues: Definition[] = [];
    const inspect = (items: Queues, generation: Generation, carrier: string): void => {
      for (const [session, queue] of items) {
        queues.push({ generation: generation.state.generation, session, count: queue.messages.length, claimed: queue.claimed, held: queueHeld(items), carrier });
        for (const message of queue.messages) {
          const notification = probe(message);
          outstanding.push({ ...(notification ?? { id: null, message }), session, generation: generation.state.generation, carrier });
        }
      }
    };
    for (const generation of generations) {
      inspect(actualQueue(generation), generation, "status_queue");
      for (const delivery of generation.outbox) {
        outstanding.push({ ...(probe(delivery.message.content) ?? { id: null, message: delivery.message.content }),
          session: delivery.session, generation: generation.state.generation, carrier: "startup_outbox" });
      }
    }
    if (handoff) inspect(handoff.queues, handoff.from, "transaction_handoff");
    const records = [...observers.values()].map(observer => ({
      generation: observer.generation.state.generation,
      extension: observer.extension,
      sentinel: observer.generation.sentinels[observer.extension] ?? null,
      startedAt: observer.startedAt,
      aborted: observer.signal.aborted,
      settled: observer.settled,
      active: !observer.signal.aborted && !observer.settled,
    }));
    const counts = new Map<number, number>();
    for (const entry of delivered) if (typeof entry.id === "number") counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
    for (const entry of outstanding) if (typeof entry.id === "number") counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
    return {
      pid: process.pid,
      requestId: latestRequestId,
      phase,
      activeGeneration: active?.state.generation ?? null,
      activeSentinels: active ? { status: active.sentinels.status ?? null, triage: active.sentinels.triage ?? null } : null,
      active: active ? { generation: active.state.generation, build: active.build, requestId: active.state.requestId,
        sentinels: active.sentinels, token: active.token.serial, phase: active.phase, manifestHash: digest(active.abi) } : null,
      activeObserverCount: records.filter(observer => observer.active).length,
      observers: records,
      leases: filesystemLeases(),
      queues,
      notifications: {
        policy: "synthetic notification queue probe; real status sendMessage intercepted; no model turn initiated",
        enqueued, delivered, outstanding,
        duplicateIds: [...counts].filter(([, count]) => count > 1).map(([id]) => id),
        missingIds: enqueued.filter(item => !counts.has(item.id)).map(item => item.id),
      },
      registrations: { events: [...eventSlots].sort(), commands: [...commandSlots].sort(), tools: [...toolSlots].sort() },
      loaderProtocol: LOADER_PROTOCOL,
      launcherProtocol: LAUNCHER_PROTOCOL,
    };
  }
  function observe(type: string, details: Definition = {}): void {
    const timestamp = new Date().toISOString();
    const row = { ...snapshot(), ...details, type, timestamp };
    appendFileSync(join(evidenceRoot, "observations.jsonl"), `${JSON.stringify(row)}\n`);
    const temporary = join(evidenceRoot, `snapshot.${process.pid}.tmp`);
    writeFileSync(temporary, `${JSON.stringify({ ...row, lastEvent: type }, null, 2)}\n`);
    renameSync(temporary, join(evidenceRoot, "snapshot.json"));
  }
  function notify(ctx: NativeContext, message: string, level: "info" | "warning" | "error"): void {
    ctx.ui.notify(message, level);
    observe("native_notify", { message, level });
  }
  function publish(generation: Generation, token: Token | undefined, surface: string, action: () => unknown): { published: boolean; result?: unknown } {
    if (!token || !authorized(generation, token)) {
      observe("publish_suppressed", { candidateGeneration: generation.state.generation, surface,
        token: token?.serial ?? null, aborted: token?.controller.signal.aborted ?? null, published: false });
      return { published: false };
    }
    return { published: true, result: action() };
  }
  function guardedContext(generation: Generation, token: Token, ctx: NativeContext): NativeContext {
    const ui = new Proxy(ctx.ui, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => publish(generation, token, `ctx.ui.${String(key)}`, () => value.apply(target, args)).result;
      },
    });
    return new Proxy(ctx, {
      get(target, key) {
        if (key === "ui") return ui;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  function run(generation: Generation, owner: OwnedCallback, args: unknown[], origin: string, ctx?: NativeContext, token = generation.token): unknown {
    return scopes.run(scopeFor(generation, owner.extension, origin, ctx, token), () => owner.callback(...args));
  }
  function deliver(generation: Generation, delivery: Delivery): void {
    const notification = probe(delivery.message.content);
    delivered.push({ ...(notification ?? { id: null, message: delivery.message.content }),
      generation: generation.state.generation, sentinel: generation.sentinels.status ?? null,
      session: delivery.session, timestamp: new Date().toISOString(), synthetic: true });
    observe("notification_delivered", { delivery: delivered[delivered.length - 1],
      synthetic: true, modelTurnInitiated: false, deliveryPolicy: "intercepted real status pi.sendMessage" });
  }
  function facade(generation: Generation, extension: Extension): Host {
    const hooks = {
      factory(data: { extension: Extension; sentinel: string }) {
        if (data.extension !== extension) throw new Error("Factory instrumentation extension mismatch");
        generation.sentinels[extension] = data.sentinel;
        observe("factory_constructed", { candidateGeneration: generation.state.generation, extension, sentinel: data.sentinel });
      },
      use(data: { extension: Extension; sentinel: string; surface: string }) {
        const scope = scopes.getStore();
        observe("source_use", { candidateGeneration: generation.state.generation, extension: data.extension,
          sentinel: data.sentinel, surface: data.surface, origin: scope?.origin ?? "unscoped",
          token: scope?.token.serial ?? null, authorized: !!scope && authorized(generation, scope.token) });
      },
      observerStarted(signal: AbortSignal) {
        if (!signal || typeof signal.addEventListener !== "function" || typeof signal.aborted !== "boolean") {
          throw new Error("observerStarted requires the real AbortController signal");
        }
        if (!observers.has(signal)) {
          observers.set(signal, { generation, extension, signal, startedAt: new Date().toISOString(), settled: false });
          signal.addEventListener("abort", () => observe("observer_aborted", {
            candidateGeneration: generation.state.generation, extension, aborted: signal.aborted,
          }), { once: true });
        }
        observe("observer_started", { candidateGeneration: generation.state.generation, extension, aborted: signal.aborted });
      },
      observerStopped(signal: AbortSignal) {
        const observer = observers.get(signal);
        if (!observer) throw new Error("observerStopped received an unobserved signal");
        if (!signal.aborted) observer.settled = true;
        observe("observer_stopped", { candidateGeneration: generation.state.generation, extension,
          aborted: signal.aborted, settled: observer.settled });
      },
      attachStatus(adapter: StatusAdapter) {
        if (extension !== "status" || generation.status) throw new Error("Status adapter must be attached exactly once by the real status factory");
        generation.status = adapter;
        observe("status_attached", { candidateGeneration: generation.state.generation });
      },
    };
    const recorded: Definition = {
      __poc: hooks,
      on(name: string, callback: Callback) {
        if (generation.finalized) throw new Error("Registration after factory staging is outside the declared ABI");
        const callbacks = generation.events.get(name) ?? [];
        callbacks.push({ extension, callback });
        generation.events.set(name, callbacks);
      },
      registerCommand(name: string, definition: Definition) {
        if (generation.finalized || generation.commands.has(name)) throw new Error(`Invalid duplicate or late command: ${name}`);
        generation.commands.set(name, { extension, definition });
      },
      registerTool(definition: Definition) {
        const name = definition.name;
        if (typeof name !== "string" || generation.finalized || generation.tools.has(name)) throw new Error(`Invalid duplicate or late tool: ${String(name)}`);
        generation.tools.set(name, { extension, definition });
      },
      sendMessage(message: Definition, options: unknown) {
        const scope = scopes.getStore();
        if (extension !== "status") {
          return publish(generation, scope?.generation === generation ? scope.token : undefined, "pi.sendMessage", () => {
            const send = host.sendMessage;
            if (typeof send !== "function") throw new Error("Native host has no sendMessage API");
            return send.call(host, message, options);
          }).result;
        }
        return publish(generation, scope?.generation === generation ? scope.token : undefined, "status.sendMessage", () => {
          const delivery: Delivery = { message, options, session: scope?.ctx?.sessionManager.getSessionId() ?? "unknown", token: scope!.token };
          if (generation.phase === "starting") {
            generation.outbox.push(delivery);
            observe("notification_staged", { candidateGeneration: generation.state.generation, synthetic: true, modelTurnInitiated: false });
          } else deliver(generation, delivery);
        }).result;
      },
    };
    const forwarded = new WeakMap<object, object>();
    function forward(target: object, prefix: string): object {
      const cached = forwarded.get(target);
      if (cached) return cached;
      const proxy = new Proxy(target, {
        get(value, key) {
          const item = Reflect.get(value, key, value);
          if (typeof item === "function") return (...args: unknown[]) => {
            const scope = scopes.getStore();
            return publish(generation, scope?.generation === generation ? scope.token : undefined,
              `${prefix}.${String(key)}`, () => item.apply(value, args)).result;
          };
          return item && typeof item === "object" ? forward(item, `${prefix}.${String(key)}`) : item;
        },
      });
      forwarded.set(target, proxy);
      return proxy;
    }
    const native = forward(host, "pi") as Host;
    return new Proxy(recorded as Host, {
      get(target, key) { return Reflect.has(target, key) ? Reflect.get(target, key) : Reflect.get(native, key); },
    });
  }
  async function dispatch(generation: Generation, name: string, event: unknown, ctx: NativeContext, origin: string): Promise<unknown> {
    const token = generation.token;
    let result: unknown;
    for (const owner of generation.events.get(name) ?? []) {
      if (!authorized(generation, token)) break;
      const value = await run(generation, owner, [event, guardedContext(generation, token, ctx)], origin, ctx, token);
      if (value !== undefined) result = value;
      if (object(value).block === true) break;
    }
    return result;
  }
  function wrapDefinition(name: string, definition: Definition, tool: boolean): Definition {
    const registered = { ...definition };
    for (const [key, value] of Object.entries(definition)) {
      if (value !== "<function>" && typeof value !== "function") continue;
      registered[key] = (...args: unknown[]) => {
        const generation = active;
        const current = (tool ? generation?.tools : generation?.commands)?.get(name);
        const callback = current?.definition[key];
        if (!generation || !current || typeof callback !== "function") {
          if (key === "execute") throw new Error(`No active implementation for tool ${name}; restart OMP`);
          return undefined;
        }
        const token = generation.token;
        if (!authorized(generation, token)) return undefined;
        const contextIndex = tool ? 4 : 1;
        const ctx = args[contextIndex] as NativeContext | undefined;
        if (ctx?.ui) args[contextIndex] = guardedContext(generation, token, ctx);
        if (tool && key === "execute" && typeof args[3] === "function") {
          const onUpdate = args[3] as Callback;
          args[3] = (...updates: unknown[]) => publish(generation, token, `tool:${name}:onUpdate`, () => onUpdate(...updates)).result;
        }
        observe("callback_dispatch", { surface: `${tool ? "tool" : "command"}:${name}:${key}`,
          candidateGeneration: generation.state.generation, extension: current.extension, origin: "native_dispatch" });
        return run(generation, { extension: current.extension, callback: callback as Callback }, args, "native_dispatch", ctx, token);
      };
    }
    return registered;
  }
  function installSurface(): void {
    for (const name of installedManifest.events) installEvent(name);
    for (const command of installedManifest.commands) {
      const { name, ...definition } = command;
      if (commandSlots.has(String(name))) throw new Error(`Installed command collides with loader control: ${String(name)}`);
      host.registerCommand(String(name), wrapDefinition(String(name), definition, false));
      commandSlots.add(String(name));
    }
    for (const definition of installedManifest.tools) {
      const name = String(definition.name);
      host.registerTool(wrapDefinition(name, definition, true));
      toolSlots.add(name);
    }
  }
  async function deadline<T>(operation: Promise<T>, name: string): Promise<T> {
    const expiry = Promise.withResolvers<never>();
    const timer = setTimeout(() => expiry.reject(new Error(`${name} exceeded ${timeoutMs}ms`)), timeoutMs);
    try {
      return await Promise.race([operation, expiry.promise]);
    } finally { clearTimeout(timer); }
  }
  async function lifecycle(generation: Generation, name: "session_start" | "session_shutdown", ctx: NativeContext, inject = false): Promise<void> {
    const token = generation.token;
    for (const owner of generation.events.get(name) ?? []) {
      if (name === "session_start" && !authorized(generation, token)) throw new Error("Stale startup generation token");
      await run(generation, owner, [{ type: name }, guardedContext(generation, token, ctx)], `lifecycle:${name}`, ctx, token);
    }
    if (name !== "session_start" || !inject) return;
    if (generation.state.fault === "lifecycle") throw new Error("Injected lifecycle failure after real status+triage startup");
    if (generation.state.fault === "timeout") {
      observe("fault_timeout_scheduled", { requestId: generation.state.requestId,
        candidateGeneration: generation.state.generation, deadlineMs: timeoutMs, lateCompletionMs: timeoutMs * 3 });
      const late = Promise.withResolvers<void>();
      setTimeout(() => {
        const result = publish(generation, token, "fault.late_lifecycle_completion", () => ctx.ui.notify("PoC late lifecycle completion", "info"));
        observe("late_completion", { requestId: generation.state.requestId,
          candidateGeneration: generation.state.generation, stale: !authorized(generation, token),
          aborted: token.controller.signal.aborted, published: result.published });
        late.resolve();
      }, timeoutMs * 3);
      await late.promise;
    }
  }
  function revoke(generation: Generation): void { generation.token.controller.abort(new Error("Generation retired or startup aborted")); }
  async function stop(generation: Generation, ctx: NativeContext): Promise<void> {
    await deadline(lifecycle(generation, "session_shutdown", ctx), "session_shutdown");
    const remaining = [...observers.values()].filter(observer => observer.generation === generation && !observer.signal.aborted && !observer.settled);
    if (remaining.length) {
      scopes.run(scopeFor(generation, "status", "shutdown_abort_recovery", ctx), () => generation.status?.stop());
      if (remaining.some(observer => !observer.signal.aborted && !observer.settled)) throw new Error("Captured shutdown left a real observer active");
    }
  }
  function acquireLease(generation: Generation): void {
    const cacheKey = basename(generation.build);
    const cacheTuple = /^([^@]+)@([a-f0-9]{40})#([a-f0-9]{64})$/.exec(cacheKey);
    const filename = `${process.pid}-${generation.token.serial}-${digest(generation.state.requestId).slice(0, 12)}.json`;
    const file = join(leaseRoot, filename);
    const fd = openSync(file, "wx", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, generation: generation.state.generation,
        requestId: generation.state.requestId, build: generation.build,
        tuple: { version: generation.identity.version ?? null, commit: generation.identity.commit ?? null,
          digest: cacheTuple?.[3] ?? null },
        cacheKey, tupleProvenance: "identity.json and cache key; archive-byte SHA256 retained in builds/build-index.json",
        acquiredAt: new Date().toISOString(), policy: "retain after first import attempt until process exit" })}\n`);
    } catch (error) { closeSync(fd); unlinkSync(file); throw error; }
    generation.lease = { file, fd };
    leaseDescriptors.set(file, fd);
    observe("lease_acquired", { requestId: generation.state.requestId, candidateGeneration: generation.state.generation, leaseFile: file });
  }
  function releasePreimportLease(generation: Generation): void {
    if (!generation.lease || generation.importStarted) return;
    closeSync(generation.lease.fd);
    unlinkSync(generation.lease.file);
    leaseDescriptors.delete(generation.lease.file);
    observe("lease_released_preimport", { requestId: generation.state.requestId, leaseFile: generation.lease.file });
    generation.lease = undefined;
  }
  function take(generation: Generation): Queues {
    return scopes.run(scopeFor(generation, "status", "queue_transfer", currentContext), () => generation.status?.takeQueue() ?? new Map());
  }
  function put(generation: Generation, queues: Queues): void {
    scopes.run(scopeFor(generation, "status", "queue_transfer", currentContext), () => generation.status!.putQueue(queues));
  }
  function restoreOutbox(generation: Generation, queues: Queues): void {
    for (const delivery of generation.outbox.splice(0).reverse()) {
      const content = delivery.message.content;
      if (typeof content !== "string") throw new Error("Real status notification did not contain its queued string");
      const queue = queues.get(delivery.session) ?? { messages: [], claimed: false };
      queue.messages.unshift(content);
      queues.set(delivery.session, queue);
    }
  }
  function commitOutbox(generation: Generation): void {
    for (const delivery of generation.outbox.splice(0)) deliver(generation, delivery);
  }
  async function prepare(state: RequestedState, ctx: NativeContext): Promise<Generation | undefined> {
    let build: string;
    let identity: Definition;
    let abi: string;
    try {
      build = realpathSync(isAbsolute(state.build) ? state.build : resolve(runtimeRoot, state.build));
      identity = object(JSON.parse(readFileSync(join(build, "identity.json"), "utf8")));
      const declaredABI = manifestString(identity.pocRegistrationManifest);
      if (state.fault === "manifest") {
        const injected = JSON.parse(declaredABI) as Manifest;
        injected.commands.push({ name: "poc-injected-manifest-mismatch", description: "Deterministic pre-import manifest fault" });
        abi = manifestString(injected);
      } else abi = declaredABI;
      observe("manifest_gate_checked", { requestId: state.requestId, candidateGeneration: state.generation,
        declaredManifestHash: digest(declaredABI), candidateManifestHash: digest(abi),
        installedManifestHash: digest(installedABI), injectedManifestMismatch: state.fault === "manifest",
        declaredLoaderProtocol: identity.pocLoaderProtocol ?? null, declaredLauncherProtocol: identity.pocLauncherProtocol ?? null });
      if (identity.pocLoaderProtocol !== LOADER_PROTOCOL || identity.pocLauncherProtocol !== LAUNCHER_PROTOCOL) {
        throw new Error("Required loader/launcher protocol mismatch");
      }
      if (installedABI !== abi || (active && active.abi !== abi)) {
        throw new Error("Registration manifest differs from the installed/current host ABI");
      }
    } catch (error) {
      phase = "idle";
      notify(ctx, `PoC manifest/protocol gate: ${failure(error)}; restart OMP. Active generation unchanged.`, "warning");
      observe("manifest_rejected", { requestId: state.requestId, candidateGeneration: state.generation,
        fault: state.fault ?? null, reason: failure(error), importStarted: false, leaseAcquired: false, restartRequired: true });
      return undefined;
    }
    const generation: Generation = {
      state, build, identity, abi, manifest: JSON.parse(abi) as Manifest, token: newToken(), phase: "staging",
      events: new Map(), commands: new Map(), tools: new Map(), sentinels: {},
      finalized: false, importStarted: false, outbox: [],
    };
    generations.add(generation);
    try {
      acquireLease(generation);
      const statusPath = state.fault === "import"
        ? join(build, "src", `poc-missing-import-${generation.token.serial}.ts`)
        : join(build, "src", "status", "index.ts");
      const statusSpecifier = pathToFileURL(statusPath).href;
      observe("import_attempt", { requestId: state.requestId, candidateGeneration: state.generation, extension: "status", specifier: statusSpecifier });
      // Cache roots and import identities are selected by runtime state, not known at author time.
      generation.importStarted = true;
      const status = await import(statusSpecifier);
      const triagePath = join(build, "src", "triage", "native.ts");
      const triageSpecifier = pathToFileURL(triagePath).href;
      observe("import_attempt", { requestId: state.requestId, candidateGeneration: state.generation, extension: "triage", specifier: triageSpecifier });
      const triage = await import(triageSpecifier);
      if (typeof status.default !== "function" || typeof triage.default !== "function") throw new Error("Candidate has no real default extension factories");
      await scopes.run(scopeFor(generation, "status", "factory", ctx), () => status.default(facade(generation, "status")));
      if (state.fault === "factory2") throw new Error("Injected second-factory failure after real status factory");
      await scopes.run(scopeFor(generation, "triage", "factory", ctx), () => triage.default(facade(generation, "triage")));
      generation.finalized = true;
      const actual = manifestString(manifestOf(generation.commands, generation.tools, generation.events));
      if (actual !== abi || actual !== installedABI || (active && actual !== active.abi)) {
        throw new Error("Constructed registrations do not match identity manifest/installed/current ABI");
      }
      if (!generation.status || !generation.sentinels.status || !generation.sentinels.triage) throw new Error("Real source instrumentation hooks are missing");
      observe("candidate_staged", { requestId: state.requestId, candidateGeneration: state.generation, manifestHash: digest(actual) });
      return generation;
    } catch (error) {
      revoke(generation);
      generation.phase = "failed";
      try { await stop(generation, ctx); }
      catch (shutdownError) { observe("candidate_shutdown_error", { requestId: state.requestId, reason: failure(shutdownError) }); }
      releasePreimportLease(generation);
      phase = "idle";
      notify(ctx, `PoC candidate rejected before activation: ${failure(error)}`, "error");
      observe("candidate_failed", { requestId: state.requestId, candidateGeneration: state.generation,
        fault: state.fault ?? null, reason: failure(error), importStarted: generation.importStarted,
        leaseRetained: generation.importStarted && !!generation.lease });
      return undefined;
    }
  }
  async function transaction(state: RequestedState, ctx: NativeContext): Promise<boolean> {
    phase = "preimport_gate";
    observe("transition_requested", { requestId: state.requestId, candidateGeneration: state.generation, fault: state.fault ?? null });
    const generation = await prepare(state, ctx);
    if (!generation || shuttingDown) return false;
    const previous = active;
    phase = "quiescing";
    try {
      if (previous) {
        revoke(previous);
        await stop(previous, ctx);
        previous.phase = "retired";
        handoff = { queues: take(previous), from: previous };
        observe("queue_taken", { requestId: state.requestId, fromGeneration: previous.state.generation,
          candidateGeneration: state.generation, transferredCount: queueSize(handoff.queues), held: queueHeld(handoff.queues) });
        put(generation, handoff.queues);
        handoff = undefined;
      }
      generation.phase = "starting";
      active = generation;
      phase = "candidate_starting";
      observe("active_ref_switched", { requestId: state.requestId, candidateGeneration: state.generation,
        previousGeneration: previous?.state.generation ?? null, combinedExtensions: ["status", "triage"] });
      await deadline(lifecycle(generation, "session_start", ctx, true), "session_start");
      if (!authorized(generation, generation.token)) throw new Error("Candidate startup completed with a stale token");
      generation.phase = "active";
      phase = "idle";
      commitOutbox(generation);
      observe("transition_committed", { requestId: state.requestId, candidateGeneration: state.generation,
        previousGeneration: previous?.state.generation ?? null, fault: state.fault ?? null });
      return true;
    } catch (error) {
      phase = "rolling_back";
      revoke(generation);
      try { await stop(generation, ctx); }
      catch (shutdownError) { observe("candidate_shutdown_error", { requestId: state.requestId, reason: failure(shutdownError) }); }
      const recovered = take(generation);
      restoreOutbox(generation, recovered);
      if (handoff) {
        for (const [session, queue] of handoff.queues) {
          const existing = recovered.get(session);
          if (existing) existing.messages.unshift(...queue.messages);
          else recovered.set(session, queue);
        }
        setQueueHeld(recovered, queueHeld(recovered) || queueHeld(handoff.queues));
        handoff = undefined;
      }
      generation.phase = "failed";
      if (previous) {
        put(previous, recovered);
        previous.token = newToken();
        previous.phase = "starting";
      }
      active = previous;
      observe("active_ref_rolled_back", { requestId: state.requestId, candidateGeneration: state.generation,
        restoredGeneration: previous?.state.generation ?? null, combinedExtensions: ["status", "triage"] });
      let rollbackError: string | null = null;
      if (previous) {
        try {
          await deadline(lifecycle(previous, "session_start", ctx), "rollback session_start");
          previous.phase = "active";
          commitOutbox(previous);
        } catch (restartError) { rollbackError = failure(restartError); }
      }
      phase = "idle";
      notify(ctx, `PoC startup aborted; both extensions rolled back${rollbackError ? `; restart failed: ${rollbackError}` : ""}: ${failure(error)}`, "error");
      observe("transition_rolled_back", { requestId: state.requestId, candidateGeneration: state.generation,
        restoredGeneration: previous?.state.generation ?? null, fault: state.fault ?? null,
        reason: failure(error), rollbackError, leaseRetained: !!generation.lease });
      return true;
    }
  }
  function consider(ctx: NativeContext, trigger: "session_start" | "deferred_agent_end"): Promise<boolean> {
    if (inFlight) { observe("single_flight_joined", { trigger }); return inFlight; }
    if (shuttingDown) return Promise.resolve(false);
    currentContext = ctx;
    let state: RequestedState;
    try { state = readRequested(runtimeRoot); }
    catch (error) {
      observe("state_read_failed", { trigger, reason: failure(error) });
      notify(ctx, `PoC state.json: ${failure(error)}`, "error");
      return Promise.resolve(false);
    }
    if (state.generation === active?.state.generation) return Promise.resolve(false);
    const key = JSON.stringify([state.generation, state.requestId]);
    if (key === lastAttemptKey) return Promise.resolve(false);
    lastAttemptKey = key;
    latestRequestId = state.requestId;
    observe("state_change_considered", { trigger, requestId: state.requestId, candidateGeneration: state.generation });
    inFlight = transaction(state, ctx).finally(() => { inFlight = undefined; });
    return inFlight;
  }
  function deferAfterAgentEnd(ctx: NativeContext): void {
    if (deferred || shuttingDown) return;
    deferred = setTimeout(() => {
      deferred = undefined;
      if (shuttingDown) return;
      const idle = ctx.isIdle();
      observe("deferred_idle", { trigger: "deferred_agent_end", idle });
      if (!idle) return;
      void consider(ctx, "deferred_agent_end").catch(error => {
        phase = "idle";
        observe("transition_unhandled_error", { reason: failure(error) });
        notify(ctx, `PoC transaction error: ${failure(error)}`, "error");
      });
    }, 0);
  }
  function nativeUsage(event: unknown): Definition {
    const messages = object(event).messages;
    const assistant = Array.isArray(messages) ? messages.filter(message => object(message).role === "assistant") : [];
    const fields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
    const totals: Definition = Object.fromEntries(fields.map(field => [field, null]));
    const entries = assistant.map(message => {
      const usage = object(object(message).usage);
      const entry: Definition = {};
      for (const field of fields) {
        const value = usage[field];
        entry[field] = typeof value === "number" && Number.isFinite(value) ? value : null;
        if (typeof entry[field] === "number") totals[field] = (typeof totals[field] === "number" ? totals[field] as number : 0) + (entry[field] as number);
      }
      return entry;
    });
    return { usageSource: "native agent_end.messages assistant usage; no content or costs",
      assistantMessageCount: assistant.length, usage: totals, assistantUsage: entries,
      turnDurationMs: turnStartedAt === undefined ? null : Date.now() - turnStartedAt };
  }
  function installEvent(name: string): void {
    if (eventSlots.has(name)) return;
    host.on(name, async (...args: unknown[]) => {
      const event = args[0];
      const ctx = args[1] as NativeContext;
      currentContext = ctx;
      if (name === "session_start") {
        const lifecycleHandled = await consider(ctx, "session_start");
        if (!lifecycleHandled && active) await deadline(lifecycle(active, "session_start", ctx), "native session_start");
        observe("session_start_observed");
        return undefined;
      }
      if (name === "session_shutdown") {
        shuttingDown = true;
        if (deferred) { clearTimeout(deferred); deferred = undefined; }
        for (const generation of generations) revoke(generation);
        for (const generation of generations) await stop(generation, ctx);
        phase = "shutdown";
        observe("session_shutdown_observed", { leasesRetainedUntilProcessExit: true });
        return undefined;
      }
      if (name === "agent_start") turnStartedAt = Date.now();
      if (name === "agent_end") observe("agent_end", nativeUsage(event));
      const generation = active;
      const result = generation ? await dispatch(generation, name, event, ctx, `native_event:${name}`) : undefined;
      if (name === "agent_end") deferAfterAgentEnd(ctx);
      return result;
    });
    eventSlots.add(name);
  }
  host.registerCommand("poc-observe", {
    description: "Observe native PoC state; queue <batch> holds three synthetic real-status notifications; release [count] pumps them; sentinel executes both real factories' callbacks. Never switches generations.",
    async handler(args: string, ctx: NativeContext) {
      currentContext = ctx;
      const [operation = "snapshot", argument] = args.trim().split(/\s+/).filter(Boolean);
      const generation = active;
      try {
        if (operation === "queue") {
          if (!generation?.status || inFlight) throw new Error("Queue probe requires a settled active generation");
          const batch = argument ?? `batch-${batches.size + 1}`;
          if (batches.has(batch)) throw new Error(`Queue probe batch already exists: ${batch}`);
          batches.add(batch);
          const ids: number[] = [];
          for (let index = 0; index < 3; index++) {
            const id = ++nextNotificationId;
            const message = `[POC SYNTHETIC NOTIFICATION] batch=${encodeURIComponent(batch)} notificationId=${id}`;
            enqueued.push({ id, batch, message });
            ids.push(id);
            scopes.run(scopeFor(generation, "status", "synthetic_queue_probe", ctx), () => generation.status!.enqueue(message, true));
          }
          observe("queue_enqueued", { batch, ids, synthetic: true, modelTurnInitiated: false });
        } else if (operation === "release") {
          if (!generation?.status || inFlight) throw new Error("Queue release requires a settled active generation");
          const count = argument === undefined ? 1 : Number(argument);
          if (!Number.isSafeInteger(count) || count < 1 || count > 1000) throw new Error("release count must be 1..1000");
          const before = delivered.length;
          for (let index = 0; index < count && queueSize(actualQueue(generation)); index++) {
            scopes.run(scopeFor(generation, "status", "synthetic_queue_probe", ctx), () => generation.status!.releaseOne());
          }
          observe("queue_released", { requestedCount: count, deliveredCount: delivered.length - before, synthetic: true, modelTurnInitiated: false });
        } else if (operation === "sentinel") {
          if (!generation || inFlight) throw new Error("Sentinel probe requires a settled active generation");
          const tool = generation.tools.get("dagu_session_id");
          const execute = tool?.definition.execute;
          if (!tool || typeof execute !== "function") throw new Error("Real status dagu_session_id tool is unavailable");
          const token = generation.token;
          const toolResult = await run(generation, { extension: tool.extension, callback: execute as Callback },
            [`poc-sentinel-${serial}`, {}, undefined, undefined, guardedContext(generation, token, ctx)], "synthetic_command_probe", ctx, token);
          const triageResult = await dispatch(generation, "tool_call", { type: "tool_call", toolName: "poc_observe_sentinel", toolCallId: `poc-sentinel-${serial}`, input: {} }, ctx, "synthetic_command_probe");
          observe("sentinel_observed", { synthetic: true, executedSurfaces: ["status:tool:dagu_session_id", "triage:event:tool_call"],
            toolReturnedSessionId: object(toolResult).details !== undefined, triageBlocked: object(triageResult).block === true });
        } else if (operation === "snapshot" || operation === "status" || operation === "registrations") {
          observe("control_observed", { operation });
        } else throw new Error("Use /poc-observe [snapshot|status|registrations|sentinel|queue <batch>|release [count]]");
        const state = snapshot();
        ctx.ui.notify(`PoC ${state.activeGeneration ?? "none"}: ${state.activeObserverCount} observer(s), ${filesystemLeases().length} lease(s), ${delivered.length} synthetic deliveries`, "info");
      } catch (error) {
        observe("control_error", { operation, reason: failure(error) });
        ctx.ui.notify(`PoC control: ${failure(error)}`, "error");
      }
    },
  });
  commandSlots.add("poc-observe");
  installEvent("session_start");
  installEvent("session_shutdown");
  installEvent("agent_start");
  installEvent("agent_end");
  // Bind host metadata before the extension factory returns; state is first read at session_start.
  installSurface();
  process.once("exit", () => {
    shuttingDown = true;
    clearTimeout(deferred);
    for (const generation of generations) {
      revoke(generation);
      scopes.run(scopeFor(generation, "status", "process_exit", currentContext), () => generation.status?.stop());
    }
    for (const [file, fd] of leaseDescriptors) {
      closeSync(fd);
      unlinkSync(file);
    }
    leaseDescriptors.clear();
    phase = "process_exit";
    observe("leases_released_on_exit");
  });
  observe("loader_registered", { generationChangesOnlyAt: ["session_start", "deferred_agent_end"],
    statePath: join(runtimeRoot, "state.json"), manifestPath, installedManifestHash: digest(installedABI), timeoutMs,
    notificationPolicy: "synthetic notification queue probe: intercept the real status pi.sendMessage; never initiate model turns" });
}
