#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function checkPaths(body) {
  if (/\/(?:Users|home)\/[^/\r\n]+\//u.test(body)) {
    throw new Error("Body contains a host absolute path; use repository-relative paths or placeholders. Logs belong in run artifacts.");
  }
}

function validate(body) {
  checkPaths(body);
  // Comments are template instructions, not published content.
  const content = body.replace(/<!--[\s\S]*?-->/gu, "").replace(/\r\n/gu, "\n").trim();
  if (!/^(?:Closes|Refs) #[1-9]\d*\n\n/u.test(content)) {
    throw new Error("Body must start with Closes #<N> or Refs #<N>.");
  }
  const headings = [...content.matchAll(/^## .+$/gmu)].map(match => match[0]);
  if (headings.join("\n") !== "## Summary\n## Verification\n## Risk") {
    throw new Error("Body requires exactly Summary, Verification and Risk sections, in that order.");
  }
  const [, summary, verification, risk] = content.split(/^## (?:Summary|Verification|Risk)\n/gmu);
  const bullets = summary.trim().split("\n");
  if (bullets.length > 5 || !bullets.every(line => /^- \S/u.test(line))) {
    throw new Error("Summary requires one to five single-line bullets.");
  }
  if (!verification.trim() || !risk.trim()) {
    throw new Error("Verification and Risk require content; use None for an empty risk.");
  }
}

function render(state, issue) {
  if (!/^[1-9]\d*$/u.test(issue ?? "")) throw new Error("A numbered issue is required.");
  const json = name => JSON.parse(readFileSync(join(state, name), "utf8"));
  const candidate = json("candidate.json");
  const gate = json("gate.json");
  if (gate.sha !== candidate.sha || gate.result !== "PASS" || typeof gate.gate !== "string" || !gate.gate.trim()) {
    throw new Error("Current candidate requires a passing gate record.");
  }
  if (typeof candidate.summary !== "string" || !candidate.summary.trim()) throw new Error("Implement SUMMARY is required.");
  const summary = candidate.summary.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
    .slice(0, 5).map(line => `- ${line.replace(/^(?:[-*] |#{1,6} )/u, "")}`);
  const verification = [`- ${gate.gate.replace(/\r/gu, "\\r").replace(/\n/gu, "\\n")} — ${gate.result}`];
  if (existsSync(join(state, "validation.json"))) {
    const validation = json("validation.json");
    if (validation.sha !== candidate.sha || validation.approved !== "yes" || typeof validation.procedure !== "string" || !validation.procedure.trim()) {
      throw new Error("Operator validation must approve the current candidate.");
    }
    verification.push(`- Operator validation: ${validation.procedure.replace(/\s+/gu, " ").trim()} — approved`);
  }
  const body = `Closes #${issue}\n\n## Summary\n${summary.join("\n")}\n\n## Verification\n${verification.join("\n")}\n\n## Risk\nNone\n`;
  validate(body);
  return body;
}

try {
  const [command, file, issue] = process.argv.slice(2);
  switch (command) {
    case "render": process.stdout.write(render(file, issue)); break;
    case "check-paths": checkPaths(readFileSync(file, "utf8")); break;
    case "validate": validate(readFileSync(file, "utf8")); break;
    case "event": {
      const event = JSON.parse(readFileSync(file ?? process.env.GITHUB_EVENT_PATH, "utf8"));
      validate(event.pull_request?.body ?? "");
      console.log("PR body: PASS");
      break;
    }
    default: throw new Error("Usage: dagu-pr-body render <state> <issue> | check-paths <file> | validate <file> | event [event.json]");
  }
} catch (error) {
  console.error(`PR body: ${error.message}`);
  process.exitCode = 1;
}
