export interface RequiredCheck {
  name: string;
  app_id?: number | null;
}

export interface CheckResult {
  name: string;
  sha: string;
  app_id?: number | null;
  state: string;
  link?: string;
  id?: number;
  text?: string;
}

interface RequiredCheckObservation {
  class: "PASS" | "PENDING" | "STALE_SHA" | "BLOCKED";
  cause: string;
  check: CheckResult | null;
}

function newer(candidate: CheckResult, current: CheckResult): boolean {
  const candidateRun = /\/actions\/runs\/(\d+)(?:\/|$)/.exec(candidate.link ?? "")?.[1];
  const currentRun = /\/actions\/runs\/(\d+)(?:\/|$)/.exec(current.link ?? "")?.[1];
  // A cancelled workflow can start its aggregate job after a superseding run's
  // job. Compare workflow runs before job/check IDs, then handle reruns by ID.
  if (candidateRun && currentRun && candidateRun !== currentRun) return Number(candidateRun) > Number(currentRun);
  return (candidate.id ?? 0) > (current.id ?? 0);
}

export function observeRequiredChecks(required: RequiredCheck[], checks: CheckResult[], sha: string): RequiredCheckObservation {
  if (!required.length) return { class: "PENDING", cause: "Required checks not yet published", check: null };
  let observation: RequiredCheckObservation = { class: "PASS", cause: "All required checks passed for current head", check: null };
  for (const requirement of required) {
    let latest: CheckResult | undefined;
    let stale = false;
    for (const check of checks) {
      if (check.name !== requirement.name || (requirement.app_id != null && check.app_id !== requirement.app_id)) continue;
      if (check.sha !== sha) { stale = true; continue; }
      if (!latest || newer(check, latest)) latest = check;
    }
    let result: RequiredCheckObservation;
    if (!latest) {
      result = { class: stale ? "STALE_SHA" : "PENDING", check: { name: requirement.name, sha, state: "EXPECTED" },
        cause: stale ? "Discarded result for another SHA; reobserve current head" : `Required check ${requirement.name} not published for ${sha}` };
    } else if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(latest.state)) {
      continue;
    } else if (["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "REQUESTED", "WAITING"].includes(latest.state)) {
      result = { class: "PENDING", cause: `Required check ${latest.name} is ${latest.state}`, check: latest };
    } else {
      result = { class: "BLOCKED", cause: `Unproven cause for ${latest.name} (${latest.state}); inspect ${latest.link ?? ""} and resolve permissions, protection or operator action`, check: latest };
    }
    // A real failure must not be hidden by another required check still running.
    if (result.class === "BLOCKED") return result;
    if (observation.class === "PASS" || result.class === "STALE_SHA") observation = result;
  }
  return observation;
}
