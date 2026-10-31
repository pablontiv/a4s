import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compiledA4sBin } from "../fixtures/admission.ts";
import { a4sBin as sourceA4sBin } from "../fixtures/a4s.ts";

const compiled = compiledA4sBin();

function sandbox(): { root: string; empty: string; run(bin: string, args: string[], env?: NodeJS.ProcessEnv): SpawnSyncReturns<string> } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "portable station ")));
  const empty = join(root, "empty-path");
  mkdirSync(empty);
  return {
    root, empty,
    run: (bin, args, env = {}) => spawnSync(bin, args, { encoding: "utf8", timeout: 30000, env: { PATH: empty, HOME: root, ...env } }),
  };
}

for (const [label, bin] of [["compiled", compiled], ["source", sourceA4sBin]] as const) {
  test(`${label} release hashing is byte-exact with no shasum or sha256sum on PATH`, () => {
    const s = sandbox();
    try {
      const names = ["plain.bin", "with space.bin", "-dash.bin"];
      for (const name of names) {
        const content = Buffer.from([0, 1, 2, 255, 10, 13, ...Buffer.from(name)]);
        writeFileSync(join(s.root, name), content);
        const result = s.run(bin, ["planning", "sha256", "--file", join(s.root, name)]);
        assert.equal(result.status, 0, String(result.stderr));
        assert.equal(result.stdout, `${createHash("sha256").update(content).digest("hex")}\n`);
      }
      const empty = s.run(bin, ["planning", "sha256", "--file", "/dev/null"]);
      assert.equal(empty.stdout, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n");
      const missing = s.run(bin, ["planning", "sha256", "--file", join(s.root, "absent")]);
      assert.notEqual(missing.status, 0);
    } finally { rmSync(s.root, { recursive: true, force: true }); }
  });
}

test("compiled planning transcript lookup follows the admitted root under any ambient profile", () => {
  const s = sandbox();
  try {
    const transcriptRoot = join(s.root, "profiles", "named", "agent", "sessions", "-repo");
    const parent = join(transcriptRoot, "2026-01-01_owner-session");
    mkdirSync(parent, { recursive: true });
    writeFileSync(`${parent}.jsonl`, `${JSON.stringify({ type: "session", id: "owner-session" })}\n`);
    writeFileSync(join(parent, "Review.jsonl"), "{}\n");
    const coordinator = JSON.stringify({ session: "owner-session", transcriptRoot });
    for (const env of [{}, { OMP_PROFILE: "other" }, { PI_PROFILE: "other" }, { PI_CONFIG_DIR: ".other" }, { PI_CODING_AGENT_DIR: join(s.root, "elsewhere") }]) {
      const found = s.run(compiled, ["planning", "planning-reviewer-transcript", "--coordinator", coordinator, "--session", "owner-session", "--review", "Review"], env);
      assert.equal(found.status, 0, String(found.stderr));
      assert.deepEqual(JSON.parse(String(found.stdout)), { transcript: join(parent, "Review.jsonl"), parent: `${parent}.jsonl` });
    }
    const decoy = join(s.root, ".omp", "agent", "sessions", "-repo");
    mkdirSync(decoy, { recursive: true });
    const lost = s.run(compiled, ["planning", "planning-reviewer-transcript", "--coordinator", JSON.stringify({ session: "owner-session", transcriptRoot: decoy }), "--session", "owner-session", "--review", "Review"]);
    assert.notEqual(lost.status, 0);
    assert.match(String(lost.stderr), /Missing or ambiguous coordinating transcript/);
    const unadmitted = s.run(compiled, ["planning", "planning-reviewer-transcript", "--coordinator", "null", "--session", "owner-session", "--review", "Review"]);
    assert.notEqual(unadmitted.status, 0);
    assert.match(String(unadmitted.stderr), /Missing admitted coordinating session\/transcript root/);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});
