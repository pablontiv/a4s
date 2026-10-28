import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { queueReadiness } from "../src/queue.ts";

test("station queue capacity is read-only and malformed or ambiguous entries fail", () => {
  const home = mkdtempSync(join(tmpdir(), "a4s-readiness-config-"));
  try {
    for (const config of ["queues: [broken", "queues: []", "queues:\n  enabled: false\n  config: []", "queues:\n  config:\n    - name: fixture\n    - name: fixture", "queues:\n  config:\n    - name: fixture\n      max_concurrency: 0"]) {
      writeFileSync(join(home, "config.yaml"), config);
      assert.match(queueReadiness(home, "fixture"), /ready=no/);
      assert.equal(readFileSync(join(home, "config.yaml"), "utf8"), config);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("station queue reports configured capacity without changing foreign station bytes", () => {
  const home = mkdtempSync(join(tmpdir(), "a4s-readiness-capacity-"));
  try {
    const config = "# foreign capacity\nqueues:\n  enabled: true\n  config:\n    - name: foreign\n      max_concurrency: 3\n";
    writeFileSync(join(home, "config.yaml"), config);
    assert.match(queueReadiness(home, "fixture"), /queue=fixture source=config.yaml ready=no/);
    assert.equal(queueReadiness(home, "foreign"), "queue=foreign source=config.yaml max_concurrency=3 ready=yes");
    assert.equal(readFileSync(join(home, "config.yaml"), "utf8"), config);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
