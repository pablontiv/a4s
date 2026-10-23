import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function withResourceGuard(script: string, definition: string): string {
  const yaml = readFileSync(definition, "utf8");
  const marker = "  - DAGU_RESOURCE_GUARD: |\n";
  const helper = yaml.slice(yaml.indexOf(marker) + marker.length, yaml.indexOf("\nsteps:\n")).split("\n").map(line => line.slice(6)).join("\n");
  return `DAGU_RESOURCE_GUARD='${helper.replace(/'/g, "'\\''")}'\n${script}`;
}

export function stubHistory(root: string): void {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(fileURLToPath(new URL("../bin/dagu-pr-body.mjs", import.meta.url)), join(bin, "dagu-pr-body"));
  writeFileSync(join(bin, "dagu"), '#!/bin/sh\nif [ "$1" = history ]; then printf \'[]\\n\'; else echo "unexpected dagu $*" >&2; exit 1; fi\n');
  chmodSync(join(bin, "dagu"), 0o755);
}
