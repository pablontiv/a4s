import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { requestDagu } from "./sandbox.ts";
import { CHOICES, createSupervisor } from "./supervisor.ts";

const dag = "pi-triage-slice";
const runId = "pi-slice-test";
const issue = "fixture-1";
const getPath = `/api/v1/dag-runs/${dag}/${runId}`;
const postPath = `${getPath}/human-tasks/decide/complete`;
const startedAt = "2026-11-17T10:01:00.123-06:00";
const triage = { schemaVersion: 1, issue, runId, poc: "yes", question: "¿Está listo?", reason: "Fixture." };
const verdict = { schemaVersion: 1, runId, decision: "REJECT" };
const accepted = { dagName: dag, dagRunId: runId, stepId: "decide", alreadyCompleted: false, queued: true };
const reply = (status, payload = {}) => ({ status, body: JSON.stringify(payload) });
const json = (path, value) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });

function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "pi-slice-supervisor-test-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const daguHome = join(root, "home");
  const stateRoot = join(root, "state private");
  const marker = join(daguHome, ".a4s-pi-triage-slice");
  mkdirSync(daguHome, { mode: 0o700 });
  mkdirSync(stateRoot, { mode: 0o700 });
  const runDir = join(stateRoot, runId);
  mkdirSync(runDir, { mode: 0o700 });
  const config = {
    schemaVersion: 1, access: "supervise", apiPort: 48123, daguHome, stateRoot,
    daguBin: join(root, "dagu"), daguConfig: join(daguHome, "config.yaml"),
    workerEntry: join(root, "worker entry.mjs"), dagFile: join(root, "pi-triage-slice.yaml"), pathDirs: [root],
  };
  writeFileSync(config.daguBin, Buffer.from("7f454c46", "hex"), { mode: 0o700 }); // Header only; execute is a double.
  for (const path of [config.daguConfig, config.dagFile, config.workerEntry, marker]) writeFileSync(path, "", { mode: 0o600 });
  const configPath = join(root, "supervisor.json");
  json(configPath, config);
  json(join(runDir, "triage.json"), triage);
  const details = {
    name: dag, dagRunId: runId, statusLabel: "waiting", log: join(daguHome, "logs", "run.log"),
    params: `ISSUE=${issue} STATE_ROOT=${stateRoot} WORKER_ENTRY=${config.workerEntry}`,
    nodes: [{ step: { name: "decide", id: "decide", humanTask: { prompt: "Decide" } }, statusLabel: "waiting", startedAt, retryCount: 0 }],
  };
  const calls = [];
  const executions = [];
  const db = { get: () => reply(200, { dagRunDetails: details }), post: () => reply(200, accepted), version: "2.26.0" };
  const supervisor = createSupervisor(configPath, {
    request: async (url, { method, signal, body }) => {
      assert.equal(url.origin, "http://127.0.0.1:48123");
      assert.equal(url.search, "");
      assert.equal(signal.aborted, false);
      calls.push({ method, path: url.pathname, body });
      return method === "GET" ? db.get() : db.post();
    },
    execute: async (file, argv, options) => {
      executions.push({ file, argv, options });
      return { stdout: argv[0] === "version" ? `${db.version}\n` : "" };
    },
  });
  return { root, marker, runDir, config, configPath, details, calls, db, executions, supervisor };
}

const methods = (fx) => fx.calls.map(({ method }) => method);

async function token(fx) {
  const { snapshot } = await fx.supervisor.status(runId);
  assert.equal(snapshot.phase, "awaiting_decision");
  assert.match(snapshot.token, /^[a-f0-9]{64}$/);
  fx.calls.length = 0;
  return snapshot.token;
}

test("start comprueba ausencia y versión; ejecuta solo el fixture, argv y entorno explícitos", async (t) => {
  const fx = fixture(t);
  const { config } = fx;
  fx.db.get = () => reply(404);
  assert.equal((await fx.supervisor.start(runId)).outcome, "started");
  assert.deepEqual(fx.calls, [{ method: "GET", path: getPath, body: undefined }]);
  assert.deepEqual(fx.executions.map(({ file, argv }) => [file, argv]), [
    [config.daguBin, ["version"]],
    [config.daguBin, ["start", "--context", "local", "--dagu-home", config.daguHome, "--config", config.daguConfig,
      "--run-id", runId, "--name", dag, config.dagFile, "--", `ISSUE=${issue}`, `WORKER_ENTRY=${config.workerEntry}`, `STATE_ROOT=${config.stateRoot}`]],
  ]);
  assert.equal(fx.executions[1].options.cwd, fx.root);
  assert.deepEqual(fx.executions[1].options.env, {
    HOME: config.daguHome, DAGU_HOME: config.daguHome, DAGU_SKIP_EXAMPLES: "true",
    XDG_CONFIG_HOME: join(config.daguHome, "xdg-config"), XDG_DATA_HOME: join(config.daguHome, "xdg-data"),
    XDG_CACHE_HOME: join(config.daguHome, "xdg-cache"), XDG_STATE_HOME: join(config.daguHome, "xdg-state"),
    TMPDIR: config.daguHome, PATH: fx.root, A4S_PI_TRIAGE_FIXTURE: "1",
  });
});

test("start no duplica un run visible ni ejecuta una versión distinta", async (t) => {
  const fx = fixture(t);
  assert.equal((await fx.supervisor.start(runId)).outcome, "already_exists");
  assert.equal(fx.executions.length, 0);
  fx.db.get = () => reply(404);
  fx.db.version = "2.27.0";
  await assert.rejects(fx.supervisor.start(runId), /admite Dagu 2\.26\.0/);
  assert.deepEqual(fx.executions.map(({ argv }) => argv[0]), ["version"]);
});

test("status lee triage.json, devuelve token estable y luego el veredicto validado", async (t) => {
  const fx = fixture(t);
  const before = await fx.supervisor.status(runId);
  assert.equal(before.outcome, "observed");
  assert.deepEqual(before.snapshot.triage, triage);
  assert.equal(before.snapshot.verdict, null);
  assert.equal(before.snapshot.token, await token(fx));
  json(join(fx.runDir, "decision.json"), verdict);
  fx.details.statusLabel = "succeeded";
  fx.details.nodes[0].statusLabel = "succeeded";
  const after = await fx.supervisor.status(runId);
  assert.equal(after.snapshot.phase, "resolved");
  assert.deepEqual(after.snapshot.verdict, verdict);
  assert.equal(after.snapshot.token, null);
  assert.equal(fx.executions.length, 0);
});

test("status no habilita decide sin evidencia, con fase incorrecta o con paso reintentado", async (t) => {
  const fx = fixture(t);
  const path = join(fx.runDir, "triage.json");
  rmSync(path);
  assert.equal((await fx.supervisor.status(runId)).snapshot.phase, "waiting_for_evidence");
  json(path, triage);
  fx.details.nodes[0].retryCount = 1;
  assert.equal((await fx.supervisor.status(runId)).snapshot.token, null);
  fx.details.nodes[0].retryCount = 0;
  fx.details.statusLabel = "running";
  assert.equal((await fx.supervisor.status(runId)).snapshot.token, null);
  fx.details.statusLabel = "waiting";
  fx.details.nodes[0].startedAt = "invalid";
  assert.equal((await fx.supervisor.status(runId)).snapshot.token, null);
});

test("denegar, cancelar, fallar la UI o no tener UI nunca envía POST", async (t) => {
  const fx = fixture(t);
  const reviewed = await token(fx);
  assert.equal((await fx.supervisor.decide(runId, "APPROVE", reviewed)).outcome, "denied");
  assert.deepEqual(fx.calls, []);
  assert.equal((await fx.supervisor.decide(runId, "APPROVE", reviewed, async () => false)).outcome, "denied");
  assert.equal((await fx.supervisor.decide(runId, "APPROVE", reviewed, async () => { throw new Error("UI perdida"); })).outcome, "denied");
  const controller = new AbortController();
  const cancelled = await fx.supervisor.decide(runId, "REJECT", reviewed, async (_text, dialogSignal) => {
    controller.abort();
    assert.equal(dialogSignal.aborted, true);
    return true;
  }, controller.signal);
  assert.equal(cancelled.outcome, "denied");
  assert.deepEqual(methods(fx), ["GET", "GET", "GET"]);
});

test("confirmación afirmativa: GET, diálogo, GET fresco y un único POST del valor exacto", async (t) => {
  for (const decision of ["APPROVE", "REJECT"]) {
    const fx = fixture(t);
    const reviewed = await token(fx);
    const result = await fx.supervisor.decide(runId, decision, reviewed, async (text, signal) => {
      assert.ok(text.includes(`${dag}/${runId}`) && text.includes(issue));
      assert.ok(text.includes(`DECISION=${decision}`) && text.includes(startedAt));
      assert.ok(text.includes(triage.question) && text.includes(triage.reason));
      assert.equal(signal.aborted, false);
      assert.deepEqual(methods(fx), ["GET"]);
      return true;
    });
    assert.equal(result.outcome, "completed");
    assert.deepEqual(methods(fx), ["GET", "GET", "POST"]);
    assert.deepEqual(fx.calls.at(-1), { method: "POST", path: postPath, body: JSON.stringify({ DECISION: decision }) });
  }
});

test("una espera cambiada antes o durante el diálogo es obsoleta, no se completa", async (t) => {
  const fx = fixture(t);
  const reviewed = await token(fx);
  const old = await fx.supervisor.decide(runId, "REJECT", "a".repeat(64), () => assert.fail("diálogo obsoleto"));
  assert.equal(old.outcome, "stale");
  const changed = await fx.supervisor.decide(runId, "REJECT", reviewed, async () => {
    fx.details.nodes[0].startedAt = "2026-11-17T10:01:00.124-06:00";
    return true;
  });
  assert.equal(changed.outcome, "stale");
  assert.deepEqual(methods(fx), ["GET", "GET", "GET"]);
  assert.notEqual(await token(fx), reviewed);
});

test("la evidencia cambiada durante el diálogo invalida el token", async (t) => {
  const fx = fixture(t);
  const reviewed = await token(fx);
  const changed = await fx.supervisor.decide(runId, "REJECT", reviewed, async () => {
    json(join(fx.runDir, "triage.json"), { ...triage, question: "¿Cambió?" });
    return true;
  });
  assert.equal(changed.outcome, "stale");
  assert.deepEqual(methods(fx), ["GET", "GET"]);
});

test("distingue una decisión ya resuelta durante el diálogo y a partir de 409", async (t) => {
  const fx = fixture(t);
  const reviewed = await token(fx);
  const resolveElsewhere = () => {
    fx.details.nodes[0].statusLabel = "succeeded";
    fx.details.statusLabel = "queued";
  };
  const done = await fx.supervisor.decide(runId, "REJECT", reviewed, async () => {
    resolveElsewhere();
    return true;
  });
  assert.equal(done.outcome, "already_resolved");
  assert.deepEqual(methods(fx), ["GET", "GET"]);
  fx.details.nodes[0].statusLabel = fx.details.statusLabel = "waiting";
  const again = await token(fx);
  fx.db.post = () => { resolveElsewhere(); return reply(409); };
  const conflict = await fx.supervisor.decide(runId, "REJECT", again, async () => true);
  assert.equal(conflict.outcome, "already_resolved");
  assert.deepEqual(methods(fx), ["GET", "GET", "POST", "GET"]);
});

test("GET inaccesible tras confirmar: ningún POST ni acción de CLI", async (t) => {
  const fx = fixture(t);
  const reviewed = await token(fx);
  await assert.rejects(fx.supervisor.decide(runId, "APPROVE", reviewed, async () => {
    fx.db.get = () => { throw new Error("ECONNREFUSED"); };
    return true;
  }), /no autoriza ninguna acción/);
  assert.deepEqual(methods(fx), ["GET", "GET"]);
  assert.equal(fx.executions.length, 0);
  await assert.rejects(fx.supervisor.start(runId), /no autoriza ninguna acción/);
  assert.equal(fx.executions.length, 0);
});

test("fallo de transporte en el POST: resultado incierto y ningún replay", async (t) => {
  const fx = fixture(t);
  const reviewed = await token(fx);
  fx.db.post = () => { throw new Error("socket closed after body"); };
  const result = await fx.supervisor.decide(runId, "REJECT", reviewed, async () => true);
  assert.equal(result.outcome, "unconfirmed");
  assert.match(result.message, /factory_status/);
  assert.deepEqual(methods(fx), ["GET", "GET", "POST"]);
});

test("perfil recurrente observe no deja iniciar ni decidir, aun con confirmación", async (t) => {
  const fx = fixture(t);
  json(fx.configPath, { ...fx.config, access: "observe" });
  const reviewed = await token(fx);
  assert.equal((await fx.supervisor.start(runId)).outcome, "read_only");
  assert.equal((await fx.supervisor.decide(runId, "APPROVE", reviewed, () => assert.fail("UI de tarea recurrente"))).outcome, "read_only");
  assert.deepEqual(fx.calls, []);
  assert.deepEqual(fx.executions, []);
});

test("config/marker/privacidad/ID inválidos fallan antes del transporte", async (t) => {
  const fx = fixture(t);
  await assert.rejects(createSupervisor(undefined).status(runId), /A4S_PI_TRIAGE_SUPERVISOR_CONFIG/);
  for (const bad of ["latest", "pi-slice-../feature", "pi-slice-x\n", "pi-slice-x?remoteNode=station"]) {
    await assert.rejects(fx.supervisor.status(bad), /runId inválido/);
  }
  json(fx.configPath, { ...fx.config, apiPort: 8080 });
  await assert.rejects(fx.supervisor.start(runId), /puerto efímero/);
  json(fx.configPath, fx.config);
  chmodSync(fx.config.stateRoot, 0o755);
  await assert.rejects(fx.supervisor.status(runId), /STATE_ROOT/);
  chmodSync(fx.config.stateRoot, 0o700);
  rmSync(fx.marker);
  await assert.rejects(fx.supervisor.status(runId), /\.a4s-pi-triage-slice/);
  writeFileSync(fx.marker, "", { mode: 0o600 });
  writeFileSync(fx.config.daguBin, "#!/bin/sh\nexit 0\n");
  await assert.rejects(fx.supervisor.start(runId), /binario nativo/);
  assert.deepEqual(fx.calls, []);
  assert.deepEqual(fx.executions, []);
});

test("estado fuera del sandbox y evidencia inválida o enlazada no habilitan decide", async (t) => {
  const fx = fixture(t);
  const reviewed = await token(fx);
  for (const [key, invalid] of [["name", "feature"], ["dagRunId", "pi-slice-other"], ["params", "ISSUE=999"], ["log", "/tmp/station.log"]]) {
    const original = fx.details[key];
    fx.details[key] = invalid;
    await assert.rejects(fx.supervisor.status(runId), /no corresponde/);
    fx.details[key] = original;
  }
  const path = join(fx.runDir, "triage.json");
  for (const invalid of [{ runId: "pi-slice-other" }, { issue: "fixture-2" }, { schemaVersion: 2 }, { poc: "no" }, { reason: " " }]) {
    json(path, { ...triage, ...invalid });
    await assert.rejects(fx.supervisor.decide(runId, "APPROVE", reviewed, () => assert.fail("evidencia inválida")), /triage.json no cumple/);
  }
  rmSync(path);
  const external = join(fx.root, "external.json");
  json(external, triage);
  symlinkSync(external, path);
  await assert.rejects(fx.supervisor.status(runId), /ELOOP/);
  rmSync(path);
  json(path, triage);
  json(join(fx.runDir, "decision.json"), { ...verdict, decision: "YES" });
  await assert.rejects(fx.supervisor.status(runId), /decision.json no cumple/);
  assert.ok(fx.calls.every(({ method }) => method === "GET"));
});

test("transporte HTTP directo no sigue redirects y serializa el POST exacto", async (t) => {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push([req.method, req.url, req.headers["content-type"], Buffer.concat(chunks).toString()]);
    if (req.method === "GET") res.writeHead(302, { Location: "/no-follow" });
    res.end("{}");
  });
  t.after(() => server.close());
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const origin = `http://127.0.0.1:${addr.port}`;
  const signal = AbortSignal.timeout(3000);
  assert.equal((await requestDagu(new URL(getPath, origin), { method: "GET", signal })).status, 302);
  assert.equal((await requestDagu(new URL(postPath, origin), { method: "POST", signal, body: '{"DECISION":"REJECT"}' })).status, 200);
  assert.deepEqual(seen, [["GET", getPath, undefined, ""], ["POST", postPath, "application/json", '{"DECISION":"REJECT"}']]);
});

test("request: el clic del operador decide; el modelo nunca elige el valor", async (t) => {
  for (const [choice, decision] of [[CHOICES.APPROVE, "APPROVE"], [CHOICES.REJECT, "REJECT"]]) {
    const fx = fixture(t);
    const result = await fx.supervisor.request(runId, async (title, options, signal) => {
      assert.ok(title.includes(runId) && title.includes(issue));
      assert.ok(title.includes(triage.question) && title.includes(triage.reason) && title.includes(startedAt));
      assert.deepEqual(options, [CHOICES.APPROVE, CHOICES.REJECT, CHOICES.LATER]);
      assert.equal(signal.aborted, false);
      assert.deepEqual(methods(fx), ["GET"]);
      return choice;
    });
    assert.equal(result.outcome, "completed");
    assert.equal(result.decidedBy, "operator-click");
    assert.deepEqual(methods(fx), ["GET", "GET", "GET", "POST"]);
    assert.deepEqual(fx.calls.at(-1), { method: "POST", path: postPath, body: JSON.stringify({ DECISION: decision }) });
  }
});

test("request: Después, sin respuesta, UI fallida, cancelada o ausente nunca envían POST", async (t) => {
  const fx = fixture(t);
  for (const choose of [async () => CHOICES.LATER, async () => undefined, async () => "aprobar", async () => { throw new Error("UI perdida"); }]) {
    assert.equal((await fx.supervisor.request(runId, choose)).outcome, "deferred");
  }
  const controller = new AbortController();
  const cancelled = await fx.supervisor.request(runId, async () => { controller.abort(); return CHOICES.APPROVE; }, controller.signal);
  assert.equal(cancelled.outcome, "deferred");
  assert.equal((await fx.supervisor.request(runId)).outcome, "denied");
  assert.ok(fx.calls.every(({ method }) => method === "GET"));
});

test("request: sin espera abierta no muestra botones y la evidencia cambiada invalida el clic", async (t) => {
  const fx = fixture(t);
  fx.details.statusLabel = "running";
  const inactive = await fx.supervisor.request(runId, () => assert.fail("no hay decisión pendiente"));
  assert.equal(inactive.outcome, "observed");
  assert.equal(inactive.snapshot.phase, "inactive");
  fx.details.statusLabel = "waiting";
  const changed = await fx.supervisor.request(runId, async () => {
    json(join(fx.runDir, "triage.json"), { ...triage, question: "¿Cambió?" });
    return CHOICES.APPROVE;
  });
  assert.equal(changed.outcome, "stale");
  assert.ok(fx.calls.every(({ method }) => method === "GET"));
});

test("request: el perfil observe no muestra botones ni decide", async (t) => {
  const fx = fixture(t);
  json(fx.configPath, { ...fx.config, access: "observe" });
  assert.equal((await fx.supervisor.request(runId, () => assert.fail("UI en perfil observe"))).outcome, "read_only");
  assert.deepEqual(fx.calls, []);
});
