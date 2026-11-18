// Temporary, local-only extension for the A4S current-thread acceptance test.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "../../pilots/pi-triage/supervisor/index.ts";

export default function demo(pi: ExtensionAPI) {
  const profile = "/home/pones/.local/state/a4s/pi-triage-current.ikwz6Q/supervise.json";
  if (!existsSync(profile)) return;
  const { daguHome } = JSON.parse(readFileSync(profile, "utf8"));
  if (!existsSync(join(daguHome, ".a4s-pi-triage-slice"))) return;
  const key = "A4S_PI_TRIAGE_SUPERVISOR_CONFIG";
  const previous = process.env[key];
  try {
    process.env[key] = profile;
    register(pi);
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}
