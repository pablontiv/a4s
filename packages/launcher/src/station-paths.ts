import { join, resolve } from "node:path";
import { readServiceEnvironment } from "./service-environment.ts";

/** An explicit DAGU_HOME retains the historical station-local default. A fresh
 * XDG station defaults to XDG_CACHE_HOME/a4s; A4S_CACHE_HOME overrides either.
 * A caller inspecting another station must supply that station's declaration. */
export function stationCacheRoot(home: string): string {
  if (!process.env.DAGU_HOME || resolve(process.env.DAGU_HOME) === resolve(home)) {
    const selected = readServiceEnvironment();
    if (resolve(selected.DAGU_HOME) === resolve(home) && selected.A4S_CACHE_HOME) return selected.A4S_CACHE_HOME;
  }
  return join(resolve(home), "cache", "a4s");
}
