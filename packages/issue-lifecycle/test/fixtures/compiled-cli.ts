import { format } from "node:util";
import { main } from "../../src/cli.ts";

/** Run sequentially: the public entry uses process environment and console IO. */
export async function runA4s(argv: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const previous = { log: console.log, error: console.error, exitCode: process.exitCode, cwd: process.cwd(), env: process.env };
  let stdout = "", stderr = "";
  console.log = (...args: unknown[]) => { stdout += `${format(...args)}\n`; };
  console.error = (...args: unknown[]) => { stderr += `${format(...args)}\n`; };
  process.exitCode = 0;
  if (options.env) process.env = options.env;
  if (options.cwd) process.chdir(options.cwd);
  try {
    try { await main(argv); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
    return { stdout, stderr, status: Number(process.exitCode ?? 0) };
  } finally {
    console.log = previous.log; console.error = previous.error;
    process.exitCode = previous.exitCode; process.env = previous.env;
    if (options.cwd) process.chdir(previous.cwd);
  }
}
