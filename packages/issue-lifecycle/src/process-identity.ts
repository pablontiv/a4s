import { execFileSync } from "node:child_process";

const prefix = "ps-c:";

function startInLocale(pid: number, locale: string): string | undefined {
  try {
    const started = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: locale },
    }).trim();
    return started || undefined;
  } catch { return undefined; }
}

/** Version the fixed-locale representation so new identities need only one probe. */
export function processStart(pid: number): string | undefined {
  const started = startInLocale(pid, "C");
  return started === undefined ? undefined : `${prefix}${started}`;
}

export function processMatches(pid: number, recorded: string): boolean {
  const current = processStart(pid);
  if (current === undefined) return false;
  if (recorded.startsWith(prefix)) return current === recorded;
  if (current.slice(prefix.length) === recorded) return true;

  // Old receipts contain an untagged lstart in the recording caller's locale.
  // Render the live start in the host's installed locales rather than guessing
  // translated month names or changing the immutable executor used by finish().
  // If locale discovery fails, propagate the error: uncertainty must not cause
  // recovery to interrupt an owner or stopWorker to signal an unrelated PID.
  const locales = execFileSync("locale", ["-a"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, LC_ALL: "C" },
  }).trim().split(/\r?\n/);
  for (const locale of new Set(locales)) {
    if (!locale || locale === "C" || locale === "POSIX") continue;
    if (startInLocale(pid, locale) === recorded) return true;
  }
  return false;
}
