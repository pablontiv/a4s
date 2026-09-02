import { randomUUID } from "node:crypto";
import { lstat, mkdir, readlink, symlink, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { basename, dirname, join } from "node:path";

const SAFE_RUN_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const PRIVATE_SOCKET_PREFIX = ".a4-";

interface UnixFilesystemIdentity {
  dev: number;
  ino: number;
}

export interface UnixEndpointBinding {
  canonicalEndpoint: string;
  listenEndpoint: string;
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

  let existing;
  try {
    existing = await lstat(endpoint);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }

  if (!existing.isSocket() && !existing.isSymbolicLink()) {
    throw new Error(`endpoint path is not a Unix socket: ${endpoint}`);
  }

  try {
    await probeEndpoint(endpoint);
    throw new Error(`endpoint already active: ${endpoint}`);
  } catch (error) {
    if (!isNodeError(error) || (error.code !== "ECONNREFUSED" && error.code !== "ENOENT")) {
      throw error;
    }

    if (existing.isSymbolicLink() && !(await isOwnPrivateSocketSymlink(endpoint))) {
      throw new Error(`endpoint symlink is not owned by a4sd: ${endpoint}`);
    }

    await unlinkIfSameEntry(endpoint, { dev: existing.dev, ino: existing.ino });
  }
}

export async function createUnixEndpointBinding(endpoint: string): Promise<UnixEndpointBinding> {
  await prepareUnixEndpoint(endpoint);
  return {
    canonicalEndpoint: endpoint,
    listenEndpoint: join(dirname(endpoint), `${PRIVATE_SOCKET_PREFIX}${randomUUID().replaceAll("-", "").slice(0, 5)}`),
  };
}

export async function advertiseUnixEndpointBinding(binding: UnixEndpointBinding): Promise<void> {
  try {
    await symlink(basename(binding.listenEndpoint), binding.canonicalEndpoint);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new Error(`endpoint already active: ${binding.canonicalEndpoint}`);
    }
    throw error;
  }
}

export async function cleanupUnixEndpointBinding(binding: UnixEndpointBinding): Promise<void> {
  try {
    await unlink(binding.listenEndpoint);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

async function isOwnPrivateSocketSymlink(endpoint: string): Promise<boolean> {
  try {
    const target = await readlink(endpoint);
    return basename(target).startsWith(PRIVATE_SOCKET_PREFIX);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function unlinkIfSameEntry(endpoint: string, expected: UnixFilesystemIdentity): Promise<void> {
  let current;
  try {
    current = await lstat(endpoint);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }

  if (current.dev !== expected.dev || current.ino !== expected.ino) return;

  try {
    await unlink(endpoint);
  } catch (error) {
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
