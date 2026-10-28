import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const packageDir = fileURLToPath(new URL("../../", import.meta.url));
const skillDir = join(packageDir, "skills", "issue-execution");
function bootstrap(): { steps: Array<{ id: string; run?: string }> } {
  return parse(readFileSync(join(skillDir, "dagu-feature-bootstrap.yaml"), "utf8"));
}

test("bootstrap detect fails with the missing release executable's path", () => {
  const root = mkdtempSync(join(tmpdir(), "a4s-detect-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    for (const tool of ["git", "gh", "jq", "dagu"]) {
      writeFileSync(join(bin, tool), "#!/bin/sh\nexit 0\n");
      chmodSync(join(bin, tool), 0o755);
    }
    const missing = join(root, "missing-a4s");
    const result = spawnSync("bash", ["-c", bootstrap().steps.find(step => step.id === "detect")!.run!], {
      encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, A4S_BIN: missing },
    });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(`bootstrap detect: required command not found: ${missing}`), result.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
