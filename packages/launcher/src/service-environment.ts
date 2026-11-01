import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isRecord } from "./type-guard.ts";

export interface ServiceEnvironment { DAGU_URL: string; DAGU_HOME: string; PATH: string; A4S_CACHE_HOME?: string }
// Node-hosted lease/lock users need the fcntl helper; compiled Bun uses libc.
export const schedulerTools = ["bash", "git", "gh", "jq", "curl", "node", "omp", "dagu",
  ...(!process.versions.bun ? ["python3"] : [])];

function failure(field: string, cause: string): never {
  throw new Error(`service-environment ready=no field=${field} cause=${JSON.stringify(cause)} action=ask-station-operator: supply/correct the operator-owned JSON declaration at $XDG_CONFIG_HOME/a4s/service-environment.json (default ~/.config/a4s/service-environment.json), or select an absolute A4S_SERVICE_ENV override; supply the same DAGU_URL, DAGU_HOME and PATH to Dagu and a4s, then follow the station's safe activation policy`);
}

function requiredString(value: Record<string, unknown>, field: keyof ServiceEnvironment): string {
  const text = value[field];
  if (typeof text !== "string" || !text.trim() || /[\0\r\n]/.test(text)) failure(field, "required nonempty string without NUL or line breaks");
  return text;
}

/** Resolve only the declaration filename; service values always come from JSON. */
export function serviceEnvironmentPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.A4S_SERVICE_ENV !== undefined) {
    if (!isAbsolute(env.A4S_SERVICE_ENV)) failure("A4S_SERVICE_ENV", "required absolute declaration file path");
    return env.A4S_SERVICE_ENV;
  }
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && isAbsolute(xdg)) return join(xdg, "a4s", "service-environment.json");
  const home = env.HOME || homedir();
  if (!isAbsolute(home)) failure("HOME", "required absolute user home for the default declaration path");
  return join(home, ".config", "a4s", "service-environment.json");
}

function xdgHome(key: string, fallback: string, env: NodeJS.ProcessEnv): string {
  const value = env[key];
  return value && isAbsolute(value) ? value : join(env.HOME || homedir(), fallback);
}

/** Read-only station contract. Never source shell code or infer service values. */
export function readServiceEnvironment(env: NodeJS.ProcessEnv = process.env): ServiceEnvironment {
  const file = serviceEnvironmentPath(env);
  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch (error) { failure("A4S_SERVICE_ENV", `cannot read declaration ${file}: ${String(error)}`); }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { failure("A4S_SERVICE_ENV", `malformed JSON: ${String(error)}`); }
  if (!isRecord(value)) failure("A4S_SERVICE_ENV", "expected a JSON object");
  const declaration: ServiceEnvironment = {
    DAGU_URL: requiredString(value, "DAGU_URL"),
    DAGU_HOME: value.DAGU_HOME === undefined ? join(xdgHome("XDG_STATE_HOME", ".local/state", env), "a4s", "dagu") : requiredString(value, "DAGU_HOME"),
    PATH: requiredString(value, "PATH"),
  };
  const cache = value.A4S_CACHE_HOME ?? (value.DAGU_HOME === undefined ? join(xdgHome("XDG_CACHE_HOME", ".cache", env), "a4s") : undefined);
  if (cache !== undefined) {
    if (typeof cache !== "string" || !isAbsolute(cache) || /[\0\r\n]/.test(cache)) failure("A4S_CACHE_HOME", "required absolute cache directory");
    declaration.A4S_CACHE_HOME = resolve(cache);
  }
  if (value.tools !== undefined) {
    if (!isRecord(value.tools)) failure("tools", "expected an object of tool names and absolute executable paths");
    const directories: string[] = [];
    for (const [tool, binary] of Object.entries(value.tools)) {
      if (!schedulerTools.includes(tool) || typeof binary !== "string" || !isAbsolute(binary) || /[\0\r\n]/.test(binary) || binary.split("/").at(-1) !== tool) failure(`tools.${tool}`, "expected an absolute executable filename matching a required tool name");
      try { accessSync(binary, constants.X_OK); if (!statSync(binary).isFile()) throw new Error("not a regular executable"); }
      catch (error) { failure(`tools.${tool}`, String(error)); }
      directories.push(resolve(binary, ".."));
    }
    declaration.PATH = [...new Set([...directories, ...declaration.PATH.split(":")])].join(":");
    for (const [tool, binary] of Object.entries(value.tools)) {
      const first = declaration.PATH.split(":").map(directory => join(directory, tool)).find(candidate => {
        try { accessSync(candidate, constants.X_OK); return statSync(candidate).isFile(); } catch { return false; }
      });
      if (first !== binary) failure(`tools.${tool}`, "configured tool directories shadow this override; separate conflicting tool installations");
    }
  }
  let url: URL;
  try { url = new URL(declaration.DAGU_URL); }
  catch { failure("DAGU_URL", "expected an absolute HTTP loopback endpoint"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || !/^\/+$/.test(url.pathname) || url.port === "0") {
    failure("DAGU_URL", "expected an unauthenticated HTTP loopback origin, without path, query or fragment");
  }
  if (!isAbsolute(declaration.DAGU_HOME)) failure("DAGU_HOME", "required absolute home path");
  let directory: boolean;
  try {
    directory = statSync(declaration.DAGU_HOME).isDirectory();
    accessSync(declaration.DAGU_HOME, constants.R_OK | constants.X_OK);
  } catch (error) { failure("DAGU_HOME", `cannot read declared home directory: ${String(error)}`); }
  if (!directory) failure("DAGU_HOME", "declared home must be an existing directory");
  if (env.DAGU_HOME !== undefined && (!isAbsolute(env.DAGU_HOME) || resolve(env.DAGU_HOME) !== resolve(declaration.DAGU_HOME))) {
    failure("DAGU_HOME", "selected DAGU_HOME does not match the declaration");
  }
  if (env.DAGU_URL !== undefined) {
    let selected: URL;
    try { selected = new URL(env.DAGU_URL); }
    catch { failure("DAGU_URL", "selected DAGU_URL does not match the declaration"); }
    if (selected.origin !== url.origin || selected.username || selected.password ||
      selected.search || selected.hash || !/^\/+$/.test(selected.pathname)) {
      failure("DAGU_URL", "selected DAGU_URL does not match the declaration");
    }
  }
  if (env.DAGU_PORT !== undefined && env.DAGU_PORT !== (url.port || "80")) {
    failure("DAGU_PORT", "selected DAGU_PORT does not match the declared endpoint");
  }
  const directories = declaration.PATH.split(":");
  if (directories.some(directory => !isAbsolute(directory))) failure("PATH", "every scheduler PATH entry must be absolute and nonempty; no shell expansion is performed");
  const missing = schedulerTools.filter(tool => !directories.some(directory => {
    try {
      const path = join(directory, tool);
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch { return false; }
  }));
  if (missing.length) failure("PATH", `declared scheduler PATH is missing ${missing.join(", ")}`);
  return { ...declaration, DAGU_URL: url.origin, DAGU_HOME: resolve(declaration.DAGU_HOME) };
}

export function serviceEnvironmentCommand(args: string[]): void {
  if (args.length) throw new Error("Usage: a4s service-environment");
  console.log(JSON.stringify(readServiceEnvironment()));
}
