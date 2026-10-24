#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { isMap, parseDocument } from "yaml";
import { REQUIRED_DAGU_VERSION } from "../src/bundle.ts";
import { queueCompatibility, stampedQueue } from "../src/queue.ts";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    "dagu-home": { type: "string" },
    "launch-agent": { type: "string" },
    "log-dir": { type: "string" },
    check: { type: "boolean", default: false },
    apply: { type: "boolean", default: false },
    "admission-close": { type: "string" },
    "admission-open": { type: "string" },
    "restart-command": { type: "string" },
    "repo-dag": { type: "string" },
    "timeout-seconds": { type: "string", default: "600" },
    help: { type: "boolean", default: false },
  } });
  if (values.help) {
    console.log("dagu-station-install [--dagu-home DIR] [--launch-agent FILE] [--log-dir DIR] [--check | --apply --repo-dag FILE --admission-close CMD --admission-open CMD --restart-command CMD] [--timeout-seconds 600]\nDefaults: DAGU_HOME or ~/.dagu; plist staged at <dagu-home>/LaunchAgent.plist; logs at <dagu-home>/logs/service.\n--check compares desired files without installing. Default installation defers activation. --apply closes admission, drains running and queued runs, requests TERM restart, verifies the repository's stamped capacity, then reopens admission. Service hooks belong to the operator.");
    return;
  }
  const timeout = Number(values["timeout-seconds"]) * 1000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("timeout-seconds must be positive");
  if (values.check && values.apply) throw new Error("--check and --apply are mutually exclusive");
  if (values.apply && (!values["admission-close"] || !values["admission-open"] || !values["restart-command"])) {
    throw new Error("--apply requires admission-close, admission-open and restart-command");
  }
  if (values.apply && !values["repo-dag"]) throw new Error("--apply requires --repo-dag pointing to a repository's stamped render; reconcile it with bootstrap first");
  const version = execFileSync("dagu", ["version"], { encoding: "utf8" }).trim();
  if (version !== REQUIRED_DAGU_VERSION) {
    throw new Error(`dagu version=${JSON.stringify(version)} required=${REQUIRED_DAGU_VERSION}; install the expected binary on PATH`);
  }
  const binary = resolve(execFileSync("which", ["dagu"], { encoding: "utf8" }).trim());
  const home = resolve(values["dagu-home"] || process.env.DAGU_HOME || join(homedir(), ".dagu"));
  const launchAgent = resolve(values["launch-agent"] || join(home, "LaunchAgent.plist"));
  const logDir = resolve(values["log-dir"] || join(home, "logs", "service"));
  const template = (name: string): string => readFileSync(new URL(`../dagu/${name}`, import.meta.url), "utf8");
  const configPath = join(home, "config.yaml");
  const config = parseDocument(existsSync(configPath) ? readFileSync(configPath, "utf8") : template("config.yaml"));
  if (config.errors.length) throw new Error(`config.yaml: ${config.errors.map(String).join("; ")}`);
  if (!isMap(config.contents)) throw new Error("config.yaml must contain a YAML mapping");
  const managed = parseDocument(template("config.yaml")).toJS() as Record<string, unknown>;
  const queues = values.apply ? [stampedQueue(readFileSync(resolve(values["repo-dag"]!), "utf8"))] : [];
  for (const queue of queues) {
    const report = queueCompatibility(home, queue);
    if (!report.endsWith("compat=ok")) throw new Error(report);
  }
  // Shared defaults preserve repository-owned queue entries.
  function merge(leaves: Record<string, unknown>, path: string[] = []): void {
    for (const [key, value] of Object.entries(leaves)) {
      const next = [...path, key];
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const current = config.getIn(next, true);
        if (current !== undefined && !isMap(current)) {
          throw new Error(`config.yaml ${next.join(".")} must contain a YAML mapping`);
        }
        merge(value as Record<string, unknown>, next);
      } else if (config.getIn(next) !== value) {
        config.setIn(next, value);
      }
    }
  }
  merge(managed);
  const replacements: Record<string, string> = {
    __DAGU_BINARY__: binary, __DAGU_HOME__: home, __LOG_DIR__: logDir, __PATH__: process.env.PATH || "",
  };
  const plist = template("LaunchAgent.plist").replace(/__\w+__/g, (key) =>
    replacements[key]!.replace(/[<>&"']/g, (character) => ({
      "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;",
    })[character]!));
  const stage = mkdtempSync(join(tmpdir(), "dagu-station-install-"));
  const lock = join(home, ".station-install.lock");
  let locked = false;
  let admissionClosed = false;
  try {
    const base = template("base.yaml");
    writeFileSync(join(stage, "base.yaml"), base);
    // Dagu initializes paths even for validation. Validate managed defaults in isolation,
    // keeping foreign path settings and the station's runtime data entirely untouched.
    writeFileSync(join(stage, "config.yaml"), template("config.yaml"));
    writeFileSync(join(stage, "probe.yaml"), "steps:\n  - run: echo station-validation\n");
    mkdirSync(join(stage, "dags"));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DAGU_")));
    env.DAGU_HOME = stage;
    execFileSync(binary, ["validate", "--config", join(stage, "config.yaml"), join(stage, "probe.yaml")], { env, stdio: "pipe" });
    if (process.platform === "darwin") {
      writeFileSync(join(stage, "LaunchAgent.plist"), plist);
      execFileSync("plutil", ["-lint", join(stage, "LaunchAgent.plist")], { stdio: "pipe" });
    }
    if (!values.check) {
      mkdirSync(home, { recursive: true });
      mkdirSync(lock);
      locked = true;
    }
    const files = [
      { destination: join(home, "base.yaml"), content: base },
      { destination: configPath, content: config.toString() },
      { destination: launchAgent, content: plist },
    ];
    let drift = false;
    for (const [index, file] of files.entries()) {
      const source = join(stage, `install-${index}`);
      writeFileSync(source, file.content);
      const same = existsSync(file.destination) && (() => {
        try { execFileSync("cmp", ["-s", source, file.destination]); return true; }
        catch { return false; }
      })();
      if (same) {
        console.log(`unchanged ${file.destination}`);
      } else if (values.check) {
        drift = true;
        console.log(`drift ${file.destination}`);
      } else {
        mkdirSync(dirname(file.destination), { recursive: true });
        execFileSync("install", ["-m", "0644", source, file.destination]);
        console.log(`installed ${file.destination}`);
      }
    }
    if (!values.check) mkdirSync(logDir, { recursive: true });
    process.exitCode = drift ? 1 : 0;
    console.log(`dagu=${version} launch-agent=${launchAgent}; activation is operator-owned`);
    if (!values.apply) return;
    const stationEnv = { ...env, DAGU_HOME: home };
    const dagu = (...args: string[]): string => execFileSync(binary, args, { env: stationEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout }).trim();
    const hook = (command: string): void => {
      execFileSync("/bin/sh", ["-eu", "-c", command], { env: { ...stationEnv, DAGU_RESTART_SIGNAL: "TERM" }, stdio: "inherit", timeout });
    };
    type Run = { dagRunId: string; status: string };
    const history = (status?: string): Run[] => {
      const rows: unknown = JSON.parse(dagu("history", ...(status ? ["--status", status] : []), "--format", "json", "--limit", status ? "1" : "1000"));
      if (!Array.isArray(rows) || rows.some(row => typeof row?.dagRunId !== "string" || typeof row?.status !== "string")) {
        throw new Error("Unexpected Dagu history response");
      }
      return rows;
    };
    const until = async (description: string, probe: () => boolean): Promise<void> => {
      const deadline = Date.now() + timeout;
      while (!probe()) {
        if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`);
        await delay(250);
      }
    };
    admissionClosed = true;
    hook(values["admission-close"]!);
    await until("station drained (running=0 queued=0)", () => history("running,queued").length === 0);
    console.log("drained running=0 queued=0; requesting TERM restart");
    hook(values["restart-command"]!);
    // Admission remains closed while capacity N is verified with N+1 barrier runs.
    for (const queue of queues) {
      const id = `station-${process.pid}-${Date.now()}`;
      const dag = join(home, "dags", `${id}.yaml`);
      const release = join(lock, `${id}.release`);
      mkdirSync(join(home, "dags"), { recursive: true });
      writeFileSync(dag, `queue: ${JSON.stringify(queue.name)}\nmax_active_runs: ${queue.max_concurrency + 1}\nsteps:\n  - run: |\n      while [ ! -f '${release.replaceAll("'", "'\\''")}' ]; do sleep 0.2; done\n`);
      const ids = new Set<string>();
      let succeeded = false;
      try {
        for (let index = 0; index <= queue.max_concurrency; index++) {
          const runId = `${id}-${index}`;
          dagu("enqueue", "--run-id", runId, dag);
          ids.add(runId);
        }
        await until(`queue ${queue.name} concurrency=${queue.max_concurrency}`, () => {
          const rows = history().filter(row => ids.has(row.dagRunId));
          if (rows.some(row => ["failed", "aborted", "succeeded"].includes(row.status))) throw new Error("Concurrency probe ended before barrier release");
          return rows.filter(row => row.status === "running").length === queue.max_concurrency
            && rows.filter(row => row.status === "queued").length === 1;
        });
        writeFileSync(release, "release\n");
        await until(`queue ${queue.name} probe succeeded`, () => {
          const rows = history().filter(row => ids.has(row.dagRunId));
          if (rows.some(row => ["failed", "aborted"].includes(row.status))) throw new Error("Concurrency probe failed");
          return rows.filter(row => row.status === "succeeded").length === ids.size;
        });
        succeeded = true;
        console.log(`verified next enqueue queue=${queue.name} max_concurrency=${queue.max_concurrency} succeeded=${ids.size}`);
      } finally {
        writeFileSync(release, "release\n");
        if (succeeded) rmSync(dag);
      }
    }
    hook(values["admission-open"]!);
    admissionClosed = false;
    console.log("applied station configuration; admission reopened");
  } finally {
    rmSync(stage, { recursive: true, force: true });
    if (admissionClosed) {
      console.error(`Admission remains closed: inspect the service and probe runs, then run the admission-open hook explicitly. Recovery files: ${lock}`);
    } else if (locked) {
      rmSync(lock, { recursive: true, force: true });
    }
  }
}

try { await main(); }
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
