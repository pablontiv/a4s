#!/usr/bin/env node
// Binary proof: the candidate factory still closes one full cycle.
// Starts an isolated T3 server and an isolated Dagu, runs dags/cycle.yaml from THIS checkout on a fixture
// repository, approves the merge through the Dagu API (as the operator's click would) and checks the result.
// Exit 0 = the cycle closed; anything else = it did not. Uses real model calls (cheap model).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { instancesFromLines } from "../src/instances.mjs";

const FACTORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KEEP = process.env.SELFTEST_KEEP === "1";
const MODEL = process.env.SELFTEST_MODEL ?? "anthropic/claude-haiku-5-5";
const PI_BIN = process.env.PI_BIN ?? join(homedir(), "bin", "pi");
const DAGU_BIN = process.env.DAGU_BIN ?? "dagu";
const VERSIONS = process.env.T3_VERSIONS_DIR ?? join(homedir(), ".t3", "runtime", "versions");
const log = (...m) => console.error("[selftest]", ...m);
const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} -> ${r.status}\n${r.stderr}`);
  return r.stdout.trim();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = () => new Promise((ok) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });

function latestT3() {
  if (process.env.T3_BIN) return process.env.T3_BIN;
  const prod = join(homedir(), ".t3", "userdata", "server-runtime.json");
  if (existsSync(prod)) {
    const v = JSON.parse(readFileSync(prod, "utf8")).serverVersion;
    if (existsSync(join(VERSIONS, v, "t3"))) return join(VERSIONS, v, "t3");
  }
  const v = readdirSync(VERSIONS).filter((d) => !d.includes("staging")).sort().at(-1);
  return join(VERSIONS, v, "t3");
}

const root = mkdtempSync(join(tmpdir(), "factory-selftest-"));
const procs = [];
let ok = false;
try {
  // 1. fixture repository (trunk = main) and fixture brief
  const repo = join(root, "repo"); mkdirSync(repo);
  writeFileSync(join(repo, "calc.mjs"), "export function add(a, b) { return a + b; }\n");
  writeFileSync(join(repo, "test.mjs"), 'import { add } from "./calc.mjs";\nif (add(2, 3) !== 5) { console.error("FAIL add"); process.exit(1); }\nconsole.log("PASS");\n');
  writeFileSync(join(repo, ".gitignore"), ".workspace/\n");
  sh("git", ["init", "-q", "-b", "main"], { cwd: repo });
  sh("git", ["add", "-A"], { cwd: repo });
  sh("git", ["-c", "user.email=selftest@a4s", "-c", "user.name=selftest", "commit", "-qm", "init"], { cwd: repo });
  const brief = join(root, "brief.md");
  writeFileSync(brief, "# Add mul\n\nAdd an exported `mul(a, b)` to calc.mjs and a check `mul(2, 3) === 6` to test.mjs. Run `node test.mjs` (must print PASS) and make one local commit \"feat: mul\".\n");

  // 2. isolated T3 with the candidate's line profiles (cheap model for the selftest)
  const t3Home = join(root, "t3"); mkdirSync(join(t3Home, "userdata"), { recursive: true });
  const linesPath = join(root, "lines.json");
  const lines = JSON.parse(readFileSync(join(FACTORY, "lines.json"), "utf8"));
  for (const l of Object.values(lines.lines)) { l.model = MODEL; l.thinking = "low"; delete l.escalate_to; if (l.instance?.prompt) l.instance.prompt = join(FACTORY, l.instance.prompt); }
  writeFileSync(linesPath, JSON.stringify(lines));
  const instances = { pi: { driver: "pi", enabled: true, config: { binaryPath: PI_BIN } }, ...instancesFromLines(linesPath, PI_BIN) };
  writeFileSync(join(t3Home, "userdata", "settings.json"), JSON.stringify({ providerInstances: instances }));
  const t3Port = await port();
  const t3 = spawn(latestT3(), ["serve", "--base-dir", t3Home, "--port", String(t3Port), "--host", "127.0.0.1", "--no-browser"], { detached: true, stdio: "ignore" });
  procs.push(t3);
  for (let i = 0; i < 60 && !existsSync(join(t3Home, "userdata", "server-runtime.json")); i++) await sleep(1000);
  await sleep(3000);
  log("t3 up on", t3Port);

  // 3. isolated Dagu that reads the DAG from this checkout
  const daguHome = join(root, "dagu"); mkdirSync(join(daguHome, "dags"), { recursive: true });
  const daguPort = await port();
  writeFileSync(join(daguHome, "config.yaml"), `host: 127.0.0.1\nport: ${daguPort}\nauth: {mode: none}\nscheduler: {port: 0}\ncoordinator: {enabled: false}\nfeatures: {unexpectedStopDetection: none}\n`);
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, DAGU_HOME: daguHome, DAGU_SKIP_EXAMPLES: "true" };
  const dagu = spawn(DAGU_BIN, ["start-all", "--dagu-home", daguHome, "--config", join(daguHome, "config.yaml"), "--host", "127.0.0.1", "--port", String(daguPort), "--dags", join(FACTORY, "dags")], { detached: true, stdio: "ignore", env });
  procs.push(dagu);
  const api = `http://127.0.0.1:${daguPort}/api/v1`;
  for (let i = 0; i < 30; i++) { try { if ((await fetch(`${api}/dags`)).ok) break; } catch {} await sleep(1000); }
  log("dagu up on", daguPort);

  // 4. run the cycle
  const runId = `selftest${Date.now()}`;
  const params = [`ISSUE=st1`, `PRIMARY=${repo}`, `FACTORY=${FACTORY}`, `T3_HOME=${t3Home}`, `STATE=${join(root, "state")}`,
    `BRIEF_FILE=${brief}`, `GATE=node test.mjs`, `PUSH=false`, `CLOSE_ISSUE=false`, `LINES=${linesPath}`];
  const cycle = spawn(DAGU_BIN, ["start", "--dagu-home", daguHome, "--config", join(daguHome, "config.yaml"), "--run-id", runId, join(FACTORY, "dags", "cycle.yaml"), "--", ...params], { stdio: ["ignore", openSync(join(root, "cycle.log"), "a"), openSync(join(root, "cycle.log"), "a")], env });
  procs.push(cycle);
  const status = async () => (await (await fetch(`${api}/dag-runs/cycle/${runId}`)).json()).dagRunDetails;
  let approved = false, final;
  for (let i = 0; i < 300; i++) {
    let d; try { d = await status(); } catch { await sleep(2000); continue; }
    const label = d?.statusLabel;
    if (label === "waiting" && !approved) {
      const r = await fetch(`${api}/dag-runs/cycle/${runId}/human-tasks/approve_merge/complete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ DECISION: "APPROVE" }) });
      approved = r.ok; log("approve_merge ->", r.status);
    }
    if (["succeeded", "failed", "aborted"].includes(label)) { final = d; break; }
    await sleep(3000);
  }
  // 5. binary checks
  const checks = {
    run_succeeded: final?.statusLabel === "succeeded",
    approved,
    trunk_has_commit: sh("git", ["log", "--format=%s", "main"], { cwd: repo }).split("\n").some((s) => /mul/i.test(s)),
    trunk_tests_pass: spawnSync("node", ["test.mjs"], { cwd: repo }).status === 0,
    worktree_removed: !existsSync(join(repo, ".workspace", "worktrees", "issue-st1")),
  };
  log(JSON.stringify(checks));
  if (final) for (const n of final.nodes ?? []) log(" step", n.step.id, n.statusLabel);
  ok = Object.values(checks).every(Boolean);
} catch (e) {
  log("error:", e.message);
} finally {
  for (const p of procs) { try { process.kill(-p.pid, "SIGTERM"); } catch { try { p.kill("SIGTERM"); } catch {} } }
  if (ok && !KEEP) rmSync(root, { recursive: true, force: true }); else log("kept", root);
}
console.log(ok ? "SELFTEST PASS" : "SELFTEST FAIL");
process.exit(ok ? 0 : 1);
