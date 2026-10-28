import { spawnSync } from "node:child_process";

const enabled = process.env.A4S_LIVE_DAGU === "1";
const version = enabled ? spawnSync("dagu", ["version"], { encoding: "utf8" }) : undefined;
export const liveDaguVersion = version?.status === 0 ? version.stdout.trim() : "unavailable";
const parts = /^(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/.exec(liveDaguVersion);
const supported = parts !== null && (Number(parts[1]) > 2
  || (Number(parts[1]) === 2 && Number(parts[2]) >= 23));

export const liveDagu = {
  skip: !enabled
    ? "Set A4S_LIVE_DAGU=1 to run live Dagu tests"
    : !supported
      ? `Dagu 2.23.0 or newer required for live integration; found ${liveDaguVersion}`
      : false,
};
