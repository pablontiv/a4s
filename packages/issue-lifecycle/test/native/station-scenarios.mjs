import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { fixtureEnvironment, sha256, writeEvidence } from './station-acceptance.mjs';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const quote = text => `'${String(text).replaceAll("'", "'\\''")}'`;
function command(c, name, binary, args, options = {}) {
  const result = spawnSync(binary, args, { cwd: c.primary ?? repository, env: c.env ?? process.env, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, ...options });
  const evidence = writeEvidence(c.out, `${name}.json`, { binary, args, status: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr });
  if (!options.allowFailure) assert.equal(result.status, 0, `${name}: ${result.error?.message ?? ''}\n${result.stderr}\n${result.stdout}`);
  return { ...result, evidence };
}
async function freePort() {
  const server = createServer();
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  const port = server.address().port;
  await new Promise((yes, no) => server.close(error => error ? no(error) : yes()));
  return port;
}
async function waitUntil(body, description, timeout = 60000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    try { const value = await body(); if (value) return value; } catch (error) { last = error; }
    await delay(200);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}: ${String(last ?? '')}`);
}
function background(c, name, binary, args, options = {}) {
  const path = join(c.out, `${name}.log`); mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'wx', 0o600);
  const child = spawn(binary, args, { cwd: c.primary ?? repository, env: c.env, stdio: ['ignore', fd, fd], ...options });
  closeSync(fd);
  const completion = new Promise((yes, no) => { child.once('error', no); child.once('exit', (code, signal) => yes({ code, signal })); });
  // A process that fails before its readiness probe must not create an unhandled rejection.
  completion.catch(() => {});
  c.children.push({ child, completion });
  return { child, completion, evidence: `${name}.log` };
}
async function stopChildren(c) {
  for (const { child } of c.children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await Promise.all(c.children.map(async ({ child, completion }) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await completion; } finally { clearTimeout(timer); }
  }));
}
function preserve(c) {
  for (const [source, destination] of [[join(c.home, 'logs'), 'dagu-logs'], [join(c.home, 'data'), 'dagu-data'], [join(c.primary ?? c.root, '.git/dagu-feature'), 'consumer-evidence']]) {
    if (existsSync(source)) cpSync(source, join(c.out, destination), { recursive: true, dereference: false });
  }
}
function state(c) { return json(join(c.home, 'cache/a4s/state.json')); }
function inventory(c, names) {
  writeFileSync(join(c.releases, 'fixture.json'), JSON.stringify({ repository: 'pablontiv/a4s', moving: {}, releases: names.map(name => ({ tag_name: `a4s-${c.fixtures[name].version}`, commit: c.commit })) }));
}
function promote(c, fixture, evidence) {
  inventory(c, [fixture]);
  const report = command(c, `${fixture}/promote`, c.launcher, ['station', 'promote']);
  assert.equal(JSON.parse(report.stdout).current.version, c.fixtures[fixture].version);
  evidence.push(report.evidence);
}
function rollback(c, evidence, label) {
  const report = command(c, `${label}/rollback`, c.launcher, ['rollback']);
  assert.equal(JSON.parse(report.stdout).current.version, c.identities.a);
  evidence.push(report.evidence);
}
function receiptPath(c, run) { return join(c.primary, '.git/dagu-feature/runs', run, 'receipt.json'); }
function receiptBytes(c, run) {
  const receipt = receiptPath(c, run);
  const snapshot = join(dirname(receipt), 'snapshot/feature.yaml');
  return { receipt: sha256(readFileSync(receipt)), snapshot: sha256(readFileSync(snapshot)) };
}
function admit(c, run, evidence, options = {}) {
  const result = command(c, `${run}/admit`, c.launcher, ['admit', '--run-id', run, 'feature', '--', 'ISSUE=821', `OMP_SESSION_ID=${options.owner ?? 'cutover-owner'}`], { allowFailure: options.allowFailure });
  evidence.push(result.evidence);
  return result;
}
async function status(c, dag, run, wanted) {
  return waitUntil(async () => {
    const response = await fetch(`${c.env.DAGU_URL}/api/v1/dag-runs/${encodeURIComponent(dag)}/${encodeURIComponent(run)}`);
    if (!response.ok) return false;
    const value = await response.json();
    return wanted.includes(value.dagRunDetails?.statusLabel?.toLowerCase()) ? value.dagRunDetails : false;
  }, `${dag}/${run} ${wanted.join('|')}`, 240000);
}
async function selectionProbes(c, label, expected, evidence) {
  const directory = join(c.out, 'r2', label); mkdirSync(directory, { recursive: true });
  const script = join(directory, 'selection.mjs'), result = join(directory, 'selection.json');
  writeFileSync(script, `import {writeFileSync} from 'node:fs';\nimport {stationSelection,leaseSelection} from ${JSON.stringify(join(c.source, 'packages/loader/src/station.ts'))};\nimport {selectPayload} from ${JSON.stringify(join(c.source, 'packages/launcher/src/select.ts'))};\nconst home=process.env.DAGU_HOME;\nconst plugin=await stationSelection(home),lease=await leaseSelection(home,plugin);\nconst tick=await selectPayload(home,['tick']);\nwriteFileSync(${JSON.stringify(result)},JSON.stringify({plugin:plugin.state.current,tick:tick.cached.record}));lease.release();\n`);
  const run = `cutover-${c.phase}-r2-${label}`;
  const dag = join(directory, 'probe.yaml');
  writeFileSync(dag, `name: reconcile\nsteps:\n  - id: select\n    command: ${JSON.stringify(`${quote(process.execPath)} --import ${quote(import.meta.resolve('tsx'))} ${quote(script)}`)}\n`);
  evidence.push(command(c, `r2/${label}/enqueue`, c.dagu, ['enqueue', '--run-id', run, dag]).evidence);
  await status(c, 'reconcile', run, ['succeeded']);
  const selected = json(result);
  assert.equal(selected.plugin.version, expected); assert.equal(selected.tick.version, expected);
  evidence.push(`r2/${label}/selection.json`);
}
async function serviceHost(c, label, binary, args) {
  const directory = join(c.out, label);
  const script = join(directory, 'service-host.sh'), pidFile = join(directory, 'host.pid'), exitFile = join(directory, 'host.exit');
  writeFileSync(script, `#!/bin/bash\ncd ${quote(c.primary)} || exit 1\nfor key in \${!DAGU_@} \${!DAG_@}; do unset "$key"; done\nunset RUN PRIMARY A4S_BIN A4S_ARTIFACT OMP_SESSION_ID\nexport DAGU_HOME=${quote(c.home)} A4S_PRIMARY=${quote(c.primary)}\n${[binary, ...args].map(quote).join(' ')} >${quote(join(directory, 'host.log'))} 2>&1 &\nhost=$!\necho "$host" >${quote(pidFile)}\nwait "$host"\ncode=$?\necho "$code" >${quote(exitFile)}\nexit "$code"\n`);
  const run = `${c.probeRun}-${label.split('/').at(-1)}`;
  const dag = join(directory, 'probe.yaml');
  writeFileSync(dag, `name: ${run}\nsteps:\n  - id: native\n    command: bash ${JSON.stringify(script)}\n`);
  command({ ...c, env: process.env }, `${label}/enqueue`, c.dagu, ['enqueue', '--run-id', run, dag]);
  const pid = await waitUntil(() => existsSync(pidFile) && Number(readFileSync(pidFile, 'utf8')), 'station native host PID');
  const child = { pid, get exitCode() { return existsSync(exitFile) ? Number(readFileSync(exitFile, 'utf8')) : null; }, signalCode: null, kill: signal => { try { process.kill(pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } } };
  const completion = waitUntil(() => existsSync(exitFile) && { code: Number(readFileSync(exitFile, 'utf8')), signal: null }, 'station native host completion', 240000);
  completion.catch(() => {});
  c.children.push({ child, completion });
  return { child, completion, evidence: `${label}/host.log` };
}

async function serviceProbe(c) {
  // Execute the probe on the station scheduler, not in this invoking shell. It
  // writes only to the explicitly supplied evidence directory and promotes nothing.
  // Station run IDs are permanent; a per-attempt suffix lets the phase be retried.
  // Dagu DAG names must stay under 40 characters, including the host label suffix.
  c.probeRun = `${c.phase}-sb-${Date.now().toString(36)}`;
  const run = c.probeRun;
  const probe = join(c.out, 'service-probe.yaml');
  const script = join(c.out, 'service-probe.mjs');
  writeFileSync(script, `import {writeFileSync,realpathSync,readFileSync} from 'node:fs';\nimport {execFileSync} from 'node:child_process';\nimport {createHash} from 'node:crypto';\nconst locate=n=>execFileSync('sh',['-c','command -v "$1"','probe',n],{encoding:'utf8'}).trim();\nconst binary=realpathSync(locate('omp')),dagu=realpathSync(locate('dagu'));\nwriteFileSync(${JSON.stringify(join(c.out, 'service-environment.json'))},JSON.stringify({binary,dagu,path:process.env.PATH,home:process.env.HOME,agentDir:process.env.PI_CODING_AGENT_DIR,version:execFileSync(binary,['--version'],{encoding:'utf8'}).trim(),digest:createHash('sha256').update(readFileSync(binary)).digest('hex')}),{mode:0o600});\n`);
  writeFileSync(probe, `name: ${run}\nsteps:\n  - id: inspect\n    command: node ${JSON.stringify(script)}\n`);
  command({ ...c, env: process.env }, 'service-probe/enqueue', 'dagu', ['enqueue', '--run-id', run, probe]);
  const selected = await waitUntil(() => existsSync(join(c.out, 'service-environment.json')) && json(join(c.out, 'service-environment.json')), 'station service environment');
  c.service = selected;
  c.dagu = selected.dagu;
  c.omp = selected.binary;
}

async function buildFixtures(c) {
  c.commit = c.station.current.commit;
  c.source = join(c.root, 'source');
  command(c, 'build/clone', 'git', ['clone', '--no-hardlinks', '--no-checkout', repository, c.source]);
  command(c, 'build/checkout', 'git', ['-C', c.source, 'checkout', '--detach', c.commit]);
  symlinkSync(join(repository, 'node_modules'), join(c.source, 'node_modules'), 'dir');
  c.releases = join(c.root, 'releases'); mkdirSync(c.releases);
  c.fixtures = {};
  const paths = { skill: join(c.source, 'packages/issue-lifecycle/skills/issue-execution/SKILL.md'), agent: join(c.source, 'packages/issue-lifecycle/agents/triage-reviewer.md'), reviewer: join(c.source, 'packages/issue-lifecycle/agents/plan-reviewer.md'), cli: join(c.source, 'packages/issue-lifecycle/src/cli.ts') };
  const original = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, readFileSync(path, 'utf8')]));
  const target = process.platform === 'darwin' && process.arch === 'arm64' ? 'darwin-arm64' : process.platform === 'linux' && process.arch === 'x64' ? 'linux-x64' : undefined;
  assert.ok(target, 'Unsupported native build platform');
  for (const [name, version] of Object.entries(c.identities)) {
    const sentinel = name === 'a' ? 'A' : name;
    for (const [key, path] of Object.entries(paths)) writeFileSync(path, original[key]);
    // Preserve declarations, routing and strict schemas; only instructions change.
    const agentSentinel = name === 'skillsOnly' ? 'A' : sentinel;
    for (const key of ['agent', 'reviewer']) writeFileSync(paths[key], `${original[key]}\nNative acceptance sentinel: ${agentSentinel}. When the scratch assignment asks for a sentinel, return exactly ${agentSentinel} in its sentinel field. For the isolated native acceptance fixture issue, answer poc=no, with this sentinel in the reason; all operations are local, already demonstrated mechanisms and require no feasibility experiment.\n`);
    writeFileSync(paths.skill, `${original.skill}\nNative acceptance skill sentinel: ${name === 'agentOnly' ? 'skillsOnly' : sentinel}.\n`);
    // Insert after any shebang: a shebang is only valid on the first line.
    if (name === 'nonStarting') writeFileSync(paths.cli, original.cli.replace(/^(#![^\n]*\n)?/, shebang => `${shebang}if (typeof A4S_COMPILED !== 'undefined' && A4S_COMPILED && process.argv[2] !== 'version') throw new Error('Native acceptance non-starting fixture');\n`));
    const patch = command(c, `build/${name}/patch`, 'git', ['-C', c.source, 'diff', '--', 'packages/issue-lifecycle']).stdout;
    const patchPath = join(c.out, `build/${name}/fixture.patch`); writeFileSync(patchPath, patch);
    command(c, `build/${name}/compile`, process.execPath, ['scripts/build-a4s.mjs', '--target', `bun-${target}`, '--outdir', c.releases, '--test-version', version, '--test-commit', c.commit], { cwd: c.source, env: { ...c.env, A4S_LIVE_DAGU: '1' } });
    const archive = `a4s-${version}-${target}.tar.gz`;
    const digest = sha256(readFileSync(join(c.releases, archive)));
    const directory = join(c.home, 'cache/a4s', version); mkdirSync(directory, { recursive: true });
    command(c, `build/${name}/extract`, 'tar', ['-xzf', join(c.releases, archive), '-C', directory]);
    const tuple = { version, commit: c.commit, digest };
    copyFileSync(join(c.releases, archive), join(directory, 'verified-archive.tar.gz'));
    writeFileSync(join(directory, 'artifact.json'), JSON.stringify({ ...tuple, verifiedAt: new Date().toISOString() }));
    c.fixtures[name] = { ...tuple, directory, sourceCommit: c.commit, patch: `build/${name}/fixture.patch`, patchSha256: sha256(patch), archiveSha256: digest };
  }
  writeEvidence(c.out, 'fixtures.json', { schema: 1, phase: c.phase, sourceCommit: c.commit, fixtures: c.fixtures });
  command(c, 'build/launcher/compile', process.execPath, ['scripts/build-launcher.mjs', '--target', `bun-${target}`, '--outdir', c.releases], { cwd: c.source });
  c.launcher = join(c.releases, `a4s-launch-${target}`);
  // Build output naming is independent of payload IDs.
  if (!existsSync(c.launcher)) {
    const archive = join(c.releases, `a4s-launch-${target}.tar.gz`);
    const installation = join(c.root, 'launcher'); mkdirSync(installation);
    command(c, 'build/launcher/extract', 'tar', ['-xzf', archive, '-C', installation]);
    c.launcher = join(installation, 'a4s-launch');
  }
}

export const nativeExecutor = {
  async prepare(c) {
    c.children = [];
    // Return cleanup ownership even when preparation fails.
    try {
      await serviceProbe(c);
      mkdirSync(c.home, { recursive: true });
      c.env = fixtureEnvironment(c.service, c.home, process.env, await freePort());
      await buildFixtures(c);
      const bin = join(c.root, 'bin'); mkdirSync(bin);
      const releaseGh = join(bin, 'release-gh.mjs');
      copyFileSync(join(repository, 'packages/issue-lifecycle/test/fixtures/release-gh.mjs'), releaseGh);
      writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node\nimport {appendFileSync} from 'node:fs';\nimport {spawnSync} from 'node:child_process';\nconst args=process.argv.slice(2);\nif(args[0]==='repo'&&args[1]==='view') console.log(args.includes('--jq')?'fixture/native-cutover':JSON.stringify({nameWithOwner:'fixture/native-cutover',defaultBranchRef:{name:'main'}}));\nelse if(args[0]==='issue'&&args[1]==='view') console.log(JSON.stringify({number:821,title:'Isolated native acceptance fixture',body:'Read-only triage of a scratch local fixture. No implementation or remote effects are requested. The launcher, loader and runner mechanisms are already demonstrated; no feasibility experiment is required.',state:'OPEN',comments:[]}));\nelse if(args[0]==='issue'&&args[1]==='comment') appendFileSync(${JSON.stringify(join(c.out, 'fixture-comments.jsonl'))},JSON.stringify(args)+'\\n');\nelse if(args[0]==='api'||args[0]==='release'){const child=spawnSync(process.execPath,[${JSON.stringify(releaseGh)},...args],{stdio:'inherit'});process.exit(child.status??1);}\nelse throw new Error('Unauthorized fixture GitHub operation: '+JSON.stringify(args));\n`, { mode: 0o755 });
      c.env.PATH = `${bin}:${c.service.path}`; c.env.A4S_FIXTURE_RELEASES = c.releases;
      c.primary = join(c.root, 'primary');
      command(c, 'consumer/init', 'git', ['init', '-b', 'main', c.primary], { cwd: c.root });
      c.env.A4S_PRIMARY = c.primary;
      command(c, 'consumer/name', 'git', ['config', 'user.name', 'Native station acceptance']);
      command(c, 'consumer/email', 'git', ['config', 'user.email', 'native@example.invalid']);
      // Use the delivered default consumer policy, with all effects constrained
      // to the fixture primary and a deliberately effect-free gate.
      const policyScript = `import {exampleConfig} from ${JSON.stringify(join(c.source, 'packages/launcher/src/config.ts'))}; console.log(JSON.stringify(exampleConfig({lane:'cutover',gate:'true',baseBranch:'main'})));`;
      const config = JSON.parse(command(c, 'consumer/policy', process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', policyScript]).stdout);
      mkdirSync(join(c.primary, '.workspace/dagu'), { recursive: true });
      writeFileSync(join(c.primary, '.workspace/dagu/config.json'), JSON.stringify(config));
      mkdirSync(join(c.primary, '.omp'), { recursive: true });
      copyFileSync(join(repository, '.omp/config.yml'), join(c.primary, '.omp/config.yml'));
      command(c, 'consumer/add', 'git', ['add', '.']); command(c, 'consumer/commit', 'git', ['commit', '-qm', 'native acceptance policy']);
      const remote = join(c.root, 'origin.git');
      command(c, 'consumer/remote-init', 'git', ['init', '--bare', '-b', 'main', remote]);
      command(c, 'consumer/remote', 'git', ['remote', 'add', 'origin', remote]);
      command(c, 'consumer/push', 'git', ['push', '-u', 'origin', 'main']);
      // This deliberate local dirt routes the delivered feature to its safe
      // start_primary_unavailable checkpoint, before implementation/worktree creation.
      writeFileSync(join(c.primary, 'native-acceptance-hold'), 'Hold all fixture feature runs before implementation.\n');
      writeFileSync(join(c.home, 'a4s-primary'), `${c.primary}\n`);
      mkdirSync(join(c.home, 'primaries')); writeFileSync(join(c.home, 'primaries/cutover'), `${c.primary}\n`);
      const initial = { ...c.station, generation: 0, current: { version: c.fixtures.a.version, commit: c.commit, digest: c.fixtures.a.digest }, previous: { version: c.fixtures.a.version, commit: c.commit, digest: c.fixtures.a.digest }, rejected: [] };
      writeFileSync(join(c.home, 'cache/a4s/state.json'), JSON.stringify(initial));
      writeFileSync(join(c.home, 'config.yaml'), `host: 127.0.0.1\nport: ${c.env.DAGU_PORT}\nauth:\n  mode: none\ncoordinator:\n  enabled: true\n  host: 127.0.0.1\n  port: ${await freePort()}\nscheduler:\n  port: ${await freePort()}\nqueues:\n  enabled: true\n  config:\n    - name: cutover\n      max_concurrency: 4\n`);
      background(c, 'dagu', c.dagu, ['start-all']);
      await waitUntil(async () => (await fetch(`${c.env.DAGU_URL}/api/v1/queues`)).ok, 'isolated Dagu');
      inventory(c, []);
      return async () => { await stopChildren(c); preserve(c); };
    } catch (error) { await stopChildren(c); preserve(c); throw error; }
  },
  async r2(c, evidence) {
    const run = `cutover-${c.phase}-r2`;
    admit(c, run, evidence);
    await status(c, 'feature', run, ['waiting']);
    const before = receiptBytes(c, run);
    assert.equal(json(receiptPath(c, run)).artifact.version, c.identities.a);
    await selectionProbes(c, 'initial', c.identities.a, evidence);
    for (const fixture of ['b', 'nonStarting']) {
      promote(c, fixture, evidence);
      assert.deepEqual(receiptBytes(c, run), before);
      await selectionProbes(c, `${fixture}-current`, c.fixtures[fixture].version, evidence);
      const selected = command(c, `${fixture}/selected`, c.launcher, [fixture === 'nonStarting' ? 'queue' : 'version'], { allowFailure: fixture === 'nonStarting' });
      if (fixture === 'nonStarting') { assert.notEqual(selected.status, 0); assert.match(selected.stderr, /Native acceptance non-starting fixture/); }
      else assert.equal(JSON.parse(selected.stdout).version, c.identities.b);
      evidence.push(selected.evidence);
      // A broken selected payload must not be required for rollback.
      rollback(c, evidence, fixture);
      assert.deepEqual(receiptBytes(c, run), before);
      await selectionProbes(c, `${fixture}-rolled-back`, c.identities.a, evidence);
    }
    evidence.push(writeEvidence(c.out, 'r2/immutable.json', { run, before, after: receiptBytes(c, run), state: state(c) }));
    evidence.push(command(c, 'r2/cancel', c.dagu, ['human-task', 'complete', 'feature', '--run-id', run, '--step', 'start_primary_unavailable', '--input', 'CANCEL=yes']).evidence);
    await status(c, 'feature', run, ['failed', 'aborted']);
  },
  async r4(c, evidence) {
    const run = `cutover-${c.phase}-r4`;
    admit(c, run, evidence);
    await status(c, 'feature', run, ['waiting']);
    const old = receiptBytes(c, run);
    const unsafe = `${run}-unsafe`;
    admit(c, unsafe, evidence, { allowFailure: true, owner: 'cutover-intruder' });
    const refusal = await status(c, 'feature', unsafe, ['failed']);
    assert.deepEqual(receiptBytes(c, run), old);
    evidence.push(writeEvidence(c.out, 'r4/unsafe-transfer.json', refusal));
    evidence.push(command(c, 'r4/cancel', c.dagu, ['human-task', 'complete', 'feature', '--run-id', run, '--step', 'start_primary_unavailable', '--input', 'CANCEL=yes']).evidence);
    const terminal = await status(c, 'feature', run, ['failed', 'aborted']);
    const replacement = `${run}-readmitted`;
    admit(c, replacement, evidence);
    await status(c, 'feature', replacement, ['waiting']);
    assert.deepEqual(receiptBytes(c, run), old);
    const owners = readFileSync(join(c.primary, '.git/dagu-feature/owners/issue-821'), 'utf8');
    assert.ok(owners.startsWith(`${replacement}\t`), 'Terminal ownership was not transferred to replacement');
    evidence.push(command(c, 'r4/replacement-cancel', c.dagu, ['human-task', 'complete', 'feature', '--run-id', replacement, '--step', 'start_primary_unavailable', '--input', 'CANCEL=yes']).evidence);
    await status(c, 'feature', replacement, ['failed', 'aborted']);
    evidence.push(writeEvidence(c.out, 'r4/result.json', { terminal, owners, before: old, after: receiptBytes(c, run) }));
  },
  async r9(c, evidence) {
    const run = `cutover-${c.phase}-r9`;
    const cached = c.fixtures.a.directory;
    admit(c, run, evidence);
    await status(c, 'feature', run, ['waiting']);
    const planning = `${run}-planning`;
    const units = join(c.out, 'r9/units.jsonl'); mkdirSync(dirname(units), { recursive: true }); writeFileSync(units, '');
    evidence.push(command(c, 'r9/planning-admit', c.launcher, ['admit', '--run-id', planning, 'planning', '--', `UNITS_FROM=${units}`, 'OMP_SESSION_ID=cutover-owner']).evidence);
    const planningReceipt = json(receiptPath(c, planning)), featureReceipt = json(receiptPath(c, run));
    assert.equal(planningReceipt.artifact.version, c.identities.a); assert.equal(featureReceipt.artifact.version, c.identities.a);
    const observer = join(c.out, 'r9/observer.ts'), spawns = join(c.out, 'r9/spawns.jsonl');
    writeFileSync(observer, `import {appendFileSync} from 'node:fs';export default function(pi){pi.on('before_subagent_spawn',(event)=>appendFileSync(${JSON.stringify(spawns)},JSON.stringify(event)+'\\n'));}\n`);
    promote(c, 'skillsOnly', evidence);
    assert.match(readFileSync(join(c.fixtures.skillsOnly.directory, 'skills/issue-execution/SKILL.md'), 'utf8'), /skill sentinel: skillsOnly/);
    promote(c, 'agentOnly', evidence);
    assert.match(readFileSync(join(c.fixtures.agentOnly.directory, 'agents/triage-reviewer.md'), 'utf8'), /sentinel: agentOnly/);
    // `omp --session` only resumes an existing transcript; a fresh session directory
    // records the new planning review, retained below as r9/planning.jsonl.
    const reviewSessions = join(c.out, 'r9/planning-session');
    mkdirSync(reviewSessions, { recursive: true });
    const prompt = 'This is a scratch native acceptance assignment for an older planning run. Invoke task with agent plan-reviewer (no model override), asking it to put SENTINEL=<its native acceptance sentinel> in its normal structured review strings. Do not read any files or use other tools. Report the result verbatim.';
    const review = command(c, 'r9/planning', c.omp, ['-p', '--no-extensions', '-e', cached, '-e', observer, '--session-dir', reviewSessions, prompt], { timeout: 240000 });
    const reviewTranscripts = readdirSync(reviewSessions, { recursive: true }).filter(name => String(name).endsWith('.jsonl'));
    assert.ok(reviewTranscripts.length > 0, 'r9 planning review must record a session transcript');
    copyFileSync(join(reviewSessions, String(reviewTranscripts.sort()[0])), join(c.out, 'r9/planning.jsonl'));
    assert.match(review.stdout, /SENTINEL=A\b/);
    assert.doesNotMatch(review.stdout, /SENTINEL=agentOnly/);
    const spawnEvents = readFileSync(spawns, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(spawnEvents.some(event => event.agent === 'plan-reviewer' && event.modelRole === 'slow'));
    evidence.push('r9/spawns.jsonl');
    evidence.push(review.evidence, 'r9/planning.jsonl');
    const result = await runNative(c, 'r9/triage', { agent: join(cached, 'agents/triage-reviewer.md'), run });
    assert.equal(result.output.sentinel, 'A');
    evidence.push(...result.evidence);
  },
  async 'selected-binary'(c, evidence) {
    evidence.push('service-probe/enqueue.json', 'service-environment.json');
    const before = readFileSync(join(c.realHome, 'cache/a4s/state.json'));
    for (const [name, flags] of [['default', {}], ['no-extensions', { noExtensions: true }], ['explicit-plugin', { noExtensions: true, plugin: true }]]) {
      const result = await runNative(c, `selected-binary/${name}`, { ...flags, agent: join(c.fixtures.a.directory, 'agents/triage-reviewer.md'), run: `cutover-${c.phase}-selected-binary` });
      assert.equal(result.output.sentinel, 'A'); evidence.push(...result.evidence);
    }
    const cancelled = await runNative(c, 'selected-binary/cancel', { cancel: true, agent: join(c.fixtures.a.directory, 'agents/triage-reviewer.md'), run: `cutover-${c.phase}-selected-binary` });
    evidence.push(...cancelled.evidence);
    assert.ok(before.equals(readFileSync(join(c.realHome, 'cache/a4s/state.json'))));
  },
};

async function runNative(c, label, options) {
  const directory = join(c.out, label); mkdirSync(directory, { recursive: true });
  const id = createHash('sha256').update(`${c.phase}/${label}`).digest('hex');
  const binding = { repo: c.primary, worktree: c.primary, lane: 'cutover', dag: 'feature', run: options.run, stage: 'triage', role: 'triage', sha: c.commit, iteration: 0, attempt: 'scratch-native-acceptance' };
  const assignment = options.cancel ? 'Scratch native cancellation acceptance: wait 60 seconds before yielding {sentinel: "A"}.' : 'Scratch native acceptance only. Do not read files or run tools. Yield {sentinel: "<your native acceptance sentinel>"} using the strict caller schema.';
  const input = { mode: 'run', cwd: c.primary, agentFile: options.agent, runtime: { binary: c.omp, version: c.service.version, digest: c.service.digest }, job: { id, directory, binding }, assignment, outputSchema: { type: 'object', properties: { sentinel: { type: 'string' } }, required: ['sentinel'], additionalProperties: false } };
  writeFileSync(join(directory, 'runner-input.json'), JSON.stringify(input));
  writeFileSync(join(directory, 'assignment.json'), JSON.stringify({ assignment, outputSchema: input.outputSchema }));
  writeFileSync(join(directory, 'binding.json'), JSON.stringify(binding));
  const observer = join(directory, 'observer.ts');
  // Register an unreachable host route. Native role routing remains the station's
  // configured @slow route; any accidental hosting turn fails closed.
  writeFileSync(observer, `import {appendFileSync} from 'node:fs';\nexport default function(pi){pi.registerProvider('cutover-unroutable',{baseUrl:'http://127.0.0.1:1',api:'openai-completions',apiKey:'unreachable',models:[{id:'hosting-model',name:'Unreachable host',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:8192,maxTokens:1024}]});pi.on('before_provider_request',(_request,ctx)=>{if(ctx.model?.provider==='cutover-unroutable'){appendFileSync(${JSON.stringify(join(directory, 'host-requests.jsonl'))},JSON.stringify({event:'before_provider_request'})+'\\n');throw new Error('Hosting request forbidden');}});}\n`);
  const args = ['-p', '--no-session', '--model', 'cutover-unroutable/hosting-model', ...(options.noExtensions ? ['--no-extensions'] : []), ...(options.plugin ? ['-e', c.fixtures.a.directory] : []), '-e', observer, '-e', join(c.fixtures.a.directory, 'role-runner.ts'), directory];
  const launched = label.startsWith('selected-binary/') ? await serviceHost(c, label, c.omp, args) : background(c, `${label}/host`, c.omp, args);
  let result;
  if (options.cancel) {
    await waitUntil(() => existsSync(join(directory, `${id}.jsonl`)), 'native child transcript');
    const processes = command(c, `${label}/processes`, 'ps', ['-eo', 'pid=,ppid=,args=']).stdout.trim().split('\n').map(line => {
      const [, pid, parent, args] = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/) ?? [];
      return { pid: Number(pid), parent: Number(parent), args };
    });
    // OMP runs native subagents inside the host process; the child transcript above
    // proves the native child session is live. Record any out-of-process descendants too.
    const descendants = new Set([launched.child.pid]);
    for (let i = 0; i < processes.length; i++) for (const row of processes) if (descendants.has(row.parent)) descendants.add(row.pid);
    launched.child.kill('SIGTERM');
    result = await launched.completion;
    assert.ok(result.code === 143 || result.signal === 'SIGTERM', JSON.stringify(result));
    assert.throws(() => process.kill(launched.child.pid, 0), /ESRCH/);
    await waitUntil(() => [...descendants].every(pid => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } }), 'all cancelled native descendants to exit');
    writeEvidence(c.out, `${label}/cancelled-processes.json`, [...descendants]);
    const transcript = join(directory, `${id}.jsonl`), settled = statSync(transcript).size;
    await delay(2000);
    assert.equal(statSync(transcript).size, settled, 'Cancelled native child must stop writing its transcript');
  } else {
    const timer = setTimeout(() => launched.child.kill('SIGTERM'), 180000);
    try { result = await launched.completion; } finally { clearTimeout(timer); }
    assert.equal(result.code, 0, readFileSync(join(directory, 'host.log'), 'utf8'));
  }
  assert.equal(existsSync(join(directory, 'host-requests.jsonl')), false, 'Hosting session made a provider request');
  const evidence = [`${label}/assignment.json`, `${label}/binding.json`, `${label}/runner-input.json`, launched.evidence];
  if (options.cancel) evidence.push(`${label}/${id}.jsonl`, `${label}/processes.json`, `${label}/cancelled-processes.json`);
  let output;
  if (!options.cancel) {
    const native = json(join(directory, 'native-result.json'));
    assert.equal(native.exitCode, 0, native.error);
    output = typeof native.output === 'string' ? JSON.parse(native.output) : native.output;
    const routing = json(join(directory, 'routing.json'));
    assert.equal(routing.agent.source, options.agent);
    assert.equal(routing.runtime.binary, c.omp);
    assert.ok(existsSync(join(directory, `${id}.jsonl`)), 'Native transcript must be retained');
    evidence.push(`${label}/native-result.json`, `${label}/routing.json`, `${label}/${id}.jsonl`);
  }
  evidence.push(writeEvidence(c.out, `${label}/receipt.json`, { binary: c.service, args, result, hostRequests: 0, cancelled: !!options.cancel }));
  return { output, evidence };
}
