import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import primaryGuard from "../src/primary-guard/index.ts";
import { isPrimaryTarget, primaryWriteDecision, unwrapTarget } from "../src/primary-guard/guard.ts";
import type { Block, GuardContext, GuardEvent } from "../src/primary-guard/guard.ts";
import { createTargetResolver } from "../src/primary-guard/paths.ts";

const guidance = "; implement in the issue worktree (.workspace/worktrees/issue-<N>) via feature";

test("primary guard classifies actual destinations in a temporary primary and nested linked worktree", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a4s-primary-write-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const primary = join(root, "primary");
  const worktree = join(primary, ".workspace/worktrees/issue-241");
  const outside = join(root, "outside");
  mkdirSync(primary);
  mkdirSync(outside);
  function git(...args: string[]) {
    return execFileSync("git", ["-C", primary, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }
  git("init", "-q");
  git("config", "user.name", "Primary Guard Test");
  git("config", "user.email", "primary-guard@example.test");
  mkdirSync(join(primary, "src"));
  writeFileSync(join(primary, "src/existing.ts"), "export const original = 1;\n");
  writeFileSync(join(primary, "file#name.ts"), "original\n");
  git("add", ".");
  git("commit", "-qm", "fixture");
  git("worktree", "add", "-qb", "issue-241", worktree);
  writeFileSync(join(outside, "outside.ts"), "original\n");
  const localContext = { cwd: worktree, localProtocolOptions: { root: primary } };
  const resolver = createTargetResolver({
    async resolve(target, context) {
      if (target === "agent://peer") return undefined; // Explicitly file-free host policy.
      if (target.startsWith("local://")) {
        assert.equal(context.localProtocolOptions, localContext.localProtocolOptions);
        return join(primary, target.slice("local://".length));
      }
      if (target.startsWith("file://")) return fileURLToPath(target);
      if (target.includes("://")) throw new Error("URI has no local file backing");
      return resolve(context.cwd, target);
    },
    async split(target, cwd) {
      const absolute = resolve(cwd, target);
      if (existsSync(absolute)) return { basePath: target };
      const parts = target.split("/");
      const index = parts.findIndex(part => /[*?{[]/.test(part));
      if (index === -1) return { basePath: target };
      return { basePath: parts.slice(0, index).join("/") || ".", glob: parts.slice(index).join("/") };
    },
    async entries(targets) { return targets; },
  });
  const decide = (toolName: string, input: Record<string, unknown>, cwd = worktree) =>
    primaryWriteDecision({ toolName, input }, { ...localContext, cwd }, resolver);
  function blocked(result: Block, path?: string) {
    assert.equal(result?.block, true);
    if (path) assert.equal(result?.reason, `PRIMARY_WRITE_BLOCKED: ${path}${guidance}`);
    else assert.match(result!.reason, /^PRIMARY_WRITE_BLOCKED: /);
  }

  await t.test("write follows destinations, independent of session cwd, for existing and new paths", async () => {
    for (const cwd of [primary, worktree, outside]) {
      for (const destination of ["src/existing.ts", "missing/deep/new.ts"]) {
        blocked(await decide("write", { path: join(primary, destination) }, cwd), join(primary, destination));
        assert.equal(await decide("write", { path: join(worktree, destination) }, cwd), undefined);
        assert.equal(await decide("write", { path: join(outside, destination) }, cwd), undefined);
      }
    }
    blocked(await decide("write", { path: "new.ts" }, primary), join(primary, "new.ts"));
    assert.equal(await decide("write", { path: "new.ts" }), undefined);
    assert.equal(await decide("write", { path: ".workspace/worktrees/issue-241/new.ts" }, primary), undefined);
  });

  await t.test("wrapped headers and file-backed URIs cannot hide primary files", async () => {
    const path = join(primary, "file#name.ts");
    blocked(await decide("write", { path: `[${path}#ABCD]` }), path);
    blocked(await decide("write", { path: pathToFileURL(path).href }), path);
    blocked(await decide("write", { path: "local://src/existing.ts" }), join(primary, "src/existing.ts"));
    assert.equal(await decide("write", { path: `[${worktree}/new.ts#ABCD]` }), undefined);
    assert.equal(unwrapTarget("[file#name.ts#abcd]  "), "file#name.ts");
    assert.equal(unwrapTarget("[file#INVALID]"), "[file#INVALID]");
    assert.equal(unwrapTarget("[file.ts]"), "file.ts");
  });

  await t.test("explicitly file-free coordination writes pass without treating failures as files", async () => {
    assert.equal(await decide("write", { path: "agent://peer" }), undefined);
    blocked(await decide("ast_edit", { paths: ["agent://peer"] }));
  });

  await t.test("edit checks every hashline section, MV and legacy rename destination", async () => {
    const source = join(worktree, "src/existing.ts");
    const destination = join(primary, "new file.ts");
    blocked(await decide("edit", { path: join(primary, "src/existing.ts") }), join(primary, "src/existing.ts"));
    blocked(await decide("edit", { input: `[${source}#ABCD]\nPUT 1.=1:\n+changed\n[${destination}#1234]\nREM\n` }), destination);
    blocked(await decide("edit", { input: `[${source}#ABCD]\nMV "${destination}"\n` }), destination);
    blocked(await decide("edit", { path: source, edits: [{ rename: destination }] }), destination);
    assert.equal(await decide("edit", { path: source, edits: [{ rename: "renamed.ts" }] }), undefined);
    assert.equal(await decide("edit", { input: `[${source}#ABCD]\nPUT 1.=1:\n+MV ${destination}\n+[${destination}#1234]\n` }), undefined);
    assert.equal(await decide("edit", { path: join(outside, "outside.ts") }), undefined);
    blocked(await decide("edit", { paths: [source, destination] }), destination);
  });

  await t.test("ast_edit expands files, directories and globs before classifying", async () => {
    for (const path of [join(primary, "src/existing.ts"), join(primary, "src"), join(primary, "src/*.ts"), join(primary, "**/*.ts")]) {
      blocked(await decide("ast_edit", { paths: [path] }));
    }
    for (const path of [join(worktree, "src/existing.ts"), worktree, join(worktree, "**/*.ts"), join(outside, "*.ts")]) {
      assert.equal(await decide("ast_edit", { paths: [path] }), undefined, path);
    }
    // Classifying the primary base directory alone would incorrectly reject this glob.
    assert.equal(await decide("ast_edit", { paths: [join(primary, ".workspace/worktrees/issue-241/**/*.ts")] }), undefined);
    blocked(await decide("ast_edit", { paths: [join(worktree, "src"), join(primary, "src")] }));
    assert.equal(await decide("ast_edit", { paths: [join(worktree, "no-match-*.ts")] }), undefined);
    const literal = join(worktree, "[literal].ts");
    writeFileSync(literal, "original\n");
    assert.equal(await decide("ast_edit", { paths: [literal] }), undefined);
  });

  await t.test("symlink ancestors use real destinations and dangling links fail closed", async () => {
    symlinkSync(primary, join(worktree, "primary-link"));
    symlinkSync(join(primary, "src/existing.ts"), join(worktree, "file-link.ts"));
    symlinkSync(worktree, join(primary, "worktree-link"));
    symlinkSync(join(root, "absent"), join(worktree, "dangling"));
    blocked(await decide("write", { path: join(worktree, "primary-link/missing/new.ts") }));
    blocked(await decide("write", { path: join(worktree, "file-link.ts") }));
    blocked(await decide("ast_edit", { paths: [join(worktree, "file-link.ts")] }));
    assert.equal(await decide("write", { path: join(primary, "worktree-link/missing/new.ts") }), undefined);
    for (const path of [join(worktree, "dangling"), join(worktree, "dangling/new.ts")]) {
      const result = await decide("write", { path });
      blocked(result);
      assert.match(result!.reason, /destination could not be resolved/);
    }
  });

  await t.test("unresolvable and malformed mutation destinations fail closed", async () => {
    for (const [tool, input] of [
      ["write", { path: "unknown://resource" }], ["write", { path: "bad\0path" }], ["write", {}],
      ["edit", { input: "not a patch" }], ["ast_edit", { paths: [null] }], ["ast_edit", { paths: [] }],
      ["ast_edit", { paths: [join(worktree, "missing-file.ts")] }],
    ] as const) {
      const result = await decide(tool, input);
      blocked(result);
      assert.match(result!.reason, /destination could not be resolved/);
    }
    assert.throws(() => isPrimaryTarget("relative.ts"), /absolute filesystem path/);
  });

  await t.test("LSP checks applied request paths without claiming WorkspaceEdit visibility", async () => {
    const file = join(primary, "src/existing.ts");
    for (const input of [{ action: "rename", file }, { action: "rename", apply: true, file }, { action: "code_actions", apply: true, file }]) {
      blocked(await decide("lsp", input), file);
    }
    for (const input of [{ action: "rename", apply: false, file }, { action: "code_actions", file }, { action: "definition", file }]) {
      assert.equal(await decide("lsp", input), undefined);
    }
    assert.equal(await decide("lsp", { action: "rename", file: "src/existing.ts" }), undefined);
    blocked(await decide("lsp", { action: "rename_file", file: "src/existing.ts", new_name: file }), file);
  });

  await t.test("extension blocks inner xd dispatch while leaving arbitrary-code tools out of scope", async () => {
    let handler: ((event: GuardEvent, context?: GuardContext) => Promise<Block>) | undefined;
    primaryGuard({ on(name, callback) { assert.equal(name, "tool_call"); handler = callback; } }, async () => resolver);
    assert.equal(await handler!({ toolName: "write", input: { path: "xd://edit", content: "{}" } }, localContext), undefined);
    blocked(await handler!({ toolName: "edit", input: { path: join(primary, "src/existing.ts") } }, localContext));
    assert.equal(await handler!({ toolName: "edit", input: { path: "src/existing.ts" } }, localContext), undefined);
    for (const toolName of ["bash", "eval", "debug", "read"]) {
      assert.equal(await handler!({ toolName, input: { path: join(primary, "src/existing.ts") } }, localContext), undefined);
    }
  });

  await t.test("Git environment overrides cannot misclassify a destination", async () => {
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = join(worktree, ".git");
    try {
      assert.equal(isPrimaryTarget(join(primary, "missing.ts")), true);
      assert.equal(isPrimaryTarget(join(worktree, "missing.ts")), false);
      assert.equal(isPrimaryTarget(join(outside, "missing.ts")), false);
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
    assert.equal(statSync(join(primary, "src/existing.ts")).isFile(), true);
    assert.equal(readFileSync(join(primary, "src/existing.ts"), "utf8"), "export const original = 1;\n");
    assert.equal(git("diff", "--exit-code"), "");
  });
});
