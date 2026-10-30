import { HELPER_API_VERSION } from "@a4s/hot-reload";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "./executable.ts";
import type { ArtifactIdentity } from "../../launcher/src/contracts.ts";

declare const A4S_REGISTRATION_MANIFEST: ArtifactIdentity["registrationManifest"];

function resourceDigests(): Record<string, string> {
  const resources: Record<string, string> = {};
  const visit = (directory: string) => {
    for (const entry of readdirSync(join(packageRoot, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (["dagu-feature-bootstrap.yaml", "__pycache__"].includes(entry.name)) continue;
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) resources[path] = createHash("sha256").update(readFileSync(join(packageRoot, path))).digest("hex");
    }
  };
  visit("skills"); visit("agents");
  return resources;
}

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
export const registrationManifest: ArtifactIdentity["registrationManifest"] = typeof A4S_REGISTRATION_MANIFEST !== "undefined"
  ? A4S_REGISTRATION_MANIFEST : {
  schema: 1,
  loaderHelperApi: HELPER_API_VERSION,
  extensions: ["./src/status/index.ts", "./src/triage/native.ts"],
  commands: [WORKFLOWS_COMMAND],
  tools: [SESSION_ID_TOOL],
  resources: resourceDigests(),
};
