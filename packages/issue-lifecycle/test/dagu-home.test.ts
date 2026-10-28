import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { identity } from "../src/identity.ts";
import { makeArchive, packageDirectory } from "./fixtures/artifact.ts";

function snapshot(home: string): string {
  const entries = readdirSync(home, { recursive: true, withFileTypes: true })
    .map(entry => {
      const path = join(entry.parentPath, entry.name);
      return [path.slice(home.length + 1), entry.isDirectory() ? "directory" : readFileSync(path).toString("base64")] as [string, string];
    }).sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

test("reconcile fixtures leave an inherited populated station home byte-identical", async t => {
  const root = mkdtempSync(join(tmpdir(), "dagu-home-regression-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const station = join(root, "station");
  const primary = join(root, "consumer");
  const releases = join(root, "releases");
  mkdirSync(primary);
  execFileSync("git", ["init", "-q", primary]);
  execFileSync("git", ["-C", primary, "-c", "user.name=Isolation test", "-c", "user.email=isolation@example.test", "commit", "--allow-empty", "-qm", "fixture"]);
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: packageDirectory, encoding: "utf8" }).trim();
  // Reuse the tiny archive fixture: the affected cache writer runs unchanged,
  // without compiling/executing an engine, fetching a release or starting Dagu.
  makeArchive(releases, identity.version, commit);
  for (const home of [station, join(station, ".dagu")]) {
    for (const directory of [`cache/a4s/${identity.version}`, "dags", "data", "logs"]) {
      mkdirSync(join(home, directory), { recursive: true });
      writeFileSync(join(home, directory, "sentinel"), `${directory}\n`);
    }
    writeFileSync(join(home, "cache/a4s", identity.version, "artifact.json"), JSON.stringify({
      version: identity.version, commit: "0".repeat(40), digest: "f".repeat(64), verifiedAt: "station-owned",
    }) + "\n");
  }
  const before = snapshot(station);

  // A file-backed worker runs the same preloads as a test-file process, with an
  // explicit station environment. Unlike eval workers, it loads --import hooks.
  // This exercises the real cache writer without leaving the no-spawn lane.
  const worker = new Worker(new URL("./fixtures/dagu-home-worker.mjs", import.meta.url), {
    env: { ...process.env, DAGU_HOME: station, HOME: station, A4S_RELEASE_DIR: releases },
    workerData: { primary },
  });
  const [messages, [code]] = await Promise.all([once(worker, "message"), once(worker, "exit")]);
  assert.equal(code, 0);
  const result: { home: string; emptyHome: string; fallbackHome: string } = messages[0];
  assert.equal(snapshot(station), before, "fixture rewrote the inherited station home");
  assert.notEqual(result.home, station);
  assert.equal(result.emptyHome, result.home, "empty discovery must also inherit the isolated home");
  assert.equal(result.fallbackHome, join(result.home, ".dagu"), "HOME fallback must also be isolated");
  assert.equal(existsSync(result.home), false, "the worker's temporary home was not cleaned up");
  const receipt = JSON.parse(readFileSync(join(primary, ".git/dagu-feature/runs/isolation/receipt.json"), "utf8"));
  assert.equal(receipt.initial.runtimeAndModels.daguHome, result.home);
  assert.equal(receipt.artifact.commit, commit);
});
