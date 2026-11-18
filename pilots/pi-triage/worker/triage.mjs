import { parseArgs } from 'node:util';

const USAGE = 'Usage: node triage.mjs --issue fixture-1 --run-id pi-slice-...';
const FIXTURE = {
  poc: 'yes',
  question: '¿Dagu recibe una única línea JSON del worker sin confundirla con los logs?',
  reason: 'Una prueba con un fixture determinista permite verificar el contrato de proceso sin un proveedor.',
};

function parseInput(args) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { issue: { type: 'string' }, 'run-id': { type: 'string' } },
      tokens: true,
    });
  } catch {
    throw new Error(USAGE);
  }
  const { issue, 'run-id': runId } = parsed.values;
  if (parsed.tokens.length !== 2 || parsed.tokens.some((token) => token.kind !== 'option' || token.inlineValue)
      || issue !== 'fixture-1' || !runId?.startsWith('pi-slice-')) {
    throw new Error(USAGE);
  }
  return { issue, runId };
}

async function getTriage(issue) {
  const fixtureMode = process.env.A4S_PI_TRIAGE_FIXTURE;
  if (fixtureMode === '1') return FIXTURE;
  if (fixtureMode !== undefined && fixtureMode !== '0') {
    throw new Error('A4S_PI_TRIAGE_FIXTURE must be 1, 0, or unset');
  }
  const key = process.env.A4S_PI_TRIAGE_ANTHROPIC_API_KEY?.trim();
  if (!key) throw new Error('Pi mode requires A4S_PI_TRIAGE_ANTHROPIC_API_KEY');

  // The fixture path must work even when the SDK is not installed.
  const { triageWithPi } = await import('./pi.mjs').catch(() => {
    throw new Error('Could not load the Pi SDK; install the A4S lockfile dependencies with npm ci');
  });
  return triageWithPi(issue, key);
}

// This entry point owns the process: reserve stdout for the result, including
// while loading/discarding the SDK. Ordinary console/stream logs go to stderr.
const writeResult = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr);
try {
  const { issue, runId } = parseInput(process.argv.slice(2));
  const { poc, question, reason } = await getTriage(issue);
  writeResult(`${JSON.stringify({ schemaVersion: 1, issue, runId, poc, question, reason })}\n`);
} catch (error) {
  process.stderr.write(`pi-triage: ${error.message}\n`);
  process.exitCode = 1;
}
