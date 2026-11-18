import assert from 'node:assert/strict';

const [issueFlag, issue, runFlag, runId, ...extra] = process.argv.slice(2);
assert.equal(issueFlag, '--issue');
assert.ok(issue);
assert.equal(runFlag, '--run-id');
assert.match(runId, /^pi-slice-/);
assert.deepEqual(extra, []);

const triage = {
  schemaVersion: 1,
  issue,
  runId,
  poc: 'yes',
  question: 'Would the fixture exercise "runtime: behavior"?',
  reason: 'Stub only; no PoC was run.',
};

switch (runId) {
  case 'pi-slice-bad-json': process.stdout.write('not JSON\n'); break;
  case 'pi-slice-extra-line': console.log('extra line'); console.log(JSON.stringify(triage)); break;
  case 'pi-slice-wrong-issue': console.log(JSON.stringify({ ...triage, issue: 'other' })); break;
  case 'pi-slice-wrong-run': console.log(JSON.stringify({ ...triage, runId: 'pi-slice-other' })); break;
  case 'pi-slice-extra-key': console.log(JSON.stringify({ ...triage, extra: true })); break;
  case 'pi-slice-duplicate-key': console.log(`{"poc":"yes",${JSON.stringify(triage).slice(1)}`); break;
  case 'pi-slice-blank-reason': console.log(JSON.stringify({ ...triage, reason: ' ' })); break;
  case 'pi-slice-poc-no': console.log(JSON.stringify({ ...triage, poc: 'no' })); break;
  case 'pi-slice-unsupported-schema': console.log(JSON.stringify({ ...triage, schemaVersion: 2 })); break;
  case 'pi-slice-nonzero': console.log(JSON.stringify(triage)); process.exitCode = 7; break;
  default: console.log(JSON.stringify(triage));
}
