import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRunEndpoint, prepareUnixEndpoint } from "../src/daemon/endpoint.ts";

const tempRoot = "/tmp/a4s-e0-tests";

test("createRunEndpoint returns a named pipe on Windows", () => {
  assert.equal(
    createRunEndpoint("run-123", tempRoot, "win32"),
    "\\\\.\\pipe\\a4s-e0-run-123",
  );
});

test("createRunEndpoint returns a run-scoped socket on Unix", () => {
  assert.equal(
    createRunEndpoint("run-123", tempRoot, "darwin"),
    "/tmp/a4s-e0-tests/run-123/a4sd.sock",
  );
});

test("createRunEndpoint rejects unsafe run IDs", () => {
  assert.throws(() => createRunEndpoint("../escape", tempRoot, "linux"), /invalid run_id/);
});

test("prepareUnixEndpoint rejects an already-active endpoint", async () => {
  const { createServer } = await import("node:net");
  const root = join(tmpdir(), `a4s-e0-active-${process.pid}-${Date.now()}`);
  const endpoint = join(root, "a4sd.sock");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const listener = createServer();

  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(endpoint, resolve);
  });

  try {
    await assert.rejects(() => prepareUnixEndpoint(endpoint), /endpoint already active/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      listener.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(root, { recursive: true, force: true });
  }
});
