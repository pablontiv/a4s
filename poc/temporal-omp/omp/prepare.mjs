import { Database } from 'bun:sqlite';
import { mkdirSync, copyFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const root = import.meta.dir;
const runtime = join(root, '.runtime');
mkdirSync(runtime, { recursive: true, mode: 0o700 });
for (const name of ['config.yml', 'models.yml']) {
  const source = join(process.env.HOME, '.omp/agent', name);
  if (existsSync(source)) { copyFileSync(source, join(runtime, name)); chmodSync(join(runtime, name), 0o600); }
}
const db = new Database(join(process.env.HOME, '.omp/agent/agent.db'), { readonly: true });
writeFileSync(join(runtime, 'agent.db'), db.serialize(), { mode: 0o600 });
db.close();
const require = createRequire(join(root, '../objective/package.json'));
const { bundleWorkflowCode } = require('@temporalio/worker');
const bundle = await bundleWorkflowCode({ workflowsPath: join(root, 'workflow.ts'), webpackConfigHook: config => { config.resolve.modules.push(join(root, '../objective/node_modules')); return config; } });
writeFileSync(join(root, 'workflow-bundle.js'), bundle.code);
console.log('Prepared private isolated configuration snapshot and prebuilt workflow bundle; credential contents not printed.');
