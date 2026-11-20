// Issue contract (see CONTRACTS.md "Issue contract"): structure only, never content quality.
export const REQUIRED = ["Goal", "Acceptance criteria", "Out of scope"];

/** Sections of a markdown body keyed by `## ` heading text (fenced code ignored). */
function sections(body) {
  const out = new Map();
  let cur = null, fence = false;
  for (const line of String(body ?? "").replace(/\r/g, "").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && /^##[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (m) { cur = m[1].trim(); if (!out.has(cur)) out.set(cur, []); continue; }
    if (cur !== null) out.get(cur).push(line);
  }
  return out;
}

/**
 * Optional `## Blocked by` section: issues as `#<n>`, one per line (an optional `- `/`* ` bullet) or comma separated.
 * @returns {{present: boolean, blockers: number[], problems: string[]}}
 */
export function parseBlockedBy(body) {
  const secs = sections(body);
  if (!secs.has("Blocked by")) return { present: false, blockers: [], problems: [] };
  const text = secs.get("Blocked by").join("\n").replace(/<!--[\s\S]*?-->/g, "");
  const blockers = [], problems = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    for (const raw of line.replace(/^\s*[-*]\s+/, "").split(",")) {
      const m = /^\s*#(\d+)\s*$/.exec(raw);
      if (m) { if (!blockers.includes(Number(m[1]))) blockers.push(Number(m[1])); }
      else problems.push(`malformed entry "${raw.trim()}" in "## Blocked by" (expected #<n>)`);
    }
  }
  if (!blockers.length && !problems.length) problems.push('empty section "## Blocked by"');
  return { present: true, blockers, problems };
}

/** @returns {{ok: boolean, problems: string[]}} */
export function checkIssue(body) {
  const problems = [];
  const secs = sections(body);
  for (const h of REQUIRED) {
    if (!secs.has(h)) { problems.push(`missing heading "## ${h}"`); continue; }
    const text = secs.get(h).join("\n").replace(/<!--[\s\S]*?-->/g, "").trim();
    if (!text) { problems.push(`empty section "## ${h}"`); continue; }
    if (h === "Acceptance criteria" && !secs.get(h).some((l) => /^\s*[-*]\s+\[[ xX]\]\s+\S/.test(l)))
      problems.push(`no checklist item "- [ ] ..." in "## ${h}"`);
  }
  problems.push(...parseBlockedBy(body).problems);
  return { ok: problems.length === 0, problems };
}
