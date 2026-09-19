# E0 Attach and Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and execute the E0 experiment proving attach, framed local IPC, Delivery/ACK, deduplication, and client reconnection between an external `a4sd` and a real Pi extension.

**Architecture:** A reusable TypeScript protocol library frames strict JSON messages over `node:net`. An in-memory `a4sd` server owns pending Deliveries; a Pi extension attaches, deduplicates, acknowledges, and reconnects. A deterministic driver starts a real Pi process in RPC mode without prompting a model, injects controlled failures, captures structured evidence, and computes the platform verdict.

**Tech Stack:** Node.js >=22.19.0, TypeScript 7.0.2, `tsx` 4.23.13, `@types/node` 26.4.1, Pi 0.84.4, `node:test`, `node:net`.

**Spec:** `.workspace/docs/specs/2026-09-01-e0-attach-transport-experiment-design.md`

## Global Constraints

- Keep `a4sd` external to Pi; do not embed the Pi SDK in the daemon.
- Use Unix domain sockets on macOS/Linux and named pipes on Windows through `node:net`.
- Use four-byte unsigned big-endian lengths followed by UTF-8 JSON payloads.
- Reject frames larger than 65,536 payload bytes.
- Support only protocol version `1` and the E0 message catalog.
- Preserve at-least-once physical delivery and at-most-once logical processing during one Pi process lifetime.
- Keep daemon state and extension deduplication in memory; daemon or Pi restart durability is outside E0.
- Do not invoke a model, inject prompts, use Herdr, or implement E1 behavior.
- Do not depend on or deep-import `pi-intercom`; it is evidence and a reference only.
- Use 20 trials for each of scenarios S1–S5 in the final experiment.
- Allow `PASS-macOS` on the current machine; report Windows as `NOT RUN` until executed on Windows.
- Keep raw artifacts under `artifacts/e0/`; version only the final report and artifact hashes.
- Use strict TypeScript and built-in Node APIs; add no web, database, messaging, or validation framework.

## Planned File Map

| Path | Responsibility |
| --- | --- |
| `package.json` | Exact toolchain, scripts, and package metadata |
| `package-lock.json` | Reproducible dependency resolution |
| `tsconfig.json` | Strict NodeNext TypeScript checking |
| `.gitignore` | Ignore dependencies, build output, and raw E0 artifacts |
| `src/protocol/messages.ts` | E0 message types, builders, strict runtime parsing |
| `src/protocol/framing.ts` | Length-prefixed encoder and incremental decoder |
| `src/daemon/state.ts` | In-memory Delivery state and idempotent ACK transitions |
| `src/daemon/endpoint.ts` | Per-platform endpoint creation and Unix stale-socket handling |
| `src/daemon/server.ts` | IPC server, attach gate, Delivery/redelivery, fault hooks |
| `src/daemon/cli.ts` | Thin standalone `a4sd` process entry point |
| `src/pi-extension/client.ts` | Socket lifecycle, attach, dedupe, ACK, reconnect |
| `src/pi-extension/index.ts` | Pi lifecycle adapter and environment parsing |
| `src/e0/evidence.ts` | Structured event recording, aggregation, artifact writing |
| `src/e0/pi-process.ts` | Real Pi RPC process startup, trace capture, graceful stop |
| `src/e0/driver.ts` | S1–S5 orchestration and verdict |
| `src/e0/report.ts` | Versioned Markdown report generation from a completed run |
| `test/messages.test.ts` | Strict message validation tests |
| `test/framing.test.ts` | Fragmentation, coalescing, size, and malformed-frame tests |
| `test/state.test.ts` | Pending/acknowledged Delivery invariants |
| `test/endpoint.test.ts` | Unix socket/named-pipe path behavior |
| `test/server.test.ts` | Attach gate, ACKs, redelivery, and protocol failures |
| `test/support/server-harness.ts` | Real-socket server test fixture with queued decoded messages |
| `test/client.test.ts` | Extension-client dedupe, ACK, reconnect, shutdown |
| `test/support/client-harness.ts` | Real-server client fixture and condition-based event waiters |
| `test/evidence.test.ts` | Artifact and verdict calculations |
| `test/driver.test.ts` | Deterministic scenario orchestration with a fake Pi launcher |
| `.workspace/docs/experiments/e0-report.md` | Empirical result generated only after the final run |

---

### Task 1: Bootstrap the project and define strict E0 messages

**Files:**

- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Modify: `.gitignore`
- Create: `src/protocol/messages.ts`
- Create: `test/messages.test.ts`

**Interfaces:**

- Consumes: no implementation code.
- Produces: `ProtocolMessage`, concrete message types, payload types, `parseMessage(value)`, `createMessageId()`, and message builders used by every later task.

- [ ] **Step 1: Add the exact Node/TypeScript project configuration**

Create `package.json`:

```json
{
  "name": "a4s",
  "version": "0.0.0-e0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22.19.0"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "tsx --test test/*.test.ts",
    "e0": "tsx src/e0/driver.ts",
    "e0:report": "tsx src/e0/report.ts"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "0.84.4",
    "@types/node": "26.4.1",
    "tsx": "4.23.13",
    "typescript": "7.0.2"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Append to `.gitignore`:

```gitignore
node_modules/
dist/
artifacts/e0/
```

Run:

```bash
npm install --package-lock-only
npm ci
```

Expected: dependencies install and `package-lock.json` records the exact versions.

- [ ] **Step 2: Write failing strict-message tests**

Create `test/messages.test.ts` with focused cases:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseMessage,
  type AttachMessage,
  type DeliveryAckMessage,
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

test("parseMessage rejects invalid attach payloads", () => {
  assert.throws(
    () => parseMessage({ ...attach, payload: { ...attach.payload, binding_revision: 0 } }),
    /INVALID_ENVELOPE/,
  );
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
```

Add equivalent acceptance cases for `attached`, `delivery`, and `error`, plus rejection cases for empty IDs, relative `session_file`, unknown payload fields, unknown message types, and non-object inputs.

- [ ] **Step 3: Run the tests to verify the parser is missing**

Run:

```bash
npm test -- --test-name-pattern="parseMessage"
```

Expected: FAIL because `src/protocol/messages.ts` does not exist.

- [ ] **Step 4: Add concrete message types and strict parsing**

Create `src/protocol/messages.ts` with these exported interfaces and functions:

```typescript
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

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
```

Implement `parseMessage(value: unknown): ProtocolMessage` with local helpers that:

- require plain objects;
- compare exact key sets using `Object.keys(value).sort()`;
- require non-empty strings;
- require `protocol_version === 1`;
- require `binding_revision === 1`;
- require `isAbsolute(session_file)`;
- construct and return a fresh typed object rather than casting the input.

Export exact builders used later:

```typescript
export function createAttached(
  inReplyTo: string,
  ownerId: string,
): AttachedMessage;

export function createDelivery(
  deliveryId: string,
  ownerId: string,
  nonce: string,
): DeliveryMessage;

export function createAck(deliveryId: string): DeliveryAckMessage;

export function createProtocolError(
  inReplyTo: string,
  code: ErrorCode,
  message: string,
): ErrorMessage;
```

- [ ] **Step 5: Run message tests and type checking**

Run:

```bash
npm test -- --test-name-pattern="parseMessage"
npm run typecheck
```

Expected: all message tests PASS and TypeScript exits 0.

- [ ] **Step 6: Commit the foundation**

```bash
git add package.json package-lock.json tsconfig.json .gitignore src/protocol/messages.ts test/messages.test.ts
git commit -m "feat: define strict E0 protocol messages"
```

---

### Task 2: Implement incremental length-prefixed framing

**Files:**

- Create: `src/protocol/framing.ts`
- Create: `test/framing.test.ts`

**Interfaces:**

- Consumes: `ProtocolMessage` from Task 1 for outbound encoding.
- Produces: `MAX_FRAME_BYTES`, `encodeFrame(message)`, `FrameDecoder.push(chunk)` returning decoded JSON values, and `FramingError`. Runtime protocol parsing remains a separate server/client responsibility.

- [ ] **Step 1: Write failing encoder/decoder tests**

Create `test/framing.test.ts`:

```typescript
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
```

Add cases for zero-length payload, exactly 65,536 bytes containing one valid JSON string, and one chunk ending exactly after a header. A syntactically valid but protocol-invalid envelope belongs in message/server tests, not framing tests.

- [ ] **Step 2: Run framing tests to verify failure**

Run:

```bash
npm test -- --test-name-pattern="FrameDecoder|encodeFrame"
```

Expected: FAIL because the framing module does not exist.

- [ ] **Step 3: Implement the encoder and stateful decoder**

Create `src/protocol/framing.ts`:

```typescript
import type { ProtocolMessage } from "./messages.ts";

export const MAX_FRAME_BYTES = 65_536;

export class FramingError extends Error {}

export function encodeFrame(message: ProtocolMessage): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.length === 0 || payload.length > MAX_FRAME_BYTES) {
    throw new FramingError(`frame payload length ${payload.length} is invalid`);
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export class FrameDecoder {
  private buffer = Buffer.alloc(0);
  private failed = false;

  push(chunk: Buffer): unknown[] {
    if (this.failed) throw new FramingError("decoder is failed");
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const values: unknown[] = [];

    try {
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32BE(0);
        if (length === 0 || length > MAX_FRAME_BYTES) {
          throw new FramingError(`frame payload length ${length} is invalid`);
        }
        if (this.buffer.length < 4 + length) break;
        const payload = this.buffer.subarray(4, 4 + length);
        this.buffer = this.buffer.subarray(4 + length);
        let value: unknown;
        try {
          value = JSON.parse(payload.toString("utf8"));
        } catch (error) {
          throw new FramingError(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
        values.push(value);
      }
      return values;
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }
}
```

For the exact-limit decoder test, build a 65,536-byte payload containing one valid JSON string, prefix it with a four-byte header, and assert that `push()` returns the decoded string. Keep `encodeFrame()` restricted to valid `ProtocolMessage` values.

- [ ] **Step 4: Run framing tests, full tests, and type checking**

Run:

```bash
npm test -- --test-name-pattern="FrameDecoder|encodeFrame"
npm test
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit framing**

```bash
git add src/protocol/framing.ts test/framing.test.ts
git commit -m "feat: add length-prefixed E0 framing"
```

---

### Task 3: Implement the in-memory Delivery state machine

**Files:**

- Create: `src/daemon/state.ts`
- Create: `test/state.test.ts`

**Interfaces:**

- Consumes: `DeliveryMessage` from Task 1.
- Produces: `DeliveryStore`, `DeliveryRecord`, `AckResult`, and pending/acknowledged counters.

- [ ] **Step 1: Write failing state-transition tests**

Create `test/state.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { DeliveryStore } from "../src/daemon/state.ts";
import { createDelivery } from "../src/protocol/messages.ts";

const delivery = createDelivery("D1", "W1", "nonce-1");

test("enqueue exposes a pending Delivery for the matching owner", () => {
  const store = new DeliveryStore();
  store.enqueue(delivery);
  assert.deepEqual(store.pendingFor("W1", 1), [delivery]);
  assert.deepEqual(store.pendingFor("W2", 1), []);
});

test("acknowledge transitions a Delivery exactly once", () => {
  const store = new DeliveryStore();
  store.enqueue(delivery);
  assert.equal(store.acknowledge("D1"), "acknowledged");
  assert.equal(store.acknowledge("D1"), "already_acknowledged");
  assert.deepEqual(store.pendingFor("W1", 1), []);
});

test("acknowledge reports unknown IDs without mutation", () => {
  const store = new DeliveryStore();
  assert.equal(store.acknowledge("missing"), "unknown");
  assert.deepEqual(store.counts(), { pending: 0, acknowledged: 0 });
});

test("enqueue rejects duplicate Delivery IDs", () => {
  const store = new DeliveryStore();
  store.enqueue(delivery);
  assert.throws(() => store.enqueue(delivery), /duplicate delivery_id/);
});
```

- [ ] **Step 2: Run state tests to verify failure**

Run:

```bash
npm test -- --test-name-pattern="enqueue|acknowledge"
```

Expected: FAIL because `DeliveryStore` does not exist.

- [ ] **Step 3: Implement the minimal state machine**

Create `src/daemon/state.ts` with this public contract:

```typescript
import type { DeliveryMessage } from "../protocol/messages.ts";

export type DeliveryStatus = "PENDING" | "ACKNOWLEDGED";
export type AckResult = "acknowledged" | "already_acknowledged" | "unknown";

export interface DeliveryRecord {
  message: DeliveryMessage;
  status: DeliveryStatus;
  sendCount: number;
}

export class DeliveryStore {
  private readonly records = new Map<string, DeliveryRecord>();

  enqueue(message: DeliveryMessage): void;
  markSent(deliveryId: string): void;
  acknowledge(deliveryId: string): AckResult;
  pendingFor(ownerId: string, bindingRevision: 1): DeliveryMessage[];
  get(deliveryId: string): Readonly<DeliveryRecord> | undefined;
  counts(): { pending: number; acknowledged: number };
}
```

Implementation rules:

- clone records returned by `get()` so callers cannot mutate store state;
- preserve insertion order in `pendingFor()`;
- increment `sendCount` on every physical send/redelivery;
- throw if `markSent()` receives an unknown ID;
- never transition `ACKNOWLEDGED` back to `PENDING`.

- [ ] **Step 4: Verify state and regression tests**

Run:

```bash
npm test -- --test-name-pattern="enqueue|acknowledge|pending"
npm test
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit Delivery state**

```bash
git add src/daemon/state.ts test/state.test.ts
git commit -m "feat: add in-memory Delivery state"
```

---

### Task 4: Build the endpoint resolver and `a4sd` IPC server

**Files:**

- Create: `src/daemon/endpoint.ts`
- Create: `src/daemon/server.ts`
- Create: `src/daemon/cli.ts`
- Create: `test/endpoint.test.ts`
- Create: `test/server.test.ts`
- Create: `test/support/server-harness.ts`

**Interfaces:**

- Consumes: framing, message builders/parser, and `DeliveryStore`.
- Produces: `createRunEndpoint()`, `E0Server`, `ServerEvent`, `FaultController`, and the standalone `a4sd` CLI.

- [ ] **Step 1: Write failing endpoint tests**

Create `test/endpoint.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { createRunEndpoint } from "../src/daemon/endpoint.ts";

const tempRoot = "/tmp/a4s-e0-tests";

test("createRunEndpoint returns a named pipe on Windows", () => {
  assert.equal(
    createRunEndpoint("run-123", tempRoot, "win32"),
    "\\\\.\\pipe\\a4s-e0-run-123",
  );
});

test("createRunEndpoint returns a run-scoped socket on Unix", () => {
  assert.equal(
    createRunEndpoint("run-123", tempRoot, "darwin"),
    "/tmp/a4s-e0-tests/run-123/a4sd.sock",
  );
});

test("createRunEndpoint rejects unsafe run IDs", () => {
  assert.throws(() => createRunEndpoint("../escape", tempRoot, "linux"), /invalid run_id/);
});
```

- [ ] **Step 2: Write failing server protocol tests**

Create `test/support/server-harness.ts` first with this public contract:

```typescript
export interface ServerHarness {
  server: E0Server;
  connectRaw(): Promise<Socket>;
  connectAndAttach(): Promise<Socket>;
  readOne(socket: Socket): Promise<ProtocolMessage>;
  expectClosed(socket: Socket): Promise<void>;
  close(): Promise<void>;
}

export async function createServerHarness(): Promise<ServerHarness>;
```

Implement it with a fresh `mkdtemp()` directory, `createRunEndpoint()`, a real `E0Server`, and real `net.Socket` clients. Maintain one `FrameDecoder` and FIFO message queue per socket so two coalesced messages can be consumed by consecutive `readOne()` calls. Every wait uses an event predicate and a two-second rejection deadline. `close()` destroys clients, stops the server, and removes the temp directory.

Create `test/server.test.ts` using that harness. Cover:

```typescript
test("server requires attach as the first message", async () => {
  const harness = await createServerHarness();
  const socket = await harness.connectRaw();
  socket.write(encodeFrame(createAck("D1")));
  const reply = await harness.readOne(socket);
  assert.equal(reply.type, "error");
  assert.equal(reply.payload.code, "ATTACH_REQUIRED");
  await harness.expectClosed(socket);
  await harness.close();
});

test("server attaches and sends pending Deliveries", async () => {
  const harness = await createServerHarness();
  harness.server.enqueueProbe("D1", "nonce-1");
  const socket = await harness.connectAndAttach();
  const attached = await harness.readOne(socket);
  const delivery = await harness.readOne(socket);
  assert.equal(attached.type, "attached");
  assert.equal(delivery.type, "delivery");
  assert.equal(delivery.payload.delivery_id, "D1");
  await harness.close();
});
```

Add exact tests for wrong owner, stale binding, unknown ACK, repeated ACK, pending redelivery after disconnect, duplicate-next-delivery fault, drop-next-ACK-and-disconnect fault, malformed JSON, oversized frames, and an already-active endpoint.

- [ ] **Step 3: Run endpoint/server tests to verify failure**

Run:

```bash
npm test -- --test-name-pattern="createRunEndpoint|server"
```

Expected: FAIL because endpoint and server modules do not exist.

- [ ] **Step 4: Implement platform endpoint creation**

Create `src/daemon/endpoint.ts`:

```typescript
import { join } from "node:path";

const SAFE_RUN_ID = /^[a-zA-Z0-9_-]{1,80}$/;

export function createRunEndpoint(
  runId: string,
  tempRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!SAFE_RUN_ID.test(runId)) throw new Error(`invalid run_id: ${runId}`);
  if (platform === "win32") return `\\\\.\\pipe\\a4s-e0-${runId}`;
  return join(tempRoot, runId, "a4sd.sock");
}
```

Also export `prepareUnixEndpoint(endpoint)` and `cleanupUnixEndpoint(endpoint)`:

- create the parent directory with mode `0o700`;
- if no path exists, continue;
- if the path exists, probe it with `net.connect()`;
- if connection succeeds, throw `endpoint already active`;
- if probing fails with `ECONNREFUSED`, unlink the stale socket;
- propagate all other errors;
- cleanup only the endpoint path owned by the current server.

- [ ] **Step 5: Implement the server with explicit fault hooks**

Create `src/daemon/server.ts` with this public contract:

```typescript
export interface ServerEvent {
  component: "a4sd";
  event: string;
  message_id?: string;
  delivery_id?: string;
  detail?: string;
}

export interface E0ServerOptions {
  endpoint: string;
  expectedOwnerId: string;
  expectedBindingRevision: 1;
  onEvent(event: ServerEvent): void;
}

export interface FaultController {
  duplicateNextDelivery(): void;
  dropNextAckAndDisconnect(): void;
}

export class E0Server {
  readonly faults: FaultController;
  constructor(options: E0ServerOptions);
  start(): Promise<void>;
  stop(): Promise<void>;
  enqueueProbe(deliveryId: string, nonce: string): void;
  disconnectClient(): void;
  counts(): { pending: number; acknowledged: number };
}
```

Server connection flow:

1. construct one `FrameDecoder` per socket;
2. close immediately on `FramingError`;
3. pass each decoded JSON value through `parseMessage()`; convert `ProtocolError` into a correlated protocol `error` when the raw value contains a string `message_id`;
4. require the first valid message to be `attach`;
5. validate owner and binding revision against options;
6. write `attached`;
7. send every pending Delivery and call `markSent()`;
8. handle only `delivery_ack` after attach;
9. for `dropNextAckAndDisconnect`, close before `store.acknowledge()`;
10. for `duplicateNextDelivery`, write the same encoded Delivery frame twice;
11. emit events at receive, send, ack transition, fault, close, and error boundaries.

Write protocol errors before closing only when framing remains trustworthy. Use `socket.end(encodeFrame(error))`; wait for `close` during test cleanup.

- [ ] **Step 6: Add the thin daemon CLI**

Create `src/daemon/cli.ts` that requires:

```text
A4S_ENDPOINT
A4S_OWNER_ID
A4S_BINDING_REVISION=1
```

It constructs `E0Server`, logs structured server events to stderr with prefix `A4S_E0_EVENT\t`, starts the listener, and stops on `SIGINT` or `SIGTERM`. Exit code is non-zero for missing/invalid configuration or listener startup failure.

- [ ] **Step 7: Verify server behavior**

Run:

```bash
npm test -- --test-name-pattern="createRunEndpoint|server|attach|redelivery|ACK"
npm test
npm run typecheck
```

Expected: all commands exit 0; no socket remains under the test temp directories.

- [ ] **Step 8: Commit the server**

```bash
git add src/daemon/endpoint.ts src/daemon/server.ts src/daemon/cli.ts test/endpoint.test.ts test/server.test.ts test/support/server-harness.ts
git commit -m "feat: add E0 IPC server"
```

---

### Task 5: Build the reconnecting Pi extension client

**Files:**

- Create: `src/pi-extension/client.ts`
- Create: `src/pi-extension/index.ts`
- Create: `test/client.test.ts`
- Create: `test/support/client-harness.ts`

**Interfaces:**

- Consumes: framing, message types/builders, and the server from Task 4.
- Produces: `E0PiClient`, `ClientEvent`, environment parsing, and the Pi extension lifecycle factory.

- [ ] **Step 1: Write failing client integration tests against the real server**

Create `test/support/client-harness.ts` with this contract:

```typescript
export interface ClientHarness {
  server: E0Server;
  client: E0PiClient;
  clientEvents: ClientEvent[];
  waitForClientEvent(event: string): Promise<ClientEvent>;
  waitForServerCounts(expected: { pending: number; acknowledged: number }): Promise<void>;
  close(): Promise<void>;
}

export async function createClientHarness(options?: {
  reconnectDelaysMs?: readonly number[];
}): Promise<ClientHarness>;
```

Build it on `createServerHarness()` with owner `W1`, binding revision `1`, an absolute synthetic session file, and predicate-based two-second waiters. `close()` stops the client before closing the server harness.

Create `test/client.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { createClientHarness } from "./support/client-harness.ts";

test("client attaches, processes a Delivery once, and ACKs", async () => {
  const harness = await createClientHarness();
  harness.server.enqueueProbe("D1", "nonce-1");
  await harness.client.start();
  await harness.waitForClientEvent("delivery_processed");
  assert.deepEqual(harness.server.counts(), { pending: 0, acknowledged: 1 });
  assert.equal(harness.clientEvents.filter((event) => event.event === "delivery_processed").length, 1);
  await harness.close();
});

test("client deduplicates redelivery after a lost ACK", async () => {
  const harness = await createClientHarness({ reconnectDelaysMs: [1, 2, 5] });
  harness.server.faults.dropNextAckAndDisconnect();
  harness.server.enqueueProbe("D1", "nonce-1");
  await harness.client.start();
  await harness.waitForServerCounts({ pending: 0, acknowledged: 1 });
  assert.equal(harness.clientEvents.filter((event) => event.event === "delivery_processed").length, 1);
  assert.equal(harness.clientEvents.filter((event) => event.event === "delivery_duplicate").length, 1);
  await harness.close();
});
```

Add cases for server-driven disconnect/reconnect, duplicate physical frame, stopping during backoff, missing attach configuration, and an invalid server frame.

- [ ] **Step 2: Run client tests to verify failure**

Run:

```bash
npm test -- --test-name-pattern="client"
```

Expected: FAIL because `E0PiClient` does not exist.

- [ ] **Step 3: Implement `E0PiClient`**

Create `src/pi-extension/client.ts` with this contract:

```typescript
import type { AttachPayload } from "../protocol/messages.ts";

export interface ClientEvent {
  component: "pi-extension";
  event: string;
  message_id?: string;
  delivery_id?: string;
  detail?: string;
}

export interface E0PiClientOptions {
  endpoint: string;
  attach: AttachPayload;
  reconnectDelaysMs?: readonly number[];
  onEvent(event: ClientEvent): void;
}

export class E0PiClient {
  constructor(options: E0PiClientOptions);
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

Required internal behavior:

- default backoff `[100, 250, 500, 1000]`, capped at the last value;
- one active socket and one reconnect timer maximum;
- reset reconnect attempt after `attached`;
- send `attach` immediately after connect;
- accept no Delivery before `attached`;
- when D1 is unseen, emit `delivery_processed`, add D1 to `seenDeliveryIds`, then ACK;
- when D1 is seen, emit `delivery_duplicate`, then ACK without processing;
- preserve `seenDeliveryIds` across socket reconnects;
- `stop()` sets a terminal flag before clearing timers and destroying the socket;
- never reconnect after `stop()`;
- emit connection, attach, delivery, ACK, reconnect, and error events.

- [ ] **Step 4: Implement the Pi lifecycle adapter**

Create `src/pi-extension/index.ts`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { E0PiClient, type ClientEvent } from "./client.ts";

const TRACE_PREFIX = "A4S_E0_EVENT\t";

function trace(event: ClientEvent): void {
  if (process.env.A4S_E0_TRACE === "stderr") {
    process.stderr.write(`${TRACE_PREFIX}${JSON.stringify(event)}\n`);
  }
}

export default function a4sE0Extension(pi: ExtensionAPI): void {
  let client: E0PiClient | undefined;

  pi.on("session_start", async (_event, ctx) => {
    const endpoint = process.env.A4S_ENDPOINT;
    const ownerId = process.env.A4S_OWNER_ID;
    const bindingRevision = process.env.A4S_BINDING_REVISION;
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionFile = ctx.sessionManager.getSessionFile();

    if (!endpoint || !ownerId || bindingRevision !== "1" || !sessionId || !sessionFile) {
      throw new Error("E0 requires A4S_ENDPOINT, A4S_OWNER_ID, A4S_BINDING_REVISION=1, session_id, and session_file");
    }

    client = new E0PiClient({
      endpoint,
      attach: {
        owner_id: ownerId,
        binding_revision: 1,
        native_ref: { session_id: sessionId, session_file: sessionFile },
      },
      onEvent: trace,
    });
    await client.start();
  });

  pi.on("session_shutdown", async () => {
    await client?.stop();
    client = undefined;
  });
}
```

If Pi does not await the long-lived first connection during `session_start`, make `start()` resolve after the first `attached` event. A failed initial connection retries; it does not keep `session_start` pending indefinitely. Add a 10-second startup deadline in the lifecycle adapter that throws if attach never succeeds.

- [ ] **Step 5: Verify client and lifecycle cleanup**

Run:

```bash
npm test -- --test-name-pattern="client|reconnect|deduplicate|shutdown"
npm test
npm run typecheck
```

Expected: all commands exit 0 and `node --test` reports no leaked handles.

- [ ] **Step 6: Commit the Pi client**

```bash
git add src/pi-extension/client.ts src/pi-extension/index.ts test/client.test.ts test/support/client-harness.ts
git commit -m "feat: add reconnecting Pi E0 client"
```

---

### Task 6: Add evidence recording and verdict calculation

**Files:**

- Create: `src/e0/evidence.ts`
- Create: `test/evidence.test.ts`

**Interfaces:**

- Consumes: `ServerEvent` and `ClientEvent`.
- Produces: `EvidenceRecorder`, `ExperimentEvent`, `ScenarioSummary`, `RunSummary`, and artifact files.

- [ ] **Step 1: Write failing evidence tests**

Create `test/evidence.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EvidenceRecorder,
  type EnvironmentRecord,
  type RunSummary,
  type ScenarioSummary,
} from "../src/e0/evidence.ts";

function environmentFixture(runId: string): EnvironmentRecord {
  return {
    run_id: runId,
    started_at: "2026-09-01T00:00:00.000Z",
    os_version: "test",
    architecture: "arm64",
    node_version: process.version,
    pi_version: "0.84.4",
    a4s_commit: "abc123",
    endpoint_pattern: "/tmp/a4s.sock",
    transport: "unix_socket",
    trials_per_scenario: 1,
  };
}

function passingScenario(): ScenarioSummary {
  return {
    planned: 1,
    executed: 1,
    passed: 1,
    failed: 0,
    deliveriesCreated: 1,
    physicalSends: 1,
    redeliveries: 0,
    acknowledged: 1,
    logicalProcesses: 1,
    duplicateFrames: 0,
    minDurationMs: 1,
    medianDurationMs: 1,
    maxDurationMs: 1,
    unhandledErrors: 0,
  };
}

function passingSummaryFixture(): RunSummary {
  return {
    run_id: "run-1",
    verdict: "PASS-macOS",
    scenarios: {
      S1: passingScenario(),
      S2: passingScenario(),
      S3: passingScenario(),
      S4: passingScenario(),
      S5: passingScenario(),
    },
    platforms: { macOS: "PASS", linux: "NOT RUN", windows: "NOT RUN" },
  };
}

test("EvidenceRecorder writes environment, events, and a PASS summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "a4s-evidence-"));
  const recorder = await EvidenceRecorder.create({
    artifactRoot: root,
    runId: "run-1",
    platform: "darwin",
    trialsPerScenario: 1,
    selectedScenarios: ["S1"],
    environment: environmentFixture("run-1"),
  });

  recorder.beginTrial("S1", 1);
  recorder.record({ component: "a4sd", event: "delivery_enqueued", delivery_id: "D1" });
  recorder.record({ component: "pi-extension", event: "delivery_processed", delivery_id: "D1" });
  recorder.record({ component: "a4sd", event: "delivery_acknowledged", delivery_id: "D1" });
  recorder.passTrial();
  const summary = await recorder.finish();

  assert.equal(summary.verdict, "PASS-macOS");
  assert.equal(summary.scenarios.S1.passed, 1);
  assert.match(await readFile(join(root, "events.jsonl"), "utf8"), /delivery_processed/);
});

test("one failed trial makes the run fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "a4s-evidence-fail-"));
  const recorder = await EvidenceRecorder.create({
    artifactRoot: root,
    runId: "run-fail",
    platform: "darwin",
    trialsPerScenario: 1,
    selectedScenarios: ["S1"],
    environment: environmentFixture("run-fail"),
  });
  recorder.beginTrial("S1", 1);
  recorder.failTrial("unexpected disconnect");
  assert.equal((await recorder.finish()).verdict, "FAIL-macOS");
});
```

Add tests for duplicate physical sends with one logical process, lost Delivery, unacknowledged Delivery, median duration, 20/20 enforcement, and `NOT RUN` platform fields.

- [ ] **Step 2: Run evidence tests to verify failure**

Run:

```bash
npm test -- --test-name-pattern="EvidenceRecorder|verdict"
```

Expected: FAIL because the evidence module does not exist.

- [ ] **Step 3: Implement append-only evidence and deterministic summaries**

Create `src/e0/evidence.ts` with these types:

```typescript
export type ScenarioId = "S1" | "S2" | "S3" | "S4" | "S5";

export interface ExperimentEvent {
  run_id: string;
  scenario: ScenarioId;
  trial: number;
  timestamp: string;
  monotonic_ms: number;
  component: "driver" | "a4sd" | "pi-extension" | "pi-process";
  event: string;
  message_id?: string;
  delivery_id?: string;
  direction?: "inbound" | "outbound";
  detail?: string;
}

export interface ScenarioSummary {
  planned: number;
  executed: number;
  passed: number;
  failed: number;
  deliveriesCreated: number;
  physicalSends: number;
  redeliveries: number;
  acknowledged: number;
  logicalProcesses: number;
  duplicateFrames: number;
  minDurationMs: number;
  medianDurationMs: number;
  maxDurationMs: number;
  unhandledErrors: number;
}

export interface EnvironmentRecord {
  run_id: string;
  started_at: string;
  os_version: string;
  architecture: string;
  node_version: string;
  pi_version: string;
  a4s_commit: string;
  endpoint_pattern: string;
  transport: "unix_socket" | "named_pipe";
  trials_per_scenario: number;
}

export interface RunSummary {
  run_id: string;
  verdict: string;
  scenarios: Record<ScenarioId, ScenarioSummary>;
  platforms: Record<"macOS" | "linux" | "windows", string>;
}

export interface EvidenceRecorderOptions {
  artifactRoot: string;
  runId: string;
  platform: NodeJS.Platform;
  trialsPerScenario: number;
  selectedScenarios: ScenarioId[];
  environment: EnvironmentRecord;
}

export class EvidenceRecorder {
  static create(options: EvidenceRecorderOptions): Promise<EvidenceRecorder>;
  beginTrial(scenario: ScenarioId, trial: number): void;
  record(event: Omit<ExperimentEvent, "run_id" | "scenario" | "trial" | "timestamp" | "monotonic_ms">): void;
  passTrial(): void;
  failTrial(detail: string): void;
  finish(): Promise<RunSummary>;
}
```

`record()` timestamps events in the driver process at receipt time using `performance.now() - trialStart`. `finish()` flushes file handles before writing `summary.json`. Sort only summary aggregates; preserve `events.jsonl` append order.

Verdict rules are exact:

- current platform passes only when every selected scenario has the configured trial count, zero failed trials, zero lost/unacknowledged Deliveries, one logical process per unique Delivery, and zero unhandled errors;
- unselected scenarios have `planned: 0` and do not affect smoke-run verdicts;
- platform labels map exactly as `darwin → macOS`, `linux → linux`, and `win32 → windows`;
- current platform failure uses `FAIL-macOS`, `FAIL-linux`, or `FAIL-windows`;
- unexecuted platforms remain `NOT RUN`.

- [ ] **Step 4: Verify evidence output**

Run:

```bash
npm test -- --test-name-pattern="EvidenceRecorder|verdict|summary"
npm test
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit evidence recording**

```bash
git add src/e0/evidence.ts test/evidence.test.ts
git commit -m "feat: record E0 experiment evidence"
```

---

### Task 7: Build the Pi process wrapper and deterministic scenario driver

**Files:**

- Create: `src/e0/pi-process.ts`
- Create: `src/e0/driver.ts`
- Create: `test/driver.test.ts`

**Interfaces:**

- Consumes: `E0Server`, `EvidenceRecorder`, and the Pi extension entrypoint.
- Produces: `PiProcess`, `runScenario()`, `runExperiment()`, CLI argument parsing, and S1–S5 orchestration.

- [ ] **Step 1: Write failing driver tests with a fake Pi launcher**

Create `test/driver.test.ts` around dependency injection:

```typescript
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runExperiment } from "../src/e0/driver.ts";
import type { PiLaunchContext, PiLauncher, PiProcessHandle } from "../src/e0/pi-process.ts";
import { E0PiClient } from "../src/pi-extension/client.ts";

async function createTempArtifactRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "a4s-driver-"));
}

class FakePiLauncher implements PiLauncher {
  starts = 0;

  async start(context: PiLaunchContext): Promise<PiProcessHandle> {
    this.starts += 1;
    const client = new E0PiClient({
      endpoint: context.endpoint,
      attach: {
        owner_id: context.ownerId,
        binding_revision: context.bindingRevision,
        native_ref: {
          session_id: `fake-${this.starts}`,
          session_file: join(context.sessionDir, `fake-${this.starts}.jsonl`),
        },
      },
      reconnectDelaysMs: [1, 2, 5],
      onEvent: context.onTrace,
    });
    await client.start();
    return { pid: process.pid, stop: () => client.stop() };
  }
}

class FailingPiLauncher implements PiLauncher {
  async start(_context: PiLaunchContext): Promise<PiProcessHandle> {
    throw new Error("synthetic Pi startup failure");
  }
}

test("runExperiment executes each selected scenario for every trial", async () => {
  const launcher = new FakePiLauncher();
  const result = await runExperiment({
    trials: 2,
    scenarios: ["S1", "S2", "S3", "S4", "S5"],
    launcher,
    artifactRoot: await createTempArtifactRoot(),
  });
  assert.equal(launcher.starts, 10);
  assert.equal(result.summary.verdict.startsWith("PASS-"), true);
});

test("runExperiment records FAIL when the Pi boundary fails", async () => {
  const result = await runExperiment({
    trials: 1,
    scenarios: ["S1"],
    launcher: new FailingPiLauncher(),
    artifactRoot: await createTempArtifactRoot(),
  });
  assert.equal(result.summary.verdict.startsWith("FAIL-"), true);
});
```

The fake launcher must use the real `E0PiClient`; it replaces only the Pi process lifecycle. This keeps protocol behavior real while making driver tests deterministic.

- [ ] **Step 2: Run driver tests to verify failure**

Run:

```bash
npm test -- --test-name-pattern="runExperiment"
```

Expected: FAIL because the driver does not exist.

- [ ] **Step 3: Implement the real Pi RPC process wrapper**

Create `src/e0/pi-process.ts` with:

```typescript
export interface PiLaunchContext {
  endpoint: string;
  ownerId: string;
  bindingRevision: 1;
  sessionDir: string;
  extensionPath: string;
  onTrace(event: Record<string, unknown>): void;
}

export interface PiProcessHandle {
  readonly pid: number;
  stop(): Promise<void>;
}

export interface PiLauncher {
  start(context: PiLaunchContext): Promise<PiProcessHandle>;
}

export class RealPiLauncher implements PiLauncher {
  constructor(private readonly piBin = process.env.PI_BIN ?? "pi") {}
  start(context: PiLaunchContext): Promise<PiProcessHandle>;
}
```

Build the child process with these exact arguments and environment additions:

```typescript
const args = [
  "--mode", "rpc",
  "--approve",
  "--session-dir", context.sessionDir,
  "--no-builtin-tools",
  "-e", context.extensionPath,
];
const env = {
  ...process.env,
  A4S_ENDPOINT: context.endpoint,
  A4S_OWNER_ID: context.ownerId,
  A4S_BINDING_REVISION: "1",
  A4S_E0_TRACE: "stderr",
};
const child = spawn(this.piBin, args, { env, stdio: ["pipe", "pipe", "pipe"] });
```

Keep stdin open; consume stdout so the child cannot block. Parse only stderr lines beginning with `A4S_E0_EVENT\t`; forward parsed JSON through `onTrace`. Forward other stderr lines as `pi-process` diagnostic events without treating them as extension events.

`stop()` sends `SIGTERM`, waits up to 5 seconds, then sends `SIGKILL` only on non-Windows. On Windows use `child.kill()` after the deadline. Treat clean signal shutdown as expected.

- [ ] **Step 4: Implement condition-based scenario orchestration**

Create `src/e0/driver.ts` exporting:

```typescript
export interface ExperimentOptions {
  trials: number;
  scenarios: ScenarioId[];
  launcher: PiLauncher;
  artifactRoot: string;
}

export async function runExperiment(options: ExperimentOptions): Promise<{
  runDir: string;
  summary: RunSummary;
}>;

export async function runManualSmoke(options: {
  endpoint: string;
  ownerId: string;
  timeoutMs: number;
}): Promise<void>;
```

Use event waiters with a 10-second deadline, never fixed sleeps, for attach, processing, reconnect, and ACK conditions.

Scenario actions:

- S1: start server, start Pi, wait attached, enqueue D1, wait one process and ACK.
- S2: start server, enqueue D1, start Pi, wait attached/process/ACK.
- S3: arm `dropNextAckAndDisconnect`, enqueue D1, wait first process, reconnect, duplicate event, final ACK.
- S4: start/attach, call `disconnectClient`, wait reconnect/attach, enqueue D1, wait ACK.
- S5: arm `duplicateNextDelivery`, enqueue D1, require one process, one duplicate event, and acknowledged state.

Use fresh server, Pi process, endpoint, session directory, and unique Delivery ID for every trial. Always stop Pi and server in `finally`. A trial failure is recorded and the run continues so the report contains all 20 results; no trial is retried automatically.

CLI arguments:

```text
--trials N                 positive integer; default 20
--scenario S1              repeatable; accepts S1, S2, S3, S4, or S5; default all
--artifact-root PATH       default artifacts/e0
--pi-bin PATH              default PI_BIN, then pi
--manual                   host one observable probe without spawning Pi
--endpoint PATH            required with --manual
```

After artifacts are flushed, print lines shaped like `run_dir=/absolute/path/to/artifacts/e0/20260901T120000Z-abcd` and `verdict=PASS-macOS`. Exit 0 only for a passing verdict; exit 1 for failed trials; exit 2 for invalid CLI input or environment setup.

Manual mode starts `E0Server`, enqueues `D-manual`, prints the endpoint and the exact second-terminal Pi command, then waits up to 60 seconds for ACK. It does not spawn Pi or invoke a model. It exits 0 after ACK and always removes its socket.

- [ ] **Step 5: Verify all scenarios through the fake launcher**

Run:

```bash
npm test -- --test-name-pattern="runExperiment|S1|S2|S3|S4|S5"
npm test
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit the driver**

```bash
git add src/e0/pi-process.ts src/e0/driver.ts test/driver.test.ts
git commit -m "feat: add deterministic E0 experiment driver"
```

---

### Task 8: Verify the real Pi boundary with one trial per scenario

**Files:**

- Modify if defects are found: only the smallest responsible source/test pair
- Generate locally: `artifacts/e0/$RUN_ID/environment.json`
- Generate locally: `artifacts/e0/$RUN_ID/events.jsonl`
- Generate locally: `artifacts/e0/$RUN_ID/summary.json`

**Interfaces:**

- Consumes: the complete experiment runner from Task 7.
- Produces: a real-Pi smoke run proving the process boundary before the expensive 20-trial run.

- [ ] **Step 1: Run proactive diagnostics and the full deterministic suite**

Run:

```bash
npm run typecheck
npm test
```

Expected: TypeScript exits 0 and every test passes.

- [ ] **Step 2: Run one real-Pi trial for S1**

Run:

```bash
npm run e0 -- --trials 1 --scenario S1
```

Expected: exit 0, one new run directory, `PASS-macOS` on macOS, and one `delivery_processed` plus one `delivery_acknowledged` event.

- [ ] **Step 3: Run one real-Pi trial for S2–S5**

Run each independently so failures are attributable:

```bash
npm run e0 -- --trials 1 --scenario S2
npm run e0 -- --trials 1 --scenario S3
npm run e0 -- --trials 1 --scenario S4
npm run e0 -- --trials 1 --scenario S5
```

Expected: each exits 0. S3 contains one `delivery_processed`, at least one `delivery_duplicate`, and final ACK. S5 contains one logical process despite two physical sends.

- [ ] **Step 4: Run the observable manual smoke in two terminals**

In terminal A:

```bash
npm run e0 -- --manual --endpoint /tmp/a4s-e0-manual.sock
```

In terminal B, from the repository root:

```bash
mkdir -p "$PWD/artifacts/e0/manual-session"
A4S_ENDPOINT=/tmp/a4s-e0-manual.sock \
A4S_OWNER_ID=W1 \
A4S_BINDING_REVISION=1 \
pi --approve \
  --session-dir "$PWD/artifacts/e0/manual-session" \
  --no-builtin-tools \
  -e "$PWD/src/pi-extension/index.ts"
```

Expected: Pi remains visibly interactive without starting a model turn; terminal A reports attach, Delivery D-manual, and ACK. Exit Pi after terminal A reports success. Herdr is not used until the later integrated acceptance.

- [ ] **Step 5: Inspect child-process and socket cleanup**

Run:

```bash
if pgrep -fl 'pi --mode rpc.*a4s'; then
  echo "Leaked Pi E0 process" >&2
  exit 1
fi
test -z "$(find artifacts/e0 -name 'a4sd.sock' -print -quit)"
test ! -e /tmp/a4s-e0-manual.sock
```

Expected: no matching Pi process and no stale experiment socket.

- [ ] **Step 6: If a real-boundary defect appears, preserve red-green evidence**

For each defect:

1. keep the failed run directory;
2. add one focused regression test reproducing the mechanism;
3. run that test and verify failure;
4. make the minimal source change;
5. rerun the focused test, full tests, and the failed one-trial scenario;
6. commit only that source/test pair with a message naming the observed mechanism, for example `fix: preserve ACK redelivery after reconnect`.

Do not proceed to Task 9 while any one-trial scenario or the manual smoke fails.

- [ ] **Step 7: Commit only if smoke-run integration required code changes**

If no code changed, do not create an empty commit. If code changed, use the focused fix commit from Step 6.

---

### Task 9: Execute the 20-trial empirical run and generate the report

**Files:**

- Create: `src/e0/report.ts`
- Create: `.workspace/docs/experiments/e0-report.md`
- Test: add report rendering cases to `test/evidence.test.ts`
- Generate locally: `artifacts/e0/$RUN_ID/environment.json`
- Generate locally: `artifacts/e0/$RUN_ID/events.jsonl`
- Generate locally: `artifacts/e0/$RUN_ID/summary.json`

**Interfaces:**

- Consumes: completed artifacts, `EnvironmentRecord`, and `RunSummary`.
- Produces: `ReportInput`, deterministic report rendering, and the committed empirical E0 report.

- [ ] **Step 1: Write a failing report-rendering test**

Append to `test/evidence.test.ts`:

```typescript
import { renderE0Report } from "../src/e0/report.ts";

test("renderE0Report includes commit, hashes, platform verdicts, and anomalies", () => {
  const markdown = renderE0Report({
    testedCommit: "abc123",
    environment: environmentFixture("run-1"),
    summary: passingSummaryFixture(),
    hashes: {
      "environment.json": "a".repeat(64),
      "events.jsonl": "b".repeat(64),
      "summary.json": "c".repeat(64),
    },
    anomalies: [],
    failedRuns: [],
  });
  assert.match(markdown, /abc123/);
  assert.match(markdown, /PASS-macOS/);
  assert.match(markdown, /Windows: NOT RUN/);
  assert.match(markdown, /events\.jsonl/);
});
```

- [ ] **Step 2: Run the report test to verify failure**

Run:

```bash
npm test -- --test-name-pattern="renderE0Report"
```

Expected: FAIL because `src/e0/report.ts` does not exist.

- [ ] **Step 3: Implement deterministic report rendering**

Create `src/e0/report.ts` with this public contract:

```typescript
import type { EnvironmentRecord, RunSummary } from "./evidence.ts";

export interface ReportInput {
  testedCommit: string;
  environment: EnvironmentRecord;
  summary: RunSummary;
  hashes: Record<"environment.json" | "events.jsonl" | "summary.json", string>;
  anomalies: string[];
  failedRuns: string[];
}

export function renderE0Report(input: ReportInput): string;
export async function writeE0Report(runDir: string, outputPath: string): Promise<void>;
```

The generated Markdown must contain these sections with concrete values from artifacts:

```text
# E0 Attach and Transport Experiment Report
## Verdict
## Tested revision and environment
## Procedure
## Results by scenario
## Delivery invariants
## Protocol-error results
## Artifacts and SHA-256 hashes
## Anomalies and failed prior runs
## Platform coverage
## Decision
```

`writeE0Report()` reads the three artifact files, computes SHA-256 using `node:crypto`, and refuses to render if the summary run ID differs from the environment run ID. It scans sibling run directories for prior `FAIL-` summaries and lists their run IDs under failed prior runs.

The CLI requires two positional arguments: run directory and output Markdown path. Missing paths exit 2 without writing a partial report.

- [ ] **Step 4: Verify report tests and all regression tests**

Run:

```bash
npm test -- --test-name-pattern="renderE0Report"
npm test
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit the report generator before measuring**

```bash
git add src/e0/report.ts test/evidence.test.ts
git commit -m "feat: render E0 experiment reports"
test -z "$(git status --porcelain)"
```

Expected: the generator and tests are committed and the working tree is clean, creating an exact revision for the experiment.

- [ ] **Step 6: Execute the authoritative 20-trial run**

```bash
git rev-parse HEAD
npm run e0 -- --trials 20 | tee /tmp/a4s-e0-authoritative.out
RUN_DIR=$(awk -F= '/^run_dir=/{print $2}' /tmp/a4s-e0-authoritative.out | tail -1)
test -n "$RUN_DIR"
test -d "$RUN_DIR"
printf 'authoritative_run=%s\n' "$RUN_DIR"
```

Expected:

```text
S1: 20/20
S2: 20/20
S3: 20/20
S4: 20/20
S5: 20/20
verdict=PASS-macOS
```

If the run fails, keep its artifacts, leave this task incomplete, and return to the focused defect workflow in Task 8 Step 6. Never relabel or overwrite a failed run.

- [ ] **Step 7: Validate the authoritative summary mechanically**

```bash
RUN_DIR=$(awk -F= '/^run_dir=/{print $2}' /tmp/a4s-e0-authoritative.out | tail -1)
jq -e '
  .verdict == "PASS-macOS" and
  ([.scenarios[] | .planned == 20 and .executed == 20 and .passed == 20 and .failed == 0] | all) and
  ([.scenarios[] | .unhandledErrors == 0] | all)
' "$RUN_DIR/summary.json"
```

Expected: `jq` exits 0.

- [ ] **Step 8: Generate and inspect the versioned report**

```bash
RUN_DIR=$(awk -F= '/^run_dir=/{print $2}' /tmp/a4s-e0-authoritative.out | tail -1)
npm run e0:report -- "$RUN_DIR" .workspace/docs/experiments/e0-report.md
rg -n 'PASS-macOS|Windows: NOT RUN|S1|S2|S3|S4|S5|SHA-256' .workspace/docs/experiments/e0-report.md
```

Expected: every required result and hash appears. Do not change a generated verdict manually.

- [ ] **Step 9: Run final verification**

```bash
npm run typecheck
npm test
git diff --check
git status --short
```

Expected: typecheck exits 0, every test passes, diff check is clean, and only `.workspace/docs/experiments/e0-report.md` is uncommitted. Raw `artifacts/e0/` remain ignored.

- [ ] **Step 10: Commit the empirical result**

```bash
git add .workspace/docs/experiments/e0-report.md
git commit -m "test: record E0 transport evidence"
```

- [ ] **Step 11: Verify the committed evidence boundary**

```bash
test -z "$(git status --porcelain)"
git show --stat --oneline HEAD
```

Expected: clean working tree and a commit containing the E0 report. The preceding commit contains the exact report generator and tests used for the authoritative run.

---

## Completion Gate

E0 implementation is complete only when all of the following are true:

- all deterministic tests pass;
- TypeScript reports no errors;
- each real-Pi smoke scenario passes independently;
- S1–S5 each pass 20/20 in one authoritative run;
- zero Deliveries are lost;
- zero logical duplicate processings occur;
- every pending Delivery becomes acknowledged;
- no unhandled errors are present;
- `.workspace/docs/experiments/e0-report.md` records hashes and `PASS-macOS`;
- Windows is stated as `NOT RUN`, not implied to pass;
- the working tree is clean.

After this gate, review the E0 evidence before brainstorming E1. Do not add prompt injection, model turns, Herdr integration, persistence, or restart durability as part of this plan.
