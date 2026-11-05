import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './commands.mjs';
const exec = promisify(execFile);
const command = fileURLToPath(new URL('./commands.mjs', import.meta.url));
export function createActivities(evidenceRoot) {
  return {
    async recordState(snapshot) {
      await appendFile(resolve(evidenceRoot, 'state-updates.jsonl'), JSON.stringify(snapshot) + '\n');
    },
    async executeBoundItem(binding, operation, upstream) {
      if (!['inventory', 'validate-inventory'].includes(operation)) throw new Error('Unsupported fixed operation');
      if (operation === 'validate-inventory' && (upstream.length !== 1 || upstream[0].binding.mandateId !== binding.mandateId || upstream[0].artifact !== 'inventory.json')) throw new Error('Validation requires correlated inventory predecessor');
      const startedAt = new Date().toISOString();
      const { stdout, stderr } = await exec(process.execPath, [command, operation, evidenceRoot], { timeout: 20_000, maxBuffer: 1024 * 1024 });
      const result = JSON.parse(stdout);
      const expectedArtifact = operation === 'inventory' ? 'inventory.json' : 'inventory-validation.json';
      if (result.artifact !== expectedArtifact) throw new Error('Unexpected command result artifact');
      const receipt = { binding, kind: 'bootstrap_command_activity', nativeHostProof: false, artifact: expectedArtifact, digest: digest(await readFile(resolve(evidenceRoot, expectedArtifact))) };
      await writeFile(resolve(evidenceRoot, `receipt-${binding.itemId}.json`), JSON.stringify({ observedAt: new Date().toISOString(), startedAt, scenario: operation, result: receipt, command: [process.execPath, command, operation, evidenceRoot], stdout, stderr, limitations: ['Command activity bootstrap; no native OMP host turn/context/reload proof.'] }, null, 2) + '\n');
      return receipt;
    },
  };
}
