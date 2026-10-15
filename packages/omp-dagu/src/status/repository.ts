import { execFile } from "node:child_process";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export function repositoryName(remote: string, commonDir: string): string {
  const path = remote.trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
  const last = path.split(/[/:]/).at(-1)?.replace(/\.git$/, "");
  return last || basename(dirname(commonDir));
}

export async function resolveRepository(cwd: string, signal: AbortSignal): Promise<string | undefined> {
  const git = async (args: string[]): Promise<string> =>
    (await exec("git", args, { cwd, signal, timeout: 5000 })).stdout.trim();
  try {
    const commonDir = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    let remote = "";
    try { remote = await git(["remote", "get-url", "origin"]); } catch { /* Local repository. */ }
    return repositoryName(remote, commonDir);
  } catch {
    return undefined;
  }
}
