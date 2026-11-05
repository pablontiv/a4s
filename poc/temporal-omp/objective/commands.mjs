import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function validateSchema(value, schema, acceptance = 'accepted') {
  if (schema === 'objective-input') {
    if (!value.mandateId || !Array.isArray(value.items) || value.items.length !== 3 || !value.items.every(item => item.id && Array.isArray(item.dependencies))) throw new Error('Invalid retained objective input');
  } else if (schema === 'admission') {
    if (value.admissions !== 1 || !value.workflowId || !value.admittedAt || value.nativeHostProof !== false || value.executionKind !== 'bootstrap_command_activity') throw new Error('Invalid admission evidence');
  } else if (schema === 'retained-evidence') {
    const records = Array.isArray(value.evidence) ? value.evidence : Array.isArray(value.scenarios) ? value.scenarios : [value];
    if (!records.length) throw new Error('Empty selected evidence');
    for (const record of records) {
      const result = record.result ?? (record.before?.result && { before: record.before.result, after: record.after });
      if (typeof record.observedAt !== 'string' || !Number.isFinite(Date.parse(record.observedAt)) || typeof record.scenario !== 'string' || !record.scenario.trim() || result === undefined || result === null || !Array.isArray(record.limitations) || !record.limitations.length || !record.limitations.every(text => typeof text === 'string' && text.trim())) throw new Error('Selected evidence requires observedAt, named scenario, actual result and explicit limitations');
      if (acceptance !== 'reported') {
        if (typeof result === 'string' && !['passed', 'completed', 'accepted'].includes(result)) throw new Error(`Unaccepted evidence result: ${result}`);
        if (typeof result === 'object' && (result.valid === false || result.passed === false || ['failed', 'pending', 'running', 'blocked'].includes(result.status))) throw new Error('Selected evidence not accepted');
        if (record.before && !record.after) throw new Error('Restart evidence is not complete');
      }
    }
  } else if (schema === 'source') {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Empty declared source');
  } else throw new Error(`Unknown declared schema ${schema}`);
}
export async function inspectEvidence(root) {
  const manifest = JSON.parse(await readFile(resolve(root, 'evidence-manifest.json'), 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length < 3) throw new Error('Invalid evidence manifest');
  const records = [];
  for (const entry of manifest.files) {
    if (isAbsolute(entry.path) || relative(root, resolve(root, entry.path)).startsWith('..')) throw new Error('Manifest path escapes evidence root');
    const bytes = await readFile(resolve(root, entry.path));
    validateSchema(entry.schema === 'source' ? bytes.toString() : JSON.parse(bytes), entry.schema, entry.acceptance);
    if (entry.schema === 'retained-evidence') {
      const value = JSON.parse(bytes);
      const scenarios = value.scenario ? [value.scenario] : (value.evidence || value.scenarios || []).map(record => record.scenario);
      if (entry.expectedScenario && !scenarios.includes(entry.expectedScenario)) throw new Error('Selected evidence scenario mismatch');
      if (entry.expectedBinding && JSON.stringify(value.binding) !== JSON.stringify(entry.expectedBinding)) throw new Error('Selected evidence binding mismatch');
    }
    records.push({ path: entry.path, schema: entry.schema, acceptance: entry.acceptance, bytes: bytes.length, sha256: digest(bytes) });
  }
  return records;
}
async function main() {
  const [operation, root] = process.argv.slice(2);
  if (!root) throw new Error('Missing evidence root');
  if (operation === 'inventory') {
    const records = await inspectEvidence(root);
    const result = { kind: 'evidence-inventory', observedAt: new Date().toISOString(), records };
    await writeFile(resolve(root, 'inventory.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ artifact: 'inventory.json', checkedFiles: records.length }));
  } else if (operation === 'validate-inventory') {
    const inventory = JSON.parse(await readFile(resolve(root, 'inventory.json'), 'utf8'));
    const current = await inspectEvidence(root);
    if (inventory.kind !== 'evidence-inventory' || JSON.stringify(inventory.records) !== JSON.stringify(current)) throw new Error('Inventory differs from actual retained artifacts');
    const result = { kind: 'evidence-inventory-validation', observedAt: new Date().toISOString(), valid: true, checkedFiles: current.length, schemas: [...new Set(current.map(record => record.schema))], inventorySha256: digest(await readFile(resolve(root, 'inventory.json'))), nativeHostProof: false };
    await writeFile(resolve(root, 'inventory-validation.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ artifact: 'inventory-validation.json', checkedFiles: current.length }));
  } else throw new Error('Only fixed inventory and validate-inventory operations are permitted');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
