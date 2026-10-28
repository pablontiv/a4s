import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { shellWords } from "../resources.ts";
import { verifiedRun } from "../run-artifact.ts";
import { artifactToken } from "../release.ts";
import type { CallDecision, Event } from "./guard.ts";
import { readProtection } from "../integration-protection.ts";

const quote = (word: string): string => `'${word.replace(/'/g, "'\\''")}'`;
/** Resolve literal tool mutations before shell execution. This is not a sandbox:
 * scripts must use the same receipt-bound CLI rather than an ambient Dagu call. */
export async function runMutationDecision(event: Event, cwd = process.cwd()): Promise<CallDecision> {
  const field = event.toolName === "bash" ? "command" : event.toolName === "eval" ? "code" : undefined;
  const text = field ? event.input[field] : undefined;
  if (typeof text !== "string" || !/(?:\bdagu[\s"']+(?:human-task|retry|stop)\b|(?:\ba4s|\$\{?A4S_BIN\}?)[\s"']+(?:run|protect|role-jobs|observe|escalation|codeql|poc-scope)\b)/.test(text)) return undefined;
  try {
    if (event.toolName !== "bash") throw new Error("Use bash with a literal receipt-bound a4s run command for run mutations");
    let syntax = "";
    const words = shellWords(text, detail => { syntax ||= detail; }).filter(word => word !== ";");
    if (syntax) throw new Error(`Run mutation requires one literal command (${syntax}); use a4s run --primary <path> --run <id> -- <command>`);
    const assignments: string[] = [];
    const env: Record<string, string> = {};
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] || "")) {
      const value = words.shift()!;
      env[value.slice(0, value.indexOf("="))] = value.slice(value.indexOf("=") + 1);
      assignments.push(value);
    }
    const file = basename(words.shift() || "");
    let command = words;
    const flag = (key: string, args = command): string | undefined => {
      const index = args.indexOf(key);
      return index >= 0 ? args[index + 1] : args.find(word => word.startsWith(`${key}=`))?.slice(key.length + 1);
    };
    let run: string | undefined, primary = env.PRIMARY || process.env.PRIMARY;
    if (file === "dagu") { run = flag("--run-id"); command = ["native", ...command]; }
    else if (file === "a4s") {
      if (command[0] === "run") {
        const separator = command.indexOf("--");
        if (separator < 0) throw new Error("Run dispatch requires -- before its action");
        primary = flag("--primary", command.slice(1, separator));
        run = flag("--run", command.slice(1, separator));
        command = command.slice(separator + 1);
      } else run = env.RUN || process.env.RUN || (command[0] === "observe" ? command[1] : undefined);
    } else throw new Error("Run mutation must invoke a4s or dagu directly");
    if (command[0] === "protect" && command[1] === "status" || command[0] === "role-jobs" && ["capacity", "detect"].includes(command[1] || "")) return undefined;
    if (!run && primary && command[0] === "protect" && command[1] === "release") run = readProtection(primary)?.protectedRun;
    if (!run) throw new Error("Run mutation requires an explicit admitted run ID (RUN or --run-id/--run)");
    if (!primary) {
      const list = execFileSync("git", ["-C", typeof event.input.cwd === "string" ? event.input.cwd : cwd, "worktree", "list", "--porcelain"], { encoding: "utf8" });
      primary = /^worktree (.+)$/m.exec(list)?.[1];
    }
    if (!primary) throw new Error("Run mutation requires an admitted PRIMARY");
    const context = await verifiedRun(primary, run);
    const prefix = assignments.filter(value => !/^(?:PRIMARY|RUN|A4S_BIN|A4S_ARTIFACT)=/.test(value)).map(value => {
      const at = value.indexOf("="); return `${value.slice(0, at)}=${quote(value.slice(at + 1))}`;
    });
    return { input: { ...event.input, command: [...prefix, ...[context.cached.executable, "run", "--primary", context.primary, "--run", run,
      "--artifact", artifactToken(context.cached.record), "--", ...command].map(quote)].join(" ") } };
  } catch (error) { return { block: true, reason: `A4S_RUN_UNSUPPORTED: ${error instanceof Error ? error.message : String(error)}` }; }
}
