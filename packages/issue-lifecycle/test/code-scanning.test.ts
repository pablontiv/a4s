import assert from "node:assert/strict";
import { test } from "node:test";
import { observeCodeScanning, type CodeScanningPolicy } from "../src/code-scanning.ts";

const sha = "a".repeat(40);
const policy = { security: "high_or_higher", alerts: "errors" };
function alert(security: string | null = "high", level = "warning", commit = sha) {
  return { number: 43, state: "open", tool: { name: "CodeQL" }, html_url: "https://github.com/example/repo/security/code-scanning/43",
    rule: { id: "js/redos", severity: level, security_severity_level: security },
    most_recent_instance: { state: "open", ref: "refs/pull/77/head", commit_sha: commit, location: { path: "src/server.ts", start_line: 4 }, message: { text: "Polynomial backtracking on user input" } } };
}
function fixture(options: { alerts?: unknown[][]; checks?: unknown[]; conclusion?: string; status?: string; heads?: string[]; error?: string } = {}) {
  const calls: string[][] = [];
  const heads = [...(options.heads ?? [sha, sha])];
  const github = (args: string[]) => {
    calls.push(args);
    if (options.error) throw new Error(options.error);
    if (args[0] === "pr") return { headRefOid: heads.shift() ?? sha };
    if (args.at(-1)!.includes("check-runs")) return [{ check_runs: options.checks ?? [{ id: 1, name: "CodeQL", app: { slug: "github-advanced-security" }, head_sha: sha, status: options.status ?? "completed", conclusion: options.conclusion ?? "success" }] }];
    return options.alerts ?? [[]];
  };
  return { calls, observe: (threshold: CodeScanningPolicy = policy) => observeCodeScanning("example/repo", "77", sha, threshold, github) };
}

test("real PoC shape: successful CodeQL check still returns high finding with rule/location/message", () => {
  const f = fixture({ alerts: [[], [alert()]] });
  const observed = f.observe();
  assert.equal(observed.class, "CODE_FAIL");
  assert.equal(observed.conclusion, "success");
  assert.deepEqual(observed.findings[0], { number: 43, rule: "js/redos", severity: "high", path: "src/server.ts", line: 4,
    message: "Polynomial backtracking on user input", url: "https://github.com/example/repo/security/code-scanning/43" });
  assert.ok(f.calls.some(call => call.includes("--paginate") && call.at(-1)!.includes("ref=refs/pull/77/head")));
});

test("thresholds distinguish security severity from non-security errors", () => {
  for (const [security, level, threshold, expected] of [
    ["medium", "error", policy, "PASS"],
    ["medium", "warning", { security: "medium_or_higher", alerts: "errors" }, "CODE_FAIL"],
    ["low", "warning", { security: "all", alerts: "none" }, "CODE_FAIL"],
    ["high", "error", { security: "none", alerts: "all" }, "PASS"],
    [null, "error", policy, "CODE_FAIL"],
    [null, "warning", policy, "PASS"],
    [null, "warning", { security: "none", alerts: "errors_and_warnings" }, "CODE_FAIL"],
    [null, "note", { security: "none", alerts: "all" }, "CODE_FAIL"],
  ] as const) assert.equal(fixture({ alerts: [[alert(security, level)]] }).observe(threshold).class, expected);
});

test("analysis publication, failures, unavailable access and stale results retain diagnosed waits", () => {
  assert.equal(fixture({ checks: [] }).observe().class, "PENDING");
  assert.equal(fixture({ status: "in_progress" }).observe().class, "PENDING");
  assert.equal(fixture({ conclusion: "failure" }).observe().class, "BLOCKED");
  assert.match(fixture({ error: "HTTP 403" }).observe().cause, /403/);
  assert.equal(fixture({ alerts: [[alert("high", "warning", "b".repeat(40))]] }).observe().class, "STALE_SHA");
  assert.equal(fixture({ heads: [sha, "b".repeat(40)], alerts: [[alert()]] }).observe().class, "STALE_SHA");
  assert.equal(fixture().observe({ security: "unknown", alerts: "errors" }).class, "BLOCKED");
  assert.equal(fixture({ alerts: [[alert("unknown")]] }).observe().class, "BLOCKED");
  assert.equal(fixture({ alerts: [[{ ...alert(), state: "dismissed" }]] }).observe().class, "PASS");
  const fixed = alert("high", "warning", "b".repeat(40));
  fixed.most_recent_instance.state = "fixed";
  assert.equal(fixture({ alerts: [[fixed]] }).observe().class, "PASS");
  assert.equal(fixture({ checks: [{ id: 2, name: "CodeQL", app: { slug: "github-advanced-security" }, head_sha: "b".repeat(40) }] }).observe().class, "STALE_SHA");
});
