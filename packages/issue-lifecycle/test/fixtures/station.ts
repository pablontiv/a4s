import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../../bin/dagu-station-install.ts", import.meta.url));

export function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dagu-station-test-"));
  const home = join(root, "Dagu & workflows");
  mkdirSync(home);
  return {
    root, home,
    run(extra: string[] = [], env: NodeJS.ProcessEnv = {}) {
      return spawnSync(process.execPath, [cli, ...extra], {
        encoding: "utf8", env: { ...process.env, DAGU_PARAMS_JSON: "{}", DAGU_HOME: home, ...env },
      });
    },
    dispose() { rmSync(root, { recursive: true, force: true }); },
  };
}
