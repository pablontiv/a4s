#!/usr/bin/env node
const { readFileSync } = require('node:fs');
const { runPart } = require('./gate-cache.cjs');

const planFile = process.argv[2];
const planned = JSON.parse(readFileSync(planFile, 'utf8'));
let status = 0;
for (const part of planned.parts) {
  const code = runPart({ ...part, cacheDir: planned.cacheDir }, planned.journal || process.env.A4S_GATE_JOURNAL);
  if (code !== 0 && status === 0) status = code;
}
process.exit(status);
