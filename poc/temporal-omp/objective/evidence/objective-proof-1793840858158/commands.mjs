import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function validateSchema(value, schema) {
  if (schema === 'objective-input') {
    if (!value.mandateId || !Array.isArray(value.items) || value.items.length !== 3 || !value.items.every(item => item.id && Array.isArray(item.dependencies))) throw new Error('Invalid retained objective input');
  } else if (schema === 'admission') {
    if (value.admissions !== 1 || !value.workflowId || !value.admittedAt || value.nativeHostProof !== false || value.executionKind !== 'bootstrap_command_activity') throw new Error('Invalid admission evidence');
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
    validateSchema(entry.schema === 'source' ? bytes.toString() : JSON.parse(bytes), entry.schema);
    records.push({ path: entry.path, schema: entry.schema, bytes: bytes.length, sha256: digest(bytes) });
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
