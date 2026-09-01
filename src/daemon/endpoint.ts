import { mkdir, stat, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";

const SAFE_RUN_ID = /^[a-zA-Z0-9_-]{1,80}$/;

export function createRunEndpoint(
  runId: string,
  tempRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!SAFE_RUN_ID.test(runId)) throw new Error(`invalid run_id: ${runId}`);
  if (platform === "win32") return `\\\\.\\pipe\\a4s-e0-${runId}`;
  return join(tempRoot, runId, "a4sd.sock");
}

export async function prepareUnixEndpoint(endpoint: string): Promise<void> {
  await mkdir(dirname(endpoint), { recursive: true, mode: 0o700 });

  try {
    await stat(endpoint);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }

  try {
    await probeEndpoint(endpoint);
    throw new Error(`endpoint already active: ${endpoint}`);
  } catch (error) {
    if (isNodeError(error) && error.code === "ECONNREFUSED") {
      await unlink(endpoint);
      return;
    }
    throw error;
  }
}

export async function cleanupUnixEndpoint(endpoint: string): Promise<void> {
  try {
    await stat(endpoint);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }

  try {
    await probeEndpoint(endpoint);
  } catch (error) {
    if (isNodeError(error) && error.code === "ECONNREFUSED") {
      await unlink(endpoint);
      return;
    }
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

function probeEndpoint(endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
