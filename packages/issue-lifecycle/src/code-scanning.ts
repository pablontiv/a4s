import { execFileSync } from "node:child_process";

export const securityThresholds = ["none", "critical", "high_or_higher", "medium_or_higher", "all"] as const;
export const alertThresholds = ["none", "errors", "errors_and_warnings", "all"] as const;
export interface CodeScanningPolicy { security: string; alerts: string }
export interface CodeScanningFinding {
  number: number; rule: string; severity: string; path: string; line: number; message: string; url: string;
}
export interface CodeScanningObservation {
  sha: string; class: "PASS" | "PENDING" | "CODE_FAIL" | "BLOCKED" | "STALE_SHA";
  check: string; conclusion: string; cause: string; findings: CodeScanningFinding[];
}
type Github = (args: string[]) => unknown;
const gh: Github = args => JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }));
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const securityMinimum: Record<string, number> = { none: 4, critical: 3, high_or_higher: 2, medium_or_higher: 1, all: 0 };
const alertMinimum: Record<string, number> = { none: 3, errors: 2, errors_and_warnings: 1, all: 0 };

/** One bounded observation. The scheduled reconciler owns subsequent observations. */
export function observeCodeScanning(repo: string, pr: string, sha: string, policy: CodeScanningPolicy, github: Github = gh): CodeScanningObservation {
  const observation: CodeScanningObservation = { sha, class: "BLOCKED", check: "CodeQL", conclusion: "", cause: "", findings: [] };
  try {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[1-9][0-9]*$/.test(pr) || !/^[a-f0-9]{40}$/.test(sha) ||
        !securityThresholds.some(value => value === policy.security) || !alertThresholds.some(value => value === policy.alerts)) throw new Error("Invalid CodeQL target or threshold policy");
    const head = () => {
      const value = github(["pr", "view", pr, "-R", repo, "--json", "headRefOid"]);
      if (!record(value) || typeof value.headRefOid !== "string") throw new Error("Missing PR head identity");
      return value.headRefOid;
    };
    if (head() !== sha) return { ...observation, class: "STALE_SHA", cause: "PR head moved before CodeQL observation" };
    const pages = github(["api", "--paginate", "--slurp", `repos/${repo}/commits/${sha}/check-runs?per_page=100`]);
    if (!Array.isArray(pages) || pages.some(page => !record(page) || !Array.isArray(page.check_runs))) throw new Error("Malformed CodeQL check-runs response");
    const checks = pages.flatMap(page => page.check_runs).filter(check => check.name === "CodeQL" && check.app?.slug === "github-advanced-security")
      .sort((a, b) => b.id - a.id);
    const check = checks[0];
    if (check && check.head_sha !== sha) return { ...observation, class: "STALE_SHA", cause: "CodeQL check belongs to another SHA" };
    observation.conclusion = check?.conclusion ?? "";
    const alertPages = github(["api", "--paginate", "--slurp", `repos/${repo}/code-scanning/alerts?state=open&tool_name=CodeQL&ref=refs/pull/${pr}/head&per_page=100`]);
    if (!Array.isArray(alertPages) || alertPages.some(page => !Array.isArray(page))) throw new Error("Malformed CodeQL alerts response");
    let stale = false;
    for (const alert of alertPages.flat()) {
      if (!record(alert) || !record(alert.rule) || !record(alert.most_recent_instance)) throw new Error("Malformed CodeQL alert");
      if (alert.state !== "open" || alert.tool?.name !== "CodeQL") continue;
      const instance = alert.most_recent_instance;
      if (instance.state === "fixed") continue;
      if (instance.commit_sha !== sha || instance.ref !== `refs/pull/${pr}/head`) { stale = true; continue; }
      const security = alert.rule.security_severity_level;
      const securityRank = ["low", "medium", "high", "critical"].indexOf(security);
      const requiredSecurity = securityMinimum[policy.security]!;
      const level = alert.rule.severity;
      const levelRank = ["note", "warning", "error"].indexOf(level);
      if ((security != null && securityRank < 0) || (securityRank < 0 && levelRank < 0)) throw new Error("Unknown CodeQL alert severity");
      const requiredLevel = alertMinimum[policy.alerts]!;
      if (securityRank >= 0 ? securityRank < requiredSecurity : levelRank < requiredLevel) continue;
      const location = instance.location;
      if (!record(location) || typeof location.path !== "string" || !Number.isInteger(location.start_line) || typeof instance.message?.text !== "string") throw new Error("Incomplete CodeQL finding location/message");
      observation.findings.push({ number: alert.number, rule: alert.rule.id, severity: security ?? level,
        path: location.path, line: location.start_line, message: instance.message.text, url: alert.html_url });
    }
    if (head() !== sha) return { ...observation, class: "STALE_SHA", findings: [], cause: "PR head moved during CodeQL observation" };
    if (observation.findings.length) return { ...observation, class: "CODE_FAIL", cause: "CodeQL findings meet the adopted threshold" };
    if (stale) return { ...observation, class: "STALE_SHA", cause: "CodeQL alerts still describe an earlier PR head" };
    if (!check || check.status !== "completed") return { ...observation, class: "PENDING", cause: "CodeQL analysis not complete for current head" };
    if (check.conclusion !== "success") return { ...observation, cause: `CodeQL check ${check.conclusion}; no threshold finding proves a candidate defect` };
    return { ...observation, class: "PASS", cause: "CodeQL completed with no open findings at the adopted threshold" };
  } catch (error) {
    return { ...observation, cause: `CodeQL observation unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}
