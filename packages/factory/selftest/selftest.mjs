#!/usr/bin/env node
// Binary proof: the candidate factory still closes one full cycle.
// Starts an isolated T3 server and an isolated Dagu, runs dags/cycle.yaml from THIS checkout on a fixture
// repository with no human step and checks the result.
// Exit 0 = the cycle closed; anything else = it did not. Uses real model calls (cheap model).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkVerdict } from "../src/lib.mjs";
import { instancesFromLines } from "../src/instances.mjs";

const FACTORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KEEP = process.env.SELFTEST_KEEP === "1";
const MODEL = process.env.SELFTEST_MODEL ?? "anthropic/claude-haiku-5-5";
const PI_BIN = process.env.PI_BIN ?? join(homedir(), "bin", "pi");
// Same Dagu as the operator's service (on PATH), not the gate's DAGU_BIN: packaged builds
// differ (e.g. the default shell), and the selftest must catch what production would hit.
const DAGU_BIN = process.env.FACTORY_DAGU_BIN ?? "dagu";
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
  writeFileSync(brief, "# Add mul\n\n## Goal\nAdd an exported `mul(a, b)` to calc.mjs.\n\n## Acceptance criteria\n- [ ] calc.mjs exports `mul(a, b)`, and test.mjs checks `mul(2, 3) === 6`.\n- [ ] `node test.mjs` prints PASS.\n\n## Out of scope\nAnything other than calc.mjs and test.mjs. Do not commit.\n");
  const brief2 = join(root, "brief2.md");
  writeFileSync(brief2, "# Add sub\n\nAdd an exported `sub(a, b)` to calc.mjs. Do not commit.\n");

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

  // 4. run the cycle: st1 must close; st2's validation fails, so nothing may be committed
  const runCycle = async (issue, briefPath, gate) => {
    const runId = `selftest-${issue}-${Date.now()}`;
    const params = [`ISSUE=${issue}`, `PRIMARY=${repo}`, `FACTORY=${FACTORY}`, `T3_HOME=${t3Home}`, `STATE=${join(root, "state")}`,
      `BRIEF_FILE=${briefPath}`, `GATE=${gate}`, `PUSH=false`, `CLOSE_ISSUE=false`, `LINE_TABLE=${linesPath}`];
    const logFd = openSync(join(root, `cycle-${issue}.log`), "a");
    const cycle = spawn(DAGU_BIN, ["start", "--dagu-home", daguHome, "--config", join(daguHome, "config.yaml"), "--run-id", runId, join(FACTORY, "dags", "cycle.yaml"), "--", ...params], { stdio: ["ignore", logFd, logFd], env });
    procs.push(cycle);
    let final;
    for (let i = 0; i < 300; i++) {
      let d; try { d = (await (await fetch(`${api}/dag-runs/cycle/${runId}`)).json()).dagRunDetails; } catch { await sleep(2000); continue; }
      const label = d?.statusLabel;
      if (["succeeded", "failed", "aborted"].includes(label)) { final = d; break; }
      await sleep(3000);
    }
    if (final) for (const n of final.nodes ?? []) log(" ", issue, n.step.id, n.statusLabel);
    return { final, step: (id) => final?.nodes?.find((n) => n.step.id === id)?.statusLabel };
  };
  const trunkLog = () => sh("git", ["log", "--format=%s%n%b%x00", "main"], { cwd: repo }).split("\0").map((x) => x.trim()).filter(Boolean);
  const r1 = await runCycle("st1", brief, "node test.mjs");
  const log1 = trunkLog();
  const r2 = await runCycle("st2", brief2, "node test.mjs && false");
  const log2 = trunkLog();
  const wt2 = join(repo, ".workspace", "worktrees", "issue-st2");
  // 5. binary checks
  const checks = {
    run_succeeded: r1.final?.statusLabel === "succeeded",
    no_human_step: !(r1.final?.nodes ?? []).some((n) => n.step.id === "approve_merge"),
    one_commit_per_issue: log1.length === 2 && /^Add mul \(#st1\)/.test(log1[0]) && /Factory-Run: /.test(log1[0]),
    trunk_tests_pass: spawnSync("node", ["test.mjs"], { cwd: repo }).status === 0,
    worktree_removed: !existsSync(join(repo, ".workspace", "worktrees", "issue-st1")),
    pass_without_criteria_downgraded: checkVerdict({ verdict: "pass", findings: [] }).verdict.verdict === "fail",
    failed_validation_blocks_commit: r2.step("validate") === "failed" && r2.step("integrate") !== "succeeded" && log2.length === log1.length &&
      existsSync(wt2) && sh("git", ["rev-list", "--count", "main..HEAD"], { cwd: wt2 }) === "0",
  };
  // 5b. admission: a scheduler-less Dagu (runs are only queued, never executed) fed from an ISSUES_FILE fixture
  const adHome = join(root, "dagu-admit"); mkdirSync(adHome, { recursive: true });
  const adCfg = join(adHome, "config.yaml");
  writeFileSync(adCfg, "auth: {mode: none}\n");
  // operator-style base config: the A4S_* variables the DAGs fall back to
  const stateAd = join(root, "state-admit");
  writeFileSync(join(adHome, "base.yaml"), `env:\n  - A4S_PRIMARY: ${repo}\n  - A4S_FACTORY: ${FACTORY}\n  - A4S_T3_HOME: ${t3Home}\n  - A4S_STATE: ${stateAd}\n`);
  const adEnv = { PATH: process.env.PATH, HOME: process.env.HOME, DAGU_HOME: adHome, DAGU_SKIP_EXAMPLES: "true" };
  const issuesFile = join(root, "issues.json");
  writeFileSync(issuesFile, JSON.stringify([{ number: 7001, labels: [{ name: "factory:ready" }, { name: "factory" }], body: "## Goal\nx\n\n## Acceptance criteria\n- [ ] y\n\n## Out of scope\nz\n" }, { number: 7002, labels: [{ name: "factory" }] }, { number: 7003, labels: [{ name: "factory:ready" }], body: "## Goal\nx\n\n## Out of scope\nz\n" }]));
  const admitDag = join(FACTORY, "dags", "admit.yaml"), cycleDag = join(FACTORY, "dags", "cycle.yaml");
  const daguAd = (sub, ...a) => spawnSync(DAGU_BIN, [sub, "--dagu-home", adHome, "--config", adCfg, ...a], { encoding: "utf8", env: adEnv });
  const queued = (n) => daguAd("status", "--run-id", `factory-issue-${n}`, cycleDag).status === 0;
  const admitCli = (n) => spawnSync("node", [join(FACTORY, "src", "admit.mjs"), "--issue", String(n), "--issues-file", issuesFile, "--dagu-home", adHome, "--config", adCfg, "--dag", cycleDag], { encoding: "utf8", env: adEnv }).status;
  // no PRIMARY/FACTORY/T3_HOME/STATE params: admit.yaml must resolve them from the base config
  const adm = daguAd("start", "--run-id", `admit${Date.now()}`, admitDag, "--", `ISSUES_FILE=${issuesFile}`, `TARGET_DAGU_HOME=${adHome}`, `TARGET_DAGU_CONFIG=${adCfg}`);
  log("admit dag ->", adm.status);
  checks.admit_dag_succeeded = adm.status === 0;
  checks.admit_ready_enqueued = queued(7001);
  checks.admit_again_is_duplicate = admitCli(7001) === 21;
  checks.admit_contract_violation_not_admitted = !queued(7003) && admitCli(7003) === 22;
  checks.admit_factory_only_not_admitted = !queued(7002) && admitCli(7002) === 20;
  // an admitted-style run without those params resolves STATE from the base config (BASE=nosuch stops it right after)
  daguAd("start", "--run-id", `cfg${Date.now()}`, cycleDag, "--", "ISSUE=7003", "BASE=nosuch");
  checks.cycle_resolves_base_config = existsSync(join(stateAd, "7003"));
  log(JSON.stringify(checks));
  ok = Object.values(checks).every(Boolean);
} catch (e) {
  log("error:", e.message);
} finally {
  for (const p of procs) { try { process.kill(-p.pid, "SIGTERM"); } catch { try { p.kill("SIGTERM"); } catch {} } }
  if (ok && !KEEP) rmSync(root, { recursive: true, force: true }); else log("kept", root);
}
console.log(ok ? "SELFTEST PASS" : "SELFTEST FAIL");
process.exit(ok ? 0 : 1);
