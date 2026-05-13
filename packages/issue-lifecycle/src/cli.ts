#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { compiled, runGate } from "./executable.ts";
import { identity } from "./identity.ts";
import { executeNative, main as runArtifact } from "./run-artifact.ts";

const usage = "Usage: a4s <gate|pr-body|codeql|poc-scope|protect|role-jobs|admit|enqueue|queue|observe|escalation|stale-recovery|prioritize|reconcile|station|run|tick|planning|heavy-slot|config|version> [args...]";
// Command imports are an intentional loading boundary: admission reads the
// package's filesystem closure and station imports SQLite at import time.
// Static command imports would make `version` depend on those runtime assets.

export async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  if (command === "run") {
    try { await runArtifact(args, main); }
    catch (error) {
      const run = args[args.indexOf("--run") + 1] || "unknown";
      console.error(`reconcile-failure run=${run} status=1 cause=${JSON.stringify(error instanceof Error ? error.message : String(error))}`);
      process.exitCode = 1;
    }
    return;
  }
  switch (command) {
    case "version":
      if (args.length) throw new Error("Usage: a4s version");
      console.log(JSON.stringify(identity));
      return;
    case "native": return executeNative(args);
    case "tick": return (await import("./tick.ts")).tick(args);
    case "gate": return runGate(args);
    case "pr-body": return (await import("./commands/pr-body.ts")).main(args);
    case "codeql": return (await import("./commands/codeql.ts")).main(args);
    case "poc-scope": return (await import("./commands/poc-scope.ts")).main(args);
    case "protect": return (await import("./commands/protect.ts")).main(args);
    case "role-jobs": return (await import("./commands/role-jobs.ts")).main(args);
    case "admit": case "enqueue": case "observe":
      return (await import("./commands/bundle.ts")).main([command, ...args]);
    case "queue": return (await import("./commands/bundle.ts")).main(["readiness", ...args]);
    case "config":
      if (args[0] !== "write" && args[0] !== "check") throw new Error("Usage: a4s config write|check <path>");
      return (await import("./commands/bundle.ts")).main([args[0] === "write" ? "write-config" : "config-check", ...args.slice(1)]);
    case "escalation": return (await import("./escalation.ts")).main(args);
    case "stale-recovery": return (await import("./commands/stale-recovery.ts")).main(args);
    case "prioritize": return (await import("./commands/prioritize.ts")).main(args);
    case "reconcile": return (await import("./reconcile.ts")).main(args);
    case "station": return (await import("./commands/station.ts")).main(args);
    case "heavy-slot": return (await import("./heavy-slot.ts")).main(args);
    case "planning":
      if (args[0] !== "validate-planning-units" && args[0] !== "planning-reviewer-identity") {
        throw new Error("Usage: a4s planning validate-planning-units [args...] | planning-reviewer-identity --transcript <file>");
      }
      return (await import("./commands/bundle.ts")).main(args);
    default: throw new Error(`${command ? `Unknown subcommand: ${command}\n` : ""}${usage}`);
  }
}
if (compiled || process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
