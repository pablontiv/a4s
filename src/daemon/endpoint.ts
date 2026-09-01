import { randomUUID } from "node:crypto";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { basename, dirname, join } from "node:path";

const SAFE_RUN_ID = /^[a-zA-Z0-9_-]{1,80}$/;

export interface UnixEndpointIdentity {
  dev: number;
  ino: number;
}

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

export async function captureUnixEndpointIdentity(endpoint: string): Promise<UnixEndpointIdentity> {
  const stats = await stat(endpoint);
  return { dev: stats.dev, ino: stats.ino };
}

export async function preserveUnixEndpointForClose(endpoint: string): Promise<() => Promise<void>> {
  const preservedEndpoint = join(
    dirname(endpoint),
    `${basename(endpoint)}.preserved-${process.pid}-${randomUUID()}`,
  );

  try {
    await rename(endpoint, preservedEndpoint);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return async () => {};
    throw error;
  }

  let restored = false;
  return async () => {
    if (restored) return;
    restored = true;
    try {
      await rename(preservedEndpoint, endpoint);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
  };
}

export async function cleanupUnixEndpoint(endpoint: string, ownedIdentity: UnixEndpointIdentity): Promise<void> {
  let currentIdentity: UnixEndpointIdentity;
  try {
    currentIdentity = await captureUnixEndpointIdentity(endpoint);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }

  if (!sameUnixEndpointIdentity(currentIdentity, ownedIdentity)) return;

  try {
    await unlink(endpoint);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

function sameUnixEndpointIdentity(left: UnixEndpointIdentity, right: UnixEndpointIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
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
