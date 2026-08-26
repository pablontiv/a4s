import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { harness, selection } from "./fixtures.ts";

test("both factories construct privately; successful combined switch leaves one producer", async t => {
  const h = harness(); t.after(() => h.loader.dispose());
  await h.loader.initialize(); await h.host.emit("session_start", h.context);
  assert.equal(h.counts().observers, 1);
  h.setCandidate(selection(2));
  await h.loader.check(h.context);
  assert.equal(h.counts().observers, 1);
  await h.host.emit("produce", h.context);
  assert.deepEqual(h.host.messages, ["2"]);
  assert.equal(h.counts().released, 0);
});

test("second factory failure publishes neither extension and preserves old observer", async t => {
  const h = harness(); t.after(() => h.loader.dispose());
  await h.loader.initialize(); await h.host.emit("session_start", h.context);
  h.assign(2, h.producer("2"), () => { throw new Error("factory failed"); });
  h.setCandidate(selection(2)); await h.loader.check(h.context);
  await h.host.emit("produce", h.context);
  assert.deepEqual(h.host.messages, ["1"]);
  assert.equal(h.counts().observers, 1);
  assert.match(h.notices.join(), /factory failed/);
});

for (const failure of ["start", "timeout"] as const) {
  test(`${failure} aborts candidate, restores old producer; late lifecycle cannot publish`, async t => {
    const h = harness(); t.after(() => h.loader.dispose());
    await h.loader.initialize(); await h.host.emit("session_start", h.context);
    const queue = h.loader.dispatcher.active!.state.get("queue") as string[];
    queue.push("old-undelivered-1", "old-undelivered-2");
    h.assign(2, h.producer("2", failure)); h.setCandidate(selection(2));
    await h.loader.check(h.context);
    assert.equal(h.counts().observers, 1);
    await delay(80);
    await h.host.emit("produce", h.context);
    assert.deepEqual(h.host.messages, ["old-undelivered-1", "old-undelivered-2", ...(failure === "start" ? ["from-failed-candidate"] : []), "1"]);
    assert.equal(h.counts().observers, 1);
    assert.equal(h.counts().released, 0);
  });
}

test("queue transfers exactly once on success and rollback, including repeated switches", async t => {
  const h = harness(); t.after(() => h.loader.dispose());
  await h.loader.initialize(); await h.host.emit("session_start", h.context);
  (h.loader.dispatcher.active!.state.get("queue") as string[]).push("one", "two");
  h.setCandidate(selection(2)); await h.loader.check(h.context);
  h.setCandidate(selection(1)); await h.loader.check(h.context);
  assert.deepEqual(h.host.messages, ["one", "two"]);
  assert.equal(h.counts().observers, 1);
});

test("agent_end defers idle check until handlers return and checks are single flight", async t => {
  const h = harness(); t.after(() => h.loader.dispose());
  await h.loader.initialize(); await h.host.emit("session_start", h.context);
  h.setCandidate(selection(2)); h.setIdle(false);
  await h.host.emit("agent_end", h.context);
  assert.equal(h.counts().leases, 1);
  h.setIdle(true); await delay(20);
  assert.equal(h.counts().leases, 2);
  assert.equal(h.counts().observers, 1);
  const first = h.loader.check(h.context); const second = h.loader.check(h.context);
  assert.equal(first, second); await first;
});

test("automatic checks attempt each failed generation once; manual reload can retry it", async t => {
  const h = harness(); t.after(() => h.loader.dispose());
  await h.loader.initialize(); await h.host.emit("session_start", h.context);
  h.assign(2, h.producer("2"), () => { throw new Error("factory failed"); });
  h.setCandidate(selection(2));
  await h.loader.check(h.context);
  await h.loader.check(h.context);
  assert.equal(h.counts().leases, 2);
  for (const callback of h.host.events.get("input") ?? []) {
    await callback({ text: "/reload-plugins", source: "interactive" }, h.context);
  }
  await delay(20);
  assert.equal(h.counts().leases, 3);
  assert.equal(h.counts().observers, 1);
});
