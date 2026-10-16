import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { liveWatcher } from "./fixtures/status-live.ts";

const version = spawnSync("dagu", ["version"], { encoding: "utf8" });
const supported: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).daguFeature.dagu;
test("Dagu durable watcher delivers fast human openings across push-back and succeeded", {
  skip: version.status !== 0 || version.stdout.trim() !== supported
    ? `live event-log integration requires Dagu ${supported}; found ${version.stdout?.trim() || "unavailable"}` : false,
  timeout: 120_000,
}, async () => { await liveWatcher(); });
