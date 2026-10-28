import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { main } from "../src/commands/pr-body.ts";
const template = readFileSync(new URL("../../../.github/pull_request_template.md", import.meta.url), "utf8");
const body = template.replace("Closes #<N>\n", "Closes #571\n");
function run(...args: string[]) {
  const result = { status: 0, stdout: "", stderr: "" };
  main(args, {
    write: value => { result.stdout += value; },
    log: value => { result.stdout += `${value}\n`; },
    error: value => { result.stderr += `${value}\n`; },
    fail: () => { result.status = 1; },
  });
  return result;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pr-body-"));
  return {
    root,
    save(name: string, value: unknown) { writeFileSync(join(root, name), JSON.stringify(value)); },
    check(value: string, command = "validate") {
      writeFileSync(join(root, "body.md"), value);
      return run(command, join(root, "body.md"));
    },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

test("PR body accepts the filled template, refs, relative paths and public-safe placeholders", () => {
  const f = fixture();
  try {
    for (const reference of ["Closes #571", "Refs #571"]) {
      const result = f.check(body.replace("Closes #571", reference).replace("Describe the behavior change.",
        "Use packages/issue-lifecycle, <primary>, <worktree>, ~ and $DAGU_HOME."));
      assert.equal(result.status, 0, result.stderr);
    }
  } finally { f.cleanup(); }
});

test("PR body rejects host paths in prose, commands, code and comments", () => {
  const f = fixture();
  try {
    for (const path of ["/Users/example/private/repo", "/home/example/worktree/file", "/Users/Example User/private/file"]) {
      for (const value of [body.replace("Describe the behavior change.", path), body + `\n\`\`\`\n${path}\n\`\`\`\n`, body + `\n<!-- ${path} -->`]) {
        const result = f.check(value);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /host absolute path/);
        assert.equal(f.check(value, "check-paths").status, 1);
      }
    }
  } finally { f.cleanup(); }
});

test("PR body requires the issue reference, three sections, bounded bullets and verification/risk content", () => {
  const f = fixture();
  try {
    for (const value of ["", body.replace("Closes #571", "Closes #<N>"),
      ...["Summary", "Verification", "Risk"].map(section => body.replace(`## ${section}`, `## Other`)),
      body + "\n## Extra\nDetails\n", body.replace("- Describe the behavior change.", "Not a bullet"),
      body.replace("- Describe the behavior change.", Array(6).fill("- Change").join("\n")),
      body.replace("- Command — result", ""), body.replace(/None\s*$/u, "")]) {
      assert.equal(f.check(value).status, 1, value);
    }
  } finally { f.cleanup(); }
});

test("PR body renders candidate summary, gate PASS and current optional operator validation", () => {
  const f = fixture();
  try {
    f.save("candidate.json", { sha: "candidate", summary: "- Change behavior\n\nPreserve compatibility\nThird\nFourth\nFifth\nDetailed artifact evidence" });
    f.save("gate.json", { sha: "candidate", gate: "npm ci && npm test && npm run typecheck", result: "PASS" });
    const initial = run("render", f.root, "571");
    assert.equal(initial.status, 0, initial.stderr);
    assert.match(initial.stdout, /## Summary\n- Change behavior\n- Preserve compatibility\n- Third\n- Fourth\n- Fifth\n/);
    assert.match(initial.stdout, /npm ci && npm test && npm run typecheck — PASS/);
    assert.equal(f.check(initial.stdout).status, 0);
    f.save("validation.json", { sha: "candidate", approved: "yes", procedure: "Run smoke\nagainst <worktree>" });
    const approved = run("render", f.root, "571");
    assert.equal(approved.status, 0, approved.stderr);
    assert.match(approved.stdout, /Operator validation: Run smoke against <worktree> — approved/);
    f.save("validation.json", { sha: "old", approved: "yes", procedure: "Run smoke" });
    assert.equal(run("render", f.root, "571").status, 1);
  } finally { f.cleanup(); }
});

test("PR body rendering requires current successful gate evidence and publication-safe run data", () => {
  const f = fixture();
  try {
    for (const [summary, gate] of [
      ["Change", { sha: "old", gate: "npm test", result: "PASS" }],
      ["Change", { sha: "candidate", gate: "npm test", result: "FAIL" }],
      ["Change", { sha: "candidate", gate: "npm test" }],
      ["", { sha: "candidate", gate: "npm test", result: "PASS" }],
      ["Change /Users/example/private/file", { sha: "candidate", gate: "npm test", result: "PASS" }],
      ["Change", { sha: "candidate", gate: "cd /home/example/repo && npm test", result: "PASS" }],
    ]) {
      f.save("candidate.json", { sha: "candidate", summary });
      f.save("gate.json", gate);
      assert.equal(run("render", f.root, "571").status, 1);
    }
  } finally { f.cleanup(); }
});

test("CI PR event payload passes conforming bodies and fails missing sections and host paths", () => {
  const f = fixture();
  try {
    for (const [value, expected] of [[body, 0], [body.replace("## Risk", "## Other"), 1], [body + "\n/home/example/private/file", 1], [null, 1]] as const) {
      f.save("event.json", { pull_request: { body: value } });
      const result = run("event", join(f.root, "event.json"));
      assert.equal(result.status, expected, result.stderr);
    }
    const workflow = parse(readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8"));
    assert.ok(workflow.on.pull_request.types.includes("edited"));
    assert.equal(workflow.jobs["pr-body"].if, "github.event_name == 'pull_request'");
    assert.equal(workflow.jobs["pr-body"].steps.at(-1).run, "node packages/issue-lifecycle/bin/dagu-pr-body.mjs event");
    assert.ok(workflow.jobs.validate.needs.includes("pr-body"));
    assert.ok(workflow.jobs.validate.steps.some((step: { env?: Record<string, string> }) => step.env?.PR_BODY_RESULT === "${{ needs.pr-body.result }}"));
  } finally { f.cleanup(); }
});
