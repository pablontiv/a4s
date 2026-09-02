import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runExperiment } from "../src/e0/driver.ts";
import type { PiLaunchContext, PiLauncher, PiProcessHandle } from "../src/e0/pi-process.ts";
import { E0PiClient } from "../src/pi-extension/client.ts";

async function createTempArtifactRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "a4s-driver-"));
}

class FakePiLauncher implements PiLauncher {
  starts = 0;

  async start(context: PiLaunchContext): Promise<PiProcessHandle> {
    this.starts += 1;
    const client = new E0PiClient({
      endpoint: context.endpoint,
      attach: {
        owner_id: context.ownerId,
        binding_revision: context.bindingRevision,
        native_ref: {
          session_id: `fake-${this.starts}`,
          session_file: join(context.sessionDir, `fake-${this.starts}.jsonl`),
        },
      },
      reconnectDelaysMs: [1, 2, 5],
      onEvent: (event) => context.onTrace(event as unknown as Record<string, unknown>),
    });
    await client.start();
    return { pid: process.pid, stop: () => client.stop() };
  }
}

class FailingPiLauncher implements PiLauncher {
  async start(_context: PiLaunchContext): Promise<PiProcessHandle> {
    throw new Error("synthetic Pi startup failure");
  }
}

test("runExperiment executes each selected scenario for every trial", async () => {
  const launcher = new FakePiLauncher();
  const result = await runExperiment({
    trials: 2,
    scenarios: ["S1", "S2", "S3", "S4", "S5"],
    launcher,
    artifactRoot: await createTempArtifactRoot(),
  });
  assert.equal(launcher.starts, 10);
  assert.equal(result.summary.verdict.startsWith("PASS-"), true);
});

test("runExperiment records FAIL when the Pi boundary fails", async () => {
  const result = await runExperiment({
    trials: 1,
    scenarios: ["S1"],
    launcher: new FailingPiLauncher(),
    artifactRoot: await createTempArtifactRoot(),
  });
  assert.equal(result.summary.verdict.startsWith("FAIL-"), true);
});
