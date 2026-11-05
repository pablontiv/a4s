import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface Binding {
  mandateId: string;
  itemId: string;
  stage: string;
  attempt: number;
  revision: string;
  generation: number;
}
export interface GitIntent {
  binding: Binding;
  repo: string;
  remote: string;
  ref: string;
  commitSha: string;
}
export interface GitEvidence {
  kind: 'git-push';
  binding: Binding;
  observedAt: string;
  commitSha: string;
  localSha: string;
  remoteSha: string;
  ref: string;
  clean: boolean;
  branchMatches: boolean;
}
export interface Receipt {
  schemaVersion: 1;
  status: 'completed';
  binding: Binding;
  evidence: { kind: 'git-push'; commitSha: string; remoteSha: string; ref: string };
  completion: boolean;
}
export type ValidationResult = { accepted: true; receipt: Receipt } | { accepted: false; reason: string };
export type Reconciliation = { state: 'observed-complete'; evidence: GitEvidence } | { state: 'blocked'; reason: string; evidence?: GitEvidence };
const sha = /^[a-f0-9]{40}$/;
const record = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x: Record<string, unknown>, keys: string[]) => Object.keys(x).sort().join(',') === keys.sort().join(',');
export function isBinding(x: unknown): x is Binding {
  return record(x) && exact(x, ['mandateId', 'itemId', 'stage', 'attempt', 'revision', 'generation']) &&
    ['mandateId', 'itemId', 'stage'].every(k => typeof x[k] === 'string' && (x[k] as string).trim().length > 0) &&
    typeof x.revision === 'string' && sha.test(x.revision) &&
    Number.isSafeInteger(x.attempt) && Number(x.attempt) > 0 && Number.isSafeInteger(x.generation) && Number(x.generation) > 0;
}
export const bindingKey = (b: Binding) => JSON.stringify([b.mandateId, b.itemId, b.stage, b.attempt, b.revision, b.generation]);

/** Evidence MUST be supplied by the trusted observer, never parsed from agent output. */
export function validateReceipt(raw: unknown, expected: Binding, evidence: GitEvidence, currentGeneration: number): ValidationResult {
  const reject = (reason: string): ValidationResult => ({ accepted: false, reason });
  if (!isBinding(expected) || currentGeneration !== expected.generation) return reject('stale-or-invalid-binding');
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { return reject('malformed-json'); }
  }
  if (!record(value) || !exact(value, ['schemaVersion', 'status', 'binding', 'evidence', 'completion']) ||
      value.schemaVersion !== 1 || value.status !== 'completed' || typeof value.completion !== 'boolean' ||
      !isBinding(value.binding) || !record(value.evidence) ||
      !exact(value.evidence, ['kind', 'commitSha', 'remoteSha', 'ref']) || value.evidence.kind !== 'git-push') return reject('schema-or-status-mismatch');
  if (bindingKey(value.binding) !== bindingKey(expected)) return reject('wrong-binding');
  if (!record(evidence) || !isBinding(evidence.binding) || bindingKey(evidence.binding) !== bindingKey(expected) ||
      evidence.kind !== 'git-push' || !Number.isFinite(Date.parse(evidence.observedAt)) || evidence.clean !== true ||
      evidence.branchMatches !== true || evidence.commitSha !== expected.revision || evidence.localSha !== expected.revision ||
      evidence.remoteSha !== expected.revision || !sha.test(evidence.commitSha)) return reject('independent-evidence-not-complete');
  if (value.evidence.commitSha !== expected.revision || value.evidence.remoteSha !== evidence.remoteSha ||
      value.evidence.ref !== evidence.ref) return reject('wrong-sha-or-ref');
  // Agent completion is deliberately not consulted: false plus actual proof succeeds; true without proof fails.
  return { accepted: true, receipt: value as unknown as Receipt };
}

const git = (repo: string, args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
export function observeGitEffect(intent: GitIntent): GitEvidence {
  if (!isBinding(intent.binding) || !sha.test(intent.commitSha) || intent.commitSha !== intent.binding.revision || !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(intent.ref)) throw new Error('invalid-git-intent');
  git(intent.repo, ['check-ref-format', intent.ref]);
  git(intent.repo, ['cat-file', '-e', `${intent.commitSha}^{commit}`]);
  const remoteLines = git(intent.repo, ['ls-remote', '--refs', '--exit-code', intent.remote, intent.ref]).split('\n');
  if (remoteLines.length !== 1 || remoteLines[0].split('\t')[1] !== intent.ref) throw new Error('unresolvable-remote-ref');
  return {
    kind: 'git-push', binding: intent.binding, observedAt: new Date().toISOString(), commitSha: intent.commitSha,
    localSha: git(intent.repo, ['rev-parse', 'HEAD']), remoteSha: remoteLines[0].split('\t')[0], ref: intent.ref,
    clean: git(intent.repo, ['status', '--porcelain=v1', '--untracked-files=all']) === '',
    branchMatches: git(intent.repo, ['symbolic-ref', 'HEAD']) === intent.ref,
  };
}
/** Observation only: an unknown outcome is never made safe by replaying the operation. */
export function reconcileGitEffect(intent: GitIntent): Reconciliation {
  try {
    const evidence = observeGitEffect(intent);
    if (evidence.localSha !== intent.commitSha || evidence.remoteSha !== intent.commitSha || !evidence.clean || !evidence.branchMatches) return { state: 'blocked', reason: 'changed-git-state', evidence };
    return { state: 'observed-complete', evidence };
  } catch (error) { return { state: 'blocked', reason: `unresolvable-git-state: ${String(error)}` }; }
}

// Adapted from pi-temporal src/core/pending.ts claimDispatch; see THIRD_PARTY_LICENSE.txt.
// Claims persist independently of results. Existing claim means unknown, NOT safe to retry.
export async function claimEffect(stateDir: string, effectKey: string): Promise<boolean> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const key = createHash('sha256').update(effectKey).digest('hex');
  try { await writeFile(join(stateDir, `${key}.started`), '', { flag: 'wx', mode: 0o600 }); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
}
export async function runClaimedEffect<T>(stateDir: string, effectKey: string, guard: () => void, operation: () => Promise<T>): Promise<{ state: 'completed'; result: T } | { state: 'unknown' }> {
  guard();
  if (!await claimEffect(stateDir, effectKey)) return { state: 'unknown' };
  guard();
  const result = await operation();
  guard();
  return { state: 'completed', result };
}

// Adapted from pi-temporal src/core/fence.ts takeFence. Generation is assigned by an authority.
// Single-host pre-dispatch fence only; cannot stop an already-dispatched external command.
export async function takeGenerationFence(stateDir: string, generation: number): Promise<() => void> {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('invalid-generation');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const token = String(generation).padStart(16, '0');
  await writeFile(join(stateDir, token), '', { flag: 'wx', mode: 0o600 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
  const guard = () => {
    const newest = readdirSync(stateDir).filter(name => /^\d{16}$/.test(name)).sort().at(-1);
    if (newest === undefined || newest > token) throw new Error('superseded-generation');
  };
  guard();
  return guard;
}
