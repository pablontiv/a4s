import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture } from "./fixtures/station.ts";

test("station installer reports version mismatch before replacing existing configuration", () => {
  const f = fixture();
  try {
    const bin = join(f.root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "dagu"), "#!/bin/sh\nprintf '2.19.0\\n'\n");
    chmodSync(join(bin, "dagu"), 0o755);
    const original = "queues:\n  config:\n    - name: antojea-e2e\n      max_concurrency: 4\n";
    writeFileSync(join(f.home, "config.yaml"), original);
    const result = f.run([], { PATH: `${bin}:${process.env.PATH}` });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /dagu version="2\.19\.0" required=2\.20\.1/);
    assert.equal(readFileSync(join(f.home, "config.yaml"), "utf8"), original);
  } finally { f.dispose(); }
});

test("station apply requires explicit admission and restart hooks before writing", () => {
  const f = fixture();
  try {
    const result = f.run(["--apply"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires admission-close, admission-open and restart-command/);
    assert.equal(existsSync(join(f.home, "config.yaml")), false);
  } finally { f.dispose(); }
});
