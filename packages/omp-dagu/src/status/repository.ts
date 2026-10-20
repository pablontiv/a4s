import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";
import type { CiDiagnostic } from "./progress.ts";

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

/** Read the reconciler's durable evidence, including a return missed by SSE. */
export async function readCiDiagnostic(primary: string | undefined, run: string, returned: boolean, signal: AbortSignal): Promise<CiDiagnostic | undefined> {
  if (!primary || !/^[A-Za-z0-9_-]+$/.test(run)) return undefined;
  try {
    const { stdout } = await exec("git", ["rev-parse", "--path-format=absolute", "--git-path",
      `dagu-feature/runs/${run}/${returned ? "ci-return" : "ci-observation"}.json`],
    { cwd: primary, signal, timeout: 5000 });
    const value: unknown = JSON.parse(await readFile(stdout.trim(), "utf8"));
    if (!value || typeof value !== "object") return undefined;
    const data = value as Record<string, unknown>;
    if (data.run !== run || !Number.isSafeInteger(data.iteration)
      || !["sha", "class", "check", "log", "cause"].every(key => typeof data[key] === "string")) return undefined;
    return data as unknown as CiDiagnostic;
  } catch {
    return undefined;
  }
}
