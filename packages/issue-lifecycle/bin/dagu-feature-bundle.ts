#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { admit, appendObservation, enqueue, enqueueArguments, parseObservation, receiptPath } from "../src/admission.ts";
import { validatePlanningUnitsCommand } from "../src/planning-validator.ts";
import {
  BUNDLE_VERSION,
  classifyCompatibility,
  parseBundleStamp,
  REQUIRED_DAGU_VERSION,
} from "../src/bundle.ts";

function git(path: string, ...args: string[]): string {
  return execFileSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function repositoryName(path: string): string {
  try {
    const remote = git(path, "remote", "get-url", "origin")
      .replace(/^git@[^:]+:/, "")
      .replace(/^https?:\/\/[^/]+\//, "")
      .replace(/^file:\/\//, "")
      .replace(/\.git\/?$/, "")
      .replace(/\/$/, "");
    const parts = remote.split("/").filter(Boolean);
    return parts.length >= 2 ? `${parts.at(-2)}/${parts.at(-1)}` : basename(path);
  } catch {
    return basename(path);
  }
}

function inspectStamp(label: string, path: string): boolean {
  if (!existsSync(path)) {
    console.log(`${label} path=${path} stamp=unstamped compat=unstamped`);
    return false;
  }
  const stamp = parseBundleStamp(readFileSync(path, "utf8"));
  if (!stamp) {
    console.log(`${label} path=${path} stamp=unstamped compat=unstamped`);
    return false;
  }
  const compat = classifyCompatibility(stamp.version, BUNDLE_VERSION);
  console.log(
    `${label} path=${path} version=${stamp.version} source=${stamp.source} bootstrap=${stamp.bootstrap} compat=${compat}`,
  );
  if (label === "feature.yaml" || label === "poc.yaml") {
    const source = readFileSync(path, "utf8");
    const policy = ["PRIMARY", ...(label === "feature.yaml" ? ["GATE", "REQUIRED_CHECK"] : [])]
      .map(name => `${name}=${source.match(new RegExp(`^  - ${name}: (.+)$`, "m"))?.[1] ?? "unset"}`);
    console.log(`${label} policy ${policy.join(" ")}${label === "feature.yaml" ? " BRANCH=dagu/issue-${ISSUE}" : ""}`);
  }
  return compat === "ok";
}

function resolveRepository(argument: string): string | undefined {
  try {
    return git(resolve(argument), "rev-parse", "--show-toplevel");
  } catch {
    console.error(`repo path=${resolve(argument)} error=not-a-git-worktree`);
    return undefined;
  }
}

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  if (command === "validate-planning-units") {
    process.exitCode = validatePlanningUnitsCommand(args);
    return;
  }
  if (command === "admit" || command === "enqueue") {
    try {
      if (command === "enqueue") process.exitCode = enqueue(args, process.cwd());
      else {
        const result = admit(enqueueArguments(args, process.cwd()));
        console.log(JSON.stringify(result));
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }
  if (command === "observe") {
    try {
      const [run, input] = args;
      if (!run || !input) throw new Error("Usage: observe <run> '<JSON observation with dag/run/attempt/category/kind/data>'");
      const observation = parseObservation(JSON.parse(input));
      appendObservation(receiptPath(process.cwd(), run), observation);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }
const argumentsOrCwd = process.argv.length > 2 ? process.argv.slice(2) : [process.cwd()];
let ok = true;
for (const argument of argumentsOrCwd) {
  const path = resolveRepository(argument);
  if (!path) {
    ok = false;
    continue;
  }
  console.log(`repo=${repositoryName(path)} path=${path} bundle=${BUNDLE_VERSION}`);
  const dags = join(path, ".workspace", "dagu", "dags");
  ok = inspectStamp("feature.yaml", join(dags, "feature.yaml")) && ok;
  ok = inspectStamp("poc.yaml", join(dags, "poc.yaml")) && ok;
  ok = inspectStamp("discovery.yaml", join(dags, "discovery.yaml")) && ok;
  ok = inspectStamp("planning.yaml", join(dags, "planning.yaml")) && ok;
}

const daguHome = process.env.DAGU_HOME || join(homedir(), ".dagu");
ok = inspectStamp("reconcile.yaml", join(daguHome, "dags", "reconcile.yaml")) && ok;
const dagu = spawnSync("dagu", ["version"], { encoding: "utf8" });
const daguOk = dagu.status === 0
  && dagu.stdout === `${REQUIRED_DAGU_VERSION}\n`
  && dagu.stderr === "";
const observed = dagu.status === null ? "unavailable" : JSON.stringify(dagu.stdout.replace(/\n$/, ""));
console.log(`dagu version=${observed} required=${REQUIRED_DAGU_VERSION} compat=${daguOk ? "ok" : "incompatible"}`);
ok = daguOk && ok;
process.exitCode = ok ? 0 : 1;
}
main();
