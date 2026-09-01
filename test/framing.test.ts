import assert from "node:assert/strict";
import test from "node:test";
import { createAck } from "../src/protocol/messages.ts";
import {
  encodeFrame,
  FrameDecoder,
  FramingError,
  MAX_FRAME_BYTES,
} from "../src/protocol/framing.ts";

const ack = createAck("D1");

test("encodeFrame writes a four-byte big-endian payload length", () => {
  const frame = encodeFrame(ack);
  assert.equal(frame.readUInt32BE(0), frame.length - 4);
});

test("FrameDecoder handles a fragmented header and payload", () => {
  const frame = encodeFrame(ack);
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(frame.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(frame.subarray(2, 7)), []);
  assert.deepEqual(decoder.push(frame.subarray(7)), [ack]);
});

test("FrameDecoder returns coalesced frames in order", () => {
  const second = createAck("D2");
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(Buffer.concat([encodeFrame(ack), encodeFrame(second)])), [ack, second]);
});

test("FrameDecoder rejects a payload above the cap", () => {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(MAX_FRAME_BYTES + 1);
  assert.throws(() => new FrameDecoder().push(header), FramingError);
});

test("FrameDecoder rejects invalid JSON and remains failed", () => {
  const payload = Buffer.from("{");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  const decoder = new FrameDecoder();
  assert.throws(() => decoder.push(Buffer.concat([header, payload])), /invalid JSON/);
  assert.throws(() => decoder.push(encodeFrame(ack)), /decoder is failed/);
});

test("FrameDecoder decodes a zero-length payload as invalid", () => {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(0);
  assert.throws(() => new FrameDecoder().push(header), FramingError);
});

test("FrameDecoder decodes exactly 65,536 bytes containing one valid JSON string", () => {
  const value = "x".repeat(MAX_FRAME_BYTES - 2);
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  assert.equal(payload.length, MAX_FRAME_BYTES);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(Buffer.concat([header, payload])), [value]);
});

test("FrameDecoder returns a frame when a chunk ends exactly after the header", () => {
  const frame = encodeFrame(ack);
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(frame.subarray(0, 4)), []);
  assert.deepEqual(decoder.push(frame.subarray(4)), [ack]);
});
