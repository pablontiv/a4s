import {
  INTEGRATION_HOLD_EXIT,
  admit,
  protectCandidate,
  readProtection,
  refreshProtectedPaths,
  releaseProtection,
  type IntegrationCheckpoint,
  type ReleaseReason,
} from "../integration-protection.ts";

const BOOLEAN = new Set(["held-lock"]);
const ALLOWED: Record<string, readonly string[]> = {
  protect: ["decision"],
  refresh: [],
  release: ["decision"],
  "release-auto": ["reason"],
  admit: ["checkpoint", "held-lock"],
  status: [],
};

function parse(args: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item?.startsWith("--")) throw new Error(`integration protection: unexpected argument: ${item ?? ""}`);
    const name = item.slice(2);
    if (BOOLEAN.has(name)) {
      flags.set(name, true);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`integration protection: missing --${name}`);
    flags.set(name, value);
    index += 1;
  }
  return flags;
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`integration protection: missing ${name}`);
  return value;
}

function text(flags: Map<string, string | true>, name: string): string {
  const value = flags.get(name);
  if (typeof value !== "string") throw new Error(`integration protection: missing --${name}`);
  return value;
}

export function main(argv: string[]): void {
const action = argv[0] ?? "";
const allowed = ALLOWED[action];

try {
  if (!allowed) throw new Error("Usage: dagu-feature-protect protect|refresh|release|release-auto|admit|status");
  const flags = parse(argv.slice(1));
  for (const name of flags.keys()) {
    if (!allowed.includes(name)) throw new Error(`integration protection: unexpected argument: --${name}`);
  }
  const primary = env("PRIMARY");
  const session = process.env.OMP_SESSION_ID || undefined;
  if (action === "protect") {
    const record = protectCandidate({
      primary, worktree: env("WORKTREE"), run: env("RUN"), issue: env("ISSUE"), decision: text(flags, "decision"),
      ...(session ? { sessionId: session } : {}),
    });
    console.error(`integration protection: active protected_run=${record.protectedRun} issue=${record.issue} paths=${record.paths.join(",")}`);
  } else if (action === "refresh") {
    refreshProtectedPaths(primary, env("WORKTREE"), env("RUN"));
  } else if (action === "release") {
    const record = releaseProtection(primary, { reason: "operator", decision: text(flags, "decision") });
    if (record) console.error(`integration protection: released protected_run=${record.protectedRun} reason=operator`);
    else console.error("integration protection: no active protection");
  } else if (action === "release-auto") {
    const reason = text(flags, "reason");
    if (reason !== "close_gate" && reason !== "terminal" && reason !== "abort") {
      throw new Error("integration protection: automatic release reason must be close_gate, terminal or abort");
    }
    const record = releaseProtection(primary, { reason: reason satisfies ReleaseReason, run: env("RUN") });
    if (record) console.error(`integration protection: released protected_run=${record.protectedRun} reason=${reason}`);
  } else if (action === "admit") {
    const checkpoint = text(flags, "checkpoint");
    if (checkpoint !== "gate" && checkpoint !== "push" && checkpoint !== "auto_merge") {
      throw new Error("integration protection: checkpoint must be gate, push or auto_merge");
    }
    const waiter = process.env.A4S_INTEGRATION_WAITER;
    if (waiter !== undefined && !/^\d+$/.test(waiter)) throw new Error("integration protection: invalid waiter pid");
    const result = admit({
      primary, worktree: env("WORKTREE"), run: env("RUN"), issue: process.env.ISSUE ?? "",
      checkpoint: checkpoint satisfies IntegrationCheckpoint, heldLock: flags.has("held-lock"),
      ...(waiter !== undefined ? { waiterPid: Number(waiter) } : {}),
    });
    if (result.action === "hold") {
      if (result.line) console.error(result.line);
      process.exitCode = INTEGRATION_HOLD_EXIT;
    }
  } else {
    const record = readProtection(primary);
    if (!record || record.status !== "active") console.log("integration protection: none");
    else console.log(JSON.stringify(record));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
}
