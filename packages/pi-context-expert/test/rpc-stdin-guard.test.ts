import assert from "node:assert/strict";
import test from "node:test";
import {
  createJsonlLineReader,
  RpcResponseTimeoutError,
  sendCommandAndAwaitResponse,
  type JsonlTransport,
} from "../src/rpc-stdin-guard.ts";

function createFakeTransport() {
  const written: string[] = [];
  const handlers = new Set<(line: string) => void>();
  const transport: JsonlTransport = {
    write(line) {
      written.push(line);
    },
    onLine(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  return {
    transport,
    written,
    emit(line: string) {
      for (const handler of [...handlers]) handler(line);
    },
    subscriberCount: () => handlers.size,
  };
}

test("createJsonlLineReader splits on LF only and strips a trailing CR", () => {
  const lines: string[] = [];
  const reader = createJsonlLineReader((line) => lines.push(line));
  reader.feed('{"a":1}\n{"b":2}\r\n');
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});

test("createJsonlLineReader reassembles a line split across chunks", () => {
  const lines: string[] = [];
  const reader = createJsonlLineReader((line) => lines.push(line));
  reader.feed('{"a":');
  reader.feed("1}\n");
  assert.deepEqual(lines, ['{"a":1}']);
});

test("createJsonlLineReader does not treat U+2028/U+2029 as a delimiter", () => {
  const lines: string[] = [];
  const reader = createJsonlLineReader((line) => lines.push(line));
  reader.feed('{"text":"line one line two"}\n');
  assert.deepEqual(lines, ['{"text":"line one line two"}']);
});

test("createJsonlLineReader flushes a trailing unterminated line on end()", () => {
  const lines: string[] = [];
  const reader = createJsonlLineReader((line) => lines.push(line));
  reader.feed('{"a":1}');
  reader.end();
  assert.deepEqual(lines, ['{"a":1}']);
});

test("createJsonlLineReader end() is a no-op when the buffer is empty", () => {
  const lines: string[] = [];
  const reader = createJsonlLineReader((line) => lines.push(line));
  reader.feed('{"a":1}\n');
  reader.end();
  assert.deepEqual(lines, ['{"a":1}']);
});

test("sendCommandAndAwaitResponse requires an id to correlate the response", () => {
  const { transport } = createFakeTransport();
  assert.throws(
    () => sendCommandAndAwaitResponse(transport, { type: "compact", id: "" }),
    RangeError,
  );
});

test("sendCommandAndAwaitResponse writes the command once as a single JSONL line", () => {
  const fake = createFakeTransport();
  void sendCommandAndAwaitResponse(fake.transport, { type: "compact", id: "req-1" });
  assert.deepEqual(fake.written, ['{"type":"compact","id":"req-1"}\n']);
});

test("sendCommandAndAwaitResponse resolves only on a response with the matching id", async () => {
  const fake = createFakeTransport();
  const pending = sendCommandAndAwaitResponse(fake.transport, { type: "compact", id: "req-1" });

  // Noise that must be ignored: a non-response event, and a response for a
  // different command id (e.g. a stale in-flight request).
  fake.emit('{"type":"compaction_start","reason":"manual"}');
  fake.emit('{"type":"response","command":"compact","id":"other","success":true}');
  assert.equal(fake.subscriberCount(), 1);

  fake.emit('{"type":"response","command":"compact","id":"req-1","success":true,"data":{}}');
  const response = await pending;
  assert.deepEqual(response, {
    type: "response",
    command: "compact",
    id: "req-1",
    success: true,
    data: {},
  });
  assert.equal(fake.subscriberCount(), 0, "resolving must unsubscribe from the transport");
});

test("sendCommandAndAwaitResponse ignores malformed JSON lines instead of throwing", async () => {
  const fake = createFakeTransport();
  const pending = sendCommandAndAwaitResponse(fake.transport, { type: "compact", id: "req-1" });
  fake.emit("not json");
  fake.emit('{"type":"response","command":"compact","id":"req-1","success":false,"error":"Compaction cancelled"}');
  const response = await pending;
  assert.equal(response.success, false);
  assert.equal(response.error, "Compaction cancelled");
});

test("sendCommandAndAwaitResponse times out and unsubscribes if the response never arrives", async () => {
  const fake = createFakeTransport();
  const pending = sendCommandAndAwaitResponse(
    fake.transport,
    { type: "compact", id: "req-1" },
    { timeoutMs: 5 },
  );
  await assert.rejects(pending, RpcResponseTimeoutError);
  assert.equal(fake.subscriberCount(), 0);
});

test("sendCommandAndAwaitResponse without a timeout stays pending indefinitely for a slow compact", async () => {
  const fake = createFakeTransport();
  let resolved = false;
  const pending = sendCommandAndAwaitResponse(fake.transport, { type: "compact", id: "req-1" }).then(
    (response) => {
      resolved = true;
      return response;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(resolved, false, "must not resolve before the real response arrives");
  fake.emit('{"type":"response","command":"compact","id":"req-1","success":true,"data":{}}');
  await pending;
  assert.equal(resolved, true);
});
