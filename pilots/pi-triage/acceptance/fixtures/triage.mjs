import assert from "node:assert/strict";

const [issueFlag, issue, runFlag, runId, ...rest] = process.argv.slice(2);
assert.equal(process.env.A4S_PI_TRIAGE_FIXTURE, "1");
for (const key of ["DAGU_A4S_ACCEPTANCE_INHERITED", "GH_TOKEN", "OPENAI_API_KEY", "TERN_PANE"]) {
  assert.equal(process.env[key], undefined, `${key} no debe heredarse`);
}
assert.equal(issueFlag, "--issue");
assert.equal(issue, "fixture-1");
assert.equal(runFlag, "--run-id");
assert.match(runId, /^pi-slice-[a-z0-9-]+$/);
assert.deepEqual(rest, []);
console.log(JSON.stringify({
  schemaVersion: 1, issue, runId, poc: "yes",
  question: "¿El run sobrevive al cierre del cliente?",
  reason: "Fixture local del harness de aceptación.",
}));
