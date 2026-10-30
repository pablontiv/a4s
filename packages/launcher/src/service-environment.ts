import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isRecord } from "./type-guard.ts";

export interface ServiceEnvironment { DAGU_URL: string; DAGU_HOME: string; PATH: string }
export const schedulerTools = ["bash", "git", "gh", "jq", "curl", "node", "omp", "dagu"];

function failure(field: string, cause: string): never {
  throw new Error(`service-environment ready=no field=${field} cause=${JSON.stringify(cause)} action=ask-station-operator: supply/correct the operator-owned JSON declaration selected by absolute A4S_SERVICE_ENV; supply the same DAGU_URL, DAGU_HOME and PATH to Dagu and a4s, then follow the station's safe activation policy`);
}

function requiredString(value: Record<string, unknown>, field: keyof ServiceEnvironment): string {
  const text = value[field];
  if (typeof text !== "string" || !text.trim() || /[\0\r\n]/.test(text)) failure(field, "required nonempty string without NUL or line breaks");
  return text;
}

/** Read-only station contract. Never source shell code or infer service values. */
export function readServiceEnvironment(env: NodeJS.ProcessEnv = process.env): ServiceEnvironment {
  const file = env.A4S_SERVICE_ENV;
  if (!file || !isAbsolute(file)) failure("A4S_SERVICE_ENV", "required absolute declaration file path");
  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch (error) { failure("A4S_SERVICE_ENV", `cannot read declaration: ${String(error)}`); }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { failure("A4S_SERVICE_ENV", `malformed JSON: ${String(error)}`); }
  if (!isRecord(value)) failure("A4S_SERVICE_ENV", "expected a JSON object");
  const declaration: ServiceEnvironment = {
    DAGU_URL: requiredString(value, "DAGU_URL"),
    DAGU_HOME: requiredString(value, "DAGU_HOME"),
    PATH: requiredString(value, "PATH"),
  };
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
  return { DAGU_URL: url.origin, DAGU_HOME: resolve(declaration.DAGU_HOME), PATH: declaration.PATH };
}

export function serviceEnvironmentCommand(args: string[]): void {
  if (args.length) throw new Error("Usage: a4s service-environment");
  console.log(JSON.stringify(readServiceEnvironment()));
}
