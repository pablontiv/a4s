import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

test("aborting a failed repository spawn never signals its caller's process group", async () => {
  const module = new URL("../../src/status/repository.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { mkdtemp, rm } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { resolveRepository, readCiDiagnostic, readStallNotices, readEscalationDiagnostic } from ${JSON.stringify(module)};
    const root = await mkdtemp(join(tmpdir(), "a4s-aborted-spawn-"));
    try {
      const cwd = join(root, "missing");
      for (const observe of [
        signal => resolveRepository(cwd, signal),
        signal => readCiDiagnostic(cwd, "test-run", false, signal),
        signal => readStallNotices(cwd, "test-run", signal),
        signal => readEscalationDiagnostic(cwd, "test-run", signal),
      ]) {
        const controller = new AbortController();
        const pending = observe(controller.signal);
        controller.abort();
        await pending;
      }
      assert.equal(await resolveRepository(cwd, AbortSignal.abort()), undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  `], { detached: true, timeout: 10_000 });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const [code, signal] = await once(child, "close");
  assert.equal(signal, null, output);
  assert.equal(code, 0, output);
});
