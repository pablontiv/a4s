import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryName, resolveRepository } from "../src/repository.ts";

test("origin URL repo name supports HTTPS, SCP SSH, SSH URLs and .git suffixes", () => {
  for (const url of ["https://github.com/pablontiv/a4s.git", "https://github.com/pablontiv/a4s", "git@github.com:pablontiv/a4s.git", "ssh://git@github.com:2222/pablontiv/a4s.git", "git+https://github.com/pablontiv/a4s.git", "https://github.com/pablontiv/a4s.git/\n"]) {
    assert.equal(repositoryName(url, "/clone/wrong/.git"), "a4s", url);
  }
  assert.equal(repositoryName("", "/clone/a4s/.git"), "a4s");
});

test("linked worktree identity uses origin then common git dir, and non-git cwd is inactive", async () => {
  const root = await mkdtemp(join(tmpdir(), "dagu-status-repo-"));
  const primary = join(root, "canonical-name");
  const worktree = join(root, "issue-157");
  const signal = new AbortController().signal;
  try {
    await mkdir(primary);
    execFileSync("git", ["init", primary], { stdio: "ignore" });
    execFileSync("git", ["-C", primary, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "init"], { stdio: "ignore" });
    execFileSync("git", ["-C", primary, "worktree", "add", worktree], { stdio: "ignore" });
    assert.equal(await resolveRepository(worktree, signal), "canonical-name");
    execFileSync("git", ["-C", primary, "remote", "add", "origin", "git@github.com:pablontiv/a4s.git"]);
    assert.equal(await resolveRepository(worktree, signal), "a4s");
    assert.equal(await resolveRepository(root, signal), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
