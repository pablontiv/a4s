import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';

const keys = ['schemaVersion', 'issue', 'runId', 'poc', 'question', 'reason'];
const nonBlank = (value) => typeof value === 'string' && value.trim() !== '';

function privateDirectory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error('State directory must be private, non-symlink and owned by the current user');
  }
}

function parseTriage(bytes, issue, runId) {
  const line = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    .decode(bytes).replace(/\r?\n$/, '');
  if (/[\r\n]/.test(line)) throw new Error('Expected exactly one JSON line from triage');
  const value = JSON.parse(line);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))
    || value.schemaVersion !== 1 || value.issue !== issue || value.runId !== runId || value.poc !== 'yes'
    || !nonBlank(value.question) || !nonBlank(value.reason)) {
    throw new Error('Triage JSON does not match the schema or this issue/run');
  }
  // JSON.parse collapses duplicate keys. Count colons outside strings in this flat object.
  const entries = line.match(/"(?:[^"\\]|\\.)*"|:/g).filter((token) => token === ':');
  if (entries.length !== keys.length) throw new Error('Duplicate keys in triage JSON');
  return value;
}

function writeJson(directory, filename, value) {
  const temp = join(directory, `.${filename}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temp, join(directory, filename));
  } finally {
    rmSync(temp, { force: true });
  }
}

function main() {
  const { ISSUE: issue, DAG_RUN_ID: runId, STATE_ROOT: root, WORKER_ENTRY: entry } = process.env;
  if (!nonBlank(issue)) throw new Error('ISSUE must be non-empty');
  if (!/^pi-slice-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId ?? '')) {
    throw new Error('Supply an explicit --run-id with prefix pi-slice-');
  }
  if (!root || !isAbsolute(root)) throw new Error('STATE_ROOT must be absolute');
  privateDirectory(root);
  const directory = join(root, runId);

  switch (process.argv[2]) {
    case 'triage': {
      if (!entry || !isAbsolute(entry) || !entry.endsWith('.mjs') || !statSync(entry).isFile()) {
        throw new Error('WORKER_ENTRY must be an absolute path to a trusted .mjs file');
      }
      const result = spawnSync(process.execPath, [entry, '--issue', issue, '--run-id', runId], {
        stdio: ['ignore', 'pipe', 'pipe'], shell: false, timeout: 150_000, maxBuffer: 1024 * 1024,
      });
      if (result.error || result.status !== 0) {
        throw new Error(`Worker failed (${result.error?.code ?? result.signal ?? result.status})`);
      }
      const triage = parseTriage(result.stdout, issue, runId);
      mkdirSync(directory, { mode: 0o700 });
      writeJson(directory, 'triage.json', triage);
      break;
    }
    case 'record-decision': {
      const { PI_SLICE_DECISION: decision } = process.env;
      if (decision !== 'APPROVE' && decision !== 'REJECT') {
        throw new Error('DECISION must be APPROVE or REJECT');
      }
      privateDirectory(directory);
      parseTriage(readFileSync(join(directory, 'triage.json')), issue, runId);
      writeJson(directory, 'decision.json', { schemaVersion: 1, runId, decision });
      break;
    }
    default:
      throw new Error('Expected triage or record-decision');
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof SyntaxError ? 'Invalid triage JSON' : error.message);
  process.exitCode = 1;
}
