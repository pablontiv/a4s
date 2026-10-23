import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

const directory = fileURLToPath(new URL("../skills", import.meta.url));

test("package skill discovery exposes every lifecycle workflow from its canonical invocable source", () => {
  const { skills, diagnostics } = loadSkillsFromDir({ dir: directory, source: "package" });
  assert.deepEqual(diagnostics, []);
  for (const name of ["issue-execution", "repository-discovery", "backlog-breakdown", "refine", "sprint-planning", "sprint-review", "sprint-retrospective"]) {
    const matches = skills.filter(skill => skill.name === name);
    assert.equal(matches.length, 1, `${name} has one discovered source`);
    assert.equal(realpathSync(matches[0]!.filePath), realpathSync(join(directory, name, "SKILL.md")));
    assert.equal(matches[0]!.disableModelInvocation, false, `${name} supports invocation`);
  }
});
