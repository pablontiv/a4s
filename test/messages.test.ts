import assert from "node:assert/strict";
import test from "node:test";
import {
  parseMessage,
  type AttachMessage,
  type AttachedMessage,
  type DeliveryAckMessage,
  type DeliveryMessage,
  type ErrorMessage,
} from "../src/protocol/messages.ts";

const attach: AttachMessage = {
  protocol_version: 1,
  message_id: "M1",
  type: "attach",
  payload: {
    owner_id: "W1",
    binding_revision: 1,
    native_ref: {
      session_id: "session-1",
      session_file: "/tmp/session-1.jsonl",
    },
  },
};

const attached: AttachedMessage = {
  protocol_version: 1,
  message_id: "M2",
  type: "attached",
  payload: {
    in_reply_to: "M1",
    owner_id: "W1",
    binding_revision: 1,
  },
};

const delivery: DeliveryMessage = {
  protocol_version: 1,
  message_id: "M3",
  type: "delivery",
  payload: {
    delivery_id: "D1",
    owner_id: "W1",
    binding_revision: 1,
    kind: "probe",
    body: { nonce: "N1" },
  },
};

const error: ErrorMessage = {
  protocol_version: 1,
  message_id: "M5",
  type: "error",
  payload: {
    in_reply_to: "M1",
    code: "INVALID_ATTACH",
    message: "invalid attach",
  },
};

test("parseMessage accepts an exact attach envelope", () => {
  assert.deepEqual(parseMessage(attach), attach);
});

test("parseMessage rejects an unknown envelope field", () => {
  assert.throws(
    () => parseMessage({ ...attach, extra: true }),
    /INVALID_ENVELOPE/,
  );
});

test("parseMessage rejects unsupported protocol versions", () => {
  assert.throws(
    () => parseMessage({ ...attach, protocol_version: 2 }),
    /UNSUPPORTED_PROTOCOL/,
  );
});

test("parseMessage classifies positive integer stale attach revisions", () => {
  assert.throws(
    () => parseMessage({ ...attach, payload: { ...attach.payload, binding_revision: 2 } }),
    /STALE_BINDING/,
  );
});

test("parseMessage rejects syntactically invalid attach binding revisions", () => {
  for (const bindingRevision of [0, 1.5, "1"]) {
    assert.throws(
      () => parseMessage({ ...attach, payload: { ...attach.payload, binding_revision: bindingRevision } }),
      /INVALID_ENVELOPE/,
    );
  }
});

test("parseMessage accepts a delivery ACK", () => {
  const ack: DeliveryAckMessage = {
    protocol_version: 1,
    message_id: "M4",
    type: "delivery_ack",
    payload: { delivery_id: "D1" },
  };
  assert.deepEqual(parseMessage(ack), ack);
});

test("parseMessage accepts an attached message", () => {
  assert.deepEqual(parseMessage(attached), attached);
});

test("parseMessage accepts a delivery message", () => {
  assert.deepEqual(parseMessage(delivery), delivery);
});

test("parseMessage accepts an error message", () => {
  assert.deepEqual(parseMessage(error), error);
});

test("parseMessage rejects empty IDs", () => {
  assert.throws(
    () => parseMessage({ ...attach, message_id: "" }),
    /INVALID_ENVELOPE/,
  );
  assert.throws(
    () => parseMessage({ ...attach, payload: { ...attach.payload, owner_id: "" } }),
    /INVALID_ENVELOPE/,
  );
});

test("parseMessage rejects relative session_file values", () => {
  assert.throws(
    () => parseMessage({
      ...attach,
      payload: {
        ...attach.payload,
        native_ref: { ...attach.payload.native_ref, session_file: "session-1.jsonl" },
      },
    }),
    /INVALID_ENVELOPE/,
  );
});

test("parseMessage rejects unknown payload fields", () => {
  assert.throws(
    () => parseMessage({ ...attach, payload: { ...attach.payload, extra: true } }),
    /INVALID_ENVELOPE/,
  );
});

test("parseMessage rejects unknown message types", () => {
  assert.throws(
    () => parseMessage({ ...attach, type: "unknown" }),
    /INVALID_ENVELOPE/,
  );
});

test("parseMessage rejects non-object inputs", () => {
  for (const value of [null, undefined, true, 1, "attach", []]) {
    assert.throws(() => parseMessage(value), /INVALID_ENVELOPE/);
  }
});
