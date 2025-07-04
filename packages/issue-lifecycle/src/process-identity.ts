import { execFileSync } from "node:child_process";

const prefix = "ps-c:";
export type ProcessProbe = "alive" | "dead-or-reused" | "unknown";
function startInLocale(pid: number, locale: string): string | undefined {
  const started = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, LC_ALL: locale },
  }).trim();
  return started || undefined;
}
/** Version the fixed-locale representation so new identities need only one probe. */
export function processStart(pid: number): string | undefined {
  try {
    const started = startInLocale(pid, "C");
    return started === undefined ? undefined : `${prefix}${started}`;
  } catch { return undefined; }
}
function compare(pid: number, recorded: string): ProcessProbe {
  if (!Number.isSafeInteger(pid) || pid < 1 || !recorded) return "unknown";
  try { process.kill(pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return "dead-or-reused";
    return "unknown";
  }
  const started = startInLocale(pid, "C");
  if (!started) return "unknown";
  if (recorded.startsWith(prefix)) return `${prefix}${started}` === recorded ? "alive" : "dead-or-reused";
  if (started === recorded) return "alive";
  // Keep historical locale decoders; immutable executor records are not rewritten.
  const locales = execFileSync("locale", ["-a"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" },
  }).trim().split(/\r?\n/);
  for (const locale of new Set(locales)) {
    if (!locale || locale === "C" || locale === "POSIX") continue;
    const localized = startInLocale(pid, locale);
    if (!localized) return "unknown";
    if (localized === recorded) return "alive";
  }
  return "dead-or-reused";
}
/** Unreadable identity is never evidence that an owner can be released. */
export function probeProcess(pid: number, recorded: string): ProcessProbe {
  try { return compare(pid, recorded); } catch { return "unknown"; }
}
/** Boolean owners fail closed rather than turning unknown into dead (or signalling it). */
export function processMatches(pid: number, recorded: string): boolean {
  let result: ProcessProbe;
  try { result = compare(pid, recorded); }
  catch (error) { throw new Error(`Process identity unknown: ${error instanceof Error ? error.message : String(error)}`); }
  if (result === "unknown") throw new Error(`Process identity unknown: pid=${pid}`);
  return result === "alive";
}
