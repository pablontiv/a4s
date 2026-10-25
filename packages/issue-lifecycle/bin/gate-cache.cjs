#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Station-local content-addressed cache for gate test and typecheck tasks.
// Remote caching is intentionally unsupported: entries with `remote: true` are
// ignored, and this module never uploads results.
const CACHED_REASON = 'content-addressed inputs: workspace sources and tests, lockfile, workspace dependency graph, root assets read by tests, referenced environment, and node and npm identity';
const ALWAYS_REASON = 'git-state: reads merge-base, the index or untracked files, and GITHUB_BASE_REF or the integration base';

const IGNORED_ENV = new Set([
  'NODE_OPTIONS', 'INIT_CWD', 'PWD', 'OLDPWD', 'SHLVL', '_', 'HOME', 'USER', 'LOGNAME', 'SHELL',
  'TMPDIR', 'TMP', 'TEMP', 'PATH', 'NODE_PATH', 'WORKTREE', 'PRIMARY', 'RUN', 'BRANCH', 'ISSUE',
  'GATE', 'REQUIRED_CHECK', 'DAGU_PARAMS_JSON', 'SUMMARY', 'MESSAGE', 'IMPLEMENTER', 'BASE_BRANCH',
  'PR_NUMBER', 'POC_BASIS', 'DAGU_OUTPUT_FILE', 'DAGU_HOME', 'DAGU_URL', 'DAGU_PORT',
  'A4S_GATE_CACHE_HIT',
]);
const IGNORED_ENV_PREFIX = /^(?:ORCA_|PI_|OMP_|CURSOR_|npm_|A4S_GATE_)/;
const ENV_READ = /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\])/g;
const ROOT_ASSET = /(?:scripts|\.github|docs)\//;

let cachedTool;

function ignoredEnv(name) {
  return IGNORED_ENV.has(name) || IGNORED_ENV_PREFIX.test(name);
}

function classifyTestSource(text) {
  const invokesGit = /(?:execFileSync|execFile|spawnSync|spawn|execSync)\(\s*['"]git['"]/.test(text);
  const mergeBase = /['"]merge-base['"]/.test(text) || /\bgit\s+merge-base\b/.test(text);
  const untracked = /['"]ls-files['"]/.test(text) || /--others\b/.test(text);
  const baseRef = text.includes('GITHUB_BASE_REF') || text.includes('integrationBase');
  if (invokesGit && mergeBase && untracked && baseRef) {
    return { classification: 'always', reason: ALWAYS_REASON };
  }
  return { classification: 'cached', reason: CACHED_REASON };
}

function toolIdentity() {
  if (!cachedTool) {
    const npm = spawnSync('npm', ['-v'], { encoding: 'utf8' });
    cachedTool = {
      node: process.version,
      execPath: fs.realpathSync(process.execPath),
      npm: npm.status === 0 ? npm.stdout.trim() : 'unknown',
    };
  }
  return { ...cachedTool, stamp: process.env.A4S_GATE_CACHE_TOOL || '' };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function relPosix(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function hashFiles(root, files) {
  const hash = crypto.createHash('sha256');
  const rows = [...new Set(files.map(file => fs.realpathSync(file)))].map(file => ({
    rel: relPosix(root, file),
    file,
  })).sort((left, right) => left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0);
  for (const row of rows) {
    hash.update(row.rel);
    hash.update('\0');
    hash.update(fs.readFileSync(row.file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function walk(dir, accept, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.turbo' || entry.name === 'coverage') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, accept, out);
    else if (entry.isFile() && accept(abs)) out.push(abs);
  }
  return out;
}

function globToRegExp(pattern) {
  const source = pattern.split('\\').join('/');
  let out = '^';
  for (let i = 0; i < source.length; i += 1) {
    if (source.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 2;
      continue;
    }
    if (source.startsWith('**', i)) {
      out += '.*';
      i += 1;
      continue;
    }
    const char = source[i];
    if (char === '*') out += '[^/]*';
    else if (char === '?') out += '[^/]';
    else if ('+.^${}()|[]\\'.includes(char)) out += `\\${char}`;
    else out += char;
  }
  return new RegExp(`${out}$`);
}

function filesMatching(workspace, token) {
  if (!token.includes('*')) {
    const abs = path.resolve(workspace, token);
    return fs.existsSync(abs) && fs.statSync(abs).isFile() ? [abs] : [];
  }
  const regexp = globToRegExp(token);
  return walk(workspace, file => regexp.test(relPosix(workspace, file)));
}

function tokens(text) {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(match => match[1] ?? match[2] ?? match[3]);
}

function stripAssignments(script) {
  let rest = script.trim();
  const env = {};
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(rest)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(\S*)\s+/.exec(rest);
    env[match[1]] = match[2];
    rest = rest.slice(match[0].length);
  }
  return { env, rest };
}

function isDispatcher(script) {
  return /\bnpm\s+(?:run\s+)?(?:test|typecheck)\b/.test(script) || /--workspaces\b/.test(script);
}

function matchRunner(rest) {
  let match;
  if ((match = /^(node)\s+--test(?:\s+([\s\S]+))?$/.exec(rest))) return { bin: 'node', args: ['--test'], files: tokens(match[2] || '') };
  if ((match = /^(tsx)\s+--test(?:\s+([\s\S]+))?$/.exec(rest))) return { bin: 'tsx', args: ['--test'], files: tokens(match[2] || '') };
  if ((match = /^(bun)\s+test(?:\s+([\s\S]+))?$/.exec(rest))) return { bin: 'bun', args: ['test'], files: tokens(match[2] || '') };
  if ((match = /^(node)\s+--check(?:\s+([\s\S]+))?$/.exec(rest))) return { bin: 'node', args: ['--check'], files: tokens(match[2] || '') };
  if ((match = /^(?:(?:\S*\/)?tsc)(?:\s+([\s\S]+))?$/.exec(rest))) {
    return { bin: 'tsc', args: tokens(match[1] || '').filter(token => token.startsWith('-')), files: tokens(match[1] || '').filter(token => !token.startsWith('-')) };
  }
  if (/^node\s+(?:-e|--eval)\b/.test(rest)) return { bin: 'node', args: [], files: [], eval: true };
  return { bin: null, args: [], files: [], opaque: true };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function workspaceDirs(repoRoot) {
  const manifestPath = path.join(repoRoot, 'package.json');
  if (!fs.existsSync(manifestPath)) return [];
  const manifest = readJson(manifestPath);
  const patterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages || [];
  const dirs = [];
  for (const pattern of patterns) {
    if (pattern.endsWith('/*')) {
      const base = path.join(repoRoot, pattern.slice(0, -2));
      if (!fs.existsSync(base)) continue;
      for (const name of fs.readdirSync(base)) {
        const dir = path.join(base, name);
        if (fs.existsSync(path.join(dir, 'package.json'))) dirs.push(dir);
      }
    } else {
      const dir = path.join(repoRoot, pattern);
      if (fs.existsSync(path.join(dir, 'package.json'))) dirs.push(dir);
    }
  }
  return dirs;
}

function dependencyNames(manifest) {
  return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
    .flatMap(field => Object.keys(manifest[field] || {}));
}

function dependencyClosure(repoRoot, workspaceDir) {
  const byName = new Map();
  for (const dir of workspaceDirs(repoRoot)) {
    const manifest = readJson(path.join(dir, 'package.json'));
    if (manifest.name) byName.set(manifest.name, { dir: fs.realpathSync(dir), manifest });
  }
  const self = readJson(path.join(workspaceDir, 'package.json'));
  const closure = [];
  const seen = new Set();
  const queue = dependencyNames(self);
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const found = byName.get(name);
    if (!found || found.dir === workspaceDir) continue;
    closure.push(found);
    queue.push(...dependencyNames(found.manifest));
  }
  return closure.sort((left, right) => left.manifest.name < right.manifest.name ? -1 : 1);
}

function isDependencySource(workspace, file) {
  const rel = relPosix(workspace, file);
  if (rel === 'package.json' || rel === 'tsconfig.json') return true;
  if (/(^|\/)(?:test|__tests__)(\/|$)/.test(rel) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(rel)) return false;
  return /\.(?:[cm]?[jt]sx?|json|node)$/.test(rel);
}

function tsconfigFiles(workspace) {
  const file = path.join(workspace, 'tsconfig.json');
  if (!fs.existsSync(file)) return [];
  let parsed;
  try {
    parsed = readJson(file);
  } catch {
    return [file];
  }
  const include = Array.isArray(parsed.include) ? parsed.include : [];
  const exclude = new Set((Array.isArray(parsed.exclude) ? parsed.exclude : []).flatMap(pattern => filesMatching(workspace, pattern)));
  const listed = Array.isArray(parsed.files) ? parsed.files.flatMap(token => filesMatching(workspace, token)) : [];
  const patterns = include.length || parsed.files ? include : ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs', '**/*.cjs'];
  const matched = patterns.flatMap(pattern => filesMatching(workspace, pattern));
  return [...new Set([file, ...listed, ...matched])].filter(candidate => !exclude.has(candidate));
}

function localImports(file, text) {
  const found = [];
  for (const match of text.matchAll(/(?:require\(\s*|from\s*)['"](\.[^'"]+)['"]/g)) {
    const base = path.resolve(path.dirname(file), match[1]);
    const candidates = [base, ...['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'].flatMap(ext => [base + ext, path.join(base, `index${ext}`)])];
    const resolved = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (resolved) found.push(fs.realpathSync(resolved));
  }
  return found;
}

function fileTexts(files) {
  return files.map(file => fs.readFileSync(file, 'utf8'));
}

function closureAlways(file, workspace) {
  const seen = new Set();
  const queue = [file];
  while (queue.length) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    let text;
    try {
      text = fs.readFileSync(current, 'utf8');
    } catch {
      continue;
    }
    if (classifyTestSource(text).classification === 'always') return true;
    if (!current.startsWith(`${workspace}${path.sep}`)) continue;
    queue.push(...localImports(current, text).filter(imported => imported.startsWith(`${workspace}${path.sep}`)));
  }
  return false;
}

function rootAssets(repoRoot, workspace, files) {
  const found = new Set();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const dir = path.dirname(file);
    for (const match of text.matchAll(/['"`]([^'"`\n]+)['"`]/g)) {
      const literal = match[1];
      if (!literal || literal.length > 200 || literal.includes('*') || literal.includes('${') || !ROOT_ASSET.test(literal)) continue;
      const candidates = [];
      if (literal.startsWith('.')) candidates.push(path.resolve(dir, literal));
      const marker = literal.match(ROOT_ASSET);
      if (marker) candidates.push(path.join(repoRoot, literal.slice(marker.index)));
      for (const candidate of candidates) {
        if (!candidate.startsWith(`${repoRoot}${path.sep}`) || candidate.startsWith(`${workspace}${path.sep}`)) continue;
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) found.add(fs.realpathSync(candidate));
      }
    }
  }
  return [...found];
}

function referencedEnv(texts) {
  const names = new Set();
  for (const text of texts) {
    for (const match of text.matchAll(ENV_READ)) names.add(match[1] || match[2]);
  }
  return [...names].filter(name => name && !ignoredEnv(name)).sort();
}

function normalizeEnv(value, worktree, primary) {
  if (value == null) return null;
  let out = String(value);
  const roots = [worktree, primary].filter(Boolean).sort((left, right) => right.length - left.length);
  for (const root of roots) {
    if (!out.includes(root)) continue;
    out = out.split(root).join(root === primary && root !== worktree ? '$PRIMARY' : '$WORKTREE');
  }
  return out;
}

function envMaterial(names, env, worktree, primary) {
  return names.map(name => [name, normalizeEnv(Object.hasOwn(env, name) ? env[name] : null, worktree, primary)]);
}

function lockfileHash(repoRoot) {
  for (const name of ['package-lock.json', 'npm-shrinkwrap.json']) {
    const file = path.join(repoRoot, name);
    if (fs.existsSync(file)) return sha256(fs.readFileSync(file));
  }
  return 'missing';
}

function workspaceManifest(repoRoot) {
  const file = path.join(repoRoot, 'package.json');
  if (!fs.existsSync(file)) return [];
  const manifest = readJson(file);
  return manifest.workspaces || [];
}

function dependencyMaterial(repoRoot, workspaceDir) {
  return dependencyClosure(repoRoot, workspaceDir).map(dep => ({
    name: dep.manifest.name,
    version: dep.manifest.version || '',
    inputs: hashFiles(repoRoot, walk(dep.dir, file => isDependencySource(dep.dir, file))),
  }));
}

function cacheKey(material) {
  return sha256(stable(material));
}

function expandFiles(workspace, runner) {
  return runner.files.flatMap(token => filesMatching(workspace, token));
}

function withImports(workspace, repoRoot, files) {
  const seen = new Set(files);
  const queue = [...files];
  const extras = [];
  while (queue.length) {
    const current = queue.shift();
    let text = '';
    try {
      text = fs.readFileSync(current, 'utf8');
    } catch {
      continue;
    }
    for (const imported of localImports(current, text)) {
      if (seen.has(imported)) continue;
      seen.add(imported);
      if (imported.startsWith(`${workspace}${path.sep}`)) queue.push(imported);
      else if (imported.startsWith(`${repoRoot}${path.sep}`)) extras.push(imported);
    }
  }
  return { inputs: [...seen], extras };
}

function runnerBin(runner) {
  return runner.bin === 'node' ? process.execPath : runner.bin;
}

function commandFor(runner, files, workspace) {
  const args = [...runner.args, ...files.map(file => path.relative(workspace, file) || path.basename(file))];
  return { bin: runnerBin(runner), args, command: `${runner.bin} ${args.join(' ')}` };
}

function describeTask({ worktree, primary, cwd, task, script, env = process.env }) {
  if (!worktree || !script || !cwd) return { action: 'passthrough' };
  const { env: scriptEnv, rest } = stripAssignments(script);
  if (isDispatcher(rest)) return { action: 'passthrough' };
  const repoRoot = fs.realpathSync(worktree);
  const workspaceDir = fs.realpathSync(cwd);
  const workspace = relPosix(repoRoot, workspaceDir) || '.';
  const runner = matchRunner(rest);
  const packageJson = path.join(workspaceDir, 'package.json');
  const baseInputs = fs.existsSync(packageJson) ? [packageJson] : [];
  const shared = {
    task,
    workspace,
    script,
    lockfile: lockfileHash(repoRoot),
    workspaces: workspaceManifest(repoRoot),
    dependencies: dependencyMaterial(repoRoot, workspaceDir),
    tool: toolIdentity(),
  };

  if (task === 'typecheck') {
    const files = [...new Set([...baseInputs, ...expandFiles(workspaceDir, runner), ...tsconfigFiles(workspaceDir)])];
    const key = cacheKey({ ...shared, inputs: hashFiles(repoRoot, files), rootAssets: hashFiles(repoRoot, []), env: [] });
    return observed(workspace, task, 'cached', CACHED_REASON, key, script);
  }

  if (runner.eval) {
    const classification = classifyTestSource(script);
    if (classification.classification === 'always') return observed(workspace, task, 'always', classification.reason, null, script);
    const texts = fileTexts(baseInputs);
    const key = cacheKey({
      ...shared,
      inputs: hashFiles(repoRoot, baseInputs),
      rootAssets: hashFiles(repoRoot, rootAssets(repoRoot, workspaceDir, baseInputs)),
      env: envMaterial(referencedEnv([script, ...texts]), { ...env, ...scriptEnv }, repoRoot, primary),
    });
    return observed(workspace, task, 'cached', CACHED_REASON, key, script);
  }

  const selected = expandFiles(workspaceDir, runner);
  const testFiles = selected.length ? selected : runner.opaque
    ? walk(workspaceDir, file => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) || /(?:^|\/)(?:test|__tests__)\//.test(relPosix(workspaceDir, file)))
    : [];
  if (!testFiles.length) {
    const files = [...new Set([...baseInputs, ...walk(workspaceDir, file => isDependencySource(workspaceDir, file))])];
    const texts = [script, ...fileTexts(files)];
    if (texts.some(text => classifyTestSource(text).classification === 'always')) {
      return observed(workspace, task, 'always', ALWAYS_REASON, null, script);
    }
    const key = cacheKey({
      ...shared,
      inputs: hashFiles(repoRoot, files),
      rootAssets: hashFiles(repoRoot, rootAssets(repoRoot, workspaceDir, files)),
      env: envMaterial(referencedEnv(texts), { ...env, ...scriptEnv }, repoRoot, primary),
    });
    return observed(workspace, task, 'cached', CACHED_REASON, key, script);
  }

  const alwaysFiles = testFiles.filter(file => closureAlways(file, workspaceDir));
  const cachedFiles = testFiles.filter(file => !alwaysFiles.includes(file));
  if (!cachedFiles.length || (alwaysFiles.length && !runner.bin)) {
    const rels = (alwaysFiles.length ? alwaysFiles : testFiles).map(file => relPosix(repoRoot, file)).sort();
    return observed(workspace, task, 'always', `${ALWAYS_REASON} (${rels.join(', ')})`, null, script);
  }
  if (!alwaysFiles.length) {
    const graph = withImports(workspaceDir, repoRoot, cachedFiles);
    const files = [...new Set([...baseInputs, ...graph.inputs])];
    const texts = [script, ...fileTexts(files)];
    const assets = [...new Set([...rootAssets(repoRoot, workspaceDir, files), ...graph.extras])];
    const key = cacheKey({
      ...shared,
      inputs: hashFiles(repoRoot, files),
      rootAssets: hashFiles(repoRoot, assets),
      env: envMaterial(referencedEnv(texts), { ...env, ...scriptEnv }, repoRoot, primary),
    });
    return observed(workspace, task, 'cached', CACHED_REASON, key, script);
  }

  const cachedGraph = withImports(workspaceDir, repoRoot, cachedFiles);
  const cachedInputs = [...new Set([...baseInputs, ...cachedGraph.inputs])];
  const cachedTexts = fileTexts(cachedInputs);
  const cachedAssets = [...new Set([...rootAssets(repoRoot, workspaceDir, cachedInputs), ...cachedGraph.extras])];
  const key = cacheKey({
    ...shared,
    inputs: hashFiles(repoRoot, cachedInputs),
    rootAssets: hashFiles(repoRoot, cachedAssets),
    env: envMaterial(referencedEnv(cachedTexts), { ...env, ...scriptEnv }, repoRoot, primary),
  });
  const cachedCommand = commandFor(runner, cachedFiles, workspaceDir);
  const alwaysCommand = commandFor(runner, alwaysFiles, workspaceDir);
  const alwaysRels = alwaysFiles.map(file => relPosix(repoRoot, file)).sort();
  return {
    action: 'split',
    workspace,
    parts: [
      {
        task, workspace, classification: 'cached', reason: CACHED_REASON, key, store: true,
        bin: cachedCommand.bin, args: cachedCommand.args, cwd: workspaceDir,
        command: cachedCommand.command, env: { ...env, ...scriptEnv },
      },
      {
        task, workspace, classification: 'always', reason: `${ALWAYS_REASON} (${alwaysRels.join(', ')})`,
        key: null, store: false, bin: alwaysCommand.bin, args: alwaysCommand.args, cwd: workspaceDir,
        command: alwaysCommand.command, env: { ...env, ...scriptEnv },
      },
    ],
  };
}

function observed(workspace, task, classification, reason, key, command) {
  return { action: 'observed', workspace, task, classification, reason, key, command };
}

function cacheDirectory(worktree) {
  const result = spawnSync('git', ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error((result.stderr || 'git common dir unavailable').trim());
  const common = path.resolve(worktree, result.stdout.trim());
  const dir = path.join(common, 'dagu-feature', 'gate-cache');
  fs.mkdirSync(dir, { recursive: true });
  const config = path.join(dir, 'config.json');
  try {
    fs.writeFileSync(config, `${JSON.stringify({ schemaVersion: 1, remote: false })}\n`, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return dir;
}

function entryPath(cacheDir, key) {
  return path.join(cacheDir, `${key}.json`);
}

function lookup(cacheDir, key) {
  const file = entryPath(cacheDir, key);
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed = readJson(file);
    if (parsed.remote || parsed.result !== 'PASS' || parsed.exitCode !== 0 || parsed.key !== key) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function storePass(cacheDir, record) {
  if (!record || record.result !== 'PASS' || record.exitCode !== 0 || record.remote || !record.key) return;
  fs.mkdirSync(cacheDir, { recursive: true });
  const target = entryPath(cacheDir, record.key);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ ...record, remote: false })}\n`);
  fs.renameSync(temporary, target);
}

function forget(cacheDir, key) {
  if (!cacheDir || !key) return;
  fs.rmSync(entryPath(cacheDir, key), { force: true });
}

function passRecord(described) {
  return {
    schemaVersion: 1,
    key: described.key,
    result: 'PASS',
    exitCode: 0,
    remote: false,
    task: {
      workspace: described.workspace,
      name: described.task,
      classification: described.classification,
      reason: described.reason,
    },
  };
}

function plan(input) {
  const described = describeTask(input);
  if (described.action === 'passthrough') return described;
  const cacheDir = cacheDirectory(input.worktree);
  if (described.action === 'split') {
    return {
      ...described,
      cacheDir,
      parts: described.parts.map(part => {
        if (!part.key) return { ...part, cache: 'executed' };
        const hit = lookup(cacheDir, part.key);
        return { ...part, cache: hit ? 'hit' : 'miss', store: !hit };
      }),
    };
  }
  if (described.classification === 'always' || !described.key) {
    return { ...described, cacheDir, cache: 'executed' };
  }
  const hit = lookup(cacheDir, described.key);
  return { ...described, cacheDir, cache: hit ? 'hit' : 'miss', record: passRecord(described) };
}

function appendJournal(journal, event) {
  if (journal) fs.appendFileSync(journal, `${JSON.stringify(event)}\n`);
}

function runPart(part, journal) {
  const id = crypto.randomUUID();
  const startedAt = Date.now();
  appendJournal(journal, {
    id, name: part.task, workspace: part.workspace, command: part.command, cache: part.cache,
    classification: part.classification, reason: part.reason, ...(part.key ? { cacheKey: part.key } : {}), startedAt,
  });
  if (part.cache === 'hit') {
    process.stderr.write(`gate-cache hit ${part.workspace} ${part.task}\n`);
    appendJournal(journal, { id, endedAt: Date.now(), exitCode: 0 });
    return 0;
  }
  const result = spawnSync(part.bin, part.args, { cwd: part.cwd, env: part.env, stdio: 'inherit' });
  const code = result.status === 0 ? 0 : result.status ?? 1;
  if (part.store && part.key && part.cache === 'miss') {
    if (code === 0) storePass(part.cacheDir, passRecord(part));
    else forget(part.cacheDir, part.key);
  }
  appendJournal(journal, { id, endedAt: Date.now(), exitCode: code });
  return code;
}

module.exports = {
  ALWAYS_REASON,
  CACHED_REASON,
  cacheDirectory,
  classifyTestSource,
  describeTask,
  forget,
  lookup,
  plan,
  runPart,
  storePass,
  toolIdentity,
};
