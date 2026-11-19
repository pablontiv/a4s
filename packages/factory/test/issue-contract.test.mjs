import test from "node:test";
import assert from "node:assert/strict";
import { checkIssue } from "../src/issue-contract.mjs";

const ok = "## Goal\ng\n\n## Acceptance criteria\n- [ ] a\n\n## Activation\nnow\n\n## Out of scope\nnothing\n\n## Notes\nn\n";
test("valid body", () => assert.deepEqual(checkIssue(ok), { ok: true, problems: [] }));
test("missing headings", () => {
  for (const h of ["Goal", "Acceptance criteria", "Out of scope"]) {
    const body = ok.replace(new RegExp(`## ${h}\\n`), "");
    const r = checkIssue(body);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes("missing") && p.includes(h)), h);
  }
  assert.equal(checkIssue(undefined).problems.length, 3);
});
test("empty section", () => {
  const r = checkIssue("## Goal\n\n## Acceptance criteria\n- [ ] a\n## Out of scope\n<!-- x -->\n");
  assert.deepEqual(r.problems, ['empty section "## Goal"', 'empty section "## Out of scope"']);
});
test("no checklist item", () => {
  const r = checkIssue("## Goal\ng\n## Acceptance criteria\njust text\n- [ ]\n## Out of scope\no\n");
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /no checklist item/);
});
