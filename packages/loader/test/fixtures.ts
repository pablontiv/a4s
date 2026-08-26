import { setTimeout as delay } from "node:timers/promises";
import type { Factory, Host, ReloadContext } from "@a4s/hot-reload";
import { HELPER_API_VERSION } from "@a4s/hot-reload";
import { registrationHash, SHARED_FORMATS, type ArtifactIdentity } from "../../launcher/src/contracts.ts";
import { HotLoader } from "../src/index.ts";
import type { Selection } from "../src/station.ts";
export class FakeHost implements Host {
  events = new Map<string, ((...args: unknown[]) => unknown)[]>();
  messages: string[] = [];
  commands = new Map<string, Record<string, unknown>>();
  tools = new Map<string, Record<string, unknown>>();
  on(name: string, callback: (...args: unknown[]) => unknown): void {
    const callbacks = this.events.get(name) ?? []; callbacks.push(callback); this.events.set(name, callbacks);
  }
  registerCommand(name: string, command: Record<string, unknown>): void { this.commands.set(name, command); }
  registerTool(tool: Record<string, unknown>): void { this.tools.set(String(tool.name), tool); }
  sendMessage(message: string): void { this.messages.push(message); }
  async emit(name: string, context: ReloadContext): Promise<void> {
    for (const callback of this.events.get(name) ?? []) await callback({ type: name }, context);
  }
}
export function selection(generation: number): Selection {
  const manifest = { schema: 1, loaderHelperApi: HELPER_API_VERSION, extensions: ["./src/status/index.ts", "./src/triage/native.ts"], commands: [], tools: [], resources: {} };
  const support = Object.fromEntries(SHARED_FORMATS.map(name => [name, { read: [1], write: 1 }])) as unknown as ArtifactIdentity["support"];
  const tuple = { version: `r${generation}`, commit: "a".repeat(40), digest: "b".repeat(64) };
  return { generation, directory: `/build/${generation}`, identity: { ...tuple, support, requiredLauncherProtocol: 1, requiredLoaderProtocol: 1,
    dispatch: "a4s-run/1", protocols: {}, registrationManifest: manifest, registrationManifestHash: registrationHash(manifest) },
  state: { schema: 1, generation, current: tuple, previous: tuple, rejected: [],
    formats: Object.fromEntries(SHARED_FORMATS.map(name => [name, [1]])) as Selection["state"]["formats"] } };
}
export function harness() {
  const host = new FakeHost();
  const notices: string[] = [];
  let idle = true;
  const context: ReloadContext = { isIdle: () => idle, ui: { notify: text => { notices.push(text); } } };
  let candidate = selection(1);
  const factories = new Map<string, Factory<object>>();
  let observers = 0;
  let leases = 0;
  let released = 0;
  let imports = 0;
  let restoreFailure = false;
  const producer = (name: string, fail?: "start" | "timeout"): Factory<object> => (api, scope) => {
    const pi = api as FakeHost;
    pi.on("session_start", async () => {
      observers++;
      let stopped = false;
      scope.onAbort(() => { if (!stopped) { stopped = true; observers--; } });
      const queue = (scope.state.get("queue") as string[] | undefined) ?? [];
      scope.state.set("queue", queue);
      if (fail === "start") { queue.push("from-failed-candidate"); throw new Error("startup rejected"); }
      if (fail === "timeout") {
        await delay(60);
        pi.sendMessage("stale");
        if (scope.signal.aborted) return;
      }
      scope.state.set("producer", name);
    });
    scope.onCommit(() => {
      const queue = scope.state.get("queue") as string[] | undefined;
      while (queue?.length) pi.sendMessage(queue.shift()!);
    });
    pi.on("produce", () => { pi.sendMessage(name); });
  };
  const assign = (generation: number, factory = producer(String(generation)), triage: Factory<object> = () => {}) => {
    factories.set(`file:///build/${generation}/src/status/index.ts`, factory);
    factories.set(`file:///build/${generation}/src/triage/native.ts`, triage);
  };
  assign(1); assign(2);
  const loader = new HotLoader(host, {
    select: async () => candidate,
    lease: async () => { leases++; return { release: () => { released++; } }; },
    resolveDirectory: async directory => { if (restoreFailure) throw new Error("restore failed before import"); return directory; },
    importModule: async url => { imports++; const factory = factories.get(url); if (!factory) throw new Error("missing import"); return { default: factory }; },
    timeout: 15, pollInterval: 60_000,
  });
  return { host, context, loader, notices, producer, assign,
    setCandidate(value: Selection) { candidate = value; },
    setIdle(value: boolean) { idle = value; },
    setRestoreFailure(value: boolean) { restoreFailure = value; },
    counts: () => ({ observers, leases, released, imports }),
  };
}
