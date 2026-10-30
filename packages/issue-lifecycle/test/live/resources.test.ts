import { renderedFeature, renderedPoc } from "../fixtures/rendered-feature.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { shellWords } from "../../src/resources.ts";
import { withResourceGuard } from "../resource-fixtures.ts";
import { a4sBin } from "../fixtures/a4s.ts";

const definitions = ["../../skills/issue-execution/feature.yaml", renderedFeature].map(path => fileURLToPath(new URL(path, import.meta.url)));
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dagu-resource-")));
  const primary = join(root, "primary space"), remote = join(root, "remote.git");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", primary]);
  git(primary, "config", "user.name", "Test"); git(primary, "config", "user.email", "test@example.com");
  writeFileSync(join(primary, "value"), "base\n");
  git(primary, "add", "."); git(primary, "commit", "-qm", "base");
  git(primary, "remote", "add", "origin", remote); git(primary, "push", "-qu", "origin", "main");
  writeFileSync(join(primary, ".git", "info", "exclude"), "/.workspace/\n");
  const bin = join(root, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "dagu"), `#!/bin/sh\nif [ -f '${root}/fail' ]; then echo 'history unavailable' >&2; exit 2; fi\ncat '${root}/'"$2"'.json'\n`);
  chmodSync(join(bin, "dagu"), 0o755);
  const history = (kind: string, rows: unknown[]) => writeFileSync(join(root, `${kind}.json`), JSON.stringify(rows));
  history("feature", []); history("poc", []);
  const worktree = join(primary, ".workspace", "worktrees", "issue-215"), branch = "dagu/issue-215";
  const row = (run: string, status: string, kind = "feature") => ({ name: kind, dagRunId: run, status, params: `PRIMARY=${primary} ISSUE=215 BRANCH=${kind === "feature" ? branch : ""}` });
  // Keep socket-backed Bash children from treating their stdin as a remote login and replacing PATH.
  const env = { ...process.env, SHLVL: "1", A4S_BIN: a4sBin, DAGU_PARAMS_JSON: "{}", POC_BASIS: "", PATH: `${bin}:${process.env.PATH}`, PRIMARY: primary, WORKTREE: worktree, BRANCH: branch, ISSUE: "215", RUN: "owner", OMP_SESSION_ID: "resource-test-session", BASE_BRANCH: "main", GATE: "true", REQUIRED_CHECK: "validate", DAGU_FEATURE_BUNDLE: "test" };
  return { root, primary, branch, worktree, git, history, row, env };
}
function script(definition: string, marker: string) {
  const lines = readFileSync(definition, "utf8").split("\n");
  const offset = lines.indexOf(marker);
  assert.notEqual(offset, -1, `missing ${marker} in ${definition}`);
  const anchor = lines.indexOf("    run: &feature_cleanup |");
  const start = anchor >= 0 && (marker === "  exit:" || marker === "  - id: close_gate")
    ? anchor : lines.indexOf("    run: |", offset);
  assert.notEqual(start, -1, `missing run block after ${marker}`);
  let end = start + 1;
  while (end < lines.length && (lines[end]!.startsWith("      ") || lines[end] === "")) end++;
  return withResourceGuard((marker === "  - id: close_gate" ? "CLEANUP_CLOSE=true\n" : "") +
    lines.slice(start + 1, end).map(line => line.slice(6)).join("\n"), definition);
}

test("shared shell words preserve Bash literal hashes, quoting and continuations", () => {
  for (const text of [
    "'quoted # text' \"double # text\" escaped\\#text foo#bar",
    '"backslash\\#hash" \'single\\#hash\'',
    "one \\\n two # ignored --input IMPLEMENTER=Other",
    "'' \"\" # trailing comment",
    "'single quoted \\\n continuation' \"double quoted \\\n continuation\"",
  ]) {
    const actual = execFileSync("bash", ["-c", `set -- ${text}\nprintf '%s\\0' "$@"`], { encoding: "utf8" }).split("\0").slice(0, -1);
    assert.deepEqual(shellWords(text), actual, text);
  }
});
for (const definition of definitions) {
  test(`${definition} onExit reports unavailable jq rather than malformed ownership history`, t => {
    const repo = fixture(); t.after(() => rmSync(repo.root, { recursive: true, force: true }));
    const bin = join(repo.root, "restricted-bin"); mkdirSync(bin);
    for (const tool of ["bash", "git", "mkdir", "dirname", "basename", "rm", "rmdir", "cat"]) {
      symlinkSync(execFileSync("bash", ["-c", 'command -v "$1"', "fixture", tool], { encoding: "utf8" }).trim(), join(bin, tool));
    }
    symlinkSync(join(repo.root, "bin", "dagu"), join(bin, "dagu"));
    const bash = join(bin, "bash"), jq = join(bin, "jq");
    const cleanup = () => spawnSync(bash, ["-c", script(definition, "  exit:")], { env: { ...repo.env, PATH: bin }, encoding: "utf8" });
    const missing = cleanup();
    assert.equal(missing.status, 127, missing.stderr);
    assert.match(missing.stderr, /required command not found: jq/);
    assert.doesNotMatch(missing.stderr, /malformed ownership history/);
    for (const status of [126, 127]) {
      writeFileSync(jq, `#!/bin/sh\nexit ${status}\n`, { mode: 0o755 });
      const unavailable = cleanup();
      assert.equal(unavailable.status, status, unavailable.stderr);
      assert.match(unavailable.stderr, /required command unavailable: jq/);
      assert.doesNotMatch(unavailable.stderr, /malformed ownership history/);
    }
    // The empty-history fallback must preserve tool failures too.
    writeFileSync(jq, '#!/bin/sh\nif [ "$1" = -er ]; then exit 4; fi\nexit 127\n', { mode: 0o755 });
    const fallback = cleanup();
    assert.equal(fallback.status, 127, fallback.stderr);
    assert.match(fallback.stderr, /required command unavailable: jq/);
    assert.doesNotMatch(fallback.stderr, /malformed ownership history/);
    assert.equal(existsSync(join(repo.primary, ".git/dagu-feature/owners/issue-215")), false);
    assert.equal(existsSync(join(repo.primary, ".git/dagu-feature/owners/issue-215.lock")), false);
    assert.equal(existsSync(repo.worktree), false);
  });

  test(`${definition} ownership history still accepts empty arrays and rejects malformed data`, t => {
    const repo = fixture(); t.after(() => rmSync(repo.root, { recursive: true, force: true }));
    const guard = withResourceGuard('set -euo pipefail\neval "$DAGU_RESOURCE_GUARD"\nresource_lock cleanup', definition);
    const empty = spawnSync("bash", ["-c", guard], { env: repo.env, encoding: "utf8" });
    assert.equal(empty.status, 0, empty.stderr);
    writeFileSync(join(repo.root, "feature.json"), "not json\n");
    const malformed = spawnSync("bash", ["-c", guard], { env: repo.env, encoding: "utf8" });
    assert.equal(malformed.status, 1, malformed.stderr);
    assert.match(malformed.stderr, /malformed ownership history/);
    assert.doesNotMatch(malformed.stderr, /required command (not found|unavailable)/);
  });

  test(`${definition} admission protects a feature owner resolved from its adopted snapshot`, t => {
    const repo = fixture(); t.after(() => rmSync(repo.root, { recursive: true, force: true }));
    repo.history("feature", [{ ...repo.row("adopted-owner", "waiting"), params: "ISSUE=215 OMP_SESSION_ID=owner-session" }]);
    const snapshot = join(repo.root, "snapshot.json");
    writeFileSync(snapshot, JSON.stringify({ spec: `env:\n  - PRIMARY: ${JSON.stringify(repo.primary)}\n` }));
    const curl = join(repo.root, "bin", "curl");
    writeFileSync(curl, `#!/bin/sh\ncat '${snapshot}'\n`);
    chmodSync(curl, 0o755);
    const result = spawnSync("bash", ["-c", script(definition, "  - id: admit")], { env: { ...repo.env, RUN: "requesting-run" }, encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /belongs to active run adopted-owner \(waiting\)/);
  });

  test(`${definition} admission/creation retries preserve candidate data, serialize claimants and transfer terminal ownership`, async t => {
    const repo = fixture(); t.after(() => rmSync(repo.root, { recursive: true, force: true }));
    const create = script(definition, "  - id: start_gate");
    repo.history("feature", [repo.row("owner", "running")]);
    const run = (extra = {}) => spawnSync("bash", ["-c", create], { env: { ...repo.env, ...extra }, encoding: "utf8" });
    let result = run(); assert.equal(result.status, 0, result.stderr);
    writeFileSync(join(repo.worktree, "value"), "candidate commit\n"); repo.git(repo.worktree, "add", "."); repo.git(repo.worktree, "commit", "-qm", "candidate");
    writeFileSync(join(repo.worktree, "untracked"), "preserve me\n");
    const head = repo.git(repo.worktree, "rev-parse", "HEAD");
    for (let i = 0; i < 2; i++) { result = run(); assert.equal(result.status, 0, result.stderr); }
    assert.equal(repo.git(repo.worktree, "rev-parse", "HEAD"), head);
    assert.equal(readFileSync(join(repo.worktree, "untracked"), "utf8"), "preserve me\n");
    result = run({ RUN: "intruder" }); assert.equal(result.status, 1); assert.match(result.stderr, /belongs to active run owner \(running\)/);
    writeFileSync(join(repo.root, "fail"), "fail");
    result = run(); assert.equal(result.status, 1); assert.match(result.stderr, /ownership history read failed/);
    rmSync(join(repo.root, "fail"));
    assert.equal(repo.git(repo.worktree, "rev-parse", "HEAD"), head);
    let owner = "owner";
    for (const terminal of ["failed", "aborted", "succeeded", "rejected", "partially_succeeded"]) {
      const replacement = `replacement-${terminal}`;
      repo.history("feature", [repo.row(owner, terminal), repo.row(replacement, "running")]);
      result = run({ RUN: replacement }); assert.equal(result.status, 0, result.stderr);
      assert.equal(repo.git(repo.worktree, "rev-parse", "HEAD"), head);
      assert.equal(readFileSync(join(repo.worktree, "untracked"), "utf8"), "preserve me\n");
      owner = replacement;
    }
    const cleanup = script(definition, "  exit:");
    result = spawnSync("bash", ["-c", cleanup], { env: repo.env, encoding: "utf8" });
    assert.equal(result.status, 1); assert.match(result.stderr, /belongs to active run replacement/);
    assert.equal(repo.git(repo.primary, "for-each-ref", "--format=%(refname)", "refs/heads/dagu/"), `refs/heads/${repo.branch}`);
    assert.equal(repo.git(repo.primary, "worktree", "list", "--porcelain").match(/worktree /g)?.length, 2);
  });

  test(`${definition} multi-hop replacement adopts a candidate after an interrupted transfer`, t => {
    const repo = fixture(); t.after(() => rmSync(repo.root, { recursive: true, force: true }));
    const create = script(definition, "  - id: start_gate");
    const run = (run: string, extra = {}) => spawnSync("bash", ["-c", create], { env: { ...repo.env, RUN: run, ...extra }, encoding: "utf8" });
    repo.history("feature", [repo.row("owner", "running")]);
    let result = run("owner"); assert.equal(result.status, 0, result.stderr);
    writeFileSync(join(repo.worktree, "value"), "candidate commit\n");
    repo.git(repo.worktree, "add", "."); repo.git(repo.worktree, "commit", "-qm", "candidate");
    writeFileSync(join(repo.worktree, "value"), "staged candidate\n"); repo.git(repo.worktree, "add", ".");
    writeFileSync(join(repo.worktree, "value"), "unstaged candidate\n");
    writeFileSync(join(repo.worktree, "untracked"), "preserve me\n");
    const head = repo.git(repo.worktree, "rev-parse", "HEAD"), status = repo.git(repo.worktree, "status", "--porcelain");
    const common = join(repo.primary, ".git", "dagu-feature"), resources = join(common, "resources");
    const resource = join(resources, readdirSync(resources)[0]!);
    const owner = repo.git(repo.worktree, "rev-parse", "--path-format=absolute", "--git-path", "dagu-feature-owner");
    const retainedResource = readFileSync(resource, "utf8"), retainedIdentity = readFileSync(owner, "utf8");
    repo.history("feature", [repo.row("owner", "failed"), repo.row("replacement-b", "running")]);
    result = run("replacement-b", { GATE: "" });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /rule=start_gate.gate/);
    assert.equal(readFileSync(join(common, "owners", "issue-215"), "utf8"), `replacement-b\t${repo.branch}\n`);
    assert.equal(readFileSync(join(common, "runs", "replacement-b", "previous-owner"), "utf8"), "owner\n");
    assert.equal(readFileSync(resource, "utf8"), retainedResource);
    assert.equal(readFileSync(owner, "utf8"), retainedIdentity);
    const snapshot = join(repo.root, "predecessor-spec.json");
    writeFileSync(snapshot, JSON.stringify({ spec: `env:\n  - PRIMARY: ${JSON.stringify(repo.primary)}\n` }));
    writeFileSync(join(repo.root, "bin", "curl"), `#!/bin/sh\ncat '${snapshot}'\n`, { mode: 0o755 });
    repo.history("feature", [
      repo.row("owner", "failed"),
      { ...repo.row("replacement-b", "aborted"), params: "ISSUE=215 OMP_SESSION_ID=resource-test-session" },
      repo.row("replacement-c", "running"),
    ]);
    result = run("replacement-c"); assert.equal(result.status, 0, result.stderr);
    const state = join(common, "runs", "replacement-c");
    assert.equal(readFileSync(join(state, "previous-owner"), "utf8"), "replacement-b\n");
    assert.equal(readFileSync(join(common, "owners", "issue-215"), "utf8"), `replacement-c\t${repo.branch}\n`);
    assert.equal(JSON.parse(readFileSync(resource, "utf8")).run, "replacement-c");
    assert.equal(readFileSync(resource, "utf8"), readFileSync(join(state, "resource.json"), "utf8"));
    assert.equal(JSON.parse(readFileSync(owner, "utf8")).run, "replacement-c");
    assert.equal(readFileSync(owner, "utf8"), readFileSync(join(state, "identity"), "utf8"));
    assert.equal(repo.git(repo.worktree, "rev-parse", "HEAD"), head);
    assert.equal(repo.git(repo.worktree, "status", "--porcelain"), status);
    assert.equal(repo.git(repo.worktree, "show", ":value"), "staged candidate");
    assert.equal(readFileSync(join(repo.worktree, "value"), "utf8"), "unstaged candidate\n");
    assert.equal(readFileSync(join(repo.worktree, "untracked"), "utf8"), "preserve me\n");
    // Completed adoption does not depend on older history remaining available.
    repo.history("feature", [repo.row("replacement-c", "running")]);
    result = run("replacement-c"); assert.equal(result.status, 0, result.stderr);
    assert.equal(repo.git(repo.worktree, "rev-parse", "HEAD"), head);
    assert.equal(repo.git(repo.worktree, "status", "--porcelain"), status);
  });

  test(`${definition} multi-hop replacement rejects unverified predecessor chains with resource_identity`, t => {
    const repo = fixture(); t.after(() => rmSync(repo.root, { recursive: true, force: true }));
    const create = script(definition, "  - id: start_gate");
    const run = (run: string, extra = {}) => spawnSync("bash", ["-c", create], { env: { ...repo.env, RUN: run, ...extra }, encoding: "utf8" });
    repo.history("feature", [repo.row("owner", "running")]);
    let result = run("owner"); assert.equal(result.status, 0, result.stderr);
    writeFileSync(join(repo.worktree, "untracked"), "preserve me\n");
    const common = join(repo.primary, ".git", "dagu-feature"), resources = join(common, "resources");
    const resource = join(resources, readdirSync(resources)[0]!);
    const retainedResource = readFileSync(resource, "utf8");
    const owner = repo.git(repo.worktree, "rev-parse", "--path-format=absolute", "--git-path", "dagu-feature-owner");
    const retainedIdentity = readFileSync(owner, "utf8"), head = repo.git(repo.worktree, "rev-parse", "HEAD");
    const rows = () => [repo.row("owner", "failed"), repo.row("replacement-b", "aborted"), repo.row("replacement-c", "running")];
    repo.history("feature", rows().filter(row => row.dagRunId !== "replacement-c"));
    result = run("replacement-b", { GATE: "" }); assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /rule=start_gate.gate/);
    repo.history("feature", rows());
    result = spawnSync("bash", ["-c", script(definition, "  - id: admit")], { env: { ...repo.env, RUN: "replacement-c" }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const previous = join(common, "runs", "replacement-b", "previous-owner");
    const cases: Array<[string, () => void]> = [
      ...["owner", "replacement-b"].flatMap(run => ["queued", "running", "waiting"].map(status =>
        [`${run} ${status}`, () => repo.history("feature", rows().map(row => row.dagRunId === run ? { ...row, status } : row))] as [string, () => void])),
      ["outside chain", () => {
        writeFileSync(resource, JSON.stringify({ ...JSON.parse(retainedResource), run: "unrelated" }));
        repo.history("feature", [...rows(), repo.row("unrelated", "failed")]);
      }],
      ["missing predecessor", () => repo.history("feature", rows().filter(row => row.dagRunId !== "owner"))],
      ["ambiguous predecessor", () => repo.history("feature", [...rows(), repo.row("owner", "failed")])],
      ["unknown predecessor status", () => repo.history("feature", rows().map(row => row.dagRunId === "owner" ? { ...row, status: "unknown" } : row))],
      ["cyclic chain", () => writeFileSync(previous, "replacement-b\n")],
      ["invalid predecessor", () => writeFileSync(previous, "../owner\n")],
      ["incomplete chain", () => writeFileSync(previous, "\n")],
      ...["primary", "branch", "worktree"].map(key =>
        [`resource ${key} mismatch`, () => writeFileSync(resource, JSON.stringify({ ...JSON.parse(retainedResource), [key]: "unrelated" }))] as [string, () => void]),
      ...[
        `PRIMARY=${repo.root} ISSUE=215 BRANCH=${repo.branch}`,
        `PRIMARY=${repo.primary} ISSUE=216 BRANCH=${repo.branch}`,
        `PRIMARY=${repo.primary} ISSUE=215 BRANCH=dagu/unrelated`,
        `PRIMARY=${repo.primary} ISSUE=215 BRANCH=${repo.branch} WORKTREE=${repo.root}`,
      ].map(params => [`predecessor identity ${params}`, () => repo.history("feature", rows().map(row => row.dagRunId === "replacement-b" ? { ...row, params } : row))] as [string, () => void]),
    ];
    for (const [name, arrange] of cases) {
      writeFileSync(resource, retainedResource); writeFileSync(previous, "owner\n"); repo.history("feature", rows());
      arrange();
      const before = readFileSync(resource, "utf8");
      result = run("replacement-c");
      assert.equal(result.status, 1, `${name}: ${result.stderr}`);
      assert.match(result.stderr, /rule=start_gate.resource_identity/, name);
      assert.equal(readFileSync(resource, "utf8"), before, name);
      assert.equal(readFileSync(owner, "utf8"), retainedIdentity, name);
      assert.equal(repo.git(repo.worktree, "rev-parse", "HEAD"), head, name);
      assert.equal(readFileSync(join(repo.worktree, "untracked"), "utf8"), "preserve me\n", name);
      assert.equal(existsSync(join(common, "owners", "issue-215.lock")), false, name);
    }
  });

  test(`${definition} simultaneous admission selects one owner and same-owner concurrent creation converges`, async t => {
    const repo = fixture(); t.after(() => rmSync(repo.root, { recursive: true, force: true }));
    repo.history("feature", [repo.row("first", "queued"), repo.row("second", "queued")]);
    const admit = script(definition, "  - id: admit");
    const launch = (body: string, run: string) => new Promise<{ code: number | null; error: string }>(resolve => {
      const child = spawn("bash", ["-c", body], { env: { ...repo.env, RUN: run } }); let error = "";
      child.stderr.on("data", chunk => { error += chunk; }); child.on("close", code => resolve({ code, error }));
    });
    const outcomes = await Promise.all([launch(admit, "first"), launch(admit, "second")]);
    assert.deepEqual(outcomes.map(r => r.code).sort(), [0, 1], JSON.stringify(outcomes));
    const winner = outcomes[0]!.code === 0 ? "first" : "second";
    assert.match(outcomes.find(r => r.code === 1)!.error, /belongs to active run .* \(queued\)/);
    const create = script(definition, "  - id: start_gate");
    const creations = await Promise.all([launch(create, winner), launch(create, winner)]);
    assert.deepEqual(creations.map(r => r.code), [0, 0], JSON.stringify(creations));
    assert.equal(repo.git(repo.primary, "worktree", "list", "--porcelain").match(/worktree /g)?.length, 2);
    assert.equal(repo.git(repo.primary, "for-each-ref", "--format=%(refname)", "refs/heads/dagu/"), `refs/heads/${repo.branch}`);
    assert.equal(readFileSync(join(repo.primary, ".git", "dagu-feature", "owners", "issue-215"), "utf8"), `${winner}\t${repo.branch}\n`);
  });
}

for (const path of ["../../skills/issue-execution/poc.yaml", renderedPoc]) {
  const definition = fileURLToPath(new URL(path, import.meta.url));
  test(`${path} PoC concurrent retries reuse the canonical run candidate and preserve files`, async t => {
    const repo = fixture(); t.after(() => rmSync(repo.root, { recursive: true, force: true }));
    const state = join(repo.primary, ".git", "poc", "runs", "owner");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "base.sha"), repo.git(repo.primary, "rev-parse", "HEAD"));
    const worktree = join(repo.primary, ".workspace", "worktrees", "poc-owner");
    const env = { ...repo.env, WORKTREE: worktree, DAGU_OUTPUT_FILE: join(repo.root, "outputs") };
    const create = script(definition, "  - id: worktree");
    const launch = () => new Promise<{ code: number | null; error: string }>(resolve => {
      const child = spawn("bash", ["-c", create], { env }); let error = "";
      child.stderr.on("data", chunk => { error += chunk; }); child.on("close", code => resolve({ code, error }));
    });
    const outcomes = await Promise.all([launch(), launch()]);
    assert.deepEqual(outcomes.map(result => result.code), [0, 0], JSON.stringify(outcomes));
    writeFileSync(join(worktree, "candidate"), "preserved\n");
    const retry = await launch(); assert.equal(retry.code, 0, retry.error);
    assert.equal(readFileSync(join(worktree, "candidate"), "utf8"), "preserved\n");
    assert.equal(repo.git(repo.primary, "for-each-ref", "--format=%(refname)", "refs/heads/poc/"), "refs/heads/poc/owner");
    assert.equal(repo.git(repo.primary, "worktree", "list", "--porcelain").match(/worktree /g)?.length, 2);
  });
}

for (const definition of [...definitions, ...["../../skills/issue-execution/poc.yaml", renderedPoc].map(path => fileURLToPath(new URL(path, import.meta.url)))]) {
  test(`${definition} primary-target rejection preserves a primary without a managed directory`, t => {
    const repo = fixture(); t.after(() => rmSync(repo.root, { recursive: true, force: true }));
    const before = JSON.stringify([readdirSync(repo.primary), repo.git(repo.primary, "show-ref"), repo.git(repo.primary, "worktree", "list", "--porcelain"), readFileSync(join(repo.primary, "value"), "utf8")]);
    const markers = definition.endsWith("/poc.yaml") ? ["  - id: worktree", "  exit:"] : ["  - id: admit", "  - id: close_gate", "  exit:"];
    for (const marker of markers) {
      const result = spawnSync("bash", ["-c", script(definition, marker)], { env: { ...repo.env, WORKTREE: repo.primary }, encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /protected primary/);
      assert.equal(JSON.stringify([readdirSync(repo.primary), repo.git(repo.primary, "show-ref"), repo.git(repo.primary, "worktree", "list", "--porcelain"), readFileSync(join(repo.primary, "value"), "utf8")]), before);
    }
  });
}
