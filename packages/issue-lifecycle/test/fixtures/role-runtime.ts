import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Fake executable boundary only: runs the real release runner against fake host
 * modules, including the awaited factory and immediate main-session exit. */
export function roleRuntimeFixture(root: string, names = ["triage-reviewer", "task"]): string {
  const runtime = join(root, "runtime");
  mkdirSync(join(runtime, "src/config"), { recursive: true });
  mkdirSync(join(runtime, "src/task"), { recursive: true });
  writeFileSync(join(runtime, "package.json"), '{"type":"module"}\n');
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "omp"), `#!/bin/sh
if [ "$1" = --version ]; then printf 'omp/fixture\\n'; exit 0; fi
exec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(import.meta.resolve("tsx"))} --import ${JSON.stringify(join(runtime, "register.mjs"))} ${JSON.stringify(join(runtime, "host.mjs"))} "$@"
`, { mode: 0o755 });
  writeFileSync(join(runtime, "register.mjs"), `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(join(runtime, "loader.mjs")).href)});\n`);
  writeFileSync(join(runtime, "loader.mjs"), `export async function resolve(id, context, next) {
if(id.startsWith('@oh-my-pi/pi-coding-agent/')) return {url:${JSON.stringify(pathToFileURL(join(runtime, "src/")).href)}+id.slice('@oh-my-pi/pi-coding-agent/'.length)+'.ts',shortCircuit:true};
return next(id,context);
}\n`);
  writeFileSync(join(runtime, "host.mjs"), `import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
assert.deepEqual(process.argv.slice(2,6), ['-p','--no-session','-e',process.argv[5]]);
assert.equal(Object.keys(process.env).some(n=>n==='DAGU_OUTPUT_FILE'||n==='DAG_RUN_LOG_FILE'||n.startsWith('DAG_RUN_STEP_')),false);
const runner=await import(pathToFileURL(process.argv[5]).href);
let start;
const pi={on(event,callback){assert.equal(event,'session_start');start=callback;}};
await runner.default(pi);
// A child-session rebind must not claim the work or register its own exit hook.
await runner.default({on(){throw Error('child rebind claimed work');}});
start({}, {agent:{kind:'subagent'}});
start({}, {agent:{kind:'main'}});
throw Error('host model turn was reached');
`);
  writeFileSync(join(runtime, "src/config/settings.ts"), "export const Settings={async loadReadOnly(){return {}}};\n");
  writeFileSync(join(runtime, "src/task/settings.ts"), "export const cfgTaskAgentModelOverrides={get(){return {}}};\n");
  writeFileSync(join(runtime, "src/config/model-resolver.ts"), "export function resolveAgentModelSelection(o){return {patterns:Array.isArray(o.agentModel)?o.agentModel:[o.agentModel||'fixture-model'],role:'fixture'}};\n");
  writeFileSync(join(runtime, "src/task/executor.ts"), "export async function runSubprocess(){throw Error('detect must not launch a native role')};\n");
  writeFileSync(join(runtime, "src/task/discovery.ts"), `export async function discoverAgents(cwd) { return {agents:${JSON.stringify(names)}.map(name=>({name,source:'fixture:'+cwd,model:['fixture-model'],systemPrompt:'fixture'}))}; }\n`);
  return runtime;
}
