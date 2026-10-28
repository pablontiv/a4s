import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "a4s source "));
export const a4sBin = join(root, "a4s");
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
writeFileSync(a4sBin, `#!/bin/sh\nexec ${quote(process.execPath)} --import ${quote(import.meta.resolve("tsx"))} ${quote(fileURLToPath(new URL("../../src/cli.ts", import.meta.url)))} "$@"\n`);
chmodSync(a4sBin, 0o755);
after(() => rmSync(root, { recursive: true, force: true }));
