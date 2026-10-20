#!/usr/bin/env node
// a4s policy, invoked only while Git is replaying the verified single candidate.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const manifest = 'packages/omp-dagu/package.json';
const lock = 'package-lock.json';
const bundle = 'packages/omp-dagu/test/bundle.test.ts';
const changelog = 'packages/omp-dagu/CHANGELOG.md';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trimEnd();
const show = (ref, file) => execFileSync('git', ['show', `${ref}:${file}`], { encoding: 'utf8' });
const parse = version => {
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'stable semantic version required');
  const parts = version.split('.').map(Number);
  assert.ok(parts.every(Number.isSafeInteger), 'version components must be safe integers');
  return parts;
};
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const lane = (a, b) => a[0] === b[0] && a[1] === b[1];
let scratch;
try {
  const refs = ['BASE', 'UPSTREAM', 'CANDIDATE'].map(key => {
    const ref = process.env[`DAGU_REBASE_${key}`];
    assert.match(ref ?? '', /^[0-9a-f]{40}$/, `verified DAGU_REBASE_${key} required`);
    return ref;
  });
  const [base, upstream, candidate] = refs;
  assert.equal(git('rev-parse', 'REBASE_HEAD'), candidate, 'replayed candidate mismatch');
  assert.equal(git('rev-parse', 'HEAD'), upstream, 'updated base mismatch');
  assert.equal(git('rev-parse', `${candidate}^`), base, 'single candidate parent mismatch');
  const versions = refs.map(ref => JSON.parse(show(ref, manifest)).version);
  const [old, current, proposed] = versions.map(parse);
  assert.ok(compare(proposed, old) > 0, 'candidate must advance its original version');
  assert.ok(compare(current, old) >= 0, 'upstream version regressed');
  let next = [...proposed];
  if (lane(proposed, old)) {
    assert.ok(lane(current, old), 'patch intent conflicts with upstream major/minor change');
    next[2] = Math.max(proposed[2], current[2] + 1);
  } else if (lane(current, proposed)) {
    next[2] = Math.max(proposed[2], current[2] + 1);
  } else {
    assert.ok(lane(current, old), 'incompatible explicit major/minor intentions');
  }
  assert.ok(next.every(Number.isSafeInteger), 'next version exceeds safe integer range');
  const version = next.join('.');
  const [previousLog, upstreamLog, candidateLog] = refs.map(ref => show(ref, changelog));
  const heading = '# Changelog\n\n';
  assert.ok(previousLog.startsWith(heading), 'unrecognized changelog header');
  const history = previousLog.slice(heading.length);
  assert.ok(history.startsWith(`## ${versions[0]}\n`), 'base changelog/version mismatch');
  function additions(text, expected, single) {
    assert.ok(text.startsWith(`${heading}## ${expected}\n\n`), 'top changelog/version mismatch');
    assert.ok(text.endsWith(history), 'published changelog history changed');
    const added = text.slice(heading.length, -history.length);
    const body = added.slice(`## ${expected}\n\n`.length);
    assert.ok(body.trim().length > 0, 'empty changelog entry');
    if (single) assert.ok(!/^## /m.test(body), 'candidate must add exactly one release block');
    return body;
  }
  const entries = additions(candidateLog, versions[2], true);
  if (upstreamLog !== previousLog) additions(upstreamLog, versions[1], false);
  else assert.equal(versions[1], versions[0], 'upstream changelog missing release');
  const results = new Map([[changelog, `${heading}## ${version}\n\n${entries}${upstreamLog.slice(heading.length)}`]]);
  scratch = mkdtempSync(join(tmpdir(), 'dagu-bundle-rebase-'));
  for (const file of [manifest, lock, bundle]) {
    const normalized = refs.map((ref, index) => {
      assert.match(git('ls-tree', ref, '--', file), /^100644 blob /, `regular tracked file required: ${file}`);
      const text = show(ref, file);
      if (file === bundle) {
        const literals = [...text.matchAll(/assert\.equal\(BUNDLE_VERSION, "(\d+\.\d+\.\d+)"\);/g)];
        assert.ok(literals.length <= 1, 'ambiguous bundle identity literal');
        if (!literals.length) return text;
        assert.equal(literals[0][1], versions[index], 'bundle identity/version mismatch');
        return text.replace(literals[0][0], `assert.equal(BUNDLE_VERSION, "${versions[0]}");`);
      }
      const value = JSON.parse(text);
      const entry = file === manifest ? value : value.packages?.['packages/omp-dagu'];
      assert.equal(entry?.version, versions[index], `${file} workspace version mismatch`);
      entry.version = versions[0];
      return JSON.stringify(value, null, 2) + '\n';
    });
    const files = normalized.map((text, index) => {
      const target = join(scratch, String(index));
      writeFileSync(target, text);
      return target;
    });
    const merge = spawnSync('git', ['merge-file', '-p', files[1], files[0], files[2]], { encoding: 'utf8' });
    assert.equal(merge.status, 0, `ambiguous non-version changes in ${file}: ${merge.stderr}\n${merge.stdout}`);
    if (file === bundle) {
      results.set(file, merge.stdout.replace(`assert.equal(BUNDLE_VERSION, "${versions[0]}");`, `assert.equal(BUNDLE_VERSION, "${version}");`));
    } else {
      const value = JSON.parse(merge.stdout);
      (file === manifest ? value : value.packages['packages/omp-dagu']).version = version;
      results.set(file, JSON.stringify(value, null, 2) + '\n');
    }
  }
  assert.match(git('ls-tree', candidate, '--', changelog), /^100644 blob /, 'regular changelog required');
  for (const file of results.keys()) assert.ok(lstatSync(file).isFile(), `regular worktree file required: ${file}`);
  for (const [file, text] of results) writeFileSync(file, text);
  git('add', '--', ...results.keys());
  const remaining = git('diff', '--name-only', '--diff-filter=U');
  console.log(`bundle-rebase: ${versions.join(' / ')} -> ${version}`);
  console.log(`bundle-rebase: remaining conflicts: ${remaining || '(none)'}`);
  process.exitCode = remaining ? 2 : 0;
} catch (error) {
  console.error(`bundle-rebase: ${error.message}`);
  process.exitCode = 2;
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}
