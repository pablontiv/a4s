import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindingKey, reconcileGitEffect, runClaimedEffect, takeGenerationFence, validateReceipt } from './index.ts';
import type { GitIntent, Receipt } from './index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'temporal-omp-safety-'));
const repo = join(root, 'work');
const remote = join(root, 'remote.git');
const claims = join(root, 'claims');
const observations: Record<string, unknown>[] = [];
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git('init', '--bare', remote);
git('init', '--initial-branch=main', repo);
git('-C', repo, 'config', 'user.email', 'safety-probe@example.invalid');
git('-C', repo, 'config', 'user.name', 'Safety Probe');
await writeFile(join(repo, 'artifact.txt'), 'real independently observed artifact\n');
const intentPath = join(root, 'intent.json');
const worker = spawnSync(process.execPath, [join(here, 'lost-result-worker.ts'), repo, remote, intentPath, claims], { encoding: 'utf8' });
assert.equal(worker.status, 73, worker.stderr);
const { intent } = JSON.parse(await readFile(intentPath, 'utf8')) as { intent: GitIntent };
assert.equal(git('-C', repo, 'rev-list', '--count', 'HEAD'), '1');
const recovered = reconcileGitEffect(intent);
assert.equal(recovered.state, 'observed-complete');
if (recovered.state !== 'observed-complete') throw new Error('recovery failed');
let repeated = 0;
const retry = await runClaimedEffect(claims, 'safety-mandate/git-effect/push', () => {}, async () => { repeated++; return 'unsafe-repeat'; });
assert.deepEqual(retry, { state: 'unknown' });
assert.equal(repeated, 0);
assert.equal(git('-C', repo, 'rev-list', '--count', 'HEAD'), '1');
observations.push({ scenario: 'lost-result-after-real-commit-and-push', result: 'passed', workerExit: worker.status, recovery: recovered, retry, repeatedOperations: repeated, commitCount: 1 });
const receipt: Receipt = { schemaVersion: 1, status: 'completed', binding: intent.binding, completion: false, evidence: { kind: 'git-push', commitSha: intent.commitSha, remoteSha: intent.commitSha, ref: intent.ref } };
const accept = validateReceipt(receipt, intent.binding, recovered.evidence, 1);
assert.equal(accept.accepted, true);
observations.push({ scenario: 'completion-flag-not-authority', result: 'passed', completionFlag: false, validation: accept });
const cases: [string, unknown, typeof recovered.evidence, number][] = [
  ['malformed-output', '{not json', recovered.evidence, 1],
  ['schema-mismatch', { ...receipt, schemaVersion: 2 }, recovered.evidence, 1],
  ['status-mismatch', { ...receipt, status: 'running' }, recovered.evidence, 1],
  ['false-completion', { ...receipt, completion: true }, { ...recovered.evidence, remoteSha: 'f'.repeat(40) }, 1],
  ['wrong-sha', { ...receipt, evidence: { ...receipt.evidence, commitSha: 'f'.repeat(40) } }, recovered.evidence, 1],
  ['wrong-evidence-binding', receipt, { ...recovered.evidence, binding: { ...intent.binding, itemId: 'other' } }, 1],
  ['stale-generation-late-result', receipt, recovered.evidence, 2],
];
for (const key of ['mandateId', 'itemId', 'stage', 'attempt', 'revision', 'generation'] as const) {
  const binding = { ...intent.binding, [key]: typeof intent.binding[key] === 'number' ? Number(intent.binding[key]) + 1 : key === 'revision' ? 'f'.repeat(40) : 'wrong' };
  cases.push([`wrong-binding-${key}`, { ...receipt, binding }, recovered.evidence, 1]);
}
for (const [scenario, output, evidence, generation] of cases) {
  const validation = validateReceipt(output, intent.binding, evidence, generation);
  assert.equal(validation.accepted, false, scenario);
  observations.push({ scenario, result: 'passed', validation });
}
await writeFile(join(repo, 'artifact.txt'), 'changed after observation\n');
const dirty = reconcileGitEffect(intent);
assert.equal(dirty.state, 'blocked');
observations.push({ scenario: 'changed-local-state-blocks', result: 'passed', reconciliation: dirty });
git('-C', repo, 'add', 'artifact.txt');
git('-C', repo, 'commit', '-m', 'Changed state');
git('-C', repo, 'push', remote, 'HEAD:refs/heads/main');
const changedRemote = reconcileGitEffect(intent);
assert.equal(changedRemote.state, 'blocked');
observations.push({ scenario: 'changed-remote-state-blocks', result: 'passed', reconciliation: changedRemote });
const unresolved = reconcileGitEffect({ ...intent, remote: join(root, 'missing.git') });
assert.equal(unresolved.state, 'blocked');
observations.push({ scenario: 'unresolvable-state-blocks', result: 'passed', reconciliation: unresolved });
const fenceDir = join(root, 'fences');
const oldGuard = await takeGenerationFence(fenceDir, 1);
await takeGenerationFence(fenceDir, 2);
let lateDispatches = 0;
await assert.rejects(runClaimedEffect(claims, 'late-effect', oldGuard, async () => { lateDispatches++; return true; }), /superseded-generation/);
assert.equal(lateDispatches, 0);
observations.push({ scenario: 'stale-generation-late-effect-rejected-before-dispatch', result: 'passed', lateDispatches });
const sourceFiles = ['index.ts', 'scenario.ts', 'lost-result-worker.ts'];
const sourceSha256: Record<string, string> = {};
for (const file of sourceFiles) sourceSha256[file] = createHash('sha256').update(await readFile(join(here, file))).digest('hex');
const report = {
  schemaVersion: 1, observedAt: new Date().toISOString(), scenario: 'safety-real-git-reconciliation', result: 'passed',
  runtime: process.version, command: 'node poc/temporal-omp/safety/scenario.ts', isolatedRepository: repo, localBareRemote: remote,
  bindingKey: bindingKey(intent.binding), sourceSha256, observations,
  limitations: [
    'Single-host local-filesystem probe; no Temporal server, OMP runtime or runtime crash recovery exercised.',
    'Worker exits deliberately after actual push but before a result; not a power loss or filesystem durability test.',
    'Generation fence checks before dispatch only; cannot retract an in-flight external effect or close the check-to-dispatch race.',
    'Trusted caller must obtain current generation from its authority and atomically gate final acceptance there.',
    'Git observer is read-only and point-in-time; state may change after observation. Bare remote is local, not hosted GitHub.',
    'Claims assume trusted local filesystem and are retained. No distributed consensus or fsync power-loss guarantee.',
  ],
};
await mkdir(join(here, 'evidence'), { recursive: true });
await writeFile(join(here, 'evidence', 'latest.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ result: report.result, checks: observations.length, evidence: join(here, 'evidence', 'latest.json'), isolatedRepository: repo }));
