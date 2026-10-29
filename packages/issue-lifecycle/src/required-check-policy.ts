import { execFileSync } from "node:child_process";

type Github = (args: string[]) => unknown;
const gh: Github = args => JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }));
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const oid = (value: unknown): boolean => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);

/** The REST binding includes the effective base, not the head/default branch. */
export function requiredCheckBinding(value: unknown) {
  if (!record(value) || !Number.isInteger(value.number) || !record(value.base) || !record(value.base.repo) ||
      !Number.isInteger(value.base.repo.id) || !text(value.base.repo.full_name) || !text(value.base.ref) ||
      !oid(value.base.sha) || !record(value.head) || !oid(value.head.sha)) throw new Error("Incomplete PR/base repository binding");
  return { pr: value.number as number, repo: value.base.repo.full_name as string, repositoryId: value.base.repo.id as number,
    ref: value.base.ref as string, base: value.base.sha as string, head: value.head.sha as string };
}

/** Only used for the exact CLI no-check response. Unknown policy always fails closed. */
export function observeRequiredCheckPolicy(repo: string, pr: string, sha: string, github: Github = gh) {
  const required: { name: string; state: string; app_id: number | null }[] = [];
  try {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[1-9][0-9]*$/.test(pr) || !oid(sha)) throw new Error("Invalid required-policy target");
    const binding = requiredCheckBinding(github(["api", `repos/${repo}/pulls/${pr}`]));
    if (binding.pr !== Number(pr) || binding.repo.toLowerCase() !== repo.toLowerCase()) throw new Error("PR/base repository identity mismatch");
    if (binding.head !== sha) return { class: "STALE_SHA", cause: "Head moved before required-policy observation", required: [], binding };
    const branch = encodeURIComponent(binding.ref);
    const classic = github(["api", `repos/${binding.repo}/branches/${branch}/protection/required_status_checks`]);
    if (!record(classic) || typeof classic.strict !== "boolean" || !Array.isArray(classic.contexts) || !classic.contexts.every(text) ||
        !Array.isArray(classic.checks)) throw new Error("Malformed classic required-status-check policy");
    function add(name: unknown, app: unknown) {
      if (!text(name) || !(app === null || (Number.isInteger(app) && Number(app) > 0))) throw new Error("Malformed required context/app constraint");
      if (!required.some(check => check.name === name && check.app_id === app)) required.push({ name, state: "EXPECTED", app_id: app as number | null });
    }
    for (const check of classic.checks) {
      if (!record(check)) throw new Error("Malformed classic required check");
      add(check.context, check.app_id);
    }
    // contexts mirrors checks on modern responses; never weaken an explicit app constraint.
    for (const context of classic.contexts) if (!required.some(check => check.name === context)) add(context, null);
    const pages = github(["api", "--paginate", "--slurp", `repos/${binding.repo}/rules/branches/${branch}?per_page=100`]);
    if (!Array.isArray(pages) || pages.length === 0 || pages.some(page => !Array.isArray(page))) throw new Error("Incomplete effective branch rules response");
    for (const rule of pages.flat()) {
      if (!record(rule) || !text(rule.type)) throw new Error("Malformed effective branch rule");
      if (rule.type !== "required_status_checks") continue;
      if (!record(rule.parameters) || !Array.isArray(rule.parameters.required_status_checks)) throw new Error("Malformed ruleset required checks");
      for (const check of rule.parameters.required_status_checks) {
        if (!record(check)) throw new Error("Malformed ruleset required check");
        add(check.context, check.integration_id ?? null);
      }
    }
    if (!required.length) throw new Error("No applicable required contexts confirmed; inspect base-branch protection");
    return { class: "PENDING", cause: "Configured required checks await current-head publication", required, binding };
  } catch (error) {
    return { class: "BLOCKED", cause: `Required-check policy lookup failed; check authentication, permissions and base-branch protection: ${error instanceof Error ? error.message : String(error)}`, required: [] };
  }
}
