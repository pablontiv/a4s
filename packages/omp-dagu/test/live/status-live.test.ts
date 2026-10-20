import test from "node:test";
import { liveWatcher } from "../fixtures/status-live.ts";

import { liveDagu } from "../fixtures/live-dagu.ts";
test("Dagu durable watcher delivers fast human openings across push-back and succeeded", {
  ...liveDagu,
  timeout: 120_000,
}, async () => { await liveWatcher(); });
