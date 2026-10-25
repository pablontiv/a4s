import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { resolveRunPrimary } from "./run-primary.ts";

type Bundle = { version: string; commit: string };
type Pin = Bundle & { path: string; package: string; bundleDigest: string; entrypointDigest?: string };
type Reference = Bundle & { dag: string; run: string; primary: string; status: string; resolution?: Pin; error?: string };
function read(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Expected JSON object: ${path}`);
  return value as Record<string, unknown>;
}
const git = (path: string, ...args: string[]): string => execFileSync("git", ["-C", path, ...args], { encoding: "utf8", timeout: 60000, maxBuffer: 64 * 1024 * 1024 }).trim();
const digest = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const json = (path: string, value: unknown): void => {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
};
function bundle(value: unknown): Bundle {
  if (!value || typeof value !== "object" || !("version" in value) || !("commit" in value) || typeof value.version !== "string" || typeof value.commit !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value.version) || !/^[a-f0-9]{40}$/.test(value.commit)) throw new Error("Invalid executor bundle identity");
  return { version: value.version, commit: value.commit };
}
function packageAt(path: string): string {
  for (const name of ["issue-lifecycle", "omp-dagu"]) {
    if (existsSync(join(path, "packages", name, "package.json"))) return name;
  }
  throw new Error(`No lifecycle package in ${path}`);
}
function inspect(path: string, expected?: Bundle): Pin {
  if (lstatSync(path).isSymbolicLink()) throw new Error(`Executor must not be a symlink: ${path}`);
  const name = packageAt(path);
  const manifest = read(join(path, "packages", name, "package.json"));
  const identity = bundle({ version: manifest.version, commit: git(path, "rev-parse", "HEAD") });
  if (manifest.name !== `@a4s/${name}` || (expected && (identity.version !== expected.version || identity.commit !== expected.commit))) throw new Error(`Executor identity mismatch: ${path}`);
  const entrypoint = join(path, "packages", name, "bin", "dagu-role-jobs.ts");
  return { ...identity, path, package: name, bundleDigest: digest(join(path, "packages", name, "src", "bundle.ts")),
    ...(existsSync(entrypoint) ? { entrypointDigest: digest(entrypoint) } : {}) };
}
function root(home: string): string { return join(home, "executors"); }
function candidates(home: string): string[] {
  if (!existsSync(root(home))) return [];
  return readdirSync(root(home)).filter(name => /^(?:issue-lifecycle|omp-dagu)-\d+\.\d+\.\d+(?:-[a-f0-9]{40})?$/.test(name)).map(name => join(root(home), name));
}
export function resolveExecutor(home: string, identity: Bundle): Pin {
  bundle(identity);
  for (const name of ["issue-lifecycle", "omp-dagu"]) {
    for (const suffix of [`${identity.version}-${identity.commit}`, identity.version]) {
      const path = join(root(home), `${name}-${suffix}`);
      if (!existsSync(path)) continue;
      // A version-only legacy directory may belong to another commit. Never use it
      // for that run, but still permit the exact-commit directory of the other name.
      try { return inspect(path, identity); } catch (error) {
        if (suffix.endsWith(identity.commit)) throw error;
      }
    }
  }
  throw new Error(`Missing pinned executor ${identity.version}@${identity.commit}`);
}
export function runBundle(primary: string, run: string): Bundle {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(run)) throw new Error("Invalid run id");
  const receipts = ["dagu-feature", "poc"].map(kind => git(primary, "rev-parse", "--path-format=absolute", "--git-path", `${kind}/runs/${run}/receipt.json`)).filter(existsSync);
  if (receipts.length !== 1) throw new Error(`Expected one immutable receipt for ${primary}:${run}`);
  const receipt = read(receipts[0]!);
  if (!receipt.runReceipt || typeof receipt.runReceipt !== "object" || !("run" in receipt.runReceipt) || receipt.runReceipt.run !== run) throw new Error(`Receipt run mismatch: ${run}`);
  return bundle(receipt.sourceVersion);
}
async function inventory(home: string): Promise<Reference[]> {
  const rows: unknown = JSON.parse(execFileSync("dagu", ["history", "--from", "1970-01-01", "--status", "running,waiting,queued,not_started", "--format", "json", "--limit", "1000"], {
    env: { ...process.env, DAGU_HOME: home }, encoding: "utf8", timeout: 30000, maxBuffer: 64 * 1024 * 1024,
  }));
  if (!Array.isArray(rows) || rows.length >= 1000) throw new Error("Incomplete active history (1000-row boundary); no migration or retention is safe");
  const result: Reference[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || typeof row.name !== "string" || typeof row.dagRunId !== "string" || typeof row.status !== "string" || (row.params !== undefined && typeof row.params !== "string")) throw new Error("Malformed active history");
    if (["succeeded", "failed", "aborted"].includes(row.status.toLowerCase())) throw new Error("Active history contains terminal status");
    const primary = await resolveRunPrimary((process.env.DAGU_URL || "http://127.0.0.1:8080").replace(/\/+$/, ""), { name: row.name, dagRunId: row.dagRunId, params: row.params, statusLabel: row.status }, AbortSignal.timeout(10000));
    if (!primary) {
      if (["feature", "poc"].includes(row.name) || (Array.isArray(row.labels) && row.labels.some((label: unknown) => typeof label === "string" && label.startsWith("dagu-feature-bundle=")))) throw new Error(`Unresolved PRIMARY for ${row.name}:${row.dagRunId}`);
      continue;
    }
    const identity = runBundle(primary, row.dagRunId);
    const reference: Reference = { ...identity, dag: row.name, run: row.dagRunId, primary: realpathSync(primary), status: row.status };
    try { reference.resolution = resolveExecutor(home, identity); }
    catch (error) { reference.error = String(error); }
    result.push(reference);
  }
  return result;
}
function clean(path: string): void {
  if (git(path, "status", "--porcelain", "--untracked-files=all")) throw new Error(`Dirty executor retained: ${path}`);
  const ignored = git(path, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory").split("\n").filter(Boolean);
  if (ignored.some(name => name !== "node_modules/" && !/^packages\/[^/]+\/node_modules\/$/.test(name))) throw new Error(`Ignored operator files retained: ${path}`);
}
function same(before: Pin, after: Pin): boolean {
  return before.version === after.version && before.commit === after.commit && before.package === after.package && before.bundleDigest === after.bundleDigest && before.entrypointDigest === after.entrypointDigest;
}
function independent(path: string): void {
  if (!statSync(join(path, ".git")).isDirectory() || realpathSync(join(path, ".git")) !== git(path, "rev-parse", "--path-format=absolute", "--git-common-dir") || existsSync(join(path, ".git", "objects", "info", "alternates"))) throw new Error(`Executor has shared Git storage: ${path}`);
}
function checkout(source: string, commit: string, staging: string): void {
  execFileSync("git", ["clone", "--no-local", "--no-checkout", "--", source, staging], { stdio: "pipe", timeout: 120000 });
  git(staging, "fetch", "--depth", "1", "origin", commit);
  git(staging, "checkout", "--detach", commit);
  independent(staging);
  execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: staging, stdio: "pipe", timeout: 120000 });
}
function target(home: string, path: string): string {
  const absolute = resolve(path);
  if (dirname(absolute) !== root(home) || !candidates(home).includes(absolute) || realpathSync(absolute) !== absolute) throw new Error(`Not a direct managed executor: ${path}`);
  if (lstatSync(join(absolute, ".git")).isSymbolicLink()) throw new Error("Symlink Git metadata retained");
  const pin = inspect(absolute);
  if (![`${pin.package}-${pin.version}`, `${pin.package}-${pin.version}-${pin.commit}`].includes(basename(absolute)) || git(absolute, "branch", "--show-current")) throw new Error("Development checkout retained");
  return absolute;
}
export type ExecutorOptions = { action: string; home: string; source?: string; commit?: string; executor?: string; launcherDir?: string; evidence: string; admissionClose?: string; admissionOpen?: string };
export async function stationExecutors(options: ExecutorOptions): Promise<void> {
  const { action } = options;
  if (!["install", "inventory", "migrate", "prune"].includes(action)) throw new Error("executor-action must be install, inventory, migrate or prune");
  if (["migrate", "prune"].includes(action) && (!options.executor || !options.source || !options.admissionClose || !options.admissionOpen)) throw new Error("migrate/prune require --executor, --source, --admission-close and --admission-open (operator-owned quiescence hooks)");
  if (action === "install" && (!options.source || !options.commit || !options.launcherDir)) throw new Error("install requires --source, --commit and --launcher-dir");
  const home = realpathSync(options.home);
  mkdirSync(root(home), { recursive: true });
  if (realpathSync(root(home)) !== root(home)) throw new Error("Executor root must not be a symlink");
  const lock = join(home, ".station-install.lock");
  mkdirSync(lock);
  let closed = false;
  let reserved = false;
  const evidence: Record<string, unknown> = { schemaVersion: 1, action, command: process.argv, startedAt: new Date().toISOString() };
  const record = (): void => json(resolve(options.evidence), evidence);
  const hook = (command: string): void => { execFileSync("/bin/sh", ["-eu", "-c", command], { env: { ...process.env, DAGU_HOME: home }, stdio: "pipe", timeout: 30000 }); };
  try {
    // Reserve evidence before effects; do not overwrite a prior operation receipt.
    writeFileSync(resolve(options.evidence), "{}\n", { flag: "wx", mode: 0o600 });
    reserved = true;
    if (options.source) evidence.worktreesBefore = git(options.source, "worktree", "list", "--porcelain");
    if (action === "migrate" || action === "prune") { closed = true; hook(options.admissionClose!); }
    const before = await inventory(home);
    evidence.before = before;
    record();
    if (closed && before.some(ref => !["waiting", "not_started"].includes(ref.status.toLowerCase()))) throw new Error("Station must be quiescent: running/queued references remain");
    if (action === "install") {
      if (!/^[a-f0-9]{40}$/.test(options.commit!)) throw new Error("--commit must be the exact recorded SHA40");
      const commit = git(options.source!, "rev-parse", `${options.commit}^{commit}`);
      // Read version from the recorded revision, never the source's working tree.
      let name = "issue-lifecycle";
      let manifest: { name: string; version: string };
      try { manifest = JSON.parse(git(options.source!, "show", `${commit}:packages/${name}/package.json`)); }
      catch { name = "omp-dagu"; manifest = JSON.parse(git(options.source!, "show", `${commit}:packages/${name}/package.json`)); }
      if (manifest.name !== `@a4s/${name}`) throw new Error("Invalid source manifest");
      const identity = bundle({ version: manifest.version, commit });
      const destination = join(root(home), `${name}-${identity.version}-${commit}`);
      if (!existsSync(destination)) {
        const stage = mkdtempSync(join(root(home), ".install-"));
        try {
          checkout(realpathSync(options.source!), commit, join(stage, "checkout"));
          inspect(join(stage, "checkout"), identity);
          renameSync(join(stage, "checkout"), destination);
        } finally { rmSync(stage, { recursive: true, force: true }); }
      }
      independent(destination);
      const pin = inspect(destination, identity);
      if (!pin.entrypointDigest) throw new Error("Recorded bundle has no role-jobs entrypoint; existing historical pins must stay retained");
      const launcherModule = join(destination, "packages", name, "bin", "dagu-station-executor.ts");
      if (!existsSync(launcherModule)) throw new Error("Active bundle predates maintained station launcher; install a current bundle, retain the historical executor");
      json(join(root(home), "active.json"), pin);
      const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
      mkdirSync(options.launcherDir!, { recursive: true });
      const launcher = join(options.launcherDir!, "dagu-role-jobs");
      const content = `#!/bin/sh\n# Managed by dagu-station-install; run receipts select their own executor.\nexport DAGU_HOME=${quote(home)}\nexec bun ${quote(launcherModule)} "$@"\n`;
      let current: string | undefined;
      try { current = readFileSync(launcher, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (current !== content) {
        const stage = mkdtempSync(join(options.launcherDir!, ".launcher-"));
        try {
          const replacement = join(stage, "dagu-role-jobs");
          writeFileSync(replacement, content, { flag: "wx", mode: 0o755 });
          renameSync(replacement, launcher);
        } finally { rmSync(stage, { recursive: true, force: true }); }
      }
      evidence.installed = pin;
    } else if (action === "migrate" || action === "prune") {
      const path = target(home, options.executor!);
      const pin = inspect(path);
      clean(path);
      if (git(options.source!, "rev-parse", `${pin.commit}^{commit}`) !== pin.commit) throw new Error("Executor does not belong to the specified source");
      const references = before.filter(ref => ref.version === pin.version && ref.commit === pin.commit);
      if (action === "prune") {
        if (before.some(ref => ref.error)) throw new Error("Unresolved run references; retention fails closed");
        if (!existsSync(join(root(home), "active.json"))) throw new Error("Install the active independent pin before pruning");
        const active = read(join(root(home), "active.json"));
        if (references.length || active?.path === path) throw new Error(`Referenced or active executor retained: ${path}`);
        if (statSync(join(path, ".git")).isDirectory()) { independent(path); rmSync(path, { recursive: true }); }
        else {
          if (git(path, "rev-parse", "--path-format=absolute", "--git-common-dir") !== git(options.source!, "rev-parse", "--path-format=absolute", "--git-common-dir")) throw new Error("Foreign worktree retained");
          git(options.source!, "worktree", "remove", path);
        }
        evidence.removed = pin;
      } else if (statSync(join(path, ".git")).isDirectory()) {
        independent(path);
        evidence.unchanged = pin;
      } else {
        if (references.some(ref => ref.error)) throw new Error("Referenced executor lacks exact bundle resolution; retained without migration");
        if (git(path, "rev-parse", "--path-format=absolute", "--git-common-dir") !== git(options.source!, "rev-parse", "--path-format=absolute", "--git-common-dir")) throw new Error("Foreign worktree retained");
        const stage = mkdtempSync(join(root(home), ".migrate-"));
        const replacement = join(stage, "checkout");
        const backup = join(stage, "original");
        let moved = false;
        try {
          checkout(realpathSync(options.source!), pin.commit, replacement);
          if (!same(pin, inspect(replacement, pin))) throw new Error("Migration changes recorded bundle resolution");
          evidence.recovery = { executor: path, backup, replacement };
          record();
          git(options.source!, "worktree", "move", path, backup);
          moved = true;
          renameSync(replacement, path);
          independent(path);
          if (!same(pin, inspect(path, pin))) throw new Error("Post-migration resolution mismatch");
          git(options.source!, "worktree", "remove", backup);
          moved = false;
          evidence.migrated = { before: pin, after: inspect(path, pin) };
        } catch (error) {
          if (moved) {
            if (existsSync(path)) renameSync(path, replacement);
            git(options.source!, "worktree", "move", backup, path);
            moved = false;
          }
          throw error;
        } finally { if (!moved) rmSync(stage, { recursive: true, force: true }); }
      }
    }
    const after = await inventory(home);
    evidence.after = after;
    for (const previous of before) {
      const current = after.find(ref => ref.primary === previous.primary && ref.run === previous.run && ref.dag === previous.dag);
      if (!current || previous.version !== current.version || previous.commit !== current.commit || (previous.resolution && (!current.resolution || !same(previous.resolution, current.resolution)))) throw new Error(`Run bundle resolution changed: ${previous.run}`);
    }
    if (options.source) evidence.worktreesAfter = git(options.source, "worktree", "list", "--porcelain");
    if (closed) { hook(options.admissionOpen!); closed = false; }
    evidence.outcome = "completed";
    evidence.finishedAt = new Date().toISOString();
    record();
    console.log(JSON.stringify(evidence));
  } catch (error) {
    evidence.outcome = "failed";
    evidence.error = String(error);
    evidence.admissionRemainsClosed = closed;
    // Preserve the original failure even if recording also fails.
    try { if (reserved) record(); } catch { /* reported by the CLI */ }
    throw error;
  } finally { rmSync(lock, { recursive: true, force: true }); }
}
