#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";

function discover() {
  const root = JSON.parse(readFileSync("package.json", "utf8"));
  const workspaces = [];
  const names = new Set();
  for (const dir of new Set(globSync(root.workspaces))) {
    const path = join(dir, "package.json");
    if (!existsSync(path)) continue;
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    if (!manifest.name || names.has(manifest.name)) throw new Error(`Invalid or duplicate workspace name: ${path}`);
    names.add(manifest.name);
    workspaces.push({
      dir, name: manifest.name,
      test: Boolean(manifest.scripts?.test),
      typecheck: Boolean(manifest.scripts?.typecheck),
      dependencies: Object.keys({ ...manifest.dependencies, ...manifest.devDependencies,
        ...manifest.peerDependencies, ...manifest.optionalDependencies }),
    });
  }
  return workspaces;
}

function pathsFromFiles(files) {
  if (!Array.isArray(files)) throw new Error("Expected an array of changed files");
  return files.flat(Infinity).flatMap(file => {
    if (typeof file === "string") return [file];
    if (!file || typeof file.filename !== "string"
      || (file.previous_filename !== undefined && typeof file.previous_filename !== "string")) {
      throw new Error("Expected GitHub filename/previous_filename records");
    }
    return [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])];
  });
}

function select(files) {
  const workspaces = discover();
  const owners = [...workspaces].sort((a, b) => b.dir.length - a.dir.length);
  const selected = new Set();
  let all = process.env.EVENT_NAME !== "pull_request";
  for (const path of pathsFromFiles(files)) {
    const owner = owners.find(workspace => path === workspace.dir || path.startsWith(`${workspace.dir}/`));
    if (owner) selected.add(owner.name);
    // Root/shared changes and deleted or moved workspace roots select existing manifests only.
    if (!owner || owner.name === "@a4s/hot-reload") all = true;
  }
  if (all) for (const workspace of workspaces) selected.add(workspace.name);
  let previous;
  do {
    previous = selected.size;
    for (const workspace of workspaces) {
      if (workspace.dependencies.some(name => selected.has(name))) selected.add(workspace.name);
    }
  } while (selected.size !== previous);
  return workspaces.filter(workspace => selected.has(workspace.name))
    .map(({ name, test, typecheck }) => ({ name, test, typecheck }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function changedFiles() {
  if (process.env.EVENT_NAME !== "pull_request") return [];
  const api = spawnSync("gh", ["api", `repos/${process.env.GITHUB_REPOSITORY}/pulls/${process.env.PR_NUMBER}/files`,
    "--paginate", "--slurp"], { encoding: "utf8" });
  if (api.status === 0) return JSON.parse(api.stdout);
  // --no-renames retains both sides, including paths containing spaces or newlines.
  const diff = spawnSync("git", ["diff", "--name-only", "--no-renames", "-z", "HEAD^1", "HEAD"], { encoding: "utf8" });
  if (diff.status !== 0) throw new Error(`Changed-file lookup failed: ${api.stderr}\n${diff.stderr}`);
  return diff.stdout.split("\0").filter(Boolean);
}

function selectedWorkspaces() {
  const matrix = process.env.WORKSPACES;
  if (!matrix?.trim()) throw new Error("WORKSPACES is empty; the changes job did not publish a workspace matrix");
  const workspaces = JSON.parse(matrix);
  if (!Array.isArray(workspaces) || !workspaces.every(workspace => workspace
    && typeof workspace.name === "string" && workspace.name.length > 0
    && typeof workspace.test === "boolean" && typeof workspace.typecheck === "boolean")) {
    throw new Error("Expected a workspace matrix with name, test and typecheck");
  }
  return workspaces;
}

function npm(args) {
  return new Promise(resolve => {
    const output = [];
    const child = spawn("npm", args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", chunk => output.push(chunk));
    child.stderr.on("data", chunk => output.push(chunk));
    child.on("error", error => resolve({ status: 1, output: String(error) }));
    child.on("close", status => resolve({ status: status ?? 1, output: Buffer.concat(output).toString() }));
  });
}

// One install serves every selected workspace: run their tests and typechecks
// concurrently, print each command's output as one group, and fail on any failure.
async function run() {
  const commands = selectedWorkspaces().flatMap(({ name, test, typecheck }) => [
    ...(test ? [["test", "--workspace", name]] : []),
    ...(typecheck ? [["run", "typecheck", "--workspace", name]] : []),
  ]);
  const failed = [];
  let next = 0;
  const worker = async () => {
    while (next < commands.length) {
      const args = commands[next++];
      const started = Date.now();
      const { status, output } = await npm(args);
      const label = `npm ${args.join(" ")}`;
      console.log(`::group::${label} (${status === 0 ? "passed" : "FAILED"} in ${Math.round((Date.now() - started) / 1000)} s)`);
      process.stdout.write(output);
      console.log("::endgroup::");
      if (status !== 0) failed.push(label);
    }
  };
  await Promise.all(Array.from({ length: Math.min(availableParallelism(), commands.length) }, worker));
  for (const label of failed) console.log(`::error::${label} failed`);
  if (failed.length) throw new Error(`${failed.length} of ${commands.length} workspace commands failed`);
}

function aggregate() {
  const workspaces = selectedWorkspaces();
  const { CHANGES_RESULT: changes, TEST_RESULT: test, PR_BODY_RESULT: prBody } = process.env;
  console.log(`changes=${changes} test=${test} pr-body=${prBody}`);
  if (prBody !== (process.env.EVENT_NAME === "pull_request" ? "success" : "skipped")
    || changes !== "success" || test !== (workspaces.length ? "success" : "skipped")) {
    throw new Error("Required CI jobs did not complete successfully");
  }
}

try {
  switch (process.argv[2]) {
    case "changes": console.log(JSON.stringify(select(changedFiles()))); break;
    case "select": console.log(JSON.stringify(select(JSON.parse(readFileSync(0, "utf8"))))); break;
    case "run": await run(); break;
    case "aggregate": aggregate(); break;
    default: throw new Error("Usage: node scripts/ci-workspaces.mjs changes|select|run|aggregate");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
