import { E0Server } from "./server.ts";

const EVENT_PREFIX = "A4S_E0_EVENT\t";

async function main(): Promise<void> {
  const endpoint = requiredEnv("A4S_ENDPOINT");
  const ownerId = requiredEnv("A4S_OWNER_ID");
  const bindingRevision = requiredEnv("A4S_BINDING_REVISION");

  if (bindingRevision !== "1") {
    throw new Error("A4S_BINDING_REVISION must be 1");
  }

  const server = new E0Server({
    endpoint,
    expectedOwnerId: ownerId,
    expectedBindingRevision: 1,
    onEvent(event) {
      process.stderr.write(`${EVENT_PREFIX}${JSON.stringify(event)}\n`);
    },
  });

  await server.start();

  const stop = async () => {
    await server.stop();
  };
  process.once("SIGINT", () => {
    stop().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    stop().finally(() => process.exit(0));
  });
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable: ${name}`);
  return value;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${EVENT_PREFIX}${JSON.stringify({ component: "a4sd", event: "fatal", detail: message })}\n`);
  process.exit(1);
});
