#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isMap, parseDocument } from "yaml";
import { REQUIRED_DAGU_VERSION } from "../src/bundle.ts";

function main(): void {
  const { values } = parseArgs({ options: {
    "dagu-home": { type: "string" },
    "launch-agent": { type: "string" },
    "log-dir": { type: "string" },
    check: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  } });
  if (values.help) {
    console.log("dagu-station-install [--dagu-home DIR] [--launch-agent FILE] [--log-dir DIR] [--check]\nDefaults: DAGU_HOME or ~/.dagu; plist staged at <dagu-home>/LaunchAgent.plist; logs at <dagu-home>/logs/service.\n--check compares desired files without installing. Service activation belongs to the operator.");
    return;
  }
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
  // Merge owned leaves rather than replacing sections: queues.config and sibling keys stay intact.
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
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

try { main(); }
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
