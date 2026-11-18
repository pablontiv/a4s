// Build T3 `providerInstances` entries from lines.json (one isolated Pi instance per line).
// The seed uses it for the selftest's isolated T3; VS7 extends it to sync the operator's T3.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function instancesFromLines(linesPath, piBinary) {
  const doc = JSON.parse(readFileSync(linesPath, "utf8"));
  const base = dirname(resolve(linesPath));
  const out = {};
  for (const [name, line] of Object.entries(doc.lines)) {
    const inst = line.instance ?? {};
    const args = [...(doc.isolation ?? [])];
    if (inst.tools?.length) args.push("--tools", inst.tools.join(","));
    if (inst.prompt) args.push("--append-system-prompt", resolve(base, inst.prompt));
    out[line.provider] = {
      driver: "pi",
      enabled: true,
      ...(inst.displayName ? { displayName: inst.displayName } : {}),
      ...(inst.accentColor ? { accentColor: inst.accentColor } : {}),
      environment: [{ name: "A4S_LINE", value: name }],
      config: { binaryPath: piBinary, launchArgs: args.join(" ") },
    };
  }
  return out;
}
