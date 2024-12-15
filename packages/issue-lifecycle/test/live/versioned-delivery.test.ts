import assert from "node:assert/strict";
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { archiveName, artifactToken, type ArtifactTuple } from "../../../launcher/src/release.ts";
import { CONFIG_PATH, exampleConfig, serializeConfig } from "../../../launcher/src/config.ts";
import { cachePath, ensureArtifact } from "../../../launcher/src/artifact-cache.ts";
import { initializeStation } from "../../../launcher/src/station.ts";
import { commitStateLocked, readStateLocked, stationTransaction } from "../../../launcher/src/station-state.ts";
import { sha256 } from "../../src/admission.ts";
import { installGithubFixture, packageDirectory, repository, writeReleaseDirectory } from "../fixtures/artifact.ts";
import { liveDagu } from "../fixtures/live-dagu.ts";

const commitA = "a".repeat(40), commitB = "b".repeat(40);
test("clean-room station selection, atomic cache, handoff and all successor routes stay pinned", { ...liveDagu, timeout: 240000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "a4s-versioned-live-"));
  const releases = join(root, "releases"), bin = installGithubFixture(join(root, "bin"));
  const home = join(root, "dagu-home"), calls = join(root, "enqueued.txt");
  const realDagu = execFileSync("which", ["dagu"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "dagu"), '#!/usr/bin/env bash\nif [[ "$1" == enqueue ]]; then printf "%s|%s\\n" "$3" "$4" >> "$A4S_ENQUEUE_LOG"; fi\nexec "$A4S_REAL_DAGU" "$@"\n');
  chmodSync(join(bin, "dagu"), 0o755);
  const environment = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, DAGU_HOME: home, A4S_FIXTURE_RELEASES: releases, A4S_REAL_DAGU: realDagu, A4S_ENQUEUE_LOG: calls };
  const initializeHome = (path: string) => {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "config.yaml"), "coordinator:\n  enabled: false\nqueues:\n  enabled: true\n  config:\n    - name: consumer-a\n      max_concurrency: 1\n    - name: consumer-b\n      max_concurrency: 1\n");
  };
  const consumer = (name: string) => {
    const directory = join(root, name), config = join(directory, CONFIG_PATH);
    mkdirSync(dirname(config), { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();
    git("init", "-b", "main"); git("config", "user.name", "Versioned Delivery"); git("config", "user.email", "versioned@example.test");
    const commitConfig = (gate: string) => { writeFileSync(config, serializeConfig(exampleConfig({ lane: name, gate, rebaseResolver: "" }))); git("add", CONFIG_PATH); git("commit", "-qm", `gate ${gate}`); return git("rev-parse", "HEAD"); };
    commitConfig("true");
    return { directory, config, commitConfig, receipt: (run: string) => join(directory, ".git", "dagu-feature", "runs", run, "receipt.json") };
  };
  const enqueues = () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : [];
  const ghCalls = (): string[][] => existsSync(join(releases, "gh-calls.jsonl")) ? readFileSync(join(releases, "gh-calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  try {
    for (const [version, commit] of [["r7981", commitA], ["r7982", commitB]]) {
      execFileSync(process.execPath, ["scripts/build-a4s.mjs", "--target", "bun-linux-x64", "--outdir", releases, "--test-version", version!, "--test-commit", commit!], { cwd: resolve(packageDirectory, "../.."), env: { ...environment, A4S_LIVE_DAGU: "1" }, stdio: "pipe", timeout: 120000 });
    }
    const installation = join(root, "initial-release");
    mkdirSync(installation);
    execFileSync("tar", ["-xzf", join(releases, archiveName("r7982")), "-C", installation]);
    const initialBinary = join(installation, "a4s");
    writeReleaseDirectory(releases, { repository, moving: {}, releases: [{ tag_name: "a4s-r7981", commit: commitA }, { tag_name: "a4s-r7982", commit: commitB }] });
    initializeHome(home);
    const saved = { PATH: process.env.PATH, releases: process.env.A4S_FIXTURE_RELEASES };
    let tupleA: ArtifactTuple, tupleB: ArtifactTuple;
    try {
      Object.assign(process.env, { PATH: environment.PATH, A4S_FIXTURE_RELEASES: releases });
      const cached = [];
      for (const [version, commit] of [["r7981", commitA], ["r7982", commitB]]) {
        const archive = archiveName(version!);
        const digest = readFileSync(join(releases, `${archive}.sha256`), "utf8").split(" ")[0]!;
        cached.push(await ensureArtifact(home, { version: version!, commit: commit!, digest, archive, repository }));
      }
      const [a, b] = cached.map(({ record: { version, commit, digest } }) => ({ version, commit, digest }));
      tupleA = a!; tupleB = b!;
      await initializeStation(home, tupleA, { listRuns: async () => [] });
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.releases === undefined) delete process.env.A4S_FIXTURE_RELEASES; else process.env.A4S_FIXTURE_RELEASES = saved.releases;
    }
    const switchCurrent = () => stationTransaction(home, async () => {
      const state = readStateLocked(home);
      commitStateLocked(home, { ...state, generation: state.generation + 1, current: tupleB, previous: tupleA });
    });
    const first = consumer("consumer-a"), second = consumer("consumer-b");
    const invoke = (repo: typeof first, run: string, dag = "feature", options: { binary?: string; parent?: string; params?: string[]; home?: string; artifact?: string } = {}) => {
      const args = [options.binary ?? initialBinary, options.parent ? "enqueue" : "admit", ...(options.artifact ? ["--artifact", options.artifact] : []), ...(options.parent ? ["--parent", options.parent] : []), "--run-id", run, dag, "--", ...(dag === "feature" || dag === "poc" ? ["ISSUE=712"] : []), "OMP_SESSION_ID=cutover-owner", ...(options.params ?? [])];
      return spawnSync(args[0]!, args.slice(1), { cwd: repo.directory, env: { ...environment, DAGU_HOME: options.home ?? home, A4S_PRIMARY: repo.directory }, encoding: "utf8", timeout: 30000 });
    };
    const readReceipt = (repo: typeof first, run: string) => JSON.parse(readFileSync(repo.receipt(run), "utf8"));
    const success = (result: SpawnSyncReturns<string>) => assert.equal(result.status, 0, `${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`);
    success(invoke(first, "feature-a"));
    const initial = readReceipt(first, "feature-a");
    assert.deepEqual(initial.artifact, { version: tupleA.version, commit: tupleA.commit, digest: tupleA.digest });
    const directoryA = cachePath(home, tupleA), binaryA = join(directoryA, "a4s");
    assert.equal(ghCalls().some(args => args.some(value => value.endsWith("git/ref/tags/v0"))), false);
    assert.ok(initial.initial.execution.dagSnapshot.includes(`  - A4S_BIN: ${JSON.stringify(binaryA)}\n`));
    const initialSnapshot = join(first.receipt("feature-a"), "..", "snapshot", "feature.yaml");
    assert.equal(readFileSync(initialSnapshot, "utf8"), initial.initial.execution.dagSnapshot);
    assert.equal(sha256(readFileSync(initialSnapshot)), initial.initial.deployment.generatedDagDigest);
    assert.equal(enqueues()[0], `feature-a|${initialSnapshot}`);
    const changedConfig = first.commitConfig("printf checked");
    await switchCurrent();
    const beforeChildren = ghCalls().length;
    const scope = ["QUESTION=Does the fixture target work?", 'REQUIRED_TARGETS=["fixture"]', 'AUTHORIZED_TARGETS=["fixture"]', "SCOPE_BASIS=Fixture grants local target access"];
    success(invoke(first, "poc-a", "poc", { binary: binaryA, parent: first.receipt("feature-a"), params: scope }));
    success(invoke(first, "feature-return-a", "feature", { binary: binaryA, parent: first.receipt("poc-a") }));
    for (const [child, parent] of [["poc-a", "feature-a"], ["feature-return-a", "poc-a"]]) {
      const receipt = readReceipt(first, child!);
      assert.deepEqual(receipt.artifact, tupleA); assert.deepEqual(receipt.parent.artifact, tupleA);
      assert.equal(receipt.parent.receipt, first.receipt(parent!)); assert.equal(receipt.initial.deployment.config.commit, changedConfig);
      assert.equal(receipt.initial.deployment.config.digest, sha256(readFileSync(first.config)));
      assert.equal(receipt.initial.deployment.config.schemaVersion, 2);
      assert.equal(Object.hasOwn(receipt.initial.deployment.config, "uses"), false);
    }
    assert.equal(ghCalls().length, beforeChildren);
    success(invoke(second, "discovery-a", "discovery", { binary: binaryA, params: ["LENSES=0"], artifact: artifactToken(tupleA) }));
    second.commitConfig("printf policy");
    const beforePlanning = ghCalls().length;
    const units = join(root, "units.jsonl"); writeFileSync(units, "");
    success(invoke(second, "planning-a", "planning", { binary: binaryA, parent: second.receipt("discovery-a"), params: [`UNITS_FROM=${units}`, "SOURCE=discovery"] }));
    assert.deepEqual(readReceipt(second, "planning-a").artifact, tupleA);
    assert.equal(readReceipt(second, "planning-a").parent.dag, "discovery"); assert.equal(ghCalls().length, beforePlanning);
    second.commitConfig("true");
    success(invoke(second, "feature-b"));
    const receiptB = readReceipt(second, "feature-b");
    assert.deepEqual(receiptB.artifact, { version: tupleB.version, commit: tupleB.commit, digest: tupleB.digest });
    const binaryB = join(cachePath(home, tupleB), "a4s");
    assert.equal(initial.initial.runtimeAndModels.roleJobStore, join(home, "role-jobs.sqlite"));
    assert.equal(receiptB.initial.runtimeAndModels.roleJobStore, initial.initial.runtimeAndModels.roleJobStore);
    const capacity = (binary: string, value: number) => spawnSync(binary, ["role-jobs", "capacity", String(value)], { env: environment, encoding: "utf8" });
    success(capacity(binaryA, 2)); const store = statSync(join(home, "role-jobs.sqlite"));
    success(capacity(binaryB, 3)); assert.equal(statSync(join(home, "role-jobs.sqlite")).ino, store.ino);
    success(capacity(binaryA, 2));
    for (const directory of [directoryA, cachePath(home, tupleB)]) assert.equal(existsSync(join(directory, "role-jobs.sqlite")), false);
    const fails = (repo: typeof first, run: string, result: SpawnSyncReturns<string>, before: number) => {
      assert.notEqual(result.status, 0, result.stdout); assert.equal(existsSync(repo.receipt(run)), false);
      assert.equal(enqueues().length, before); return result.stderr;
    };
    const count = enqueues().length;
    const mismatch = invoke(first, "wrong-handoff", "feature", { binary: binaryB, artifact: artifactToken(tupleA) });
    assert.match(fails(first, "wrong-handoff", mismatch, count), /identity mismatch/);
    const corruptHome = join(root, "corrupt-home"); initializeHome(corruptHome);
    mkdirSync(join(corruptHome, "cache", "a4s"), { recursive: true });
    copyFileSync(join(home, "cache", "a4s", "state.json"), join(corruptHome, "cache", "a4s", "state.json"));
    const archiveB = join(releases, archiveName("r7982")), backup = join(root, "archive-backup.tar.gz"); copyFileSync(archiveB, backup);
    writeFileSync(archiveB, "corrupt release archive");
    assert.match(fails(second, "corrupt", invoke(second, "corrupt", "feature", { home: corruptHome }), count), /SHA-256 mismatch/);
    copyFileSync(backup, archiveB);
    assert.equal(existsSync(cachePath(corruptHome, tupleB)), false);
    const conflictHome = join(root, "conflict-home"); initializeHome(conflictHome);
    mkdirSync(join(conflictHome, "cache", "a4s"), { recursive: true });
    copyFileSync(join(home, "cache", "a4s", "state.json"), join(conflictHome, "cache", "a4s", "state.json"));
    const conflict = cachePath(conflictHome, tupleB); mkdirSync(conflict, { recursive: true });
    writeFileSync(join(conflict, "artifact.json"), JSON.stringify({ ...tupleB, digest: "0".repeat(64), verifiedAt: new Date().toISOString() }));
    assert.match(fails(second, "conflict", invoke(second, "conflict", "feature", { home: conflictHome }), count), /Conflicting artifact cache entry/);
    const parentPath = first.receipt("feature-a"), originalParent = readFileSync(parentPath, "utf8");
    const invalidParent = JSON.parse(originalParent); delete invalidParent.artifactSupport; writeFileSync(parentPath, JSON.stringify(invalidParent));
    assert.match(fails(first, "invalid-parent", invoke(first, "invalid-parent", "poc", { binary: binaryA, parent: parentPath, params: scope }), count), /lacks supported artifact declarations/);
    writeFileSync(parentPath, originalParent);
    rmSync(join(directoryA, "skills", "issue-execution", "poc.yaml"));
    const callsBeforeMissing = ghCalls().length;
    fails(first, "missing-parent-cache", invoke(first, "missing-parent-cache", "poc", { binary: binaryA, parent: parentPath, params: scope }), count);
    assert.equal(ghCalls().length, callsBeforeMissing);
    assert.equal(existsSync(join(directoryA, "skills", "issue-execution", "poc.yaml")), false);
    assert.deepEqual(readdirSync(first.directory).sort(), [".git", ".workspace"]);
    assert.deepEqual(readdirSync(second.directory).sort(), [".git", ".workspace"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
