import { homedir } from "node:os";
import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Dispatcher, Generation, HELPER_API_VERSION, LIFECYCLE_TIMEOUT_MS, RELOAD_INPUT, switchGeneration,
  type Factory, type Host, type ReloadContext } from "@a4s/hot-reload";
import { assertManifest, validateRegistrations } from "./manifest.ts";
import { leaseSelection, stationSelection, type Lease, type Selection } from "./station.ts";
export { LOADER_PROTOCOL } from "./manifest.ts";
export { HELPER_API_VERSION };
export interface LoaderDependencies {
  select(): Promise<Selection>;
  lease(selection: Selection): Promise<Lease>;
  importModule(url: string): Promise<{ default: Factory<object> }>;
  resolveDirectory?: (directory: string) => Promise<string>;
  timeout?: number;
  pollInterval?: number;
}

export class HotLoader {
  readonly dispatcher: Dispatcher;
  private current: Selection | undefined;
  private attempted: number | undefined;
  private state = new Map<string, unknown>();
  private inFlight: Promise<void> | undefined;
  private context: ReloadContext | undefined;
  private timer: NodeJS.Timeout | undefined;
  private poll: NodeJS.Timeout | undefined;
  private stopped = false;
  constructor(private api: object, private dependencies: LoaderDependencies) {
    this.dispatcher = new Dispatcher(api as Host);
  }
  private async prepare(selection: Selection): Promise<Generation> {
    assertManifest(selection.identity, this.current?.identity);
    const lease = await this.dependencies.lease(selection);
    let importStarted = false;
    const next = new Generation(this.state);
    try {
      const directory = await (this.dependencies.resolveDirectory ?? realpath)(selection.directory);
      if (directory !== selection.directory) throw new Error("Candidate build directory changed after lease");
      // Everything above this line may safely release its lease. Import may evaluate code
      // even when its promise rejects: every subsequent outcome retains the lease to exit.
      const statusUrl = pathToFileURL(`${directory}/src/status/index.ts`).href;
      const triageUrl = pathToFileURL(`${directory}/src/triage/native.ts`).href;
      importStarted = true;
      const status = await this.dependencies.importModule(statusUrl);
      const triage = await this.dependencies.importModule(triageUrl);
      await next.record(this.api, status.default);
      await next.record(this.api, triage.default);
      validateRegistrations(next, selection.identity);
      return next;
    } catch (error) {
      next.abort();
      if (!importStarted) lease.release();
      throw error;
    }
  }
  async initialize(): Promise<void> {
    const selection = await this.dependencies.select();
    const initial = await this.prepare(selection);
    this.dispatcher.publish(initial);
    this.dispatcher.active = initial;
    initial.commit();
    this.current = selection;
    const host = this.api as Host;
    host.on("session_start", (...args) => { this.request(args[1] as ReloadContext); });
    host.on("agent_end", (...args) => { this.request(args[1] as ReloadContext); });
    host.on("input", (...args) => {
      const event = args[0] as { text: string; source: string };
      if (event.source !== "extension" && RELOAD_INPUT.test(event.text)) {
        this.attempted = undefined;
        this.request(args[1] as ReloadContext);
      }
    });
    host.on("session_shutdown", () => { this.dispose(); });
    this.poll = setInterval(() => { if (this.context) this.request(this.context); }, this.dependencies.pollInterval ?? 1000);
    this.poll.unref();
  }
  /** Always defer: the host is busy until all agent_end callbacks have returned. */
  request(context: ReloadContext): void {
    if (this.stopped) return;
    this.context = context;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.stopped && this.context?.isIdle()) void this.check(this.context);
    }, 0);
  }
  check(context: ReloadContext): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const selection = await this.dependencies.select();
        if (selection.generation === this.current?.generation || selection.generation === this.attempted) return;
        this.attempted = selection.generation;
        const next = await this.prepare(selection);
        if (this.stopped) { next.abort(); return; }
        await switchGeneration(this.dispatcher, next, context, this.dependencies.timeout ?? LIFECYCLE_TIMEOUT_MS);
        this.current = selection;
      } catch (error) { context.ui.notify(`A4s hot switch: ${String(error)}`, "error"); }
      finally { this.inFlight = undefined; }
    })();
    return this.inFlight;
  }
  dispose(): void {
    this.stopped = true;
    clearTimeout(this.timer); clearInterval(this.poll);
    this.dispatcher.active?.abort();
    this.dispatcher.active = undefined;
  }
}

export default async function loader(api: object): Promise<void> {
  const home = process.env.DAGU_HOME ?? `${homedir()}/.dagu`;
  const loader = new HotLoader(api, {
    select: () => stationSelection(home), lease: selection => leaseSelection(home, selection),
    importModule: url => import(url),
  });
  await loader.initialize();
}
