import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { TYPESAFE_PROVIDER_ID } from "./model.ts";

/**
 * Credential-only Pi provider for TypeSafe: no models, no oauth. It exists to
 * store and resolve the API key via Pi's auth.json (0600); behavior config
 * stays with each consumer. Registered once from this package (ADR 0020).
 */
export function createTypesafeProvider() {
  return createProvider({
    id: TYPESAFE_PROVIDER_ID,
    name: "TypeSafe (Jev)",
    auth: {
      apiKey: {
        name: "TypeSafe API key",
        async login(interaction) {
          return {
            type: "api_key" as const,
            key: await interaction.prompt({ type: "secret", message: "TypeSafe API key" }),
          };
        },
        async resolve({ credential }) {
          return credential?.key
            ? { auth: { apiKey: credential.key }, source: "stored API key" }
            : undefined;
        },
      },
    },
    models: [],
    api: openAICompletionsApi(),
  });
}
