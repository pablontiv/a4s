import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

export type ErrorCode =
  | "UNSUPPORTED_PROTOCOL"
  | "INVALID_ENVELOPE"
  | "ATTACH_REQUIRED"
  | "INVALID_ATTACH"
  | "STALE_BINDING"
  | "UNEXPECTED_MESSAGE";

interface Envelope<T extends string, P> {
  protocol_version: 1;
  message_id: string;
  type: T;
  payload: P;
}

export interface NativeRef {
  session_id: string;
  session_file: string;
}

export interface AttachPayload {
  owner_id: string;
  binding_revision: 1;
  native_ref: NativeRef;
}

export type AttachMessage = Envelope<"attach", AttachPayload>;
export type AttachedMessage = Envelope<"attached", {
  in_reply_to: string;
  owner_id: string;
  binding_revision: 1;
}>;
export type DeliveryMessage = Envelope<"delivery", {
  delivery_id: string;
  owner_id: string;
  binding_revision: 1;
  kind: "probe";
  body: { nonce: string };
}>;
export type DeliveryAckMessage = Envelope<"delivery_ack", { delivery_id: string }>;
export type ErrorMessage = Envelope<"error", {
  in_reply_to: string;
  code: ErrorCode;
  message: string;
}>;

export type ProtocolMessage =
  | AttachMessage
  | AttachedMessage
  | DeliveryMessage
  | DeliveryAckMessage
  | ErrorMessage;

export class ProtocolError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(`${code}: ${message}`);
  }
}

export function createMessageId(): string {
  return randomUUID();
}

export function parseMessage(value: unknown): ProtocolMessage {
  const envelope = requireObject(value, "message envelope");
  requireExactKeys(envelope, ["message_id", "payload", "protocol_version", "type"]);

  if (envelope.protocol_version !== 1) {
    throw new ProtocolError("UNSUPPORTED_PROTOCOL", "Unsupported protocol version");
  }

  const messageId = requireNonEmptyString(envelope.message_id, "message_id");
  const payload = requireObject(envelope.payload, "payload");

  switch (envelope.type) {
    case "attach":
      return {
        protocol_version: 1,
        message_id: messageId,
        type: "attach",
        payload: parseAttachPayload(payload),
      };
    case "attached":
      return {
        protocol_version: 1,
        message_id: messageId,
        type: "attached",
        payload: parseAttachedPayload(payload),
      };
    case "delivery":
      return {
        protocol_version: 1,
        message_id: messageId,
        type: "delivery",
        payload: parseDeliveryPayload(payload),
      };
    case "delivery_ack":
      return {
        protocol_version: 1,
        message_id: messageId,
        type: "delivery_ack",
        payload: parseDeliveryAckPayload(payload),
      };
    case "error":
      return {
        protocol_version: 1,
        message_id: messageId,
        type: "error",
        payload: parseErrorPayload(payload),
      };
    default:
      throw new ProtocolError("INVALID_ENVELOPE", "Unknown message type");
  }
}

export function createAttached(
  inReplyTo: string,
  ownerId: string,
): AttachedMessage {
  return {
    protocol_version: 1,
    message_id: createMessageId(),
    type: "attached",
    payload: {
      in_reply_to: requireNonEmptyString(inReplyTo, "in_reply_to"),
      owner_id: requireNonEmptyString(ownerId, "owner_id"),
      binding_revision: 1,
    },
  };
}

export function createDelivery(
  deliveryId: string,
  ownerId: string,
  nonce: string,
): DeliveryMessage {
  return {
    protocol_version: 1,
    message_id: createMessageId(),
    type: "delivery",
    payload: {
      delivery_id: requireNonEmptyString(deliveryId, "delivery_id"),
      owner_id: requireNonEmptyString(ownerId, "owner_id"),
      binding_revision: 1,
      kind: "probe",
      body: { nonce: requireNonEmptyString(nonce, "nonce") },
    },
  };
}

export function createAck(deliveryId: string): DeliveryAckMessage {
  return {
    protocol_version: 1,
    message_id: createMessageId(),
    type: "delivery_ack",
    payload: { delivery_id: requireNonEmptyString(deliveryId, "delivery_id") },
  };
}

export function createProtocolError(
  inReplyTo: string,
  code: ErrorCode,
  message: string,
): ErrorMessage {
  return {
    protocol_version: 1,
    message_id: createMessageId(),
    type: "error",
    payload: {
      in_reply_to: requireNonEmptyString(inReplyTo, "in_reply_to"),
      code: requireErrorCode(code),
      message: requireNonEmptyString(message, "message"),
    },
  };
}

function parseAttachPayload(payload: Record<string, unknown>): AttachPayload {
  requireExactKeys(payload, ["binding_revision", "native_ref", "owner_id"]);
  requireBindingRevision(payload.binding_revision);
  const nativeRef = requireObject(payload.native_ref, "native_ref");
  requireExactKeys(nativeRef, ["session_file", "session_id"]);

  const sessionFile = requireNonEmptyString(nativeRef.session_file, "session_file");
  if (!isAbsolute(sessionFile)) {
    throw new ProtocolError("INVALID_ENVELOPE", "session_file must be absolute");
  }

  return {
    owner_id: requireNonEmptyString(payload.owner_id, "owner_id"),
    binding_revision: 1,
    native_ref: {
      session_id: requireNonEmptyString(nativeRef.session_id, "session_id"),
      session_file: sessionFile,
    },
  };
}

function parseAttachedPayload(payload: Record<string, unknown>): AttachedMessage["payload"] {
  requireExactKeys(payload, ["binding_revision", "in_reply_to", "owner_id"]);
  requireBindingRevision(payload.binding_revision);
  return {
    in_reply_to: requireNonEmptyString(payload.in_reply_to, "in_reply_to"),
    owner_id: requireNonEmptyString(payload.owner_id, "owner_id"),
    binding_revision: 1,
  };
}

function parseDeliveryPayload(payload: Record<string, unknown>): DeliveryMessage["payload"] {
  requireExactKeys(payload, ["binding_revision", "body", "delivery_id", "kind", "owner_id"]);
  requireBindingRevision(payload.binding_revision);
  if (payload.kind !== "probe") {
    throw new ProtocolError("INVALID_ENVELOPE", "delivery kind must be probe");
  }

  const body = requireObject(payload.body, "body");
  requireExactKeys(body, ["nonce"]);

  return {
    delivery_id: requireNonEmptyString(payload.delivery_id, "delivery_id"),
    owner_id: requireNonEmptyString(payload.owner_id, "owner_id"),
    binding_revision: 1,
    kind: "probe",
    body: { nonce: requireNonEmptyString(body.nonce, "nonce") },
  };
}

function parseDeliveryAckPayload(payload: Record<string, unknown>): DeliveryAckMessage["payload"] {
  requireExactKeys(payload, ["delivery_id"]);
  return { delivery_id: requireNonEmptyString(payload.delivery_id, "delivery_id") };
}

function parseErrorPayload(payload: Record<string, unknown>): ErrorMessage["payload"] {
  requireExactKeys(payload, ["code", "in_reply_to", "message"]);
  return {
    in_reply_to: requireNonEmptyString(payload.in_reply_to, "in_reply_to"),
    code: requireErrorCode(payload.code),
    message: requireNonEmptyString(payload.message, "message"),
  };
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolError("INVALID_ENVELOPE", `${label} must be a plain object`);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ProtocolError("INVALID_ENVELOPE", `${label} must be a plain object`);
  }

  return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, expectedKeys: string[]): void {
  const actual = Object.keys(value).sort().join("\u0000");
  const expected = [...expectedKeys].sort().join("\u0000");
  if (actual !== expected) {
    throw new ProtocolError("INVALID_ENVELOPE", "Unexpected object keys");
  }
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProtocolError("INVALID_ENVELOPE", `${label} must be a non-empty string`);
  }
  return value;
}

function requireBindingRevision(value: unknown): 1 {
  if (value !== 1) {
    throw new ProtocolError("INVALID_ENVELOPE", "binding_revision must be 1");
  }
  return 1;
}

function requireErrorCode(value: unknown): ErrorCode {
  switch (value) {
    case "UNSUPPORTED_PROTOCOL":
    case "INVALID_ENVELOPE":
    case "ATTACH_REQUIRED":
    case "INVALID_ATTACH":
    case "STALE_BINDING":
    case "UNEXPECTED_MESSAGE":
      return value;
    default:
      throw new ProtocolError("INVALID_ENVELOPE", "Unknown error code");
  }
}
