import assert from "node:assert/strict";
import test from "node:test";
import { E0Server } from "../src/daemon/server.ts";
import { encodeFrame, MAX_FRAME_BYTES } from "../src/protocol/framing.ts";
import { createAck } from "../src/protocol/messages.ts";
import { createAttach, createServerHarness } from "./support/server-harness.ts";

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

test("server rejects stale binding revisions", async () => {
  const harness = await createServerHarness({ expectedBindingRevision: 2 as 1 });
  try {
    const socket = await harness.connectRaw();
    socket.write(encodeFrame(createAttach("W1", "M-stale")));
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
