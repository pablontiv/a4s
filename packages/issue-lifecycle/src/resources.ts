import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { CallDecision, Event } from "./triage/guard.ts";
import { resolveRunPrimary } from "./status/progress.ts";

const exec = promisify(execFile);
const active: Record<string, true> = { queued: true, running: true, waiting: true };

// Literal shell words, including quoted paths and command boundaries. Callers
// requiring one literal command can observe syntax outside that contract.
// This is a tool-call guard, not a shell interpreter or an OS isolation boundary.
export function shellWords(text: string, onSyntax?: (syntax: string) => void): string[] {
  const words: string[] = [];
  let word = "", quote = "", present = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\" && quote !== "'") {
      const next = text[i + 1];
      if (next === "\n") { i++; continue; }
      if (next === undefined) onSyntax?.("unfinished escape");
      if (quote === '"' && next !== undefined && !/[$`"\\]/.test(next)) word += c;
      else word += text[++i] ?? "";
      present = true;
    } else if (quote) {
      if (c === quote) quote = "";
      else {
        if (quote === '"' && /[$`]/.test(c)) onSyntax?.("shell expansion");
        word += c;
      }
      present = true;
    } else if (c === "'" || c === '"') { quote = c; present = true; }
    else if (c === "#" && !present) {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
    } else if (/[ \t\n;&|()]/.test(c)) {
      if (present) words.push(word);
      word = ""; present = false;
      if (/[;&|()\n]/.test(c)) {
        words.push(";");
        if (c !== "\n" || /[^ \t\n]/.test(text.slice(i + 1))) onSyntax?.("command boundary");
      }
    } else {
      if (/[$`<>*?[\]{}~]/.test(c)) onSyntax?.("shell expansion or redirection");
      word += c; present = true;
    }
  }
  if (quote) onSyntax?.("unfinished quote");
  if (present) words.push(word);
  return words;
}

export async function canonical(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonical(parent), basename(path));
  }
}
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", ["-C", cwd, ...args])).stdout.trim();
}
async function primaryAt(path: string): Promise<string> {
  let cwd = path;
  while (true) {
    try { if ((await stat(cwd)).isDirectory()) break; } catch { /* Find existing parent. */ }
    const parent = dirname(cwd);
    if (parent === cwd) throw new Error(`Cannot locate repository for ${path}`);
    cwd = parent;
  }
  const list = await git(cwd, "worktree", "list", "--porcelain");
  const primary = /^worktree (.+)$/m.exec(list)?.[1];
  if (!primary) throw new Error(`Cannot locate primary for ${path}`);
  return canonical(primary);
}
// Adopted feature/PoC renders name one canonical PRIMARY. Another clone of those
// files is not that checkout and stays outside primary protection.
async function adoptedPrimary(primary: string): Promise<boolean> {
  for (const name of ["feature.yaml", "poc.yaml"]) {
    let text: string;
    try { text = await readFile(join(primary, ".workspace", "dagu", "dags", name), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const literal = /^  - PRIMARY: (.+)$/m.exec(text)?.[1];
    if (!literal) continue;
    try {
      const recorded: unknown = JSON.parse(literal);
      if (typeof recorded === "string" && isAbsolute(recorded) && await canonical(recorded) === primary) return true;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return false;
}
interface Owner { kind: string; run: string; status: string; primary: string; branch: string; issue: string }
export async function readOwners(): Promise<Owner[]> {
  const owners: Owner[] = [];
  for (const kind of ["feature", "poc"]) {
    const { stdout } = await exec("dagu", ["history", kind, "--format", "json", "--from", "1970-01-01", "--status", "queued,running,waiting", "--limit", "1000"], { maxBuffer: 64 * 1024 * 1024, timeout: 10000 });
    const rows: unknown = JSON.parse(stdout);
    if (!Array.isArray(rows)) throw new Error(`${kind} history is not an array`);
    if (rows.length >= 1000) throw new Error(`${kind} active history reached the 1000-row limit; ownership is incomplete`);
    for (const row of rows) {
      if (typeof row.params !== "string" || typeof row.dagRunId !== "string" || typeof row.status !== "string") throw new Error(`Malformed ${kind} history row`);
      const params = Object.fromEntries([...row.params.matchAll(/(?:^| )([A-Z_]+)=(.*?)(?= [A-Z_]+=|$)/g)].map(match => [match[1]!, match[2]!.replace(/^(['"])(.*)\1$/, "$2")]));
      const primary = await resolveRunPrimary(
        (process.env.DAGU_URL || "http://127.0.0.1:8080").replace(/\/+$/, ""),
        { name: kind, dagRunId: row.dagRunId, statusLabel: row.status, params: row.params },
        AbortSignal.timeout(10000),
      );
      if (!primary) continue;
      owners.push({ kind, run: row.dagRunId, status: row.status.toLowerCase(), primary: await canonical(resolve(primary)), branch: params.BRANCH ?? (kind === "feature" ? `dagu/issue-${params.ISSUE}` : ""), issue: params.ISSUE ?? "" });
    }
  }
  return owners;
}
const contains = (parent: string, child: string) => child === parent || child.startsWith(parent === sep ? sep : parent + sep);

export async function resourceDecision(event: Event, cwd: string): Promise<CallDecision> {
  if (event.toolName !== "bash" || typeof event.input.command !== "string") return undefined;
  const words = shellWords(event.input.command);
  let directory = resolve(cwd, typeof event.input.cwd === "string" ? event.input.cwd : ".");
  let owners: Owner[] | undefined;
  for (let start = 0; start < words.length;) {
    let end = words.indexOf(";", start); if (end < 0) end = words.length;
    const command = words.slice(start, end); start = end + 1;
    let i = command.findIndex(w => ["git", "rm", "cd"].includes(basename(w)));
    if (i < 0) continue;
    const name = basename(command[i++]!);
    if (name === "cd") { if (command[i]) directory = resolve(directory, command[i]!); continue; }
    let repo = directory;
    while (name === "git" && command[i]?.startsWith("-")) {
      if (command[i] === "-C") { repo = resolve(repo, command[i + 1] ?? ""); i += 2; }
      else if (["-c", "--git-dir", "--work-tree"].includes(command[i]!)) i += 2;
      else i++;
    }
    let branch = false, targets: string[] = [];
    if (name === "git" && command[i] === "worktree" && command[i + 1] === "remove") targets = command.slice(i + 2).filter(w => !w.startsWith("-"));
    else if (name === "git" && command[i] === "branch" && command.slice(i + 1).some(w => /^-[dD]$|^-[^-]*[dD]/.test(w) || w === "--delete")) { branch = true; targets = command.slice(i + 1).filter(w => !w.startsWith("-")); }
    else if (name === "rm" && command.slice(i).some(w => w === "--recursive" || /^-[^-]*[rR]/.test(w))) targets = command.slice(i).filter(w => !w.startsWith("-"));
    for (const target of targets) {
      let managed = branch ? /^(dagu|poc)\//.test(target) : /(?:^|\/)\.workspace(?:\/worktrees(?:\/|$)|$)/.test(target);
      try {
        const path = branch ? undefined : await canonical(resolve(name === "git" ? repo : directory, target));
        let primary: string;
        try { primary = await primaryAt(branch ? repo : path!); }
        catch { primary = await primaryAt(repo); }
        const removesOwnPrimary = branch
          ? target === await git(primary, "branch", "--show-current")
          : contains(path!, primary);
        // Only a lifecycle primary is protected: an active admitted run's canonical
        // PRIMARY, or this checkout's adopted feature/PoC render. An independent
        // clone is its own git primary and stays removable.
        if (removesOwnPrimary) {
          try {
            const known = await adoptedPrimary(primary) || (owners ??= await readOwners()).some(owner =>
              !!active[owner.status] && (owner.primary === primary || (!branch && contains(path!, owner.primary))));
            if (known) return { block: true, reason: `dagu-feature: ${path ?? target} is the protected primary checkout` };
          } catch (error) {
            return { block: true, reason: `dagu-feature: cannot verify ownership of ${target}: ${error instanceof Error ? error.message : String(error)}` };
          }
        }
        const root = join(primary, ".workspace", "worktrees");
        managed ||= !!path && (contains(root, path) || contains(path, root));
        if (!managed) continue;
        owners ??= await readOwners();
        const branches: string[] = [];
        if (path) {
          for (const entry of (await git(primary, "worktree", "list", "--porcelain")).split("\n\n")) {
            const location = /^worktree (.+)$/m.exec(entry)?.[1];
            const ref = /^branch refs\/heads\/(.+)$/m.exec(entry)?.[1];
            if (location && ref) {
              const actual = await canonical(location);
              if (contains(path, actual) || contains(actual, path)) branches.push(ref);
            }
          }
        }
        const owner = owners.find(o => {
          if (o.primary !== primary || !active[o.status]) return false;
          if (branch) return o.kind === "feature" ? o.branch === target : target === `poc/${o.run}`;
          const location = join(root, o.kind === "feature" ? `issue-${o.issue}` : `poc-${o.run}`);
          return (o.kind === "feature" && branches.includes(o.branch))
            || ((o.kind === "poc" || !!o.issue) && (contains(path!, location) || contains(location, path!)));
        });
        if (owner) return { block: true, reason: `dagu-feature: ${path ?? target} belongs to active run ${owner.run} (${owner.status})` };
      } catch (error) {
        if (managed) return { block: true, reason: `dagu-feature: cannot verify ownership of ${target}: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
  }
  return undefined;
}
