import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { testRunId } from "./fixtures/run-id.ts";

const execute = promisify(execFile);

test("run identities distinguish repeated allocations and preserve readable labels", () => {
  const first = testRunId("same-case");
  const second = testRunId("same-case");
  assert.match(first, /^same-case-[a-f0-9-]+-\d+$/);
  assert.notEqual(first, second);
  assert.notEqual(`poc-${first}`, `poc-${second}`);
  assert.notEqual(`feature-${first}`, `feature-${second}`);
  const recovery = testRunId("recovery");
  assert.ok(`recovery-start_gate-${recovery}`.length <= 63);
  const policy = testRunId("feature-rebase_resolver-4");
  assert.ok(policy.length <= 63);
});

test("independent concurrent processes allocate distinct identities for the same case", async () => {
  const fixture = new URL("./fixtures/run-id.ts", import.meta.url).href;
  const code = `import { testRunId } from ${JSON.stringify(fixture)}; console.log(testRunId("same-case"));`;
  const results = await Promise.all([0, 1].map(() => execute(process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", code], { timeout: 30_000 })));
  const ids = results.map(result => result.stdout.trim());
  for (const id of ids) assert.match(id, /^same-case-[a-f0-9-]+-1$/);
  assert.equal(new Set(ids).size, 2);
});
