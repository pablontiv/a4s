import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { dagName, issue, poll, withStation } from "./station.mjs";

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const clientEntry = path("./client.mjs");
const nextId = (label) => `pi-slice-${label}-${randomUUID()}`;
const detailPath = (runId) => `/dag-runs/${dagName}/${runId}`;

function successful(response, operation) {
  assert.ok(response.ok, `${operation}: HTTP ${response.status}: ${response.text}`);
  return JSON.parse(response.text);
}

function triageFields(data, runId) {
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.runId, runId);
  assert.equal(data.issue, issue);
  assert.equal(data.poc, "yes");
  for (const field of ["question", "reason"]) {
    assert.equal(typeof data[field], "string", field);
    assert.ok(data[field].trim(), `${field} vacío`);
  }
}

function startData(worker, state, runId) {
  return {
    dagRunId: runId,
    params: Object.entries({ ISSUE: issue, WORKER_ENTRY: worker, STATE_ROOT: state })
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(" "),
  };
}

function startResult(response, runId) {
  assert.equal(successful(response, `start ${runId}`).dagRunId, runId);
}

function decideNode(detail) {
  const matches = detail.nodes.filter(({ step }) => step.id === "decide");
  assert.equal(matches.length, 1, "Debe haber una única tarea decide.");
  return matches[0];
}

async function observe(station, runId, status, signal) {
  const detail = await poll(`${runId} → ${status}`, async () => {
    const response = await station.request(detailPath(runId));
    if (response.status === 404) return undefined;
    const { dagRunDetails } = successful(response, `status ${runId}`);
    assert.equal(dagRunDetails.name, dagName);
    assert.equal(dagRunDetails.dagRunId, runId);
    assert.ok(!["failed", "aborted", "cancelled"].includes(dagRunDetails.statusLabel), response.text);
    return dagRunDetails;
  }, (data) => data?.statusLabel === status, signal);
  const node = decideNode(detail);
  assert.equal(node.statusLabel, status, `decide en ${runId}`);
  assert.equal(node.retryCount, 0, "El piloto no reintenta decide.");
  if (status === "succeeded") assert.equal(node.doneCount, 1, "decide se completa una sola vez.");
  return detail;
}

function awaitingDecision(station, runId) {
  const dir = join(station.state, runId);
  triageFields(JSON.parse(readFileSync(join(dir, "triage.json"), "utf8")), runId);
  assert.equal(existsSync(join(dir, "decision.json")), false, "No hay decisión antes de responder.");
}

function evidence(station, runId) {
  const path = join(station.state, runId, "decision.json");
  const { ino, mtimeNs, ctimeNs } = statSync(path, { bigint: true });
  return { text: readFileSync(path, "utf8"), ino, mtimeNs, ctimeNs };
}

async function finish(station, runId, decision, signal) {
  const complete = (choice) => station.request(`${detailPath(runId)}/human-tasks/decide/complete`, {
    DECISION: choice,
  });
  const completed = await complete(decision);
  assert.ok(completed.ok, `decide ${decision}: HTTP ${completed.status}: ${completed.text}`);
  const detail = await observe(station, runId, "succeeded", signal);
  const first = evidence(station, runId);
  assert.deepEqual(JSON.parse(first.text), { schemaVersion: 1, runId, decision });
  station.runs.delete(runId);
  return { complete, first, detail };
}

async function checkDuplicate(station, runId, original, signal) {
  // Dagu 2.26.0 treats an identical replay as a no-op, a different value as a conflict.
  const duplicate = successful(await original.complete("APPROVE"), "decisión duplicada");
  assert.equal(duplicate.dagRunId, runId);
  assert.equal(duplicate.stepId, "decide");
  assert.equal(duplicate.alreadyCompleted, true);
  assert.equal(duplicate.queued, false);
  assert.equal(duplicate.resumeRequested, false);
  const opposite = await original.complete("REJECT");
  assert.equal(opposite.status, 409, `decisión opuesta tras cerrar decide: ${opposite.text}`);
  // Cover at least one scheduler tick in case a replay wrongly enqueued work.
  const until = Date.now() + 3_500;
  do {
    const current = await observe(station, runId, "succeeded", signal);
    assert.deepEqual(current, original.detail, "El estado persistido cambió tras duplicar decide.");
    assert.deepEqual(evidence(station, runId), original.first, "Se reescribió decision.json.");
    await sleep(100, undefined, { signal });
  } while (Date.now() < until);
}

async function checkClientClose(station, worker, signal) {
  const runId = nextId("client");
  const data = startData(worker, station.state, runId);
  const client = fork(clientEntry, [station.origin, dagName, JSON.stringify(data)], {
    ...station.opts, execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  // 'close' also settles if spawning this disposable client fails.
  const exited = new Promise((done) => client.once("close", (...result) => done(result)));
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  try {
    station.runs.add(runId);
    const response = await Promise.race([
      once(client, "message", { signal: deadline }).then(([message]) => message),
      exited.then(([code, reason]) => assert.fail(`Cliente cerrado antes de iniciar el run: ${code}/${reason}`)),
    ]);
    startResult(response, runId);
    await observe(station, runId, "waiting", signal);
    assert.equal(client.exitCode, null);
    assert.equal(client.signalCode, null);
  } finally {
    client.kill("SIGTERM");
    await exited;
  }
  assert.equal(client.signalCode, "SIGTERM", "Se cerró solo el proceso cliente.");
  await observe(station, runId, "waiting", signal);
  awaitingDecision(station, runId);
  await finish(station, runId, "APPROVE", signal);
  console.log("PASS cierre del cliente: otro cliente lee y decide el mismo run");
}

async function acceptance(station, worker, signal) {
  const workerId = nextId("worker");
  const stdout = await station.worker(worker, workerId);
  assert.match(stdout, /^[^\r\n]+\r?\n?$/, "El worker debe emitir una única línea JSON.");
  triageFields(JSON.parse(stdout), workerId);
  assert.equal(await station.worker(worker, workerId), stdout, "La fixture del worker no es determinista.");
  console.log("PASS worker: fixture opt-in, determinista y JSON en una línea");

  for (const decision of ["APPROVE", "REJECT"]) {
    const runId = nextId(decision.toLowerCase());
    station.runs.add(runId);
    startResult(await station.request(`/dags/${dagName}/start`, startData(worker, station.state, runId)), runId);
    await observe(station, runId, "waiting", signal);
    awaitingDecision(station, runId);
    const original = await finish(station, runId, decision, signal);
    console.log(`PASS ${decision}: Waiting → Succeeded con evidencia`);
    if (decision === "APPROVE") {
      await checkDuplicate(station, runId, original, signal);
      console.log("PASS duplicate decide: alreadyCompleted, sin segunda transición ni reescritura");
    }
  }
  await checkClientClose(station, worker, signal);
}

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && !["--fixture", "--e2e"].includes(args[0]))) {
  console.error("Uso: node pilots/pi-triage/acceptance/run.mjs [--fixture | --e2e]");
  process.exit(2);
}
const fixture = args[0] === "--fixture";
const definition = path(fixture ? "./fixtures/pi-triage-slice.yaml" : "../../../.workspace/dagu/pilot/pi-triage-slice.yaml");
const worker = path(fixture ? "./fixtures/triage.mjs" : "../worker/triage.mjs");
const companions = fixture ? [] : [path("../../../.workspace/dagu/pilot/pi-triage-slice.mjs")];
const missing = [definition, ...companions, worker].filter((entry) => !existsSync(entry));
if (missing.length > 0) {
  const problem = fixture ? "FAIL FIXTURE: faltan fixtures" : "BLOCKED E2E: faltan componentes reales";
  console.error(`${problem}:\n${missing.join("\n")}`);
  process.exit(2);
}
const mode = fixture ? "FIXTURE (solo harness)" : "E2E (DAG y worker reales, proveedor fixture)";
const abort = new AbortController();
const handlers = new Map([["SIGINT", 130], ["SIGTERM", 143]].map(([signal, exitCode]) => [signal, () => {
  process.exitCode = exitCode;
  abort.abort(new Error(`Interrumpido por ${signal}`));
}]));
for (const [signal, handler] of handlers) process.on(signal, handler);
try {
  console.log(`Inicio ${mode}`);
  await withStation(definition, abort.signal, (station) => acceptance(station, worker, abort.signal), { companions });
  abort.signal.throwIfAborted();
  console.log(`PASS ${mode}`);
} catch (error) {
  console.error(`FAIL ${mode}:`, error);
  process.exitCode ||= 1;
} finally {
  for (const [signal, handler] of handlers) process.off(signal, handler);
}
