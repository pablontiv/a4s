import { HELPER_API_VERSION, type Generation } from "@a4s/hot-reload";
import { LAUNCHER_PROTOCOL, registrationHash, type ArtifactIdentity } from "../../launcher/src/contracts.ts";
export const LOADER_PROTOCOL = 1;
export function assertManifest(identity: ArtifactIdentity, current?: ArtifactIdentity): void {
  const manifest = identity.registrationManifest;
  const launcher = identity.requiredLauncherProtocol;
  const loader = identity.requiredLoaderProtocol ?? 1;
  if (!Number.isSafeInteger(launcher) || launcher < 1 || launcher > LAUNCHER_PROTOCOL
    || !Number.isSafeInteger(loader) || loader < 1 || loader > LOADER_PROTOCOL
    || manifest.schema !== 1 || manifest.loaderHelperApi !== HELPER_API_VERSION
    || JSON.stringify(manifest.extensions) !== JSON.stringify(["./src/status/index.ts", "./src/triage/native.ts"])
    || registrationHash(manifest) !== identity.registrationManifestHash
    || (current && current.registrationManifestHash !== identity.registrationManifestHash)) {
    throw new Error("Registration/resources or loader/launcher protocol changed; restart OMP. Active generation unchanged.");
  }
}
export function validateRegistrations(generation: Generation, identity: ArtifactIdentity): void {
  const commands = [...generation.commands].map(([name, command]) => ({
    name, description: command.description,
    completions: typeof command.getArgumentCompletions === "function"
      ? (command.getArgumentCompletions("") as { value: string }[] | null)?.map(item => item.value) ?? [] : [],
  }));
  const tools = [...generation.tools.values()].map(tool => Object.fromEntries(
    Object.entries(tool).filter(([, value]) => typeof value !== "function"),
  ));
  const sort = (items: unknown[]) => items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (registrationHash(sort(commands)) !== registrationHash(sort([...identity.registrationManifest.commands]))
    || registrationHash(sort(tools)) !== registrationHash(sort([...identity.registrationManifest.tools]))) {
    throw new Error("Constructed registrations differ from identity.json; restart OMP");
  }
  generation.seal();
}
