import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, unlink } from "node:fs/promises";
import { Server, createConnection, createServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createRunEndpoint } from "../src/daemon/endpoint.ts";
import { E0Server } from "../src/daemon/server.ts";
import { encodeFrame, MAX_FRAME_BYTES } from "../src/protocol/framing.ts";
import { createAck } from "../src/protocol/messages.ts";
import { createAttach, createServerHarness } from "./support/server-harness.ts";

const unixFilesystemEndpointSkip = process.platform === "win32"
  ? "Windows named pipes do not use filesystem cleanup"
  : false;

test("server requires attach as the first message", async () => {
  const harness = await createServerHarness();
  try {
    const socket = await harness.connectRaw();
    socket.write(encodeFrame(createAck("D1")));
    const reply = await harness.readOne(socket);
    assert.equal(reply.type, "error");
    assert.equal(reply.payload.code, "ATTACH_REQUIRED");
    await harness.expectClosed(socket);
  } finally {
    await harness.close();
  }
});

test("server attaches and sends pending Deliveries", async () => {
  const harness = await createServerHarness();
  try {
    harness.server.enqueueProbe("D1", "nonce-1");
    const socket = await harness.connectAndAttach();
    const attached = await harness.readOne(socket);
    const delivery = await harness.readOne(socket);
    assert.equal(attached.type, "attached");
    assert.equal(delivery.type, "delivery");
    assert.equal(delivery.payload.delivery_id, "D1");
    assert.deepEqual(harness.server.counts(), { pending: 1, acknowledged: 0 });
    assert.deepEqual(sentDetails(harness, "D1"), ["send_count=1"]);
  } finally {
    await harness.close();
  }
});

test("server immediately sends a Delivery enqueued after attach", async () => {
  const harness = await createServerHarness();
  try {
    const socket = await harness.connectAndAttach();
    const attached = await harness.readOne(socket);
    assert.equal(attached.type, "attached");

    harness.server.enqueueProbe("D-after-attach", "nonce-after-attach");
    const delivery = await harness.readOne(socket);
    assert.equal(delivery.type, "delivery");
    assert.equal(delivery.payload.delivery_id, "D-after-attach");
    assert.deepEqual(harness.server.counts(), { pending: 1, acknowledged: 0 });
    assert.deepEqual(sentDetails(harness, "D-after-attach"), ["send_count=1"]);
  } finally {
    await harness.close();
  }
});

test("server rejects attach from the wrong owner", async () => {
  const harness = await createServerHarness();
  try {
    const socket = await harness.connectRaw();
    socket.write(encodeFrame(createAttach("W2", "M-wrong-owner")));
    const reply = await harness.readOne(socket);
    assert.equal(reply.type, "error");
    assert.equal(reply.payload.in_reply_to, "M-wrong-owner");
    assert.equal(reply.payload.code, "INVALID_ATTACH");
    await harness.expectClosed(socket);
  } finally {
    await harness.close();
  }
});

test("server rejects stale binding revisions sent over the wire", async () => {
  const harness = await createServerHarness();
  try {
    const socket = await harness.connectRaw();
    socket.write(rawJsonFrame({
      protocol_version: 1,
      message_id: "M-stale",
      type: "attach",
      payload: {
        owner_id: "W1",
        binding_revision: 2,
        native_ref: {
          session_id: "session-1",
          session_file: "/tmp/a4s-e0-session.jsonl",
        },
      },
    }));
    const reply = await harness.readOne(socket);
    assert.equal(reply.type, "error");
    assert.equal(reply.payload.in_reply_to, "M-stale");
    assert.equal(reply.payload.code, "STALE_BINDING");
    await harness.expectClosed(socket);
  } finally {
    await harness.close();
  }
});

test("server reports unknown ACKs without acknowledging", async () => {
  const harness = await createServerHarness();
  try {
    const socket = await harness.connectAndAttach();
    assert.equal((await harness.readOne(socket)).type, "attached");
    const ack = createAck("missing");
    socket.write(encodeFrame(ack));
    const reply = await harness.readOne(socket);
    assert.equal(reply.type, "error");
    assert.equal(reply.payload.in_reply_to, ack.message_id);
    assert.equal(reply.payload.code, "UNEXPECTED_MESSAGE");
    assert.deepEqual(harness.server.counts(), { pending: 0, acknowledged: 0 });
  } finally {
    await harness.close();
  }
});

test("server reports repeated ACKs without a second transition", async () => {
  const harness = await createServerHarness();
  try {
    harness.server.enqueueProbe("D1", "nonce-1");
    const socket = await harness.connectAndAttach();
    assert.equal((await harness.readOne(socket)).type, "attached");
    assert.equal((await harness.readOne(socket)).type, "delivery");
    socket.write(encodeFrame(createAck("D1")));
    await waitFor(() => harness.server.counts().acknowledged === 1);

    const repeated = createAck("D1");
    socket.write(encodeFrame(repeated));
    const reply = await harness.readOne(socket);
    assert.equal(reply.type, "error");
    assert.equal(reply.payload.in_reply_to, repeated.message_id);
    assert.equal(reply.payload.code, "UNEXPECTED_MESSAGE");
    assert.deepEqual(harness.server.counts(), { pending: 0, acknowledged: 1 });
  } finally {
    await harness.close();
  }
});

test("server redelivers pending Delivery after disconnect", async () => {
  const harness = await createServerHarness();
  try {
    harness.server.enqueueProbe("D1", "nonce-1");
    const first = await harness.connectAndAttach();
    assert.equal((await harness.readOne(first)).type, "attached");
    const firstDelivery = await harness.readOne(first);
    assert.equal(firstDelivery.type, "delivery");
    assert.equal(firstDelivery.payload.delivery_id, "D1");
    harness.server.disconnectClient();
    await harness.expectClosed(first);

    const second = await harness.connectAndAttach();
    assert.equal((await harness.readOne(second)).type, "attached");
    const redelivery = await harness.readOne(second);
    assert.equal(redelivery.type, "delivery");
    assert.equal(redelivery.payload.delivery_id, "D1");
    assert.deepEqual(sentDetails(harness, "D1"), ["send_count=1", "send_count=2"]);
  } finally {
    await harness.close();
  }
});

test("server duplicate-next-delivery fault writes the same Delivery twice", async () => {
  const harness = await createServerHarness();
  try {
    harness.server.enqueueProbe("D1", "nonce-1");
    harness.server.faults.duplicateNextDelivery();
    const socket = await harness.connectAndAttach();
    assert.equal((await harness.readOne(socket)).type, "attached");
    const first = await harness.readOne(socket);
    const duplicate = await harness.readOne(socket);
    assert.equal(first.type, "delivery");
    assert.equal(duplicate.type, "delivery");
    assert.equal(first.payload.delivery_id, "D1");
    assert.deepEqual(duplicate, first);
    assert.deepEqual(sentDetails(harness, "D1"), ["send_count=1", "send_count=2"]);
  } finally {
    await harness.close();
  }
});

test("server drop-next-ACK-and-disconnect fault preserves pending state", async () => {
  const harness = await createServerHarness();
  try {
    harness.server.enqueueProbe("D1", "nonce-1");
    harness.server.faults.dropNextAckAndDisconnect();
    const first = await harness.connectAndAttach();
    assert.equal((await harness.readOne(first)).type, "attached");
    assert.equal((await harness.readOne(first)).type, "delivery");
    first.write(encodeFrame(createAck("D1")));
    await harness.expectClosed(first);
    assert.deepEqual(harness.server.counts(), { pending: 1, acknowledged: 0 });

    const second = await harness.connectAndAttach();
    assert.equal((await harness.readOne(second)).type, "attached");
    const redelivery = await harness.readOne(second);
    assert.equal(redelivery.type, "delivery");
    assert.equal(redelivery.payload.delivery_id, "D1");
    second.write(encodeFrame(createAck("D1")));
    await waitFor(() => harness.server.counts().acknowledged === 1);
    assert.deepEqual(harness.server.counts(), { pending: 0, acknowledged: 1 });
    assert.deepEqual(sentDetails(harness, "D1"), ["send_count=1", "send_count=2"]);
  } finally {
    await harness.close();
  }
});

test("server closes immediately on malformed JSON", async () => {
  const harness = await createServerHarness();
  try {
    const socket = await harness.connectRaw();
    socket.write(rawPayloadFrame(Buffer.from("{")));
    await harness.expectClosed(socket);
    assert.equal(harness.events.some((event) => event.event === "protocol_error"), false);
  } finally {
    await harness.close();
  }
});

test("server closes immediately on oversized frames", async () => {
  const harness = await createServerHarness();
  try {
    const socket = await harness.connectRaw();
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1);
    socket.write(header);
    await harness.expectClosed(socket);
    assert.equal(harness.events.some((event) => event.event === "protocol_error"), false);
  } finally {
    await harness.close();
  }
});

test("server correlates decoded protocol errors", async () => {
  const harness = await createServerHarness();
  try {
    const socket = await harness.connectRaw();
    socket.write(rawJsonFrame({
      protocol_version: 2,
      message_id: "M-unsupported",
      type: "attach",
      payload: {},
    }));
    const reply = await harness.readOne(socket);
    assert.equal(reply.type, "error");
    assert.equal(reply.payload.in_reply_to, "M-unsupported");
    assert.equal(reply.payload.code, "UNSUPPORTED_PROTOCOL");
    await harness.expectClosed(socket);
  } finally {
    await harness.close();
  }
});

test("server refuses an already-active endpoint", async () => {
  const harness = await createServerHarness();
  const second = new E0Server({
    endpoint: harness.endpoint,
    expectedOwnerId: "W1",
    expectedBindingRevision: 1,
    onEvent() {},
  });
  try {
    await assert.rejects(() => second.start(), /endpoint already active/);
  } finally {
    await second.stop();
    await harness.close();
  }
});

test("server stop keeps the canonical Unix endpoint present while closing the listener", { skip: unixFilesystemEndpointSkip }, async () => {
  const harness = await createServerHarness();
  const originalClose = Server.prototype.close;
  let canonicalEntryPresentAtClose = false;
  Server.prototype.close = function patchedClose(this: Server, ...args: Parameters<Server["close"]>): Server {
    canonicalEntryPresentAtClose = pathEntryExists(harness.endpoint);
    return originalClose.apply(this, args);
  } as typeof Server.prototype.close;

  try {
    await harness.server.stop();
    assert.equal(canonicalEntryPresentAtClose, true);
  } finally {
    Server.prototype.close = originalClose;
    await harness.close();
  }
});

test("server stop does not overwrite a concurrently-created canonical Unix endpoint", { skip: unixFilesystemEndpointSkip }, async () => {
  const harness = await createServerHarness();
  const originalClose = Server.prototype.close;
  let foreignServer: NetServer | undefined;
  let foreignCreated = false;

  Server.prototype.close = function patchedClose(this: Server, callback?: (err?: Error) => void): Server {
    return originalClose.call(this, (error?: Error) => {
      if (error || pathEntryExists(harness.endpoint)) {
        callback?.(error);
        return;
      }

      foreignServer = createServer((socket) => socket.end("foreign"));
      foreignServer.once("error", (listenError) => callback?.(listenError));
      foreignServer.listen(harness.endpoint, () => {
        foreignCreated = true;
        callback?.();
      });
    });
  } as typeof Server.prototype.close;

  try {
    await harness.server.stop();
    if (foreignCreated) {
      assert.equal(await readFromEndpoint(harness.endpoint), "foreign");
    }
  } finally {
    Server.prototype.close = originalClose;
    await closeOptionalServer(foreignServer);
    await harness.close();
  }
});

test("server cleanup preserves a replaced endpoint identity", { skip: unixFilesystemEndpointSkip }, async () => {
  const harness = await createServerHarness();
  try {
    await unlink(harness.endpoint);
    await createStaleUnixSocket(harness.endpoint);

    await harness.server.stop();

    await assert.doesNotReject(() => stat(harness.endpoint));
  } finally {
    await harness.close();
  }
});

test("server starts after removing a stale Unix socket from an abnormally terminated Node child", { skip: unixFilesystemEndpointSkip }, async () => {
  const root = await mkdtemp(join(tmpdir(), "a4s-e0-stale-node-"));
  const endpoint = createRunEndpoint("run-1", root, process.platform);
  const server = new E0Server({
    endpoint,
    expectedOwnerId: "W1",
    expectedBindingRevision: 1,
    onEvent() {},
  });

  try {
    await createStaleUnixSocket(endpoint);
    await assert.doesNotReject(() => server.start());
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed startup does not clean an unowned Unix endpoint", { skip: unixFilesystemEndpointSkip }, async () => {
  const root = await mkdtemp(join(tmpdir(), "a4s-e0-start-fail-"));
  const endpoint = createRunEndpoint("run-1", root, process.platform);
  const server = new E0Server({
    endpoint,
    expectedOwnerId: "W1",
    expectedBindingRevision: 1,
    onEvent() {},
  });
  const originalListen = Server.prototype.listen;
  const patchedListen = function patchedListen(this: Server): Server {
    void createStaleUnixSocket(endpoint).then(
      () => this.emit("error", Object.assign(new Error("synthetic listen failure"), { code: "EADDRINUSE" })),
      (error: unknown) => this.emit("error", error),
    );
    return this;
  };
  Server.prototype.listen = patchedListen as typeof Server.prototype.listen;

  try {
    await assert.rejects(() => server.start(), /synthetic listen failure|EADDRINUSE/);
    await assert.doesNotReject(() => stat(endpoint));
  } finally {
    Server.prototype.listen = originalListen;
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

async function createStaleUnixSocket(endpoint: string): Promise<void> {
  await mkdir(dirname(endpoint), { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [
    "-e",
    "const net = require('node:net'); const server = net.createServer(); server.listen(process.argv[1], () => process.send?.('listening')); setInterval(() => {}, 1000);",
    endpoint,
  ], { stdio: ["ignore", "ignore", "ignore", "ipc"] });

  await withChildStartup(child);
  child.kill("SIGKILL");
  await new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function readFromEndpoint(endpoint: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let data = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk: string) => {
      data += chunk;
    });
    socket.once("end", () => resolve(data));
  });
}

function closeOptionalServer(server: NetServer | undefined): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function withChildStartup(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for child socket listener")), 2_000);
    child.once("message", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`child exited before listening: code=${code ?? "none"} signal=${signal ?? "none"}`));
    });
  });
}

function rawJsonFrame(value: unknown): Buffer {
  return rawPayloadFrame(Buffer.from(JSON.stringify(value), "utf8"));
}

function rawPayloadFrame(payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

function sentDetails(harness: { events: { event: string; delivery_id?: string; detail?: string }[] }, deliveryId: string): string[] {
  return harness.events
    .filter((event) => event.event === "delivery_sent" && event.delivery_id === deliveryId)
    .map((event) => event.detail ?? "");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for predicate");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
