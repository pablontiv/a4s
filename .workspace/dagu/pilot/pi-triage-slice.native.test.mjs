import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  accessSync, closeSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const name = 'pi-triage-slice';

function nativeDagu() {
  const override = process.env.DAGU_BIN;
  const candidates = override ? [override] : (process.env.PATH ?? '')
    .split(delimiter).filter(isAbsolute).map((dir) => join(dir, 'dagu'));
  const found = candidates.find((path) => {
    if (!isAbsolute(path)) return false;
    try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
  });
  assert.ok(found, 'Set DAGU_BIN to the absolute path of the standalone Dagu 2.26.0 executable');
  const path = realpathSync(found);
  const signature = Buffer.alloc(2);
  const fd = openSync(path, 'r');
  try { readSync(fd, signature); } finally { closeSync(fd); }
  assert.notEqual(signature.toString(), '#!', 'Use the bare Dagu binary, not a station wrapper');
  return path;
}

async function freePort() {
  const probe = createServer();
  const ready = once(probe, 'listening');
  probe.listen(0, '127.0.0.1');
  await ready;
  const { port } = probe.address();
  const closed = once(probe, 'close');
  probe.close();
  await closed;
  return port;
}

async function until(check, diagnostic) {
  const deadline = Date.now() + 10_000;
  do {
    const value = await check();
    if (value) return value;
    await delay(50);
  } while (Date.now() < deadline);
  assert.fail(diagnostic());
}

function readArtifact(directory, filename) {
  const path = join(directory, filename);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('pi-triage-slice on isolated Dagu 2.26.0', { timeout: 90_000 }, async (t) => {
  const dagu = nativeDagu();
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'pi-triage-slice-'));
  const home = join(root, 'home');
  const daguHome = join(root, 'dagu');
  const dags = join(daguHome, 'dags');
  const data = join(daguHome, 'data');
  const state = join(root, 'private state');
  const config = join(root, 'config.yaml');
  const dag = join(dags, `${name}.yaml`);
  const worker = join(root, 'worker fixture; argv.mjs');
  let server;
  let serverLog = '';
  try {
    for (const dir of [home, dags, state]) mkdirSync(dir, { mode: 0o700, recursive: true });
    copyFileSync(new URL(`./${name}.yaml`, import.meta.url), dag);
    copyFileSync(new URL(`./${name}.mjs`, import.meta.url), join(dags, `${name}.mjs`));
    copyFileSync(new URL('./triage-worker.stub.mjs', import.meta.url), worker);
    const port = await freePort();
    writeFileSync(config, [
      'host: 127.0.0.1', `port: ${port}`, 'auth: {mode: none}',
      'coordinator: {enabled: false}', 'scheduler: {port: 0}', 'queues: {enabled: true}', 'paths:',
      `  dags_dir: ${JSON.stringify(dags)}`, `  data_dir: ${JSON.stringify(data)}`,
      `  executable: ${JSON.stringify(dagu)}`, '',
    ].join('\n'), { mode: 0o600 });

    // Allowlist only: no operator HOME/XDG, DAGU_* settings, tokens, or station executables.
    const env = {
      HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_STATE_HOME: join(home, '.local', 'state'), XDG_CACHE_HOME: join(home, '.cache'),
      TMPDIR: root, PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
      DAGU_SKIP_EXAMPLES: 'true',
    };
    const options = { env, cwd: root };
    const isolation = ['--context', 'local', '--config', config, '--dagu-home', daguHome];
    const cli = (args, params = []) => execute(dagu, [...args, ...isolation, ...params], {
      ...options, timeout: 10_000,
    });
    assert.equal((await execute(dagu, ['version'], options)).stdout.trim(), '2.26.0');
    const { stdout: resolved } = await cli(['config']);
    const paths = Object.fromEntries(resolved.trim().split('\n').map((line) => line.split(/:\s+/)));
    assert.equal(paths['Config file'], config);
    assert.equal(paths['DAGs directory'], dags);
    assert.equal(paths['Data directory'], data);
    assert.equal(paths.Executable, dagu);
    for (const [key, value] of Object.entries(paths)) {
      if (key !== 'Executable') assert.ok(value.startsWith(`${root}/`), `${key}: ${value}`);
    }
    await cli(['validate', dag]);

    // Human task completion queues a resume; the isolated scheduler must consume it.
    server = spawn(dagu, ['start-all', ...isolation], { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [server.stdout, server.stderr]) stream.on('data', (chunk) => { serverLog += chunk; });
    server.on('error', (error) => { serverLog += error.message; });
    const url = `http://127.0.0.1:${port}`;
    const get = (path) => fetch(`${url}${path}`, { signal: AbortSignal.timeout(1_000) });
    const list = await until(async () => {
      assert.equal(server.exitCode, null, serverLog);
      const response = await get('/api/v1/dags').catch(() => null);
      return response?.ok ? response.json() : null;
    }, () => serverLog);
    assert.deepEqual(list.dags.map((entry) => entry.dag.name), [name], JSON.stringify(list));
    for (const stationDag of ['feature', 'triage-pilot']) {
      assert.equal((await get(`/api/v1/dags/${stationDag}`)).status, 404);
    }

    const start = (runId, issue) => cli(['start', '--run-id', runId, dag], [
      '--', `WORKER_ENTRY=${worker}`, `STATE_ROOT=${state}`, ...(issue ? [`ISSUE=${issue}`] : []),
    ]);
    const status = async (runId) => (await cli(['status', '--run-id', runId, name])).stdout;
    const complete = (runId, decision) => cli([
      'human-task', 'complete', name, '--run-id', runId, '--step', 'decide', '--input', `DECISION=${decision}`,
    ]);
    for (const [decision, issue] of [['APPROVE', undefined], ['REJECT', 'fixture-1;$(printf shell-expanded)']]) {
      await t.test(`decide ${decision} records the verdict and Succeeds`, async () => {
        const runId = `pi-slice-${decision.toLowerCase()}`;
        const dir = join(state, runId);
        await start(runId, issue);
        const waiting = await status(runId);
        assert.match(waiting, /^Waiting\b/m);
        assert.match(waiting, /\bdecide\b[^\n]*\bWaiting\b/i);
        assert.equal(statSync(dir).mode & 0o777, 0o700);
        assert.deepEqual(readdirSync(dir), ['triage.json']);
        assert.deepEqual(readArtifact(dir, 'triage.json'), {
          schemaVersion: 1, issue: issue ?? 'fixture-1', runId, poc: 'yes',
          question: 'Would the fixture exercise "runtime: behavior"?', reason: 'Stub only; no PoC was run.',
        });
        if (decision === 'APPROVE') {
          await assert.rejects(complete(runId, 'MAYBE'));
          assert.match(await status(runId), /^Waiting\b/m);
          assert.deepEqual(readdirSync(dir), ['triage.json']);
        }
        await complete(runId, decision);
        let lastStatus;
        await until(async () => {
          lastStatus = await status(runId);
          return /^Succeeded\b/m.test(lastStatus);
        }, () => `${lastStatus}\n${serverLog}`);
        assert.deepEqual(readdirSync(dir).sort(), ['decision.json', 'triage.json']);
        assert.deepEqual(readArtifact(dir, 'decision.json'), { schemaVersion: 1, runId, decision });
      });
    }

    for (const suffix of [
      'bad-json', 'extra-line', 'wrong-issue', 'wrong-run', 'extra-key', 'duplicate-key',
      'blank-reason', 'poc-no', 'unsupported-schema', 'nonzero', 'unprefixed',
    ]) {
      await t.test(`rejects ${suffix} before decide`, async () => {
        const runId = suffix === 'unprefixed' ? suffix : `pi-slice-${suffix}`;
        await assert.rejects(start(runId));
        const failed = await status(runId);
        assert.match(failed, /^Failed\b/m);
        assert.doesNotMatch(failed, /\bdecide\b[^\n]*\bWaiting\b/i);
        assert.equal(existsSync(join(state, runId)), false);
      });
    }
  } finally {
    if (server?.pid && server.exitCode === null && server.signalCode === null) {
      const stopped = once(server, 'exit');
      server.kill('SIGTERM');
      const forceKill = setTimeout(() => server.kill('SIGKILL'), 3_000);
      try { await stopped; } finally { clearTimeout(forceKill); }
    }
    rmSync(root, { force: true, recursive: true });
  }
});
