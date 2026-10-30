import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { schedulerTools } from "../../../launcher/src/service-environment.ts";

/** Isolated operator-owned declaration; production never writes these files. */
export function declareService(home: string, endpoint: string, path?: string): NodeJS.ProcessEnv {
  const bin = join(home, "bin");
  if (path === undefined) {
    mkdirSync(bin, { recursive: true });
    for (const tool of schedulerTools) {
      writeFileSync(join(bin, tool), "#!/bin/sh\nexit 0\n");
      chmodSync(join(bin, tool), 0o755);
    }
  }
  const file = join(home, "service-environment.json");
  writeFileSync(file, JSON.stringify({ DAGU_URL: endpoint, DAGU_HOME: home, PATH: path ?? bin }));
  return { A4S_SERVICE_ENV: file, DAGU_HOME: home, DAGU_URL: endpoint };
}
