import { readServiceEnvironment } from "@a4s/launcher/service-environment";

import { join } from "node:path";
import { gc, initializeStation, promote } from "@a4s/launcher/station";
import { readStateLocked, stationTransaction } from "@a4s/launcher/station-state";
import { parseArtifact } from "@a4s/launcher/release";

export async function main(args: string[]): Promise<void> {
  const home = readServiceEnvironment().DAGU_HOME;
  if (args[0] === "init" && args.length === 3 && args[1] === "--artifact") {
    console.log(JSON.stringify(await initializeStation(home, parseArtifact(args[2]))));
    return;
  }
  if (args.length === 1) {
    if (args[0] === "state") { console.log(JSON.stringify(await stationTransaction(home, async () => readStateLocked(home)))); return; }
    if (args[0] === "promote") { console.log(JSON.stringify(await promote(home))); return; }
    if (args[0] === "gc") { console.log(JSON.stringify(await gc(home))); return; }
  }
  throw new Error("Usage: a4s station init --artifact <id>@<sha>#<digest> | state | promote | gc; rollback is a4s-launch rollback");
}
