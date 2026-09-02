import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runExperiment, runManualSmoke } from "../src/e0/driver.ts";
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

test("runManualSmoke removes only its endpoint and preserves the parent directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "a4s-manual-cleanup-"));
  const endpoint = join(root, "a4sd.sock");
  const marker = join(root, "keep.txt");
  await writeFile(marker, "keep", "utf8");

  const smoke = runManualSmoke({ endpoint, ownerId: "W1", timeoutMs: 2_000 });
  await waitForPath(endpoint);
  const client = new E0PiClient({
    endpoint,
    attach: {
      owner_id: "W1",
      binding_revision: 1,
      native_ref: { session_id: "manual-test", session_file: join(root, "session.jsonl") },
    },
    reconnectDelaysMs: [1, 2, 5],
    onEvent: () => undefined,
  });

  try {
    await client.start();
    await smoke;
    await access(marker);
    await assert.rejects(() => access(endpoint), /ENOENT/);
  } finally {
    await client.stop();
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      await access(path);
      return;
    } catch {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
