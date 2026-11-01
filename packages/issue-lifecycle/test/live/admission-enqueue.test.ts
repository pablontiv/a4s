import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import type { Observation, Receipt } from "../../src/admission.ts";
import { admissionFixture } from "../fixtures/admission.ts";

test("successful enqueue stays admitted with an incident when observation persistence fails", { timeout: 120_000 }, () => {
  const fixture = admissionFixture();
  try {
    const bin = join(fixture.root, "bin");
    mkdirSync(bin);
    const ledger = join(fixture.root, "enqueues.jsonl");
    const dagu = join(bin, "dagu");
    writeFileSync(dagu, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "version") console.log("2.24.0");
else if (args[0] === "enqueue") {
  fs.appendFileSync(${JSON.stringify(ledger)}, JSON.stringify(args) + "\\n");
  const state = path.dirname(path.dirname(args[3]));
  if (process.env.A4S_TEST_OBSERVATION_FAILURE) {
    fs.mkdirSync(path.join(state, "receipt.json") + "." + process.ppid + ".tmp");
  }
  if (process.env.A4S_TEST_OBSERVATION_FAILURE === "incident") {
    fs.mkdirSync(path.join(state, "enqueue-incident.json"));
  }
  if (process.env.A4S_TEST_ENQUEUE_SIGNAL) process.kill(process.pid, "SIGTERM");
  else process.exitCode = Number(process.env.A4S_TEST_ENQUEUE_EXIT || "0");
} else process.exitCode = 91;
`);
    chmodSync(dagu, 0o755);
    const cases = [
      { run: "enqueued", failure: "", exit: "0", signal: "", status: 0 },
      { run: "admitted-incident", failure: "append", exit: "0", signal: "", status: 0 },
      { run: "admitted-unwritable-incident", failure: "incident", exit: "0", signal: "", status: 0 },
      { run: "enqueue-failed-incident", failure: "append", exit: "7", signal: "", status: 7 },
      { run: "enqueue-signalled-incident", failure: "append", exit: "0", signal: "yes", status: 1 },
    ];
    for (const scenario of cases) {
      const result = fixture.command("enqueue", scenario.run, { PATH: `${bin}:${process.env.PATH ?? ""}`,
        A4S_TEST_OBSERVATION_FAILURE: scenario.failure, A4S_TEST_ENQUEUE_EXIT: scenario.exit, A4S_TEST_ENQUEUE_SIGNAL: scenario.signal });
      assert.equal(result.status, scenario.status, result.stderr);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /DAGU_ADMISSION_REJECTED/);
      assert.match(result.stdout, /receipt=/);
      if (scenario.status === 0) assert.match(result.stdout, /admitted=yes/);
      const path = fixture.receipt(scenario.run);
      const receipt: Receipt = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(readFileSync(join(dirname(path), "snapshot/feature.yaml"), "utf8"), receipt.initial.execution.dagSnapshot);
      const incidentPath = join(dirname(path), "enqueue-incident.json");
      if (!scenario.failure) {
        assert.equal(receipt.runReceipt.observations.at(-1)?.kind, "enqueued");
        assert.equal(existsSync(incidentPath), false);
        assert.doesNotMatch(result.stderr, /DAGU_ADMISSION_INCIDENT/);
        continue;
      }
      assert.equal(receipt.runReceipt.observations.length, 0);
      const diagnosticLine = result.stderr.split("\n").find(line => line.startsWith("DAGU_ADMISSION_INCIDENT: "));
      assert.ok(diagnosticLine, result.stderr);
      const diagnostic = JSON.parse(diagnosticLine.slice("DAGU_ADMISSION_INCIDENT: ".length));
      assert.equal(diagnostic.receipt, path);
      assert.equal(diagnostic.incidentPath, incidentPath);
      const incident: Observation = diagnostic.incident;
      assert.equal(incident.kind, "incident:enqueue-observation");
      assert.equal(incident.dag, "feature");
      assert.equal(incident.run, scenario.run);
      assert.equal(incident.attempt, 1);
      assert.ok(Number.isFinite(Date.parse(incident.at)));
      const data = incident.data as { admitted: boolean; error: string; observation: Omit<Observation, "at"> };
      assert.equal(data.admitted, scenario.status === 0);
      assert.match(data.error, /EISDIR/);
      assert.equal(data.observation.kind, scenario.status === 0 ? "enqueued" : "incident");
      const enqueueData = data.observation.data;
      assert.ok(enqueueData && typeof enqueueData === "object" && "latency" in enqueueData);
      assert.equal(typeof enqueueData.latency, "number");
      assert.deepEqual(enqueueData, { exit: scenario.signal ? null : Number(scenario.exit),
        signal: scenario.signal ? "SIGTERM" : null, originalDag: fixture.dag,
        snapshot: join(dirname(path), "snapshot/feature.yaml"), latency: enqueueData.latency });
      if (scenario.failure === "incident") assert.match(diagnostic.persistenceError, /EISDIR/);
      else {
        assert.equal(diagnostic.persistenceError, undefined);
        assert.deepEqual(JSON.parse(readFileSync(incidentPath, "utf8")), incident);
      }
    }
    const enqueues: string[][] = readFileSync(ledger, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(enqueues.map(args => args[2]), cases.map(scenario => scenario.run), "each admission calls enqueue exactly once");
  } finally { fixture.dispose(); }
});
