import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Dispatcher, Generation, switchGeneration, type Factory, type Host, type ReloadContext } from "@a4s/hot-reload";
import status from "../../issue-lifecycle/src/status/index.ts";

type Queue = { messages: string[]; claimed: boolean; alerts: { message: string; type: "info" | "warning" | "error" }[] };
for (const outcome of ["success", "reject", "timeout"] as const) {
  test(`production status hands messages, UI notifications and deduplication state through ${outcome}`, async t => {
    const cwd = await mkdtemp(join(tmpdir(), "a4s-status-handoff-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const messages: string[] = [], alerts: string[] = [];
    const host: Host & { sendMessage(message: { content: string }): void } = {
      on() {}, registerCommand() {}, registerTool() {},
      sendMessage(message) { messages.push(message.content); },
    };
    const ctx = {
      cwd, hasUI: false, isIdle: () => false, agent: { kind: "main" },
      sessionManager: { getSessionId: () => "owner" },
      ui: { notify(message: string) { alerts.push(message); }, setWidget() {} },
    } as ReloadContext;
    const shared = new Map<string, unknown>();
    const previous = new Generation(shared), next = new Generation(shared);
    const dispatcher = new Dispatcher(host);
    await previous.record(host, status as unknown as Factory<typeof host>);
    dispatcher.active = previous; dispatcher.publish(previous);
    await previous.lifecycle("session_start", ctx, 100);
    previous.commit();
    const queue = (shared.get("status.queues") as Map<string, Queue>).get("owner")!;
    queue.messages.push("old-1", "old-2");
    queue.alerts.push({ message: "old-warning", type: "warning" });
    const notices = shared.get("status.notices");
    await next.record(host, status as unknown as Factory<typeof host>);
    await next.record(host, api => {
      api.on("session_start", async (_event, context) => {
        assert.deepEqual(messages, [], "candidate cannot drain the shared queue before commit");
        queue.messages.push("during-switch");
        queue.alerts.push({ message: "during-switch-warning", type: "warning" });
        if (outcome === "reject") throw new Error("startup rejected");
        if (outcome === "timeout") {
          await delay(60);
          (context as ReloadContext).ui.notify("stale-candidate", "warning");
        }
      });
    });
    try {
      if (outcome === "success") await switchGeneration(dispatcher, next, ctx, 15);
      else await assert.rejects(switchGeneration(dispatcher, next, ctx, 15));
      await delay(80);
      assert.deepEqual(messages, ["old-1", "old-2", "during-switch"]);
      assert.deepEqual(alerts, ["old-warning", "during-switch-warning"]);
      assert.equal(shared.get("status.notices"), notices);
      assert.equal(dispatcher.active, outcome === "success" ? next : previous);
      assert.equal(next.scope.signal.aborted, outcome !== "success");
    } finally { dispatcher.active?.abort(); }
  });
}
