import { engineCommand } from "../executable.ts";
import { preflightAdmission, enqueueArguments, loadedExtensionDigest } from "../admission.ts";

// Rewrite before shell evaluation so loops and quoted variable expansions are
// checked using their effective arguments immediately before Dagu creates a run.
export function admissionDecision(event: Event, session?: { transcriptRoot: string }, cwd = process.cwd()): CallDecision {
  const field = event.toolName === "bash" ? "command" : event.toolName === "eval" ? "code" : undefined;
  const text = field ? event.input[field] : undefined;
  if (!field || typeof text !== "string" || !/\bdagu\s+enqueue\b/.test(text)) return undefined;
  if (text.includes("dagu-feature-bootstrap.yaml") && (text.match(/\benqueue\b/g) ?? []).length === 1) return undefined;
  if (event.toolName !== "bash") return { block: true, reason: "DAGU_ADMISSION_REQUIRED: Enqueue lifecycle DAGs through bash or a4s admit; admission must resolve effective arguments before creating a run." };
  if (/^\s*dagu\s+enqueue\s+/.test(text) && !/[$`\\;&|()<>\n]/.test(text)) {
    try {
      const words = text.match(/"[^"]*"|'[^']*'|[^\s]+/g)!.map(word => word.replace(/^["']|["']$/g, ""));
      const options = enqueueArguments(words.slice(2), typeof event.input.cwd === "string" ? event.input.cwd : cwd);
      preflightAdmission({ ...options, ...(session ? { session: { ...session, extensionDigest: loadedExtensionDigest } } : {}) });
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
  const cli = engineCommand("enqueue");
  const prefix = `DAGU_ADMISSION_SESSION=${quote(JSON.stringify({ ...session, extensionDigest: loadedExtensionDigest }))} `;
  const command = text.replace(/\bdagu\s+enqueue\b/g, `${prefix}${[cli.file, ...cli.args].map(quote).join(" ")}`);
  return { input: { ...event.input, command } };
}

type RecordValue = Record<string, any>;
export interface Event {
  toolName: string;
  toolCallId: string;
  input: RecordValue;
  details?: RecordValue;
  content?: { type: string; text?: string }[];
  isError?: boolean;
}
export type CallDecision = { block: true; reason: string } | { input: RecordValue } | undefined;

