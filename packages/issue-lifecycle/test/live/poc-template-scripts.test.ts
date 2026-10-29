import { renderedPoc } from "../fixtures/rendered-feature.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { withResourceGuard } from "../resource-fixtures.ts";
import { exampleConfig, serializeConfig } from "../../src/config.ts";
import { preflightAdmission } from "../../src/admission.ts";
import { a4sBin } from "../fixtures/a4s.ts";

function withConsumerConfig(primary: string, home: string, run: () => void): void {
  const config = join(primary, ".workspace", "dagu", "config.json");
  mkdirSync(join(config, ".."), { recursive: true });
  writeFileSync(config, serializeConfig(exampleConfig({ lane: "poc-fixture" })));
  execFileSync("git", ["-C", primary, "add", ".workspace/dagu/config.json"], { stdio: "pipe" });
  execFileSync("git", ["-C", primary, "-c", "user.name=PoC test", "-c", "user.email=poc@example.invalid", "commit", "-qm", "config"], { stdio: "pipe" });
  mkdirSync(home, { recursive: true });
  const previousPrimary = process.env.A4S_PRIMARY;
  const previousHome = process.env.DAGU_HOME;
  process.env.A4S_PRIMARY = primary;
  process.env.DAGU_HOME = home;
  try { run(); }
  finally {
    if (previousPrimary === undefined) delete process.env.A4S_PRIMARY;
    else process.env.A4S_PRIMARY = previousPrimary;
    if (previousHome === undefined) delete process.env.DAGU_HOME;
    else process.env.DAGU_HOME = previousHome;
  }
}

for (const [name, definition] of [
  ["template", new URL("../../skills/issue-execution/poc.yaml", import.meta.url)],
  ["rendered DAG", new URL(renderedPoc, import.meta.url)],
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

const template = new URL("../../skills/issue-execution/poc.yaml", import.meta.url);

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
  execFileSync("git", ["init", "-q", primary]);
  execFileSync("git", ["init", "--bare", "-q", join(root, "origin.git")]);
  execFileSync("git", ["-C", primary, "remote", "add", "origin", join(root, "origin.git")]);
  const state = join(primary, ".git", "poc", "runs", "existing-issue");
  const issue = join(root, "issue.json");
  const pages = join(root, "pages.json");
  const calls = join(root, "calls.jsonl");
  const enqueues = join(root, "enqueue.jsonl");
  const published = join(root, "published.jsonl");
  writeFileSync(published, "");
  writeFileSync(calls, "");
  writeFileSync(enqueues, "");
  writeFileSync(pages, "[]");
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash
set -euo pipefail
jq -nc --args '$ARGS.positional' -- "$@" >> "$FAKE_GH_CALLS"
case "$1 $2" in
  "repo view") printf 'owner/repo\\n' ;;
  "issue view") cat "$FAKE_ISSUE" ;;
  "api --paginate") cat "$FAKE_PAGES" ;;
  "issue comment")
    while (($#)); do
      if [[ "$1" == --body-file ]]; then
        if [[ "\${FAKE_LARGE_COMMENT:-}" == yes && "$2" == */comment-*.txt ]]; then
          printf 'body too large\\n' >&2
          exit 1
        fi
        jq -nc --rawfile body "$2" '$body' >> "$FAKE_PUBLISHED"
        printf 'https://example.test/comments/9\\n'
        exit 0
      fi
      shift
    done
    exit 1 ;;
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
  writeFileSync(join(bin, "a4s"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == enqueue ]]; then
  jq -nc --args '$ARGS.positional' -- "$@" >> "$FAKE_ENQUEUES"
else
  exec ${JSON.stringify(a4sBin)} "$@"
fi
`);
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "a4s"), 0o755);
  const env = {
    ...process.env, A4S_BIN: join(bin, "a4s"), DAGU_PARAMS_JSON: "{}", PRIMARY: primary,
    WORKTREE: join(root, "worktree"), RUN: "existing-issue", ISSUE: "41",
    QUESTION: "", BASE_BRANCH: "main", OMP_SESSION_ID: "same-session",
    FAKE_GH_CALLS: calls, FAKE_ISSUE: issue, FAKE_PAGES: pages, FAKE_ENQUEUES: enqueues,
    FAKE_PUBLISHED: published,
    DAGU_OUTPUT_FILE: join(root, "outputs"),
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
  return {
    root, state, issue, pages, calls, enqueues, primary, published,
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
    assert.match(readFileSync(join(fixture.root, "outputs"), "utf8"), /question<<QUESTION_\d+_\d+\nCan the real target run\?\nQUESTION_\d+_\d+\n/);
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
      writeFileSync(join(fixture.state, "full.patch"), "published candidate\n");
      const promoted = fixture.run("dispose", { PROMOTE: "yes" });
      assert.equal(promoted.status, 0, promoted.stderr);
      const enqueues = readFileSync(fixture.enqueues, "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.deepEqual(enqueues, [[
        "enqueue", "--parent", join(fixture.primary, ".git", "dagu-feature", "runs", "existing-issue", "receipt.json"),
        "--run-id", "feature-existing-issue",
        join(fixture.primary, ".workspace", "dagu", "dags", "feature.yaml"), "--",
        "ISSUE=41", "OMP_SESSION_ID=same-session",
        "POC_BASIS=https://example.test/comments/9",
      ]]);
      const digest = execFileSync("shasum", ["-a", "256", join(fixture.state, "full.patch")], { encoding: "utf8" }).slice(0, 64);
      assert.equal(readFileSync(join(fixture.state, "full.patch.sha256"), "utf8").trim(), digest);
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
      const patchPath = join(fixture.state, "full.patch");
      const digest = execFileSync("shasum", ["-a", "256", patchPath], { encoding: "utf8" }).slice(0, 64);
      assert.equal(readFileSync(`${patchPath}.sha256`, "utf8").trim(), digest);
    },
    exit() {
      return spawnSync("bash", ["-c", pocExitScript()], {
        encoding: "utf8",
        env: { ...process.env, DAGU_PARAMS_JSON: "{}", PRIMARY: fixture.primary, WORKTREE: worktree, RUN: "existing-issue", DAGU_OUTPUT_FILE: join(fixture.root, "exit-outputs") },
      });
    },
    branchExists() {
      return spawnSync("git", ["-C", fixture.primary, "show-ref", "--verify", "--quiet", "refs/heads/poc/existing-issue"]).status === 0;
    },
  };
}

for (const mode of ["local", "pushed", "unreachable"] as const) {
  test(`PoC scope gate checks the actual origin: ${mode}`, () => {
    const fixture = cleanupFixture();
    try {
      const remote = join(fixture.root, "remote.git");
      execFileSync("git", ["init", "--bare", "-q", remote]);
      fixture.git("remote", "set-url", "origin", remote);
      const resultPath = join(fixture.state, "input.md");
      fixture.save("result.path", resultPath);
      writeFileSync(resultPath, "VERDICT: PASS\n## Pregunta\nCan the real target run?\n## Proposición demostrada\nObserved target\n## Ruta ejercitada\nReal target release digest\n## Comandos y salida\ncommand: PASS\n## Después del PASS\nImplement verified route\n");
      if (mode === "pushed") fixture.git("push", "origin", "poc/existing-issue");
      if (mode === "unreachable") fixture.git("remote", "set-url", "origin", join(fixture.root, "missing.git"));
      const result = fixture.run("scope_gate", { WORKTREE: fixture.worktree, TEST_PATHS: "^tests/" });
      assert.equal(result.status, mode === "local" ? 0 : 1, result.stderr);
      assert.equal(readFileSync(join(fixture.state, "scope"), "utf8").trim(), mode === "local" ? "OK" : "FAIL");
      if (mode === "pushed") assert.equal(readFileSync(join(fixture.state, "scope-errors"), "utf8"), `rule=poc-branch-pushed branch=refs/heads/poc/existing-issue SHA=${fixture.git("rev-parse", "HEAD")}\n`);
      if (mode === "unreachable") assert.equal(readFileSync(join(fixture.state, "scope-errors"), "utf8"), "rule=remote-unreachable branch=refs/heads/poc/existing-issue\n");
    } finally { fixture.cleanup(); }
  });
}
test("PoC prompt requires public-safe placeholders and retained raw artifacts", () => {
  const prompt = readFileSync(template, "utf8").split("  - id: run_poc\n")[1]!.split("      form:")[0]!;
  for (const placeholder of ["<primary>", "<worktree>", "~", "$DAGU_HOME"]) assert.ok(prompt.includes(placeholder));
  assert.match(prompt, /retain raw/);
  assert.match(prompt, /identify placeholder substitutions/);
});

for (const mode of ["normal", "failure", "chunked"] as const) {
  test(`PoC ${mode} publication redacts known roots and preserves raw evidence`, () => {
    const fixture = cleanupFixture();
    try {
      const home = "/home/PoC Operator";
      const daguHome = `${home}/.dagu`;
      const evidence = `primary=${fixture.primary}/config\nworktree=${fixture.worktree}/probe\nhome="${home}/notes"\ndagu="${daguHome}/runs"\n`;
      const raw = `VERDICT: PASS\n## Comandos y salida\n${evidence}\n## Después del PASS\nInspect ${fixture.worktree}/probe.\n`;
      const input = join(fixture.state, "input.md");
      writeFileSync(input, raw);
      fixture.save("result.path", input);
      fixture.save("scope", "OK\n");
      writeFileSync(join(fixture.worktree, "probe.txt"), evidence);
      const result = fixture.run("publish", {
        WORKTREE: fixture.worktree, HOME: home, DAGU_HOME: daguHome,
        PUBLICATION_FAILURE: mode === "failure" ? "yes" : "",
        FAKE_LARGE_COMMENT: mode === "chunked" ? "yes" : "",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(input, "utf8"), raw);
      assert.equal(readFileSync(join(fixture.state, "result.md"), "utf8"), raw);
      assert.ok(readFileSync(join(fixture.state, "full.patch"), "utf8").includes(fixture.worktree));
      const comments: string[] = readFileSync(fixture.published, "utf8").trim().split("\n").map(line => JSON.parse(line));
      const publicText = comments.join("\n");
      for (const root of [fixture.primary, fixture.worktree, home, daguHome]) assert.ok(!publicText.includes(root), root);
      for (const placeholder of ["<primary>/config", "<worktree>/probe", "~/notes", "$DAGU_HOME/runs"]) assert.ok(publicText.includes(placeholder), placeholder);
      for (const [index, comment] of comments.entries()) {
        const path = join(fixture.root, `published-${index}.txt`);
        writeFileSync(path, comment);
        const checked = spawnSync(a4sBin, ["pr-body", "check-paths", path], { encoding: "utf8" });
        assert.equal(checked.status, 0, checked.stderr);
      }
      if (mode === "chunked") {
        const chunks = comments.map(comment => { try { return JSON.parse(comment); } catch { return undefined; } })
          .filter(value => value?.kind === "poc-evidence-base64");
        assert.ok(chunks.length > 0);
        const decoded = Buffer.from(chunks.map(chunk => chunk.data).join(""), "base64").toString("utf8");
        assert.equal(decoded, readFileSync(join(fixture.state, "comment-1.txt"), "utf8"));
        for (const root of [fixture.primary, fixture.worktree, home, daguHome]) assert.ok(!decoded.includes(root), root);
      }
      if (mode !== "failure") {
        const issue = JSON.parse(readFileSync(fixture.issue, "utf8")).body;
        assert.ok(issue.includes("Inspect <worktree>/probe."));
        assert.ok(!issue.includes(fixture.worktree));
      }
    } finally { fixture.cleanup(); }
  });
}

for (const publicationFailure of ["", "yes"]) {
test(`PoC publication checks result and patch before GitHub mutation (failure=${publicationFailure || "no"})`, () => {
  const fixture = cleanupFixture();
  try {
    const before = readFileSync(fixture.calls, "utf8");
    for (const [result, patch] of [
      ["VERDICT: FAIL\nEvidence: /Users/example/private/repo\n", "Safe probe\n"],
      ["VERDICT: FAIL\nSafe evidence\n", "Config: /home/example/private/repo\n"],
      ["VERDICT: FAIL\nEvidence: /home/PoC-Operator-other/private/repo\n", "Safe probe\n"],
    ]) {
      fixture.save("result.md", result!);
      writeFileSync(join(fixture.worktree, "probe.txt"), patch!);
      const rejected = fixture.run("publish", { WORKTREE: fixture.worktree, HOME: "/home/PoC-Operator", PUBLICATION_FAILURE: publicationFailure });
      assert.equal(rejected.status, 1, rejected.stderr);
      assert.match(rejected.stderr, /host absolute path/);
      assert.equal(readFileSync(fixture.calls, "utf8"), before);
      assert.ok(existsSync(join(fixture.state, "comment-1.txt")));
    }
  } finally { fixture.cleanup(); }
});
}

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

test("PoC without promotion disposes a clean base-only worktree and branch", () => {
  const fixture = cleanupFixture();
  try {
    fixture.save("verdict", "PASS\n");
    assert.equal(execFileSync("git", ["-C", fixture.worktree, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }), "");
    const disposed = fixture.run("dispose", { PROMOTE: "no" });
    assert.equal(disposed.status, 0, disposed.stderr);
    assert.equal(readFileSync(fixture.enqueues, "utf8"), "");
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



test("INCONCLUSIVE result validation records the explicit scope/access/other cause", () => {
  const fixture = pocFixture();
  try {
    fixture.body("## PoC\nCan Linux run?\n");
    assert.equal(fixture.run("record").status, 0);
    execFileSync("git", ["-C", fixture.primary, "-c", "user.name=PoC test", "-c", "user.email=poc@example.invalid", "commit", "--allow-empty", "-qm", "seed"]);
    fixture.save("base.sha", execFileSync("git", ["-C", fixture.primary, "rev-parse", "HEAD"], { encoding: "utf8" }));
    const resultPath = join(fixture.root, "result.md");
    fixture.save("result.path", resultPath);
    const result = "VERDICT: INCONCLUSIVE\n## Pregunta\nCan Linux run?\n## Proposición demostrada\nTarget unreachable.\n## Ruta ejercitada\nLinux arm64\n## Comandos y salida\nssh: access denied\n";
    for (const cause of ["scope", "access", "other"]) {
      writeFileSync(resultPath, `${result}## Inconclusive cause\n${cause}\n`);
      const checked = fixture.run("scope_gate", { WORKTREE: fixture.primary, TEST_PATHS: "^test/" });
      assert.equal(checked.status, 0, checked.stderr);
      assert.equal(readFileSync(join(fixture.state, "scope"), "utf8").trim(), "OK");
    }
    writeFileSync(resultPath, result);
    const missing = fixture.run("scope_gate", { WORKTREE: fixture.primary, TEST_PATHS: "^test/" });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /INCONCLUSIVE requires ## Inconclusive cause/);
  } finally { fixture.cleanup(); }
});

test("adoption escalation thresholds are immutable in PoC admission", () => {
  const fixture = pocFixture();
  try {
    const result = fixture.run("admission", { DAGU_PARAMS_JSON: '{"ESCALATION_POC_INCONCLUSIVE":"200"}' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /admission rejected run parameter: ESCALATION_POC_INCONCLUSIVE/);
    const dag = join(fixture.root, "poc.yaml");
    writeFileSync(dag, "name: poc\n");
    withConsumerConfig(fixture.primary, join(fixture.root, "dagu-home"), () => {
      assert.throws(() => preflightAdmission({ cwd: fixture.primary, dag, run: "scope-overridden",
        params: ["ISSUE=41", "ESCALATION_SECONDS=999999"] }), /admission rejected run parameter: ESCALATION_SECONDS/);
    });
  } finally { fixture.cleanup(); }
});

test("scope CLI passes an assessed reachable route and defers an unreachable route", () => {
  const fixture = pocFixture();
  try {
    const script = fileURLToPath(new URL("../../bin/dagu-poc-scope.ts", import.meta.url));
    const output = join(fixture.root, "scope-outputs");
    const env: NodeJS.ProcessEnv = { ...process.env, PRIMARY: fixture.primary, ISSUE: "41", QUESTION: "Can Linux run?",
      REQUIRED_TARGETS: '["linux-arm64"]', AUTHORIZED_TARGETS: '["linux-arm64"]', SCOPE_BASIS: "Operator authorized local Linux",
      DAGU_OUTPUT_FILE: output, ESCALATION_POC_INCONCLUSIVE: "2" };
    const run = (action: string, overrides: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [script, action],
      { env: { ...env, ...overrides }, encoding: "utf8" });
    const assessed = run("assess");
    assert.equal(assessed.status, 0, assessed.stderr);
    assert.match(assessed.stdout, /SCOPE_DECISION=no/);
    const id = /SCOPE_REQUEST=([a-f0-9]{64})/.exec(assessed.stdout)![1]!;
    const resolved = run("decide", { SCOPE_REQUEST: id });
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.match(resolved.stdout, /POC_QUESTION=Can Linux run\?/);
    const skippedDecision = {
      POC_SCOPE_ACTION: "${steps.poc_scope_decision.outputs.ACTION}", POC_QUESTION: "${steps.poc_scope_decision.outputs.QUESTION}",
      POC_REQUIRED_TARGETS: "${steps.poc_scope_decision.outputs.REQUIRED_TARGETS}",
      POC_AUTHORIZED_TARGETS: "${steps.poc_scope_decision.outputs.AUTHORIZED_TARGETS}", POC_SCOPE_BASIS: "${steps.poc_scope_decision.outputs.BASIS}",
    };
    const skipped = run("decide", { ...skippedDecision, SCOPE_REQUEST: id });
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.equal(skipped.stdout, resolved.stdout, "native skipped decision retains the exact assessed question and route");
    assert.equal(run("require", { SCOPE_REQUEST: id }).status, 0);
    const blocked = run("assess", { AUTHORIZED_TARGETS: "[]" });
    const blockedId = /SCOPE_REQUEST=([a-f0-9]{64})/.exec(blocked.stdout)![1]!;
    assert.match(blocked.stdout, /SCOPE_DECISION=yes/);
    const unresolved = run("decide", { ...skippedDecision, SCOPE_REQUEST: blockedId });
    assert.equal(unresolved.status, 23);
    assert.match(unresolved.stderr, /POC_SCOPE_DECISION_REQUIRED/);
    const deferred = run("decide", { ...skippedDecision, SCOPE_REQUEST: blockedId, POC_SCOPE_ACTION: "defer", POC_SCOPE_BASIS: "Operator deferred inaccessible target" });
    assert.equal(deferred.status, 77, deferred.stderr);
    const rejected = run("require", { SCOPE_REQUEST: blockedId, AUTHORIZED_TARGETS: "[]" });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /POC_SCOPE_DEFERRED/);
  } finally { fixture.cleanup(); }
});
