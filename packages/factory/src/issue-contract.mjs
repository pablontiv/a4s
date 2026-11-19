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
  return { ok: problems.length === 0, problems };
}
