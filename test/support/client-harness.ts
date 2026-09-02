import { join } from "node:path";
import { E0Server } from "../../src/daemon/server.ts";
import { E0PiClient, type ClientEvent } from "../../src/pi-extension/client.ts";
import { createServerHarness } from "./server-harness.ts";

export interface ClientHarness {
  server: E0Server;
  client: E0PiClient;
  clientEvents: ClientEvent[];
  waitForClientEvent(event: string): Promise<ClientEvent>;
  waitForServerCounts(expected: { pending: number; acknowledged: number }): Promise<void>;
  close(): Promise<void>;
}

interface ClientHarnessOptions {
  reconnectDelaysMs?: readonly number[];
}

const DEADLINE_MS = 2_000;

export async function createClientHarness(options: ClientHarnessOptions = {}): Promise<ClientHarness> {
  const serverHarness = await createServerHarness({ expectedOwnerId: "W1", expectedBindingRevision: 1 });
  const clientEvents: ClientEvent[] = [];
  let closed = false;

  const client = new E0PiClient({
    endpoint: serverHarness.endpoint,
    attach: {
      owner_id: "W1",
      binding_revision: 1,
      native_ref: {
        session_id: "session-1",
        session_file: join(process.cwd(), "synthetic-session.jsonl"),
      },
    },
    ...(options.reconnectDelaysMs ? { reconnectDelaysMs: options.reconnectDelaysMs } : {}),
    onEvent(event) {
      clientEvents.push(event);
    },
  });

  async function waitForClientEvent(event: string): Promise<ClientEvent> {
    await waitUntil(() => clientEvents.some((entry) => entry.event === event));
    const match = clientEvents.find((entry) => entry.event === event);
    if (!match) throw new Error(`client event ${event} unexpectedly missing`);
    return match;
  }

  async function waitForServerCounts(expected: { pending: number; acknowledged: number }): Promise<void> {
    await waitUntil(() => countsEqual(serverHarness.server.counts(), expected));
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    await client.stop();
    await serverHarness.close();
  }

  return {
    server: serverHarness.server,
    client,
    clientEvents,
    waitForClientEvent,
    waitForServerCounts,
    close,
  };
}

function countsEqual(actual: { pending: number; acknowledged: number }, expected: { pending: number; acknowledged: number }): boolean {
  return actual.pending === expected.pending && actual.acknowledged === expected.acknowledged;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for predicate");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
