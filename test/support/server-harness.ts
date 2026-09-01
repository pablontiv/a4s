import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket, createConnection } from "node:net";
import { createRunEndpoint } from "../../src/daemon/endpoint.ts";
import { E0Server, type ServerEvent } from "../../src/daemon/server.ts";
import { FrameDecoder } from "../../src/protocol/framing.ts";
import { parseMessage, type AttachMessage, type ProtocolMessage } from "../../src/protocol/messages.ts";

export interface ServerHarness {
  server: E0Server;
  events: ServerEvent[];
  endpoint: string;
  connectRaw(): Promise<Socket>;
  connectAndAttach(): Promise<Socket>;
  readOne(socket: Socket): Promise<ProtocolMessage>;
  expectClosed(socket: Socket): Promise<void>;
  close(): Promise<void>;
}

interface SocketState {
  decoder: FrameDecoder;
  queue: ProtocolMessage[];
  signal: EventEmitter;
  error?: Error;
}

interface HarnessOptions {
  expectedOwnerId?: string;
  expectedBindingRevision?: 1;
}

const DEFAULT_OWNER_ID = "W1";
const DEADLINE_MS = 2_000;

export async function createServerHarness(options: HarnessOptions = {}): Promise<ServerHarness> {
  const root = await mkdtemp(join(tmpdir(), "a4s-e0-server-"));
  const endpoint = createRunEndpoint("run-1", root, process.platform);
  const clients = new Set<Socket>();
  const states = new WeakMap<Socket, SocketState>();
  const events: ServerEvent[] = [];
  const server = new E0Server({
    endpoint,
    expectedOwnerId: options.expectedOwnerId ?? DEFAULT_OWNER_ID,
    expectedBindingRevision: options.expectedBindingRevision ?? 1,
    onEvent(event) {
      events.push(event);
    },
  });

  await server.start();

  async function connectRaw(): Promise<Socket> {
    const socket = createConnection(endpoint);
    const state: SocketState = {
      decoder: new FrameDecoder(),
      queue: [],
      signal: new EventEmitter(),
    };
    states.set(socket, state);
    clients.add(socket);

    socket.on("data", (chunk: Buffer) => {
      try {
        for (const value of state.decoder.push(chunk)) {
          state.queue.push(parseMessage(value));
        }
        state.signal.emit("change");
      } catch (error) {
        state.error = error instanceof Error ? error : new Error(String(error));
        state.signal.emit("change");
      }
    });
    socket.once("close", () => {
      clients.delete(socket);
      state.signal.emit("change");
    });
    socket.once("error", (error) => {
      state.error = error;
      state.signal.emit("change");
    });

    await withDeadline(once(socket, "connect").then(() => undefined), "socket connect");
    return socket;
  }

  async function connectAndAttach(): Promise<Socket> {
    const socket = await connectRaw();
    socket.write(await attachFrame(root));
    return socket;
  }

  async function readOne(socket: Socket): Promise<ProtocolMessage> {
    const state = requireState(states, socket);
    await waitUntil(state, () => state.queue.length > 0 || state.error !== undefined);
    if (state.error) throw state.error;
    const message = state.queue.shift();
    if (!message) throw new Error("message queue unexpectedly empty");
    return message;
  }

  async function expectClosed(socket: Socket): Promise<void> {
    if (socket.closed || socket.destroyed) return;
    await waitUntil(requireState(states, socket), () => socket.closed || socket.destroyed);
  }

  async function close(): Promise<void> {
    for (const client of clients) {
      client.destroy();
    }
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }

  return { server, events, endpoint, connectRaw, connectAndAttach, readOne, expectClosed, close };
}

export function createAttach(ownerId = DEFAULT_OWNER_ID, messageId = "M-attach"): AttachMessage {
  return {
    protocol_version: 1,
    message_id: messageId,
    type: "attach",
    payload: {
      owner_id: ownerId,
      binding_revision: 1,
      native_ref: {
        session_id: "session-1",
        session_file: "/tmp/a4s-e0-session.jsonl",
      },
    },
  };
}

async function attachFrame(root: string): Promise<Buffer> {
  const { encodeFrame } = await import("../../src/protocol/framing.ts");
  const attach = createAttach();
  return encodeFrame({
    ...attach,
    payload: {
      ...attach.payload,
      native_ref: {
        ...attach.payload.native_ref,
        session_file: join(root, "session.jsonl"),
      },
    },
  });
}

function requireState(states: WeakMap<Socket, SocketState>, socket: Socket): SocketState {
  const state = states.get(socket);
  if (!state) throw new Error("unknown socket");
  return state;
}

async function waitUntil(state: SocketState, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  while (!predicate()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("timed out waiting for socket event");
    await withDeadline(once(state.signal, "change").then(() => undefined), "socket event", remaining);
  }
}

async function withDeadline<T>(promise: Promise<T>, label: string, ms = DEADLINE_MS): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
