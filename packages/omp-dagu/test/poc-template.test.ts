import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { withResourceGuard } from "./resource-fixtures.ts";
import "./waiting-cancellation.test.ts";

for (const [name, definition] of [
  ["template", new URL("../skills/dagu-feature/poc.yaml", import.meta.url)],
  ["rendered DAG", new URL("../../../.workspace/dagu/dags/poc.yaml", import.meta.url)],
] as const) {
  test(`${name} PoC base accepts a symlinked primary and creates its worktree`, () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-dagu-poc-symlink-")));
    const primary = join(root, "primary-link");
    const actual = join(root, "primary");
    const remote = join(root, "remote.git");
    const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
    try {
      git("init", "--bare", "-b", "main", remote);
      git("init", "-b", "main", actual);
      symlinkSync(actual, primary, "dir");
      git("-C", primary, "config", "user.name", "PoC test");
      git("-C", primary, "config", "user.email", "poc@example.invalid");
      writeFileSync(join(primary, ".gitignore"), "/.workspace/\n");
      git("-C", primary, "add", ".");
      git("-C", primary, "commit", "-m", "seed");
      git("-C", primary, "remote", "add", "origin", remote);
      git("-C", primary, "push", "origin", "main");
      const state = join(primary, ".git", "poc", "runs", "symlink-test");
      mkdirSync(state, { recursive: true });
      const worktree = join(primary, ".workspace", "worktrees", "poc-symlink-test");
      const source = readFileSync(definition, "utf8").split("\n");
      const script = (id: string) => {
        const start = source.indexOf("    run: |", source.indexOf(`  - id: ${id}`)) + 1;
        assert.ok(start > 0);
        let end = start;
        while (end < source.length && (source[end]!.startsWith("      ") || source[end] === "")) end++;
        return withResourceGuard(source.slice(start, end).map(line => line.slice(6)).join("\n"), fileURLToPath(definition));
      };
      for (const id of ["base", "worktree"]) {
        const result = spawnSync("bash", ["-c", script(id)], {
          encoding: "utf8",
          env: { ...process.env, DAGU_PARAMS_JSON: "{}", PRIMARY: primary, WORKTREE: worktree, BASE_BRANCH: "main", RUN: "symlink-test", DAGU_FEATURE_BUNDLE: "test", DAGU_OUTPUT_FILE: join(root, "outputs") },
        });
        assert.equal(result.status, 0, `${id}\n${result.stdout}\n${result.stderr}`);
      }
      assert.ok(existsSync(worktree));
      assert.equal(git("-C", worktree, "branch", "--show-current"), "poc/symlink-test");
      assert.equal(readFileSync(join(state, "base.sha"), "utf8").trim(), git("-C", worktree, "rev-parse", "HEAD"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

const template = new URL("../skills/dagu-feature/poc.yaml", import.meta.url);

function pocScript(id: string): string {
  const lines = readFileSync(template, "utf8").split("\n");
  const start = lines.indexOf(`  - id: ${id}`);
  assert.ok(start >= 0, `missing step ${id}`);
  const run = lines.findIndex((line, index) => index > start && /^    run: (?:&publish )?\|$/.test(line));
  assert.ok(run > start, `missing script for ${id}`);
  let end = run + 1;
  while (end < lines.length && (lines[end]!.startsWith("      ") || lines[end] === "")) end++;
  return lines.slice(run + 1, end).map(line => line.slice(6)).join("\n");
}

function pocFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "poc-existing-issue-")));
  const primary = join(root, "primary");
  const bin = join(root, "bin");
  mkdirSync(primary);
  mkdirSync(bin);
  symlinkSync(fileURLToPath(new URL("../bin/dagu-pr-body.mjs", import.meta.url)), join(bin, "dagu-pr-body"));
  execFileSync("git", ["init", "-q", primary]);
  const state = join(primary, ".git", "poc", "runs", "existing-issue");
  const issue = join(root, "issue.json");
  const pages = join(root, "pages.json");
  const calls = join(root, "calls.jsonl");
  const enqueues = join(root, "enqueue.jsonl");
  writeFileSync(calls, "");
  writeFileSync(enqueues, "");
  writeFileSync(pages, "[]");
  writeFileSync(join(bin, "gh"), `#!/bin/bash
set -euo pipefail
jq -nc --args '$ARGS.positional' -- "$@" >> "$FAKE_GH_CALLS"
case "$1 $2" in
  "repo view") printf 'owner/repo\\n' ;;
  "issue view") cat "$FAKE_ISSUE" ;;
  "api --paginate") cat "$FAKE_PAGES" ;;
  "issue comment") printf 'https://example.test/comments/9\\n' ;;
  "issue edit")
    while (($#)); do
      if [[ "$1" == --body-file ]]; then
        jq -n --rawfile body "$2" '{body:$body}' > "$FAKE_ISSUE"
        exit 0
      fi
      shift
    done
    exit 1 ;;
  *) printf 'unexpected gh call: %s\\n' "$*" >&2; exit 1 ;;
esac
`);
  writeFileSync(join(bin, "dagu-feature-bundle"), `#!/bin/bash
set -euo pipefail
jq -nc --args '$ARGS.positional' -- "$@" >> "$FAKE_ENQUEUES"
`);
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "dagu-feature-bundle"), 0o755);
  const env = {
    ...process.env, DAGU_PARAMS_JSON: "{}", PRIMARY: primary,
    WORKTREE: join(root, "worktree"), RUN: "existing-issue", ISSUE: "41",
    QUESTION: "", BASE_BRANCH: "main", OMP_SESSION_ID: "same-session",
    FAKE_GH_CALLS: calls, FAKE_ISSUE: issue, FAKE_PAGES: pages, FAKE_ENQUEUES: enqueues,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
  return {
    root, state, issue, pages, calls, enqueues, primary,
    run(id: string, overrides: NodeJS.ProcessEnv = {}) {
      return spawnSync("bash", ["-c", pocScript(id)], { encoding: "utf8", env: { ...env, ...overrides } });
    },
    body(body: string) { writeFileSync(issue, JSON.stringify({ body })); },
    save(name: string, value: string) { writeFileSync(join(state, name), value); },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

test("PoC records an existing issue and reads only its PoC section when QUESTION is empty", () => {
  const fixture = pocFixture();
  try {
    fixture.body("# Context\r\nOther work\r\n\r\n## PoC\r\nCan the real target run?\r\n\r\n## Veredicto\r\nPending\r\n");
    const result = fixture.run("record");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(fixture.state, "issue.number"), "utf8"), "41\n");
    assert.equal(readFileSync(join(fixture.state, "question.txt"), "utf8").trim(), "Can the real target run?");
    assert.deepEqual(readFileSync(fixture.calls, "utf8").trim().split("\n").map(line => JSON.parse(line)), [
      ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
      ["issue", "view", "41", "--repo", "owner/repo", "--json", "body"],
    ]);
  } finally {
    fixture.cleanup();
  }
});

test("PoC requires a numbered ISSUE and a nonempty question or PoC section", () => {
  const fixture = pocFixture();
  try {
    fixture.body("## Problem\nUnrelated feature description\n```\n## PoC\nFenced text\n```\n");
    for (const ISSUE of ["", "0", "not-an-issue"]) {
      assert.notEqual(fixture.run("record", { ISSUE, QUESTION: "Explicit question" }).status, 0);
    }
    assert.notEqual(fixture.run("record").status, 0);
    fixture.body("## PoC\n \n## Veredicto\nPending\n");
    assert.notEqual(fixture.run("record").status, 0);
    const explicit = fixture.run("record", { QUESTION: "Question from feature triage" });
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.equal(readFileSync(join(fixture.state, "question.txt"), "utf8"), "Question from feature triage\n");
  } finally {
    fixture.cleanup();
  }
});

for (const origin of ["backlog", "feature-triage"] as const) {
  test(`PoC promotes a complete PASS from ${origin} using the same issue and session`, () => {
    const fixture = pocFixture();
    try {
      const question = origin === "backlog" ? "Can the target run?" : "Question from feature triage";
      fixture.body(`## PoC\n${origin === "backlog" ? question : "Earlier question"}\n\n## Después del PASS\nImplement the verified path.\n`);
      const record = fixture.run("record", { QUESTION: origin === "backlog" ? "" : question });
      assert.equal(record.status, 0, record.stderr);
      const result = `<!-- poc-verdict:PASS scope:OK run:existing-issue attempt:1 base:abc -->\n\nVERDICT: PASS\n## Pregunta\n${question}\n## Proposición demostrada\nThe target runs.\n## Ruta ejercitada\nReal target release.\n## Comandos y salida\ncommand: PASS\n## Después del PASS\nImplement the verified path.\n`;
      const comments = [
        ...(origin === "feature-triage" ? [{ body: `<!-- poc-triage:yes run:feature -->\n\n## Pregunta\n${question}\n` }] : []),
        { body: result, html_url: "https://example.test/comments/9" },
      ];
      writeFileSync(fixture.pages, JSON.stringify([comments]));
      fixture.save("verdict", "PASS\n");
      fixture.save("scope", "OK\n");
      const promoted = fixture.run("dispose", { PROMOTE: "yes" });
      assert.equal(promoted.status, 0, promoted.stderr);
      const enqueues = readFileSync(fixture.enqueues, "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.deepEqual(enqueues, [[
        "enqueue", "--run-id", "feature-existing-issue",
        join(fixture.primary, ".workspace", "dagu", "dags", "feature.yaml"), "--",
        "ISSUE=41", "BASE_BRANCH=main", "OMP_SESSION_ID=same-session",
        "POC_BASIS=https://example.test/comments/9",
      ]]);
    } finally {
      fixture.cleanup();
    }
  });
}

test("PoC failure publication and a negative decision preserve the existing issue", () => {
  const fixture = pocFixture();
  try {
    fixture.body("## PoC\nCan the target run?\n");
    const record = fixture.run("record");
    assert.equal(record.status, 0, record.stderr);
    const original = readFileSync(fixture.issue, "utf8");
    const published = fixture.run("publish", { PUBLICATION_FAILURE: "yes" });
    assert.equal(published.status, 0, published.stderr);
    assert.equal(readFileSync(join(fixture.state, "verdict"), "utf8"), "ORCHESTRATION_FAILURE\n");
    for (const verdict of ["FAIL", "INCONCLUSIVE", "ORCHESTRATION_FAILURE"]) {
      fixture.save("verdict", `${verdict}\n`);
      const disposed = fixture.run("dispose", { PROMOTE: "no" });
      assert.equal(disposed.status, 0, disposed.stderr);
      assert.equal(readFileSync(fixture.issue, "utf8"), original);
    }
    const calls = readFileSync(fixture.calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(calls.map(args => args.slice(0, 2)), [
      ["repo", "view"], ["issue", "view"], ["issue", "comment"],
    ]);
  } finally {
    fixture.cleanup();
  }
});

for (const verdict of ["PASS", "FAIL"] as const) {
  test(`PoC decide recovery replays ${verdict} publication for the same run and attempt`, () => {
    const fixture = pocFixture();
    try {
      const original = "## PoC\nCan the target run?\n";
      fixture.body(original);
      const record = fixture.run("record");
      assert.equal(record.status, 0, record.stderr);
      fixture.save("base.sha", "abc\n");
      fixture.save("attempt", "3\n");
      fixture.save("scope", "OK\n");
      fixture.save("result.md", `VERDICT: ${verdict}\n\n## Después del PASS\nImplement the verified path.\n`);
      let firstComment = "";
      for (const publication of [1, 2]) {
        const result = fixture.run("publish");
        assert.equal(result.status, 0, result.stderr);
        const comment = readFileSync(join(fixture.state, "comment-3.txt"), "utf8");
        assert.equal(comment.split("\n")[0],
          `<!-- poc-verdict:${verdict} scope:OK run:existing-issue attempt:3 base:abc -->`);
        if (publication === 1) firstComment = comment;
        else assert.equal(comment, firstComment);
        const calls: string[][] = readFileSync(fixture.calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
        assert.equal(calls.filter(args => args[0] === "issue" && args[1] === "comment").length, publication);
        assert.equal(calls.filter(args => args[0] === "issue" && args[1] === "edit").length, verdict === "PASS" ? publication : 0);
        const body: string = JSON.parse(readFileSync(fixture.issue, "utf8")).body;
        const expectedSections = verdict === "PASS" ? publication : 0;
        assert.ok(body.startsWith(original));
        assert.equal(body.split("\n## Después del PASS\n").length - 1, expectedSections);
        assert.equal(body.split("Implement the verified path.").length - 1, expectedSections);
        if (verdict === "FAIL") assert.equal(body, original);
      }
    } finally {
      fixture.cleanup();
    }
  });
}

test("PoC cancelled failure handler preserves evidence without publishing a verdict", () => {
  const fixture = pocFixture();
  try {
    mkdirSync(fixture.state, { recursive: true });
    fixture.save("cancellation.json", '{"outcome":"cancelled","checkpoint":"run_poc"}\n');
    const result = fixture.run("publish", { PUBLICATION_FAILURE: "yes" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(fixture.calls, "utf8"), "");
    assert.equal(readFileSync(fixture.enqueues, "utf8"), "");
    assert.ok(existsSync(join(fixture.state, "cancellation.json")));
  } finally { fixture.cleanup(); }
});

function pocExitScript(): string {
  const lines = readFileSync(template, "utf8").split("\n");
  const start = lines.indexOf("  exit:");
  assert.ok(start >= 0);
  return withResourceGuard(lines.slice(start + 2).map(line => line.slice(6)).join("\n"), fileURLToPath(template));
}

function cleanupFixture() {
  const fixture = pocFixture();
  const git = (...args: string[]) => execFileSync("git", ["-C", fixture.primary, ...args], { encoding: "utf8" }).trim();
  git("config", "user.name", "PoC cleanup test");
  git("config", "user.email", "poc@example.invalid");
  writeFileSync(join(fixture.primary, ".gitignore"), "/.workspace/\nignored-probe\n");
  writeFileSync(join(fixture.primary, "tracked.bin"), Buffer.from([0, 1, 2, 3]));
  git("add", ".");
  git("commit", "-qm", "seed");
  fixture.body("## PoC\nCan the real target run?\n");
  const record = fixture.run("record");
  assert.equal(record.status, 0, record.stderr);
  const worktree = join(fixture.primary, ".workspace", "worktrees", "poc-existing-issue");
  git("worktree", "add", "-b", "poc/existing-issue", worktree);
  fixture.save("base.sha", `${git("rev-parse", "HEAD")}\n`);
  return {
    ...fixture, worktree, git,
    dirty() {
      writeFileSync(join(worktree, "tracked.bin"), Buffer.from([0, 4, 5, 6]));
      writeFileSync(join(worktree, "untracked binary.bin"), Buffer.from([0, 7, 8, 9]));
      writeFileSync(join(worktree, "probe.txt"), "published probe\n");
    },
    publish(verdict = "PASS") {
      fixture.save("scope", "OK\n");
      fixture.save("result.md", `VERDICT: ${verdict}\n\n## Después del PASS\nImplement the verified path.\n`);
      const result = fixture.run("publish", { WORKTREE: worktree });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(readFileSync(join(fixture.state, "comment.url"), "utf8").trim());
    },
    exit() {
      return spawnSync("bash", ["-c", pocExitScript()], {
        encoding: "utf8",
        env: { ...process.env, DAGU_PARAMS_JSON: "{}", PRIMARY: fixture.primary, WORKTREE: worktree, RUN: "existing-issue" },
      });
    },
    branchExists() {
      return spawnSync("git", ["-C", fixture.primary, "show-ref", "--verify", "--quiet", "refs/heads/poc/existing-issue"]).status === 0;
    },
  };
}

test("PoC publication checks both result prose and patch content before any GitHub mutation", () => {
  const fixture = cleanupFixture();
  try {
    const before = readFileSync(fixture.calls, "utf8");
    for (const [result, patch] of [
      ["VERDICT: FAIL\nEvidence: /Users/example/private/repo\n", "Safe probe\n"],
      ["VERDICT: FAIL\nSafe evidence\n", "Config: /home/example/private/repo\n"],
    ]) {
      fixture.save("result.md", result!);
      writeFileSync(join(fixture.worktree, "probe.txt"), patch!);
      const rejected = fixture.run("publish", { WORKTREE: fixture.worktree });
      assert.equal(rejected.status, 1, rejected.stderr);
      assert.match(rejected.stderr, /host absolute path/);
      assert.equal(readFileSync(fixture.calls, "utf8"), before);
      assert.ok(existsSync(join(fixture.state, "comment-1.txt")));
    }
  } finally { fixture.cleanup(); }
});

for (const outcome of ["PASS", "FAIL", "promote=no"]) {
  test(`PoC cleanup removes published tracked and untracked binary probes after ${outcome}`, () => {
    const fixture = cleanupFixture();
    try {
      fixture.dirty();
      fixture.publish(outcome === "FAIL" ? "FAIL" : "PASS");
      const patch = readFileSync(join(fixture.state, "full.patch"), "utf8");
      assert.match(patch, /GIT binary patch/);
      assert.match(patch, /untracked binary.bin/);
      assert.match(patch, /probe.txt/);
      if (outcome === "promote=no") {
        const disposed = fixture.run("dispose", { PROMOTE: "no" });
        assert.equal(disposed.status, 0, disposed.stderr);
      }
      const result = fixture.exit();
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(fixture.worktree), false);
      assert.equal(fixture.branchExists(), false);
      const repeated = fixture.exit();
      assert.equal(repeated.status, 0, repeated.stderr);
    } finally {
      fixture.cleanup();
    }
  });
}

for (const evidence of ["mutated tracked", "mutated untracked", "new untracked", "missing patch", "missing marker", "empty marker", "unpublished"]) {
  test(`PoC cleanup retains unpublished bytes with ${evidence}`, () => {
    const fixture = cleanupFixture();
    try {
      fixture.dirty();
      if (evidence !== "unpublished") fixture.publish();
      if (evidence === "mutated tracked") writeFileSync(join(fixture.worktree, "tracked.bin"), Buffer.from([0, 10, 11]));
      if (evidence === "mutated untracked") writeFileSync(join(fixture.worktree, "untracked binary.bin"), Buffer.from([0, 12, 13]));
      if (evidence === "new untracked") writeFileSync(join(fixture.worktree, "later.txt"), "unpublished\n");
      if (evidence === "missing patch") rmSync(join(fixture.state, "full.patch"));
      if (evidence === "missing marker") rmSync(join(fixture.state, "comment.url"));
      if (evidence === "empty marker") fixture.save("comment.url", "");
      const tracked = readFileSync(join(fixture.worktree, "tracked.bin"));
      const untracked = readFileSync(join(fixture.worktree, "untracked binary.bin"));
      const result = fixture.exit();
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stderr.trim(), `cleanup retained: worktree ${fixture.worktree} has unpublished changes; evidence ${fixture.state}`);
      assert.ok(fixture.branchExists());
      assert.deepEqual(readFileSync(join(fixture.worktree, "tracked.bin")), tracked);
      assert.deepEqual(readFileSync(join(fixture.worktree, "untracked binary.bin")), untracked);
      if (evidence === "new untracked") assert.equal(readFileSync(join(fixture.worktree, "later.txt"), "utf8"), "unpublished\n");
    } finally {
      fixture.cleanup();
    }
  });
}

test("PoC clean cleanup requires no publication and is idempotent", () => {
  const fixture = cleanupFixture();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = fixture.exit();
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(fixture.worktree), false);
      assert.equal(fixture.branchExists(), false);
    }
  } finally {
    fixture.cleanup();
  }
});
