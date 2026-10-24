#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { constants } = require('node:os');

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
// Observe the original spawn and return its original ChildProcess unchanged.
if (require.main !== module && journal && npmCli) {
  if (process.argv[2] === 'ci') {
    const id = start('install', { command: 'npm ci' });
    process.on('exit', code => end(id, code));
  }
  const childProcess = require('node:child_process');
  const original = childProcess.spawn;
  childProcess.spawn = function (...args) {
    const options = args[2] ?? (Array.isArray(args[1]) ? {} : args[1]) ?? {};
    const event = options.env?.npm_lifecycle_event;
    const name = event === 'test' ? 'tests' : event === 'typecheck' ? 'typecheck' : undefined;
    if (!name) return Reflect.apply(original, this, args);
    const cwd = String(options.cwd ?? process.cwd());
    const workspace = path.relative(process.env.WORKTREE, cwd) || '.';
    const id = start(name, { workspace, command: options.env.npm_lifecycle_script });
    try {
      const child = Reflect.apply(original, this, args);
      child.once('exit', (code, signal) => end(id, code, signal));
      child.once('error', () => end(id, 1));
      return child;
    } catch (error) {
      end(id, 1);
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
