import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ExtensionContext, ExtensionHandler, SessionShutdownEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { createRunEndpoint } from "../src/daemon/endpoint.ts";
import { encodeFrame, FrameDecoder } from "../src/protocol/framing.ts";
import { createAttached, createDelivery, parseMessage } from "../src/protocol/messages.ts";
import a4sE0Extension from "../src/pi-extension/index.ts";
import { E0PiClient } from "../src/pi-extension/client.ts";
import { createClientHarness } from "./support/client-harness.ts";
import { createServerHarness } from "./support/server-harness.ts";

test("client attaches, processes a Delivery once, and ACKs", async () => {
  const harness = await createClientHarness();
  try {
    harness.server.enqueueProbe("D1", "nonce-1");
    await harness.client.start();
    await harness.waitForClientEvent("delivery_processed");
    await harness.waitForServerCounts({ pending: 0, acknowledged: 1 });
    assert.deepEqual(harness.server.counts(), { pending: 0, acknowledged: 1 });
    assert.equal(harness.clientEvents.filter((event) => event.event === "delivery_processed").length, 1);
  } finally {
    await harness.close();
  }
});

test("client deduplicates redelivery after a lost ACK", async () => {
  const harness = await createClientHarness({ reconnectDelaysMs: [1, 2, 5] });
  try {
    harness.server.faults.dropNextAckAndDisconnect();
    harness.server.enqueueProbe("D1", "nonce-1");
    await harness.client.start();
    await harness.waitForServerCounts({ pending: 0, acknowledged: 1 });
    assert.equal(harness.clientEvents.filter((event) => event.event === "delivery_processed").length, 1);
    assert.equal(harness.clientEvents.filter((event) => event.event === "delivery_duplicate").length, 1);
  } finally {
    await harness.close();
  }
});

test("client reconnects after a server-driven disconnect and receives pending Delivery", async () => {
  const harness = await createClientHarness({ reconnectDelaysMs: [1, 2, 5] });
  try {
    await harness.client.start();
    await harness.waitForClientEvent("attached");
    harness.server.enqueueProbe("D2", "nonce-2");
    harness.server.disconnectClient();
    await harness.waitForClientEvent("reconnect_scheduled");
    await harness.waitForClientEvent("delivery_processed");
    assert.deepEqual(harness.server.counts(), { pending: 0, acknowledged: 1 });
    assert.equal(harness.clientEvents.filter((event) => event.event === "attached").length >= 2, true);
  } finally {
    await harness.close();
  }
});

test("client deduplicates duplicate physical Delivery frames", async () => {
  const harness = await createClientHarness({ reconnectDelaysMs: [1, 2, 5] });
  try {
    harness.server.faults.duplicateNextDelivery();
    harness.server.enqueueProbe("D1", "nonce-1");
    await harness.client.start();
    await harness.waitForClientEvent("delivery_duplicate");
    await harness.waitForServerCounts({ pending: 0, acknowledged: 1 });
    assert.equal(harness.clientEvents.filter((event) => event.event === "delivery_processed").length, 1);
    assert.equal(harness.clientEvents.filter((event) => event.event === "delivery_duplicate").length, 1);
  } finally {
    await harness.close();
  }
});

test("client does not reconnect after stop during backoff", async () => {
  const harness = await createClientHarness({ reconnectDelaysMs: [200] });
  try {
    await harness.client.start();
    await harness.waitForClientEvent("attached");
    harness.server.disconnectClient();
    await harness.waitForClientEvent("reconnect_scheduled");
    await harness.client.stop();
    const connectedAtStop = harness.clientEvents.filter((event) => event.event === "connected").length;
    await sleep(250);
    assert.equal(harness.clientEvents.filter((event) => event.event === "connected").length, connectedAtStop);
  } finally {
    await harness.close();
  }
});

test("client rejects an attached response with the wrong correlation", async () => {
  const root = await mkdtemp(join(tmpdir(), "a4s-e0-wrong-attached-"));
  const endpoint = createRunEndpoint("run-1", root, process.platform);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", () => socket.write(encodeFrame(createAttached("wrong-message", "W1"))));
  });
  await mkdir(dirname(endpoint), { recursive: true, mode: 0o700 });
  await listen(server, endpoint);
  const events: { event: string; detail?: string }[] = [];
  const client = new E0PiClient({
    endpoint,
    attach: {
      owner_id: "W1",
      binding_revision: 1,
      native_ref: { session_id: "session-1", session_file: join(root, "session.jsonl") },
    },
    reconnectDelaysMs: [50],
    onEvent: (event) => events.push(event),
  });

  try {
    await assert.rejects(() => client.start(), /attached response does not match attach request/);
    assert.equal(events.some((event) => event.event === "attached"), false);
  } finally {
    await client.stop();
    for (const socket of sockets) socket.destroy();
    await closeServer(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("client rejects a Delivery addressed to another owner without processing or ACKing", async () => {
  const root = await mkdtemp(join(tmpdir(), "a4s-e0-wrong-owner-"));
  const endpoint = createRunEndpoint("run-1", root, process.platform);
  const sockets = new Set<Socket>();
  let ackReceived = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const decoder = new FrameDecoder();
    socket.on("data", (chunk: Buffer) => {
      for (const value of decoder.push(chunk)) {
        const message = parseMessage(value);
        if (message.type === "attach") {
          socket.write(encodeFrame(createAttached(message.message_id, "W1")));
          socket.write(encodeFrame(createDelivery("D-wrong", "W2", "nonce")));
        } else if (message.type === "delivery_ack") {
          ackReceived = true;
        }
      }
    });
  });
  await mkdir(dirname(endpoint), { recursive: true, mode: 0o700 });
  await listen(server, endpoint);
  const events: { event: string; detail?: string }[] = [];
  const client = new E0PiClient({
    endpoint,
    attach: {
      owner_id: "W1",
      binding_revision: 1,
      native_ref: { session_id: "session-1", session_file: join(root, "session.jsonl") },
    },
    reconnectDelaysMs: [50],
    onEvent: (event) => events.push(event),
  });

  try {
    await client.start();
    await sleep(25);
    assert.equal(events.some((event) => event.event === "delivery_processed"), false);
    assert.equal(events.some((event) => event.event === "error" && /owner_id/.test(event.detail ?? "")), true);
    assert.equal(ackReceived, false);
  } finally {
    await client.stop();
    for (const socket of sockets) socket.destroy();
    await closeServer(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("client emits an error for an invalid server frame", async () => {
  const root = await mkdtemp(join(tmpdir(), "a4s-e0-invalid-server-"));
  const endpoint = createRunEndpoint("run-1", root, process.platform);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", () => {
      socket.write(invalidJsonFrame());
      socket.destroySoon();
    });
  });
  await mkdir(dirname(endpoint), { recursive: true, mode: 0o700 });
  await listen(server, endpoint);

  const events: { event: string; detail?: string }[] = [];
  const client = new E0PiClient({
    endpoint,
    attach: {
      owner_id: "W1",
      binding_revision: 1,
      native_ref: { session_id: "session-1", session_file: join(root, "session.jsonl") },
    },
    reconnectDelaysMs: [50],
    onEvent: (event) => events.push(event),
  });

  try {
    await assert.rejects(() => client.start(), /invalid JSON|timed out/i);
    assert.equal(events.some((event) => event.event === "error" && /invalid JSON/.test(event.detail ?? "")), true);
  } finally {
    await client.stop();
    for (const socket of sockets) socket.destroy();
    await closeServer(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi adapter starts from environment configuration and shuts down cleanly", async () => {
  const harness = await createServerHarness();
  const previousEnv = snapshotEnv();
  try {
    process.env.A4S_ENDPOINT = harness.endpoint;
    process.env.A4S_OWNER_ID = "W1";
    process.env.A4S_BINDING_REVISION = "1";

    const lifecycle = createLifecycleHarness();
    a4sE0Extension(lifecycle.pi);
    await lifecycle.sessionStart({ sessionId: "session-1", sessionFile: join(process.cwd(), "adapter-session.jsonl") });
    assert.equal(harness.events.some((event) => event.event === "client_connected"), true);
    assert.equal(harness.events.some((event) => event.event === "message_received" && event.detail === "attach"), true);
    await lifecycle.sessionShutdown();
  } finally {
    restoreEnv(previousEnv);
    await harness.close();
  }
});

test("Pi adapter rejects missing attach configuration", async () => {
  const previousEnv = snapshotEnv();
  try {
    delete process.env.A4S_ENDPOINT;
    delete process.env.A4S_OWNER_ID;
    delete process.env.A4S_BINDING_REVISION;

    const lifecycle = createLifecycleHarness();
    a4sE0Extension(lifecycle.pi);
    await assert.rejects(
      () => lifecycle.sessionStart({ sessionId: "session-1", sessionFile: join(process.cwd(), "adapter-session.jsonl") }),
      /E0 requires A4S_ENDPOINT/,
    );
  } finally {
    restoreEnv(previousEnv);
  }
});

test("Pi adapter startup deadline rejects when attach never completes", async () => {
  const root = await mkdtemp(join(tmpdir(), "a4s-e0-deadline-"));
  const endpoint = createRunEndpoint("run-1", root, process.platform);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("data", () => undefined);
  });
  await mkdir(dirname(endpoint), { recursive: true, mode: 0o700 });
  await listen(server, endpoint);
  const previousEnv = snapshotEnv();

  try {
    process.env.A4S_ENDPOINT = endpoint;
    process.env.A4S_OWNER_ID = "W1";
    process.env.A4S_BINDING_REVISION = "1";

    const lifecycle = createLifecycleHarness();
    a4sE0Extension(lifecycle.pi);
    await assert.rejects(
      () => lifecycle.sessionStart({ sessionId: "session-1", sessionFile: join(root, "adapter-session.jsonl") }),
      /timed out waiting for E0 attach/,
    );
    await lifecycle.sessionShutdown();
  } finally {
    restoreEnv(previousEnv);
    for (const socket of sockets) socket.destroy();
    await closeServer(server);
    await rm(root, { recursive: true, force: true });
  }
});

function createLifecycleHarness(): {
  pi: Parameters<typeof a4sE0Extension>[0];
  sessionStart(options: { sessionId: string; sessionFile?: string }): Promise<void>;
  sessionShutdown(): Promise<void>;
} {
  const handlers: Partial<{
    session_start: ExtensionHandler<SessionStartEvent>;
    session_shutdown: ExtensionHandler<SessionShutdownEvent>;
  }> = {};

  const pi = {
    on(event: string, handler: ExtensionHandler<SessionStartEvent> | ExtensionHandler<SessionShutdownEvent>) {
      if (event === "session_start") handlers.session_start = handler as ExtensionHandler<SessionStartEvent>;
      if (event === "session_shutdown") handlers.session_shutdown = handler as ExtensionHandler<SessionShutdownEvent>;
    },
  } as Parameters<typeof a4sE0Extension>[0];

  async function sessionStart(options: { sessionId: string; sessionFile?: string }): Promise<void> {
    if (!handlers.session_start) throw new Error("session_start handler was not registered");
    await handlers.session_start(
      { type: "session_start", reason: "startup" } as SessionStartEvent,
      createContext(options),
    );
  }

  async function sessionShutdown(): Promise<void> {
    if (!handlers.session_shutdown) return;
    await handlers.session_shutdown(
      { type: "session_shutdown", reason: "quit" } as SessionShutdownEvent,
      createContext({ sessionId: "session-1", sessionFile: join(process.cwd(), "adapter-session.jsonl") }),
    );
  }

  return { pi, sessionStart, sessionShutdown };
}

function createContext(options: { sessionId: string; sessionFile?: string }): ExtensionContext {
  return {
    sessionManager: {
      getSessionId: () => options.sessionId,
      getSessionFile: () => options.sessionFile,
    },
  } as ExtensionContext;
}

function snapshotEnv(): Record<string, string | undefined> {
  return {
    A4S_ENDPOINT: process.env.A4S_ENDPOINT,
    A4S_OWNER_ID: process.env.A4S_OWNER_ID,
    A4S_BINDING_REVISION: process.env.A4S_BINDING_REVISION,
    A4S_E0_TRACE: process.env.A4S_E0_TRACE,
  };
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function invalidJsonFrame(): Buffer {
  const payload = Buffer.from("{", "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

function listen(server: ReturnType<typeof createServer>, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
