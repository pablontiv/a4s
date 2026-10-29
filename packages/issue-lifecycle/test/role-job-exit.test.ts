import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runRoleCommand } from "./fixtures/rolejobs-cli.ts";

for (const blocked of [true, false]) {
  test(`role command explicitly terminates after ${blocked ? "BLOCKED" : "completed"} dispatch`, async () => {
    let dispatched = false;
    const result = await runRoleCommand(["stage", "implement"], process.env, {
      execFileSync,
      dispatchStage: async stage => {
        assert.equal(stage, "implement");
        dispatched = true;
        if (blocked) throw new Error("Role implement failed: Native role execution failed: BLOCKED_AUTHORIZATION fixture");
      },
    });
    assert.equal(dispatched, true);
    assert.equal(result.status, blocked ? 1 : 0);
    assert.equal(result.stdout, "");
    if (blocked) assert.match(result.stderr, /DAGU_ROLE_JOB_BLOCKED: Role implement failed: Native role execution failed: BLOCKED_AUTHORIZATION fixture/);
    else assert.equal(result.stderr, "");
  });
}
test("role command retains only its own output sink after native environment scrubbing", async () => {
  const root = mkdtempSync(join(tmpdir(), "role-output-"));
  const output = join(root, "outputs");
  writeFileSync(output, "");
  try {
    const result = await runRoleCommand(["stage", "implement"], { ...process.env, DAGU_OUTPUT_FILE: output }, {
      execFileSync,
      dispatchStage: async (_stage, emit) => {
        delete process.env.DAGU_OUTPUT_FILE;
        emit("SUMMARY", "Completed\nwith isolation");
        emit("MESSAGE", "fix: isolate role environment");
        emit("IMPLEMENTER", "fixture");
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output, "utf8"), "SUMMARY=Completed with isolation\nMESSAGE=fix: isolate role environment\nIMPLEMENTER=fixture\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("role-job usage errors explicitly terminate", async () => {
  const result = await runRoleCommand([]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DAGU_ROLE_JOB_BLOCKED: Usage: dagu-role-jobs/);
});
