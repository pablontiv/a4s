import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('./triage.mjs', import.meta.url));
const mockProvider = fileURLToPath(new URL('./test/mock-provider.mjs', import.meta.url));
const issue = 'fixture-1';
const runId = 'pi-slice-test';
const argv = ['--issue', issue, '--run-id', runId];
const goodReply = { poc: 'yes', question: '¿Hay una sola línea?', reason: 'El log\nqueda en stderr.' };

function run(args = argv, env = {}) {
  // Do not inherit credentials, startup hooks, or Pi configuration from the test host.
  const result = spawnSync(process.execPath, ['--import', mockProvider, entry, ...args], {
    env: { A4S_PI_TRIAGE_TEST_NODE_MODULES: process.env.A4S_PI_TRIAGE_TEST_NODE_MODULES, ...env },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function assertResult(result, expectedRunId = runId) {
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\{[^\r\n]*\}\n$/);
  const value = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(value).sort(), ['issue', 'poc', 'question', 'reason', 'runId', 'schemaVersion']);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.issue, issue);
  assert.equal(value.runId, expectedRunId);
  assert.equal(value.poc, 'yes');
  for (const field of ['question', 'reason']) {
    assert.equal(typeof value[field], 'string');
    assert.ok(value[field].trim());
  }
  return value;
}

function assertFailure(result, diagnostic) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, diagnostic);
  assert.doesNotMatch(result.stderr, /test-only-key/);
}

function runPi(reply, env) {
  return run(argv, {
    A4S_PI_TRIAGE_ANTHROPIC_API_KEY: 'test-only-key',
    A4S_PI_TRIAGE_TEST_REPLY: reply,
    ...env,
  });
}

test('explicit fixture is deterministic and never loads Pi', () => {
  const env = { A4S_PI_TRIAGE_FIXTURE: '1' };
  const first = run(argv, env);
  const second = run(argv, env);
  assertResult(first);
  assert.equal(first.stderr, '');
  assert.equal(second.stdout, first.stdout);
  assert.equal(second.status, 0);
});

test('run-id remains data and cannot add a physical output line', () => {
  const unusual = 'pi-slice-"quoted"\nnext';
  assertResult(run(['--run-id', unusual, '--issue', issue], { A4S_PI_TRIAGE_FIXTURE: '1' }), unusual);
});

test('missing, unknown, duplicate, or invalid arguments fail before triage', () => {
  for (const args of [[], ['--issue', issue], ['--issue', 'fixture-2', '--run-id', runId],
    ['--issue', issue, '--run-id', 'wrong'], [...argv, '--issue', issue], [...argv, '--extra'],
    ['--issue', issue, '--run-id'], [`--issue=${issue}`, '--run-id', runId]]) {
    assertFailure(run(args, { A4S_PI_TRIAGE_FIXTURE: '1' }), /pi-triage: Usage:/);
  }
});

test('fixture does not silently activate on configuration or SDK errors', () => {
  assertFailure(run(), /requires A4S_PI_TRIAGE_ANTHROPIC_API_KEY/);
  assertFailure(run(argv, { A4S_PI_TRIAGE_FIXTURE: '0' }), /requires A4S_PI_TRIAGE_ANTHROPIC_API_KEY/);
  assertFailure(run(argv, { A4S_PI_TRIAGE_FIXTURE: 'true' }), /A4S_PI_TRIAGE_FIXTURE must be/);
  assertFailure(run(argv, { A4S_PI_TRIAGE_ANTHROPIC_API_KEY: 'test-only-key' }), /Could not load the Pi SDK/);
});

test('default mode uses the public Pi SDK and contains provider logs on stderr', () => {
  const result = runPi(JSON.stringify(goodReply, null, 2));
  assert.deepEqual(assertResult(result), { schemaVersion: 1, issue, runId, ...goodReply });
  assert.equal(result.stderr, 'mock provider request\n');
});

test('Pi rejects non-JSON or decisions outside the schema', () => {
  assertFailure(runPi(`\`\`\`json\n${JSON.stringify(goodReply)}\n\`\`\``), /invalid triage JSON/);
  for (const wrong of [null, { ...goodReply, runId: 'forged' }, { ...goodReply, poc: 'no' },
    { ...goodReply, question: '  ' }, { ...goodReply, reason: 1 }]) {
    assertFailure(runPi(JSON.stringify(wrong)), /must contain only/);
  }
});

test('provider errors and truncation fail even without an SDK rejection', () => {
  assertFailure(runPi('http-error'), /Pi (did not finish triage successfully|prompt failed)/);
  assertFailure(runPi(JSON.stringify(goodReply), { A4S_PI_TRIAGE_TEST_STOP: 'max_tokens' }), /did not finish triage successfully/);
});
