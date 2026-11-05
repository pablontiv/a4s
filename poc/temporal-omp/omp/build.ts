// SDK 1.25.0-specific bundling: fail closed when a rewritten lookup changes.
import { copyFileSync, mkdirSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const root = process.env.A4S_TEMPORAL_BUILD_ROOT || import.meta.dir;
const modules = realpathSync(join(root, '../objective/node_modules'));
const sdk = realpathSync(join(modules, '@temporalio/worker/lib'));
const bridge = realpathSync(join(modules, '@temporalio/core-bridge'));
const thread = join(sdk, 'workflow/workflow-worker-thread.js');
const outdir = join(root, 'dist');
const target = 'x86_64-unknown-linux-gnu';
const stub = `
exports.defaultWorkflowInterceptorModules = [];
exports.moduleMatches = (m, ms) => ms.some((x) => m === x || m.startsWith(x + '/'));
exports.bundleWorkflowCode = () => { throw new Error('Pass a prebuilt workflowBundle'); };
exports.WorkflowCodeBundler = class { constructor() { throw new Error('Pass a prebuilt workflowBundle'); } };
`;
const rewrites = [
  [join(sdk, 'workflow/threaded-vm.js'), "require.resolve('./workflow-worker-thread')", 'globalThis.__A4S_TEMPORAL_THREAD_ENTRY'],
  [join(bridge, 'common.js'), "path.resolve(__dirname, 'releases', getPrebuiltTargetName(), 'index.node')", "path.resolve(process.env.A4S_TEMPORAL_DIST, 'releases', getPrebuiltTargetName(), 'index.node')"],
  [realpathSync(join(modules, 'source-map/lib/read-wasm.js')), 'path.join(__dirname, "mappings.wasm")', 'path.join(process.env.A4S_TEMPORAL_DIST, "mappings.wasm")'],
];
const plugin: Bun.BunPlugin = {
  name: 'temporal-self-contained',
  setup(build) {
    build.onLoad({ filter: /workflow[\\/]bundler\.js$/ }, args =>
      args.path === join(sdk, 'workflow/bundler.js') ? { loader: 'js', contents: stub } : undefined);
    for (const [path, needle, replacement] of rewrites) {
      build.onLoad({ filter: /\.js$/ }, async args => {
        if (args.path !== path) return undefined;
        const source = await Bun.file(path).text();
        if (!source.includes(needle)) throw new Error(`SDK rewrite needle missing: ${path}`);
        return { loader: 'js', contents: source.replace(needle, replacement) };
      });
    }
  },
};
const result = await Bun.build({
  entrypoints: [join(root, 'extension.ts'), thread], outdir,
  naming: '[name].[ext]', target: 'bun', external: ['@oh-my-pi/*'], plugins: [plugin],
});
if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1); }
mkdirSync(join(outdir, 'releases', target), { recursive: true });
copyFileSync(join(root, 'workflow-bundle.js'), join(outdir, 'workflow-bundle.js'));
copyFileSync(join(modules, 'source-map/lib/mappings.wasm'), join(outdir, 'mappings.wasm'));
copyFileSync(join(bridge, 'releases', target, 'index.node'), join(outdir, 'releases', target, 'index.node'));
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const inputs = ['build.ts', 'runtime-paths.ts', 'extension.ts', 'workflow.ts', 'workflow-bundle.js', 'prepare.mjs', 'package.json', '../objective/package-lock.json'];
const sdkInputs = [thread, join(sdk, 'workflow/bundler.js'), ...rewrites.map(([path]) => path)];
const outputs = ['extension.js', 'workflow-worker-thread.js', 'workflow-bundle.js', 'mappings.wasm', `releases/${target}/index.node`];
writeFileSync(join(outdir, 'build-manifest.json'), JSON.stringify({
  bun: Bun.version, temporalSdk: JSON.parse(readFileSync(join(modules, '@temporalio/worker/package.json'), 'utf8')).version,
  inputSha256: Object.fromEntries(inputs.map(path => [path, hash(join(root, path))])),
  sdkInputSha256: Object.fromEntries(sdkInputs.map(path => [path.slice(modules.length + 1), hash(path)])),
  outputSha256: Object.fromEntries(outputs.map(path => [path, hash(join(outdir, path))])),
}, null, 2) + '\n');
for (const path of outputs) console.log(join(outdir, path));
