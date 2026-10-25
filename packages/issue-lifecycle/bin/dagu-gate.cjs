#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { constants } = require('node:os');
const gateCache = require('./gate-cache.cjs');

const journal = process.env.A4S_GATE_JOURNAL;
function emit(event) {
  fs.appendFileSync(journal, JSON.stringify(event) + '\n');
}
function start(name, details = {}) {
  const id = randomUUID();
  emit({ id, name, ...details, startedAt: Date.now() });
  return id;
}
function end(id, code, signal) {
  emit({ id, endedAt: Date.now(), exitCode: code ?? 128 + (constants.signals[signal] ?? 0) });
}
const npmCli = process.argv[1] && /npm(?:-cli)?\.js$/.test(fs.realpathSync(process.argv[1]));

// npm's lifecycle shell is the workspace boundary, independent of its log format.
// A cache hit replaces that shell with a successful no-op. Misses and always-run
// checks keep the original child process, arguments, and exit status.
if (require.main !== module && journal && npmCli) {
  if (process.argv[2] === 'ci') {
    const id = start('install', { command: 'npm ci' });
    process.on('exit', code => end(id, code));
  }
  const childProcess = require('node:child_process');
  const original = childProcess.spawn;
  const settle = (id, plan, code, signal, settled) => {
    if (settled.done) return;
    settled.done = true;
    end(id, code, signal);
    if (!plan.key || plan.cache !== 'miss') return;
    if ((code ?? 1) === 0 && !signal) gateCache.storePass(plan.cacheDir, plan.record);
    else gateCache.forget(plan.cacheDir, plan.key);
  };
  childProcess.spawn = function (...args) {
    const options = args[2] ?? (Array.isArray(args[1]) ? {} : args[1]) ?? {};
    const event = options.env?.npm_lifecycle_event;
    const name = event === 'test' ? 'tests' : event === 'typecheck' ? 'typecheck' : undefined;
    if (!name) return Reflect.apply(original, this, args);
    const cwd = String(options.cwd ?? process.cwd());
    const workspace = path.relative(process.env.WORKTREE || '', cwd) || '.';
    let plan;
    try {
      plan = gateCache.plan({
        worktree: process.env.WORKTREE, primary: process.env.PRIMARY, cwd, task: name,
        script: options.env.npm_lifecycle_script, env: options.env,
      });
    } catch (error) {
      process.stderr.write(`gate-cache planner error: ${error.message}\n`);
      plan = { action: 'passthrough' };
    }
    if (plan.action === 'split') {
      const planFile = path.join(require('node:os').tmpdir(), `a4s-gate-${randomUUID()}.json`);
      fs.writeFileSync(planFile, `${JSON.stringify({ ...plan, journal })}\n`, { mode: 0o600 });
      const childEnv = { ...options.env, npm_lifecycle_event: '', A4S_GATE_JOURNAL: journal };
      let child;
      try {
        child = Reflect.apply(original, this, [process.execPath, [path.join(__dirname, 'gate-cache-run.cjs'), planFile], { ...options, env: childEnv }]);
      } catch (error) {
        fs.rmSync(planFile, { force: true });
        throw error;
      }
      const cleanup = () => fs.rmSync(planFile, { force: true });
      child.once('exit', cleanup);
      child.once('error', cleanup);
      return child;
    }
    const details = plan.action === 'observed' ? {
      cache: plan.cache, classification: plan.classification, reason: plan.reason,
      ...(plan.key ? { cacheKey: plan.key } : {}),
    } : {};
    const id = start(name, { workspace: plan.workspace || workspace, command: options.env.npm_lifecycle_script, ...details });
    const launch = plan.cache === 'hit'
      ? [process.execPath, ['-e', 'process.stderr.write("gate-cache hit " + (process.env.A4S_GATE_CACHE_HIT || "") + "\\n"); process.exit(0);'], {
        ...options,
        env: { ...options.env, npm_lifecycle_event: '', A4S_GATE_CACHE_HIT: `${plan.workspace} ${plan.task}` },
      }]
      : args;
    const settled = { done: false };
    try {
      const child = Reflect.apply(original, this, launch);
      child.once('exit', (code, signal) => settle(id, plan, code, signal, settled));
      child.once('error', () => settle(id, plan, 1, undefined, settled));
      return child;
    } catch (error) {
      settle(id, plan, 1, undefined, settled);
      throw error;
    }
  };
} else if (require.main === module) {
  const [command, value] = process.argv.slice(2);
  if (command === 'path') {
    console.log(__filename);
  } else if (command === 'begin') {
    const state = value;
    const file = path.join(state, 'gate.json');
    const sha = JSON.parse(fs.readFileSync(path.join(state, 'candidate.json'), 'utf8')).sha;
    let evidence = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
    if (evidence && evidence.sha !== sha) {
      const historical = path.join(state, 'historical', evidence.sha);
      fs.mkdirSync(historical, { recursive: true });
      fs.renameSync(file, path.join(historical, 'gate.json'));
      evidence = undefined;
    }
    const id = randomUUID();
    const startedAt = Number(process.env.A4S_GATE_STEP_STARTED_MS ?? Date.now());
    const directory = path.join(state, 'gate-attempts');
    fs.mkdirSync(directory, { recursive: true });
    const target = path.join(directory, id + '.jsonl');
    fs.writeFileSync(target, JSON.stringify({ id: 'lock_wait', name: 'lock_wait', startedAt }) + '\n');
    const attempt = { id, iteration: Number(process.env.DAG_PUSHBACK_ITERATION ?? 0), startedAt, endedAt: null, exitCode: null, result: 'RUNNING', phases: [{ name: 'lock_wait', startedAt, endedAt: null, exitCode: null }] };
    const attempts = [...(evidence?.attempts ?? []), attempt];
    const temporary = file + '.' + id;
    fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, sha, gate: process.env.GATE, result: 'RUNNING', attempts }) + '\n');
    fs.renameSync(temporary, file);
    console.log(target);
  } else if (command === 'start') {
    emit({ id: value, name: value, startedAt: Date.now() });
  } else if (command === 'end') {
    end(value, Number(process.argv[4]));
  } else if (command === 'finish') {
    const code = Number(value);
    const state = path.dirname(path.dirname(journal));
    const file = path.join(state, 'gate.json');
    const evidence = JSON.parse(fs.readFileSync(file, 'utf8'));
    const id = path.basename(journal, '.jsonl');
    const attempt = evidence.attempts.find(item => item.id === id);
    const endedAt = Date.now();
    const records = new Map();
    for (const line of fs.readFileSync(journal, 'utf8').trim().split('\n')) {
      const event = JSON.parse(line);
      records.set(event.id, { ...records.get(event.id), ...event });
    }
    const all = [...records.values()].map(record => ({ ...record, endedAt: record.endedAt ?? endedAt, exitCode: record.exitCode ?? code }));
    // Aggregate npm lifecycle shells and the complete GATE contain their leaf
    // workspace phases. Keep leaves; account for dispatcher time as overhead.
    const leaves = all.filter(record => !['command', 'tests', 'typecheck'].includes(record.name) || !all.some(other =>
      other.id !== record.id && ['install', 'tests', 'typecheck'].includes(other.name) &&
      other.startedAt > record.startedAt && other.endedAt < record.endedAt));
    const commandRecord = records.get('command');
    if (commandRecord?.exitCode && !leaves.some(record => record.exitCode !== 0)) {
      leaves.push({ id: 'command_failure', name: 'command', startedAt: commandRecord.endedAt, endedAt: commandRecord.endedAt, exitCode: commandRecord.exitCode });
    }
    leaves.sort((a, b) => a.startedAt - b.startedAt || a.endedAt - b.endedAt);
    const phases = [];
    let cursor = attempt.startedAt;
    for (const { id: ignored, ...record } of leaves) {
      if (record.startedAt > cursor) phases.push({ name: 'overhead', startedAt: cursor, endedAt: record.startedAt, exitCode: 0, durationMs: record.startedAt - cursor });
      phases.push({ ...record, durationMs: record.endedAt - record.startedAt });
      cursor = Math.max(cursor, record.endedAt);
    }
    if (endedAt > cursor) phases.push({ name: 'overhead', startedAt: cursor, endedAt, exitCode: 0, durationMs: endedAt - cursor });
    Object.assign(attempt, { endedAt, exitCode: code, result: code === 0 ? 'PASS' : 'FAIL', durationMs: endedAt - attempt.startedAt, phases });
    evidence.result = attempt.result;
    const temporary = file + '.' + id;
    fs.writeFileSync(temporary, JSON.stringify(evidence) + '\n');
    fs.renameSync(temporary, file);
  } else {
    throw new Error('Expected path, begin, start, end or finish');
  }
}
