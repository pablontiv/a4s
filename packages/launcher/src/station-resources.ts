import { lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { StateDependencies } from "./station-state.ts";

type ReportConflict = NonNullable<StateDependencies["reportResourceConflict"]>;

function publishLink(path: string, target: string, owns: (target: string) => boolean, report: ReportConflict): void {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  const current = entry?.isSymbolicLink() ? readlinkSync(path) : undefined;
  if (entry) {
    // Normalize text, not realpath: ownership must retain the literal current root.
    if (current === undefined || !owns(resolve(dirname(path), current))) {
      report(`A4S resource conflict: preserving ${path}; expected symlink to ${target}`);
      return;
    }
    if (current === target) return;
    rmSync(path);
  }
  symlinkSync(target, path, "dir");
}
function userDirectory(path: string, report: ReportConflict): boolean {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) { mkdirSync(path, { mode: 0o700 }); return true; }
  if (entry.isDirectory()) return true;
  report(`A4S resource conflict: preserving ${path}; expected a directory for native skills`);
  return false;
}
function releaseSkills(directory: string): Set<string> | undefined {
  let entries: Dirent[];
  try {
    if (!lstatSync(directory).isDirectory()) throw new Error(`Station skills source must be a real directory: ${directory}`);
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const names = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skill = lstatSync(join(directory, entry.name, "SKILL.md"), { throwIfNoEntry: false });
    if (skill?.isFile()) names.add(entry.name);
  }
  return names;
}
/** Reconcile derived native discovery links only while holding .state.lock. */
export function reconcileResources(root: string, dependencies: StateDependencies): void {
  const env = dependencies.env ?? process.env;
  const home = env.HOME || homedir();
  if (!isAbsolute(home)) throw new Error("HOME must be an absolute user home for native resource discovery");
  const report = dependencies.reportResourceConflict ?? console.error;
  const agents = join(root, "current", "agents");
  publishLink(join(root, "loader", "agents"), "../current/agents", target => target === agents || target.startsWith(`${agents}${sep}`), report);

  const source = join(root, "current", "skills");
  const names = releaseSkills(source);
  // A missing active cache must not erase links or prevent state-envelope recovery.
  if (!names) return;
  const nativeRoot = join(home, ".agents"), directory = join(nativeRoot, "skills");
  if (!userDirectory(nativeRoot, report) || !userDirectory(directory, report)) return;
  const prefix = `${source}${sep}`, owns = (target: string) => target.startsWith(prefix);
  for (const name of readdirSync(directory)) {
    if (names.has(name)) continue;
    const path = join(directory, name), entry = lstatSync(path, { throwIfNoEntry: false });
    if (entry?.isSymbolicLink() && owns(resolve(dirname(path), readlinkSync(path)))) rmSync(path);
  }
  for (const name of names) publishLink(join(directory, name), join(source, name), owns, report);
}
