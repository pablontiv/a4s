import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const requiredVersion: string = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).daguFeature.dagu;
const enabled = process.env.A4S_LIVE_DAGU === "1";
const version = enabled ? spawnSync("dagu", ["version"], { encoding: "utf8" }) : undefined;
export const liveDaguVersion = version?.status === 0 ? version.stdout.trim() : "unavailable";

export const liveDagu = {
  skip: !enabled
    ? "Set A4S_LIVE_DAGU=1 to run live Dagu tests"
    : liveDaguVersion !== requiredVersion
      ? `Dagu ${requiredVersion} required for live integration; found ${liveDaguVersion}`
      : false,
};
