import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { claimEffect, bindingKey } from './index.ts';
import type { Binding, GitIntent } from './index.ts';

const [repo, remote, intentPath, claims] = process.argv.slice(2);
const binding: Binding = { mandateId: 'safety-mandate', itemId: 'git-effect', stage: 'push', attempt: 1, revision: '0'.repeat(40), generation: 1 };
// Effect identity deliberately excludes attempt/generation: replacement must not redispatch the same logical effect.
if (!await claimEffect(claims, 'safety-mandate/git-effect/push')) throw new Error('already-dispatched');
execFileSync('git', ['-C', repo, 'add', 'artifact.txt']);
execFileSync('git', ['-C', repo, 'commit', '-m', 'Actual effect before lost result'], { stdio: 'pipe' });
binding.revision = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const intent: GitIntent = { repo, remote, ref: 'refs/heads/main', commitSha: binding.revision, binding };
writeFileSync(intentPath, JSON.stringify({ intent, bindingKey: bindingKey(binding) }, null, 2));
execFileSync('git', ['-C', repo, 'push', remote, `${binding.revision}:refs/heads/main`], { stdio: 'pipe' });
// The external effect is real. Deliberately terminate BEFORE returning/storing any completion receipt.
process.exit(73);
