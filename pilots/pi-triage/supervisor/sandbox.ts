import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { accessSync, constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { type IncomingMessage, request } from "node:http";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

export const DAG = "pi-triage-slice";
export const ISSUE = "fixture-1";
export const STEP = "decide";
export const RUN_ID = "^pi-slice-[A-Za-z0-9][A-Za-z0-9_-]{0,62}$";
export const TOKEN = "^[a-f0-9]{64}$";
export const CONFIG_ENV = "A4S_PI_TRIAGE_SUPERVISOR_CONFIG";
const MARKER = ".a4s-pi-triage-slice";
const HTTP_LIMIT = 1024 * 1024;
const FILE_LIMIT = 16 * 1024;
const NATIVE_MAGIC = new Set(["7f454c46", "feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]);

export type JsonObject = Record<string, unknown>;
export const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function localPath(value: unknown, label: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${label}: se requiere una ruta absoluta explícita.`);
  }
  return value;
}

export function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return isAbsolute(child) && rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function privateDirectory(path: string, label: string): void {
  const info = lstatSync(path);
  if (realpathSync(path) !== path || !info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) {
    throw new Error(`${label}: se requiere un directorio canónico propio con modo 0700.`);
  }
}

function nativeBinary(path: string): void {
  accessSync(path, constants.X_OK);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const header = Buffer.alloc(4);
    if (!fstatSync(fd).isFile() || readSync(fd, header) !== header.length || !NATIVE_MAGIC.has(header.toString("hex"))) {
      throw new Error("daguBin: usa el binario nativo de Dagu, no un wrapper de estación.");
    }
  } finally { closeSync(fd); }
}

function trustedFile(path: string, label: string): void {
  const info = lstatSync(path);
  if (!info.isFile() || (info.mode & 0o022) !== 0) {
    throw new Error(`${label}: se requiere un archivo regular sin escritura de grupo u otros.`);
  }
}

// Final component must be a regular file, not a symlink, device or FIFO. Bound the
// read itself in addition to checking size; the fixture writes by atomic rename.
function readJson(path: string, label: string): JsonObject {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > FILE_LIMIT) throw new Error(`${label}: archivo no regular o demasiado grande.`);
    const buffer = Buffer.alloc(FILE_LIMIT + 1);
    let size = 0;
    while (size < buffer.length) {
      const n = readSync(fd, buffer, size, buffer.length - size, null);
      if (n === 0) break;
      size += n;
    }
    if (size > FILE_LIMIT) throw new Error(`${label}: archivo demasiado grande.`);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))); }
    catch { throw new Error(`${label}: JSON/UTF-8 inválido.`); }
    if (!object(value)) throw new Error(`${label}: se requiere un objeto JSON.`);
    return value;
  } finally { closeSync(fd); }
}

export interface Sandbox {
  access: "observe" | "supervise";
  daguBin: string;
  daguHome: string;
  daguConfig: string;
  dagFile: string;
  workerEntry: string;
  stateRoot: string;
  origin: string;
  env: NodeJS.ProcessEnv;
}

export function checkSandbox(sandbox: Sandbox): void {
  privateDirectory(sandbox.daguHome, "DAGU_HOME");
  privateDirectory(sandbox.stateRoot, "STATE_ROOT");
  trustedFile(join(sandbox.daguHome, MARKER), MARKER);
  if (realpathSync(sandbox.daguConfig) !== sandbox.daguConfig || !inside(sandbox.daguHome, sandbox.daguConfig)) {
    throw new Error("El config de Dagu debe ser canónico y estar dentro de DAGU_HOME.");
  }
  trustedFile(sandbox.daguConfig, "daguConfig");
}

export function loadSandbox(configPath: string | undefined): Sandbox {
  const path = localPath(configPath, CONFIG_ENV);
  trustedFile(path, CONFIG_ENV);
  const value = readJson(path, CONFIG_ENV);
  if (value.schemaVersion !== 1 || (value.access !== "observe" && value.access !== "supervise")) {
    throw new Error("Config del supervisor: se requiere schemaVersion=1 y access=observe|supervise.");
  }
  const port = value.apiPort;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 32768 || port > 65535) {
    throw new Error("apiPort: se requiere un puerto efímero explícito (32768–65535).");
  }
  const daguHome = localPath(value.daguHome, "daguHome");
  const stateRoot = localPath(value.stateRoot, "stateRoot");
  const daguConfig = localPath(value.daguConfig, "daguConfig");
  const dagFile = localPath(value.dagFile, "dagFile");
  const workerEntry = localPath(value.workerEntry, "workerEntry");
  const daguBin = localPath(value.daguBin, "daguBin");
  if (daguHome === stateRoot || [daguHome, stateRoot].includes(homedir()) || inside(stateRoot, daguHome)) {
    throw new Error("DAGU_HOME y STATE_ROOT deben ser directorios dedicados al piloto.");
  }
  if (![`${DAG}.yaml`, `${DAG}.yml`].includes(basename(dagFile))) {
    throw new Error(`dagFile: solo se admite ${DAG}.yaml o ${DAG}.yml.`);
  }
  if (!Array.isArray(value.pathDirs) || value.pathDirs.length === 0) throw new Error("pathDirs explícito es obligatorio.");
  const pathDirs = value.pathDirs.map(dir => localPath(dir, "pathDirs"));
  if (pathDirs.some(dir => dir.includes(delimiter) || !statSync(dir).isDirectory())) {
    throw new Error("pathDirs: se requieren directorios de ejecutables sin separadores PATH.");
  }
  // No process.env spread, proxy, tokens, Pi/OMP paths, or station settings.
  const env = {
    HOME: daguHome,
    DAGU_HOME: daguHome,
    DAGU_SKIP_EXAMPLES: "true",
    XDG_CONFIG_HOME: join(daguHome, "xdg-config"),
    XDG_DATA_HOME: join(daguHome, "xdg-data"),
    XDG_CACHE_HOME: join(daguHome, "xdg-cache"),
    XDG_STATE_HOME: join(daguHome, "xdg-state"),
    TMPDIR: daguHome,
    PATH: pathDirs.join(delimiter),
    A4S_PI_TRIAGE_FIXTURE: "1",
  };
  const sandbox = { access: value.access, daguBin, daguHome, daguConfig, dagFile, workerEntry, stateRoot, env, origin: `http://127.0.0.1:${port}` } satisfies Sandbox;
  checkSandbox(sandbox);
  trustedFile(dagFile, "dagFile");
  trustedFile(workerEntry, "workerEntry");
  nativeBinary(daguBin);
  return sandbox;
}

export function readArtifact(sandbox: Sandbox, runId: string, name: "triage.json" | "decision.json"): JsonObject | undefined {
  const folder = join(sandbox.stateRoot, runId);
  try {
    if (!lstatSync(folder).isDirectory() || realpathSync(folder) !== folder) {
      throw new Error("El directorio de evidencia no es un directorio local del run.");
    }
    return readJson(join(folder, name), name);
  } catch (error) {
    if (object(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

interface RequestOptions { method: "GET" | "POST"; signal: AbortSignal; body?: string }
export type DaguRequest = (url: URL, options: RequestOptions) => Promise<{ status: number; body: string }>;

// Direct connection, no proxy/redirect/auth from the Pi host, no replay.
export const requestDagu: DaguRequest = (url, { method, signal, body }) => new Promise((resolve, reject) => {
  const req = request(url, {
    method, signal, agent: false,
    headers: body === undefined ? undefined : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
  }, (res: IncomingMessage) => {
    let size = 0;
    const chunks: Buffer[] = [];
    res.on("error", reject);
    res.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > HTTP_LIMIT) return res.destroy(new Error("Respuesta Dagu demasiado grande."));
      chunks.push(chunk);
    });
    res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
  });
  req.on("error", reject);
  req.end(body);
});

export interface ExecOptions { cwd: string; env: NodeJS.ProcessEnv; timeout: number; signal?: AbortSignal }
export type DaguExec = (bin: string, argv: string[], options: ExecOptions) => Promise<{ stdout: string }>;
export const execDagu: DaguExec = (bin, argv, options) => promisify(execFile)(bin, argv, {
  ...options, shell: false, encoding: "utf8", maxBuffer: 1024 * 1024,
});
