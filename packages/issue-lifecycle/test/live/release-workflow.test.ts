import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { gitBuildIdentity } from "../../../../scripts/release-identity.mjs";
import { planPublication, publishArchives } from "../../../../scripts/publish-a4s.mjs";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const inputs = ["packages/issue-lifecycle/**", "packages/hot-reload/**", "packages/loader/**", "packages/launcher/**", "scripts/build-a4s.mjs", "package.json", "package-lock.json"];
const live = { skip: process.env.A4S_LIVE_DAGU !== "1" };

test("fresh full-history checkouts produce increasing IDs; unchanged SHA keeps its ID; shallow history fails", live, () => {
  const root = mkdtempSync(join(tmpdir(), "a4s-release-history-"));
  try {
    const repository = join(root, "origin"); mkdirSync(repository);
    git(repository, "init", "-b", "main");
    git(repository, "-c", "user.name=Release test", "-c", "user.email=release@example.invalid", "commit", "--allow-empty", "-m", "one");
    const first = git(repository, "rev-parse", "HEAD");
    git(repository, "-c", "user.name=Release test", "-c", "user.email=release@example.invalid", "commit", "--allow-empty", "-m", "two");
    const second = git(repository, "rev-parse", "HEAD");
    for (const name of ["one", "two", "same"]) git(root, "clone", `file://${repository}`, join(root, name));
    git(join(root, "one"), "checkout", first);
    git(join(root, "same"), "checkout", first);
    assert.deepEqual(gitBuildIdentity(join(root, "one")), { version: "r1", commit: first });
    assert.deepEqual(gitBuildIdentity(join(root, "two")), { version: "r2", commit: second });
    assert.deepEqual(gitBuildIdentity(join(root, "same")), gitBuildIdentity(join(root, "one")));
    git(root, "clone", "--depth=1", `file://${repository}`, join(root, "shallow"));
    assert.throws(() => gitBuildIdentity(join(root, "shallow")), /full history/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("publisher binds successful validate, shipped diff, immutable reruns, tag conflicts and late completion", live, async () => {
  const root = mkdtempSync(join(tmpdir(), "a4s-release-publication-"));
  try {
    git(root, "init", "-b", "main");
    mkdirSync(join(root, "packages/issue-lifecycle"), { recursive: true });
    writeFileSync(join(root, "packages/issue-lifecycle/input"), "one");
    const commit = () => { git(root, "add", "."); git(root, "-c", "user.name=Release test", "-c", "user.email=release@example.invalid", "commit", "-m", "fixture"); return git(root, "rev-parse", "HEAD"); };
    const first = commit();
    git(root, "tag", "a4s-r1", first);
    const releases = [{ tag_name: "a4s-r1", draft: false, prerelease: false }];
    const event = { repository: { full_name: "fixture/a4s" }, workflow_run: { id: 7, conclusion: "success", event: "push", head_branch: "main", head_sha: first, head_repository: { full_name: "fixture/a4s" } } };
    let validation = "success";
    const calls: string[][] = [];
    const gh = (args: string[]) => {
      calls.push(args);
      return JSON.stringify(args.some(arg => arg.includes("/jobs?")) ? [{ jobs: [{ name: "validate", conclusion: validation, head_sha: event.workflow_run.head_sha }] }] : [releases]);
    };
    const plan = () => planPublication({ cwd: root, event, inputs, gh });
    const rerun = plan(); assert.equal(rerun.publish, true); assert.equal(rerun.existing, true);
    const archives = join(root, "archives"); mkdirSync(archives);
    const checksums = new Map<string, string>();
    for (const platform of ["linux-x64", "darwin-arm64"]) {
      const name = `a4s-r1-${platform}.tar.gz`, bytes = Buffer.from(platform);
      const checksum = `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`;
      writeFileSync(join(archives, name), bytes); writeFileSync(join(archives, `${name}.sha256`), checksum);
      checksums.set(`${name}.sha256`, checksum);
    }
    const downloads = (args: string[]) => { calls.push(args); return checksums.get(args[args.indexOf("--pattern") + 1]!)!; };
    await publishArchives(rerun, archives, { cwd: root, gh: downloads });
    assert.equal(calls.some(args => args.includes("create") || args.includes("upload")), false);
    checksums.set("a4s-r1-linux-x64.tar.gz.sha256", `${"b".repeat(64)}  a4s-r1-linux-x64.tar.gz\n`);
    await assert.rejects(publishArchives(rerun, archives, { cwd: root, gh: downloads }), /Rerun digest mismatch/);
    validation = "failure";
    await publishArchives(plan(), archives, { cwd: root, gh: downloads });
    assert.equal(plan().publish, false);
    event.workflow_run.conclusion = "failure"; assert.equal(plan().publish, false);
    event.workflow_run.conclusion = "success"; validation = "success";
    writeFileSync(join(root, "README"), "not shipped"); event.workflow_run.head_sha = commit();
    assert.equal(plan().publish, false);
    writeFileSync(join(root, "packages/issue-lifecycle/input"), "two"); event.workflow_run.head_sha = commit();
    const latest = event.workflow_run.head_sha;
    assert.equal(plan().publish, true);
    git(root, "tag", "a4s-r3", first);
    assert.throws(plan, /ID\/SHA conflict/);
    git(root, "tag", "-d", "a4s-r3"); git(root, "tag", "a4s-r3", latest);
    releases.push({ tag_name: "a4s-r3", draft: false, prerelease: false });
    assert.equal(plan().publish, true);
    git(root, "checkout", first); event.workflow_run.head_sha = first;
    assert.throws(plan, /first-parent descendant/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
