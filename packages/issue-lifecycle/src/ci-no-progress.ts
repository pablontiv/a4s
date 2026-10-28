import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomicJson } from "./atomic-json.ts";
import { withFileLock } from "./file-lock.ts";

interface Observation {
  run: string; sha: string; check: string; cause: string; class: string; action: string;
  decisionRequest?: { id: string; observations: number };
}
interface NoProgress {
  schemaVersion: 1; run: string; fingerprint: string | null; observations: number; observationId: string | null;
  requests: Record<string, { id: string; observations: number }>;
}
export function recordNoProgress(root: string, observationId: string, rawThreshold: string, lock = withFileLock): void {
  const threshold = Number(rawThreshold);
  if (!Number.isInteger(threshold) || threshold < 1) throw new Error("ESCALATION_CI_BLOCKED must be a positive integer");
  lock(join(root, "ci-no-progress.lock"), () => {
    const file = join(root, "ci-observation.json");
    const observation: Observation = JSON.parse(readFileSync(file, "utf8"));
    const stateFile = join(root, "ci-no-progress.json");
    const state: NoProgress = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {
      schemaVersion: 1, run: observation.run, fingerprint: null, observations: 0, observationId: null, requests: {},
    };
    const blocked = observation.class === "BLOCKED" && observation.action === "WAIT";
    // Python json.dumps(..., separators=(",", ":")) escapes non-ASCII; preserve
    // those bytes so an existing run retains its fingerprint across cutover.
    const compact = JSON.stringify([observation.run, observation.sha, observation.check, observation.cause])
      .replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
    const fingerprint = blocked ? createHash("sha256").update(compact).digest("hex") : null;
    if (state.observationId !== observationId || state.fingerprint !== fingerprint) {
      state.observations = fingerprint && state.fingerprint === fingerprint ? state.observations + 1 : Number(blocked);
      state.fingerprint = fingerprint;
      state.observationId = observationId;
    }
    if (blocked && state.observations >= threshold) {
      observation.decisionRequest = state.requests[fingerprint!] ??= { id: fingerprint!, observations: state.observations };
    }
    writeAtomicJson(stateFile, state);
    writeAtomicJson(file, observation);
  });
}
