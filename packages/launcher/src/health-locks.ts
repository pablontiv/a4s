import { readFileSync, readdirSync, readlinkSync, statSync, statfsSync } from "node:fs";
import { join } from "node:path";

export interface Observation<T> { value: T | null; reason: string | null }
export function known<T>(value: T): Observation<T> { return { value, reason: null }; }
export function unknown<T = never>(reason: string): Observation<T> { return { value: null, reason }; }
export function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
interface Identity { major: string; minor: string; inode: string }
interface LockRow extends Identity { pid: number }
/** Linux gnu_dev_major/minor layout; do not use JS's truncating 32-bit operators. */
export function deviceIdentity(dev: bigint, inode: bigint): Identity {
  return { major: (((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n)).toString(),
    minor: ((dev & 0xffn) | ((dev >> 12n) & 0xffffff00n)).toString(), inode: inode.toString() };
}
function same(a: Identity, b: Identity): boolean { return a.major === b.major && a.minor === b.minor && a.inode === b.inode; }
export function parseLockInventory(text: string): LockRow[] {
  const rows: LockRow[] = [];
  for (const line of text.split("\n").filter(line => line.trim())) {
    const fields = line.trim().split(/\s+/);
    if (!/^\d+:$/.test(fields[0] ?? "")) throw new Error("Malformed /proc/locks row index");
    if (fields[1] === "->") fields.splice(1, 1); // Validate waiters, but never count them as holders.
    const blocked = /\s->\s/.test(line);
    const identity = /^([a-f\d]+):([a-f\d]+):(\d+)$/i.exec(fields[5] ?? "");
    if (fields.length !== 8 || !identity || !/^-?\d+$/.test(fields[4] ?? "") ||
        !["FLOCK", "POSIX", "OFDLCK", "LEASE"].includes(fields[1]!) ||
        !["ADVISORY", "MANDATORY", "ACTIVE", "BREAKING", "BREAKER"].includes(fields[2]!) ||
        !["READ", "WRITE", "UNLCK"].includes(fields[3]!) || !/^\d+$/.test(fields[6]!) || !/^(?:\d+|EOF)$/.test(fields[7]!)) {
      throw new Error("Malformed /proc/locks inventory; occupancy cannot be established");
    }
    if (!blocked && fields[1] === "FLOCK" && fields[2] === "ADVISORY" && fields[3] === "WRITE") {
      const pid = Number(fields[4]);
      if (!Number.isSafeInteger(pid)) throw new Error("Invalid /proc/locks PID");
      rows.push({ major: BigInt(`0x${identity[1]}`).toString(), minor: BigInt(`0x${identity[2]}`).toString(), inode: BigInt(identity[3]!).toString(), pid });
    }
  }
  return rows;
}
function reportedProcess(pid: number, path: string, identity: Identity, proc: string) {
  const opaque = "Reported PID is nonpositive or namespace-opaque; descriptor ownership is unknown";
  const root = join(proc, String(pid));
  let alive: Observation<boolean> = unknown(opaque), cmdline: Observation<string> = unknown(opaque);
  let matchingFds: Observation<Array<{ fd: string; target: string }>> = unknown(opaque);
  if (pid > 0) {
    try {
      const before = readFileSync(join(root, "stat"), "utf8");
      const fields = before.slice(before.lastIndexOf(")") + 2).split(" "), start = fields[19], state = fields[0];
      const status = readFileSync(join(root, "status"), "utf8");
      if (!start || !/^\d+$/.test(start) || !state || !/^[RSDZTtXxKWPI]$/.test(state) || !new RegExp(`^Pid:\\s+${pid}$`, "m").test(status)) throw new Error("Malformed or translated process identity");
      alive = /[ZXx]/.test(state) ? { value: false, reason: "Reported process is zombie/exited; another process may still retain an inherited locked descriptor" } : known(true);
      try {
        const value = readFileSync(join(root, "cmdline"), "utf8").replace(/\0/g, " ").trim();
        cmdline = value ? known(value) : unknown("Process cmdline is empty (kernel thread, zombie or race)");
      } catch (error) { cmdline = unknown(diagnostic(error)); }
      try {
        const matches: Array<{ fd: string; target: string }> = [];
        for (const fd of readdirSync(join(root, "fd")).sort((a, b) => Number(a) - Number(b))) {
          const descriptor = join(root, "fd", fd);
          const target = readlinkSync(descriptor);
          if (target !== path) continue;
          const info = statSync(descriptor, { bigint: true });
          if (same(identity, deviceIdentity(info.dev, info.ino))) matches.push({ fd, target });
        }
        matchingFds = known(matches);
      } catch (error) { matchingFds = unknown(`Descriptor corroboration incomplete: ${diagnostic(error)}`); }
      const after = readFileSync(join(root, "stat"), "utf8");
      if (after.slice(after.lastIndexOf(")") + 2).split(" ")[19] !== start) throw new Error("Process changed during observation (possible PID reuse)");
    } catch (error) {
      const reason = `Reported PID metadata unavailable: ${diagnostic(error)}; exited, hidden namespace, inherited descriptor or snapshot race; lock occupancy is independent`;
      alive = unknown(reason); cmdline = unknown(reason); matchingFds = unknown(reason);
    }
  }
  return { reportedPid: pid, alive, cmdline, matchingFds,
    ownership: "A reported PID or executable name is not ownership proof; matching fds corroborate a descriptor, not exclusive ownership" };
}
/** Exactly one kernel inventory read shared by the two canonical paths. Never opens a lock. */
export function observeLocks(paths: string[], proc = "/proc", filesystemType: (path: string) => number = path => statfsSync(path).type) {
  const identities = paths.map(path => {
    try {
      if (process.platform !== "linux") throw new Error("Lock device identity mapping is supported only on Linux ext4");
      const info = statSync(path, { bigint: true });
      if (!info.isFile()) throw new Error("Lock path is not a regular file");
      if (filesystemType(path) !== 0xef53) throw new Error("Unsupported filesystem: stat-to-kernel lock mapping was demonstrated only on ext4");
      return known(deviceIdentity(info.dev, info.ino));
    } catch (error) { return unknown<Identity>(diagnostic(error)); }
  });
  let inventory: Observation<LockRow[]>;
  try { inventory = known(parseLockInventory(readFileSync(join(proc, "locks"), "utf8"))); }
  catch (error) { inventory = unknown(diagnostic(error)); }
  return paths.map((path, index) => {
    let identity = identities[index]!;
    if (identity.value) {
      try {
        const after = statSync(path, { bigint: true });
        if (!same(identity.value, deviceIdentity(after.dev, after.ino))) throw new Error("Lock inode changed during observation");
      } catch (error) { identity = unknown(diagnostic(error)); }
    }
    const reason = identity.reason ?? inventory.reason;
    const rows = identity.value && inventory.value ? inventory.value.filter(row => same(row, identity.value!)).sort((a, b) => a.pid - b.pid) : null;
    return { path, identity, held: rows ? known(rows.length > 0) : unknown<boolean>(reason!),
      holders: rows ? known(rows.map(row => reportedProcess(row.pid, path, identity.value!, proc))) : unknown(reason!),
      source: "/proc/locks: granted FLOCK ADVISORY WRITE; device major/minor (hex) and inode (decimal)",
      scope: "Kernel inventory snapshot, not an atomic process/lock observation; false means no matching granted row observed" };
  });
}
