#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  BUNDLE_VERSION,
  classifyCompatibility,
  parseBundleStamp,
  REQUIRED_DAGU_VERSION,
} from "../src/bundle.ts";
import { loadDaguConfig } from "../src/config.ts";

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

function inspectStamp(label: string, path: string, spec: string | undefined): boolean {
  const stamp = spec === undefined ? undefined : parseBundleStamp(spec);
  if (!stamp) {
    console.log(`${label} path=${path} stamp=unstamped compat=unstamped`);
    return false;
  }
  const compat = classifyCompatibility(stamp.version, BUNDLE_VERSION);
  console.log(
    `${label} path=${path} version=${stamp.version} source=${stamp.source} bootstrap=${stamp.bootstrap} compat=${compat}`,
  );
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

const argumentsOrCwd = process.argv.length > 2 ? process.argv.slice(2) : [process.cwd()];
let ok = true;
let firstRepository: string | undefined;
for (const argument of argumentsOrCwd) {
  const path = resolveRepository(argument);
  if (!path) {
    ok = false;
    continue;
  }
  firstRepository ??= path;
  console.log(`repo=${repositoryName(path)} path=${path} bundle=${BUNDLE_VERSION}`);
  const dags = join(path, ".workspace", "dagu", "dags");
  for (const name of ["feature.yaml", "poc.yaml"]) {
    const file = join(dags, name);
    ok = inspectStamp(name, file, existsSync(file) ? readFileSync(file, "utf8") : undefined) && ok;
  }
}

const { daguUrl } = loadDaguConfig(firstRepository ?? process.cwd());
const reconcileUrl = `${daguUrl}/api/v1/dags/reconcile/spec`;
try {
  const response = await fetch(reconcileUrl, { signal: AbortSignal.timeout(5000), redirect: "manual" });
  if (response.status === 404) {
    ok = inspectStamp("reconcile.yaml", reconcileUrl, undefined) && ok;
  } else {
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || !("spec" in payload) || typeof payload.spec !== "string") {
      throw new Error("expected a JSON spec string");
    }
    ok = inspectStamp("reconcile.yaml", reconcileUrl, payload.spec) && ok;
  }
} catch (error) {
  console.log(`reconcile.yaml path=${reconcileUrl} compat=unreachable error=${JSON.stringify((error as Error).message)}`);
  ok = false;
}
const dagu = spawnSync("dagu", ["version"], { encoding: "utf8" });
const daguOk = dagu.status === 0
  && dagu.stdout === `${REQUIRED_DAGU_VERSION}\n`
  && dagu.stderr === "";
const observed = dagu.status === null ? "unavailable" : JSON.stringify(dagu.stdout.replace(/\n$/, ""));
console.log(`dagu version=${observed} required=${REQUIRED_DAGU_VERSION} compat=${daguOk ? "ok" : "incompatible"}`);
ok = daguOk && ok;
process.exitCode = ok ? 0 : 1;
