import { createHash } from "node:crypto";
import { accessSync, constants, openSync, closeSync, readSync, fstatSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "./type-guard.ts";
import { readServiceEnvironment, type ServiceEnvironment } from "./service-environment.ts";
const identityTools = ["bash", "git", "gh", "jq", "curl", "node", "omp", "dagu"];
const requiredTools = () => process.versions.bun ? identityTools : [...identityTools, "python3"];

export interface StationBinding {
  schemaVersion: 1;
  target: { endpoint: string; device: string; inode: string };
  tools: Record<string, { sha256: string }>;
}
export function executableOnPath(tool: string, path: string): string {
  for (const directory of path.split(":")) {
    const candidate = join(directory, tool);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch { /* Continue the declared search order. */ }
  }
  throw new Error(`Station tool ${tool} is unavailable; ask the station operator to restore the configured executable`);
}
export function executableDigest(path: string): string {
  const fd = openSync(path, "r"), hash = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error(`Station executable is not a regular file: ${path}`);
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(fd, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error(`Station executable changed while hashing: ${path}; retry after installation completes`);
    return hash.digest("hex");
  } finally { closeSync(fd); }
}
export function stationBinding(station: ServiceEnvironment = readServiceEnvironment()): StationBinding {
  const home = statSync(station.DAGU_HOME, { bigint: true });
  return { schemaVersion: 1, target: { endpoint: station.DAGU_URL, device: String(home.dev), inode: String(home.ino) },
    tools: Object.fromEntries(requiredTools().map(tool => [tool, { sha256: executableDigest(executableOnPath(tool, station.PATH)) }])) };
}
export function assertStationBinding(value: unknown, selected: ServiceEnvironment = readServiceEnvironment()): void {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.target) || !isRecord(value.tools)) throw new Error("Station identity evidence is missing or malformed; use station-recovery pin before changing the admitted station, or restore independently retained evidence");
  const home = statSync(selected.DAGU_HOME, { bigint: true });
  for (const [field, actual] of Object.entries({ endpoint: selected.DAGU_URL, device: String(home.dev), inode: String(home.ino) })) {
    if (value.target[field] !== actual) throw new Error(`Station target ${field} differs from admitted identity; restore the original station target (recovery cannot retarget runs)`);
  }
  for (const tool of new Set([...requiredTools(), ...Object.keys(value.tools)])) {
    if (!identityTools.includes(tool) && tool !== "python3") throw new Error(`Station tool ${tool} has unsupported identity evidence`);
    const expected = value.tools[tool];
    if (!isRecord(expected) || typeof expected.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(expected.sha256)) throw new Error(`Station tool ${tool} has no verified digest evidence; restore retained admission evidence or the original station before station-recovery pin`);
    const actual = executableDigest(executableOnPath(tool, selected.PATH));
    if (expected.sha256 !== actual) throw new Error(`Station tool ${tool} identity mismatch (sha256 expected=${expected.sha256} actual=${actual}); restore the pinned tool bytes; a changed tool requires a separately authorized new admission`);
  }
}
/** Legacy literal bindings stay strict unless a receipt-bound recovery record exists. */
export function assertReceiptStation(station: unknown, recovery?: unknown): void {
  if (station === undefined) return;
  if (!isRecord(station)) throw new Error("Receipt station contract is malformed");
  if (station.schemaVersion === 1) return assertStationBinding(station);
  const selected = readServiceEnvironment();
  for (const field of ["DAGU_URL", "DAGU_HOME"] as const) {
    if (station[field] !== selected[field]) throw new Error(`Run station declaration differs from admitted ${field}; restore the original station target`);
  }
  if (recovery !== undefined) return assertStationBinding(recovery, selected);
  if (station.PATH !== selected.PATH) throw new Error("Run station declaration differs from admitted PATH; use a4s station-recovery with receipt-bound digest evidence; without pre-change evidence restore the original toolchain and declaration before station-recovery pin");
}
