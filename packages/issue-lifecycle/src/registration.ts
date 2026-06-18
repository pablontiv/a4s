import { createHash } from "node:crypto";
import { HELPER_API_VERSION } from "@a4s/hot-reload";

// The host registrations and the build identity consume these same declarations.
export const WORKFLOWS_COMMAND = {
  name: "workflows",
  description: "Toggle the Workflows widget fold, or pass expand / collapse / show / hide",
  completions: ["expand", "collapse", "show", "hide"],
};
export const SESSION_ID_TOOL = {
  name: "dagu_session_id",
  label: "Dagu session ID",
  description: "Return the persistent OMP session ID to pass as OMP_SESSION_ID when enqueueing a Dagu run.",
  loadMode: "essential" as const,
  parameters: { type: "object" as const, properties: {}, additionalProperties: false as const },
};
export const registrationManifest = {
  schema: 1,
  loaderHelperApi: HELPER_API_VERSION,
  extensions: ["./src/status/reloadable.ts", "./src/triage/reloadable.ts"],
  commands: [WORKFLOWS_COMMAND],
  tools: [SESSION_ID_TOOL],
};
/** Sorted keys at every depth make the registration hash independent of insertion order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function registrationHash(manifest: unknown): string {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}
