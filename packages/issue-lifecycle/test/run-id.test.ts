import assert from "node:assert/strict";
import test from "node:test";
import { testRunId } from "./fixtures/run-id.ts";

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

