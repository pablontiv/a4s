// Shared leaf module for the launcher, engine and standalone Node gate helpers.
const { randomUUID } = require('node:crypto');
const { closeSync, fsyncSync, linkSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');

const EXIT_CODES = Object.freeze({ integrationHold: 86, retry: 75, cancelled: 77 });

function canonicalJson(value, pretty = false) {
  function serialize(input, depth) {
    if (input !== null && typeof input === 'object') {
      const array = Array.isArray(input);
      const prefix = pretty ? `\n${'  '.repeat(depth + 1)}` : '';
      const entries = array
        ? input.map(item => serialize(item, depth + 1))
        : Object.keys(input).sort().map(key => `${JSON.stringify(key)}:${pretty ? ' ' : ''}${serialize(input[key], depth + 1)}`);
      const contents = entries.length
        ? `${prefix}${entries.join(`,${prefix}`)}${pretty ? `\n${'  '.repeat(depth)}` : ''}`
        : '';
      return array ? `[${contents}]` : `{${contents}}`;
    }
    return JSON.stringify(input);
  }
  return serialize(value, 0);
}

// Rename is the commit point. Immutable records use link instead, so an existing
// record is never replaced. Both publication paths sync the containing directory.
function writeAtomicJson(path, value, options = {}) {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, contents); fsyncSync(fd); }
    finally { closeSync(fd); }
    options.fault?.('before-rename');
    if (options.exclusive) linkSync(temporary, path);
    else renameSync(temporary, path);
    const fdDirectory = openSync(directory, 'r');
    try { fsyncSync(fdDirectory); } finally { closeSync(fdDirectory); }
    options.fault?.('after-rename');
  } finally { rmSync(temporary, { force: true }); }
}

module.exports = { canonicalJson, writeAtomicJson, EXIT_CODES };
