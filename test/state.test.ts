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

test("pendingFor preserves insertion order and markSent tracks physical sends", () => {
  const store = new DeliveryStore();
  const d2 = createDelivery("D2", "W1", "nonce-2");
  store.enqueue(delivery);
  store.enqueue(d2);
  store.markSent("D1");
  store.markSent("D1");
  assert.deepEqual(store.pendingFor("W1", 1).map((item) => item.payload.delivery_id), ["D1", "D2"]);
  assert.equal(store.get("D1")?.sendCount, 2);
});

test("get returns a cloned record view", () => {
  const store = new DeliveryStore();
  store.enqueue(delivery);
  const record = store.get("D1");
  assert.ok(record);
  (record as { status: string }).status = "ACKNOWLEDGED";
  assert.equal(store.get("D1")?.status, "PENDING");
});
