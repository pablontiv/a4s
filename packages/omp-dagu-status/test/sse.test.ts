import assert from "node:assert/strict";
import test from "node:test";
import { SSEParser } from "../src/sse.ts";
import type { SSEEvent } from "../src/sse.ts";

test("SSE separates control and message, joins multiline data, and ignores comments/id/retry", () => {
  const events: SSEEvent[] = [];
  const parser = new SSEParser(event => events.push(event));
  parser.feed(': heartbeat\r\nevent: control\r\ndata: {"sessionID":"s","subscribed":[]}\r\n\r\nid: 1\nevent: message\ndata: {"topic":"dagrun:feature/one",\ndata: "payload":{}}\nretry: 1000\n\n');
  assert.deepEqual(events, [
    { event: "control", data: '{"sessionID":"s","subscribed":[]}' },
    { event: "message", data: '{"topic":"dagrun:feature/one",\n"payload":{}}' },
  ]);
  assert.equal(JSON.parse(events[1]!.data).topic, "dagrun:feature/one");
});

test("SSE preserves partial fields, CRLF boundaries, UTF-8 and default event type", () => {
  const events: SSEEvent[] = [];
  const parser = new SSEParser(event => events.push(event));
  const bytes = new TextEncoder().encode('event: control\r\ndata: listo\r\n\r\ndata: revisión\r\n\r\ndata: incomplete');
  const decoder = new TextDecoder();
  for (const byte of bytes) parser.feed(decoder.decode(Uint8Array.of(byte), { stream: true }));
  assert.deepEqual(events, [{ event: "control", data: "listo" }, { event: "message", data: "revisión" }]);
});

test("SSE dispatches empty data but not field-only events, and handles bare CR", () => {
  const events: SSEEvent[] = [];
  const parser = new SSEParser(event => events.push(event));
  parser.feed("event: control\n\ndata:\r\rdata:  leading space\r\r");
  assert.deepEqual(events, [{ event: "message", data: "" }, { event: "message", data: " leading space" }]);
});
