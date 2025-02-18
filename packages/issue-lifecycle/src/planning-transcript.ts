import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { isRecord } from "../../launcher/src/type-guard.ts";

export interface CoordinatingSession { session: string; transcriptRoot: string }
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Capture only admission evidence, never the scheduler's ambient profile. */
export function admittedCoordinator(owner: string, current?: { sessionId?: string; transcriptRoot?: string },
  inherited?: { session: unknown; transcriptRoot: unknown }): CoordinatingSession | undefined {
  if (current?.sessionId !== undefined && current.sessionId !== owner) throw new Error("Coordinating session identity differs from OMP_SESSION_ID");
  const root = current?.transcriptRoot;
  const parentRoot = typeof inherited?.transcriptRoot === "string" ? inherited.transcriptRoot : undefined;
  if (parentRoot && inherited?.session !== owner) throw new Error("Foreign coordinating session in parent admission");
  if (root && parentRoot && root !== parentRoot) throw new Error("Ambiguous coordinating transcript roots at admission");
  const selected = root ?? parentRoot;
  if (selected === undefined) return undefined;
  if (!identifier.test(owner) || !isAbsolute(selected) || /[\0\r\n$`]/.test(selected)) throw new Error("Coordinating transcript root must be an explicit absolute directory bound to the admitted session");
  return { session: owner, transcriptRoot: selected };
}

/** Native OMP children live next to their exact parent's JSONL, inside its stem. */
export function planningTranscript(coordinator: unknown, session: string, review: string): { transcript: string; parent: string } {
  if (!isRecord(coordinator) || typeof coordinator.session !== "string" || typeof coordinator.transcriptRoot !== "string") {
    throw new Error("Missing admitted coordinating session/transcript root; enqueue from the coordinating OMP session with its actual transcript context");
  }
  const bound = admittedCoordinator(session, { sessionId: coordinator.session, transcriptRoot: coordinator.transcriptRoot });
  if (!bound || !identifier.test(review)) throw new Error("Invalid planning reviewer identity");
  const root = bound.transcriptRoot;
  let parents: string[];
  try {
    parents = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith(`_${session}.jsonl`)).map(entry => join(root, entry.name));
  } catch (error) {
    throw new Error(`Cannot read admitted coordinating transcript root: ${String(error)}`);
  }
  if (parents.length !== 1) throw new Error(`Missing or ambiguous coordinating transcript: expected exactly one parent for ${session}, found ${parents.length} in admitted root`);
  const parent = parents[0]!;
  const sessions = readFileSync(parent, "utf8").split("\n").filter(line => line.trim()).map(line => JSON.parse(line) as unknown)
    .filter(row => isRecord(row) && row.type === "session");
  if (sessions.length !== 1 || !isRecord(sessions[0]) || sessions[0].id !== session) throw new Error("Foreign or ambiguous coordinating transcript session identity");
  const transcript = join(parent.slice(0, -".jsonl".length), `${review}.jsonl`);
  try {
    if (!statSync(transcript).isFile() || dirname(realpathSync(transcript)) !== realpathSync(parent.slice(0, -".jsonl".length))) throw new Error("reviewer is not a rooted transcript file");
  } catch (error) {
    throw new Error(`Missing planning reviewer transcript in admitted coordinating session: ${String(error)}`);
  }
  return { transcript, parent };
}
