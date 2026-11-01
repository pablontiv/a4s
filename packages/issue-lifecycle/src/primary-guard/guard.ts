import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export interface GuardEvent { toolName: string; input: Record<string, unknown> }
export interface GuardContext { cwd: string; localProtocolOptions?: unknown }
export interface TargetResolver {
  /** undefined means an explicitly file-free host operation, never failed resolution. */
  resolve(target: string, context: GuardContext): Promise<string | undefined>;
  expand(target: string, context: GuardContext): Promise<string[]>;
}
export type Block = { block: true; reason: string } | undefined;

/** Match the tool's hashline header grammar, including filenames containing '#'. */
export function unwrapTarget(target: string): string {
  const trimmed = target.trimEnd();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return target;
  const inner = trimmed.slice(1, -1);
  const tag = /#[0-9a-f]{4}$/i.exec(inner);
  const path = tag ? inner.slice(0, tag.index) : inner;
  return path && (tag || !path.includes("#")) ? path : target;
}

/** No cwd/session classification: even a missing target is classified by its real ancestor. */
export function isPrimaryTarget(target: string, classifications?: Map<string, boolean>): boolean {
  if (!isAbsolute(target)) throw new Error("resolver did not return an absolute filesystem path");
  let ancestor = target;
  for (;;) {
    try { lstatSync(ancestor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  const real = realpathSync(ancestor); // A dangling link is unresolved, not an absent path.
  const cwd = statSync(real).isDirectory() ? real : dirname(real);
  const cached = classifications?.get(cwd);
  if (cached !== undefined) return cached;
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C" };
  // Ambient Git overrides must not turn destination classification into session classification.
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  let output: string;
  try {
    output = execFileSync("git", ["-C", cwd, "rev-parse", "--absolute-git-dir", "--git-common-dir"], {
      encoding: "utf8", env, timeout: 5000, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const failure = error as { status?: number; stderr?: Buffer | string };
    if (failure.status === 128 && String(failure.stderr).includes("not a git repository")) {
      classifications?.set(cwd, false);
      return false;
    }
    throw error;
  }
  const lines = output.trimEnd().split("\n");
  if (lines.length !== 2 || !lines[0] || !lines[1]) throw new Error("unrecognized Git directory response");
  const primary = realpathSync(resolve(cwd, lines[0])) === realpathSync(resolve(cwd, lines[1]));
  classifications?.set(cwd, primary);
  return primary;
}

function requiredPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new Error("missing or invalid destination path");
  return value;
}

function editTargets(input: Record<string, unknown>): string[] {
  const targets: string[] = [];
  if (input.path !== undefined) targets.push(requiredPath(input.path));
  if (Array.isArray(input.paths)) targets.push(...input.paths.map(requiredPath));
  if (input.input !== undefined) {
    if (typeof input.input !== "string") throw new Error("invalid hashline input");
    // Added content starts with '+', so neither file text nor pasted 'MV' text is a target.
    for (const line of input.input.split(/\r?\n/)) {
      if (line.startsWith("[") && line.endsWith("]")) targets.push(unwrapTarget(line));
      else if (line.startsWith("MV ")) {
        const destination = line.slice(3).trim();
        targets.push(requiredPath(destination.startsWith('"') && destination.endsWith('"') ? destination.slice(1, -1) : destination));
      }
    }
  }
  if (Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      if (edit && typeof edit === "object" && "rename" in edit && edit.rename !== undefined) targets.push(requiredPath(edit.rename));
    }
  }
  if (!targets.length) throw new Error("edit exposes no destination path");
  return targets;
}

const guidance = "; implement in the issue worktree (.workspace/worktrees/issue-<N>) via feature";

export async function primaryWriteDecision(event: GuardEvent, context: GuardContext, resolver: TargetResolver): Promise<Block> {
  if (!["write", "edit", "ast_edit", "lsp"].includes(event.toolName)) return;
  let current = "<unresolved>";
  try {
    let targets: string[];
    switch (event.toolName) {
      case "write": {
        current = requiredPath(event.input.path);
        const target = unwrapTarget(current);
        // xd dispatch emits an interceptable inner tool_call with the parsed tool arguments.
        if (/^xd:\/\//i.test(target)) return;
        targets = [target];
        break;
      }
      case "edit": targets = editTargets(event.input); break;
      case "ast_edit": {
        if (!Array.isArray(event.input.paths) || !event.input.paths.length) throw new Error("ast_edit exposes no destination paths");
        targets = event.input.paths.map(requiredPath);
        break;
      }
      default: {
        const { action, apply } = event.input;
        if (!((action === "rename" || action === "rename_file") && apply !== false) && !(action === "code_actions" && apply === true)) return;
        // OMP exposes only the request, not the server's eventual WorkspaceEdit.
        targets = [requiredPath(event.input.file)];
        if (action === "rename_file") targets.push(requiredPath(event.input.new_name));
      }
    }
    const classifications = new Map<string, boolean>();
    for (const target of new Set(targets)) {
      current = target;
      const paths = event.toolName === "ast_edit"
        ? await resolver.expand(target, context)
        : [await resolver.resolve(unwrapTarget(target), context)];
      for (const path of paths) {
        if (path === undefined) continue;
        current = path;
        if (isPrimaryTarget(path, classifications)) return { block: true, reason: `PRIMARY_WRITE_BLOCKED: ${path}${guidance}` };
      }
    }
  } catch (error) {
    return { block: true, reason: `PRIMARY_WRITE_BLOCKED: ${current}${guidance}; destination could not be resolved: ${error instanceof Error ? error.message : String(error)}` };
  }
}
