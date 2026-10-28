import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";

export function writeAtomicJson(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    renameSync(temporary, path);
  } catch (error) {
    try { closeSync(fd); } catch { /* Already closed before rename. */ }
    throw error;
  } finally { rmSync(temporary, { force: true }); }
}
