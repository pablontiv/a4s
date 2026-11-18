import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  accessSync, closeSync, constants, copyFileSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const dagName = "pi-triage-slice";
export const issue = "fixture-1";
const loopback = "127.0.0.1";
const nativeMagic = new Set(["7f454c46", "feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "cafebabf"]);

function nativeDagu() {
  const command = process.env.DAGU_BIN || "dagu";
  const candidates = command.includes("/") ? [resolve(command)] :
    (process.env.PATH ?? "").split(delimiter).map((dir) => resolve(dir, command));
  const binary = candidates.find((path) => {
    try { accessSync(path, constants.X_OK); return true; } catch { return false; }
  });
  assert.ok(binary, "Se requiere Dagu 2.26.0 en PATH o DAGU_BIN absoluto.");
  const magic = Buffer.alloc(4);
  const fd = openSync(binary, "r");
  try { readSync(fd, magic); } finally { closeSync(fd); }
  assert.ok(nativeMagic.has(magic.toString("hex")),
    `Dagu debe ser el binario nativo, no un launcher/wrapper del operador: ${binary}. Usa DAGU_BIN.`);
  return binary;
}

async function loopbackPort() {
  const probe = createServer();
  probe.listen(0, loopback);
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((done, reject) => probe.close((error) => error ? reject(error) : done()));
  return port;
}

// Every child gets an allowlist, not the parent env minus a few known secrets.
function stationEnv(root, home, bin) {
  const dirs = {
    HOME: join(root, "home"), TMPDIR: join(root, "tmp"),
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "xdg-state"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { mode: 0o700 });
  return {
    ...dirs,
    PATH: [bin, ...(process.env.PATH ?? "").split(delimiter).filter((dir) => dir.startsWith("/"))].join(delimiter),
    LANG: "C", DAGU_HOME: home, A4S_PI_TRIAGE_FIXTURE: "1",
  };
}

function launch(file, args, options) {
  const child = spawn(file, args, { ...options, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", error;
  child.stdout.setEncoding("utf8").on("data", (data) => { stdout = (stdout + data).slice(-64_000); });
  child.stderr.setEncoding("utf8").on("data", (data) => { stderr = (stderr + data).slice(-64_000); });
  child.on("error", (failure) => { error = failure; });
  const exited = new Promise((done) => child.once("close", (code, signal) => done({ code, signal, stdout, stderr, error })));
  return { child, exited, logs: () => `${error ?? ""}\n${stdout}\n${stderr}`.trim() };
}

async function end({ child, exited }) {
  const send = (signal) => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    try { process.kill(-child.pid, signal); } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  const grace = new AbortController();
  send("SIGTERM");
  try {
    const result = await Promise.race([exited, sleep(3_000, null, { signal: grace.signal })]);
    if (result) return result;
    send("SIGKILL");
    return await exited;
  } finally { grace.abort(); }
}

// Use a one-shot direct connection even if the parent Node enables env proxies.
function localRequest(url, body, signal) {
  return new Promise((done, reject) => {
    const options = { agent: false, signal };
    if (body !== undefined) {
      options.method = "POST";
      options.headers = { "content-type": "application/json" };
    }
    const request = httpRequest(url, options, (response) => {
      let text = "";
      response.setEncoding("utf8").on("data", (chunk) => { text += chunk; });
      response.on("error", reject).on("end", () => {
        const status = response.statusCode;
        done({ status, ok: status >= 200 && status < 300, text });
      });
    });
    request.on("error", reject).end(body === undefined ? undefined : JSON.stringify(body));
  });
}

export async function poll(description, read, accept, signal, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let observation;
  do {
    signal.throwIfAborted();
    observation = await read();
    if (accept(observation)) return observation;
    await sleep(100, undefined, { signal });
  } while (Date.now() < deadline);
  assert.fail(`${description}: timeout; última observación ${JSON.stringify(observation)}`);
}

export async function withStation(definition, signal, run) {
  const binary = nativeDagu();
  const root = mkdtempSync(resolve(tmpdir(), "a4s-pi-triage-"));
  const home = join(root, "dagu"), state = join(root, "state"), bin = join(root, "bin");
  const dags = join(home, "dags"), config = join(home, "config.yaml"), baseConfig = join(home, "base.yaml");
  const marker = join(home, ".a4s-pi-triage-slice"), forbidden = join(root, "forbidden-command");
  const token = randomUUID();
  const base = `/a4s-pi-triage-${token}`;
  const runs = new Set();
  let station, ready = false, origin, owned = false;
  try {
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(marker, `${token}\n`, { mode: 0o600, flag: "wx" });
    owned = true;
    for (const dir of [state, bin, dags]) mkdirSync(dir, { mode: 0o700 });
    const env = stationEnv(root, home, bin);
    env.A4S_PILOT_FORBIDDEN = forbidden;
    symlinkSync(process.execPath, join(bin, "node"));
    symlinkSync(binary, join(bin, "dagu"));
    for (const command of ["omp", "tern", "gh", "git"]) {
      writeFileSync(join(bin, command), `#!/bin/sh\nprintf '%s\\n' ${command} >> "$A4S_PILOT_FORBIDDEN"\nexit 127\n`, { mode: 0o700 });
    }
    copyFileSync(definition, join(dags, `${dagName}.yaml`));
    const port = await loopbackPort();
    origin = `http://${loopback}:${port}${base}`;
    // Dagu 2.26's HTTP launcher does not forward arbitrary server env to steps.
    // Inject only these values via the private base config; don't patch the DAG under test.
    writeFileSync(baseConfig,
      `env:\n  - A4S_PI_TRIAGE_FIXTURE: "1"\n  - A4S_PILOT_FORBIDDEN: ${JSON.stringify(forbidden)}\n`,
      { mode: 0o600 });
    writeFileSync(config, [
      `host: ${loopback}`, `port: ${port}`, `base_path: ${base}`, "paths:",
      `  base_config: ${JSON.stringify(baseConfig)}`, "auth:", "  mode: none",
      "skip_examples: true", "coordinator:", "  enabled: false", "queues:", "  enabled: true",
      "scheduler:", "  port: 0", "",
    ].join("\n"), { mode: 0o600 });
    const opts = { cwd: root, env };
    const cli = (args) => launch(binary, args, opts);
    const checked = async (child, label, timeout, abortSignal) => {
      const deadline = AbortSignal.timeout(timeout);
      const stop = abortSignal ? AbortSignal.any([abortSignal, deadline]) : deadline;
      const terminate = () => void end(child).catch((error) => console.error(error));
      if (stop.aborted) terminate();
      else stop.addEventListener("abort", terminate, { once: true });
      try {
        const result = await child.exited;
        stop.throwIfAborted();
        assert.equal(result.code, 0, `${label}: ${child.logs()}`);
        return result.stdout;
      } finally { stop.removeEventListener("abort", terminate); }
    };
    const globalFlags = ["--config", config, "--dagu-home", home];
    const version = await checked(cli(["version"]), "Dagu version", 5_000, signal);
    assert.equal(version.trim(), "2.26.0", "El harness está fijado a Dagu 2.26.0.");
    // Completing human.task enqueues the continuation in 2.26.0.
    station = cli(["start-all", ...globalFlags, "--dags", dags, "--host", loopback, "--port", String(port)]);
    const request = (path, body) => localRequest(`${origin}/api/v1${path}`, body,
      AbortSignal.any([signal, AbortSignal.timeout(5_000)]));
    await poll("arranque de la estación privada", async () => {
      assert.equal(station.child.exitCode, null, station.logs());
      const response = await localRequest(`${origin}/api/v1/dags`, undefined,
        AbortSignal.any([signal, AbortSignal.timeout(800)])).catch(() => undefined);
      return response?.ok ? response.text : undefined;
    }, (body) => body?.includes(dagName), signal, 10_000);
    ready = true;
    await run({
      opts, request, origin, state, runs,
      worker: (entry, runId) => checked(
        launch(process.execPath, [entry, "--issue", issue, "--run-id", runId], opts),
        "Worker fixture", 10_000, signal),
    });
    const forbiddenCalls = (() => {
      try { return readFileSync(forbidden, "utf8"); } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return "";
      }
    })();
    assert.equal(forbiddenCalls, "", "Se invocó OMP, Tern, GitHub CLI o Git.");
  } catch (error) {
    if (station) console.error(`Log de la estación privada:\n${station.logs()}`);
    throw error;
  } finally {
    try {
      if (station) {
        try {
          // Run subprocesses may have their own process group. Stop only the IDs
          // submitted here; waiting/terminal runs have no live executor to stop.
          if (ready) await stopRuns(origin, runs);
        } finally { await end(station); }
      }
    } finally {
      if (owned) {
        assert.equal(readFileSync(marker, "utf8"), `${token}\n`, "No se borra un home sin nuestro marcador.");
      }
      rmSync(root, { recursive: true, force: true });
    }
  }
}

async function stopRuns(origin, runs) {
  const running = new Set(["running", "queued"]);
  await Promise.all([...runs].map(async (runId) => {
    assert.match(runId, /^pi-slice-[a-z0-9-]+$/);
    const url = `${origin}/api/v1/dag-runs/${dagName}/${runId}`;
    const deadline = AbortSignal.timeout(5_000);
    const status = async () => {
      const response = await localRequest(url, undefined, deadline);
      if (response.status === 404) return undefined;
      assert.ok(response.ok, response.text);
      return JSON.parse(response.text).dagRunDetails.statusLabel;
    };
    await poll(`teardown ${runId}`, async () => {
      const before = await status();
      if (running.has(before)) {
        // A queued run can become running just after this call; recheck until settled.
        await localRequest(`${url}/stop`, {}, deadline);
      }
      return before;
    }, (label) => !running.has(label), deadline, 5_000);
  }));
}
