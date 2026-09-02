import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { E0PiClient, type ClientEvent } from "./client.ts";

const TRACE_PREFIX = "A4S_E0_EVENT\t";
const STARTUP_DEADLINE_MS = 10_000;

function trace(event: ClientEvent): void {
  if (process.env.A4S_E0_TRACE === "stderr") {
    process.stderr.write(`${TRACE_PREFIX}${JSON.stringify(event)}\n`);
  }
}

export default function a4sE0Extension(pi: ExtensionAPI): void {
  let client: E0PiClient | undefined;

  pi.on("session_start", async (_event, ctx) => {
    const endpoint = process.env.A4S_ENDPOINT;
    const ownerId = process.env.A4S_OWNER_ID;
    const bindingRevision = process.env.A4S_BINDING_REVISION;
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionFile = ctx.sessionManager.getSessionFile();

    if (!endpoint || !ownerId || bindingRevision !== "1" || !sessionId || !sessionFile) {
      throw new Error("E0 requires A4S_ENDPOINT, A4S_OWNER_ID, A4S_BINDING_REVISION=1, session_id, and session_file");
    }

    client = new E0PiClient({
      endpoint,
      attach: {
        owner_id: ownerId,
        binding_revision: 1,
        native_ref: { session_id: sessionId, session_file: sessionFile },
      },
      onEvent: trace,
    });

    try {
      await withDeadline(client.start(), STARTUP_DEADLINE_MS, "timed out waiting for E0 attach");
    } catch (error) {
      await client.stop();
      client = undefined;
      throw error;
    }
  });

  pi.on("session_shutdown", async () => {
    await client?.stop();
    client = undefined;
  });
}

async function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
