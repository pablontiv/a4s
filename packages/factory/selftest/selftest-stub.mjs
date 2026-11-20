#!/usr/bin/env node
// Stub selftest (CI-safe): the same cycle as selftest.mjs (isolated Dagu, the DAGs of THIS checkout, a fixture
// repository) but with PUSH=true and CLOSE_ISSUE=true against a bare git remote and a `gh` stub, and the T3 CLI
// replaced by a deterministic stub that answers each line from fixture verdicts (stub/t3.mjs). No model, no T3
// server, no credentials. It exercises `integrate`/`push`, `ci` and `close`, which only production ran before.
// Exit 0 = every scenario held. Needs `git`, `jq` and Dagu (FACTORY_DAGU_BIN, DAGU_BIN or `dagu` on PATH).
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttp } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FACTORY = resolve(HERE, "..");
const KEEP = process.env.SELFTEST_KEEP === "1";
const DAGU_BIN = process.env.FACTORY_DAGU_BIN ?? process.env.DAGU_BIN ?? "dagu";
const log = (...m) => console.error("[selftest:stub]", ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = () => new Promise((ok) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });

// hard cap: the CI job must never hang (the whole run takes a few minutes)
setTimeout(() => { console.error("[selftest:stub] timeout"); process.exit(1); }, 12 * 60_000).unref();
const procs = [];
let root = "";
let ok = false;
let httpServer;
try {
  root = mkdtempSync(join(tmpdir(), "factory-selftest-stub-"));
  const home = join(root, "home"); mkdirSync(home);
  const GIT_ENV = { GIT_AUTHOR_NAME: "selftest", GIT_AUTHOR_EMAIL: "selftest@a4s", GIT_COMMITTER_NAME: "selftest", GIT_COMMITTER_EMAIL: "selftest@a4s", GIT_CONFIG_NOSYSTEM: "1" };
  const baseEnv = { PATH: "", HOME: home, ...GIT_ENV };
  const sh = (cmd, args, opts = {}) => {
    const r = spawnSync(cmd, args, { encoding: "utf8", ...opts, env: { ...process.env, ...GIT_ENV, HOME: home, ...(opts.env ?? {}) } });
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} -> ${r.status}\n${r.stderr}`);
    return r.stdout.trim();
  };
  // identity for the commits of the cycle (the steps do not see this process's GIT_* variables)
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = selftest\n\temail = selftest@a4s\n[init]\n\tdefaultBranch = main\n");
  const fixture = join(root, "fixture"); mkdirSync(join(fixture, "issues"), { recursive: true });

  // 1. fixture repository (trunk = main) with a bare remote
  const remote = join(root, "remote.git");
  const repo = join(root, "repo"); mkdirSync(repo);
  sh("git", ["init", "-q", "--bare", "-b", "main", remote]);
  writeFileSync(join(repo, "calc.mjs"), "export function add(a, b) { return a + b; }\n");
  writeFileSync(join(repo, "test.mjs"), 'import { add } from "./calc.mjs";\nif (add(2, 3) !== 5) { console.error("FAIL add"); process.exit(1); }\nconsole.log("PASS");\n');
  writeFileSync(join(repo, ".gitignore"), ".workspace/\n");
  sh("git", ["init", "-q", "-b", "main"], { cwd: repo });
  sh("git", ["add", "-A"], { cwd: repo });
  sh("git", ["commit", "-qm", "init"], { cwd: repo });
  sh("git", ["remote", "add", "origin", remote], { cwd: repo });
  sh("git", ["push", "-q", "origin", "main"], { cwd: repo });
  sh("git", ["fetch", "-q", "origin"], { cwd: repo });
  const initSha = sh("git", ["rev-parse", "HEAD"], { cwd: repo });
  const rgit = (...a) => sh("git", ["--git-dir", remote, ...a]);

  // 2. stubs: `gh` on PATH, the `t3` CLI behind a fake T3 home (resolved by lib.resolveT3)
  const bin = join(root, "bin"); mkdirSync(bin);
  copyFileSync(join(HERE, "stub", "gh.mjs"), join(bin, "gh")); chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(join(bin, "gh-config.json"), JSON.stringify({ fixture, remote }));
  // Dagu hands its steps only a few variables (PATH, HOME...), so the stub lives where resolveT3 looks by default: $HOME/.t3/runtime/versions
  const versions = join(home, ".t3", "runtime", "versions"); mkdirSync(join(versions, "stub"), { recursive: true });
  copyFileSync(join(HERE, "stub", "t3.mjs"), join(versions, "stub", "t3")); chmodSync(join(versions, "stub", "t3"), 0o755);
  writeFileSync(join(versions, "stub", "t3-config.json"), JSON.stringify({ fixture }));
  httpServer = createHttp((q, s) => s.end("ok"));
  const t3Port = await new Promise((r) => httpServer.listen(0, "127.0.0.1", () => r(httpServer.address().port)));
  const t3Home = join(root, "t3"); mkdirSync(join(t3Home, "userdata"), { recursive: true });
  writeFileSync(join(t3Home, "userdata", "server-runtime.json"), JSON.stringify({ serverVersion: "stub", origin: `http://127.0.0.1:${t3Port}` }));

  // 3. fixtures: issues, verdicts of the stub lines, CI runs
  const body = (what) => `## Goal\n${what}\n\n## Acceptance criteria\n- [ ] \`node test.mjs\` prints PASS.\n\n## Out of scope\nAnything else.\n`;
  const SCENARIOS = {
    delivered: { issue: "101", title: "Add mul", gate: "node test.mjs", file: "mul" },
    red: { issue: "102", title: "Add neg", gate: "node test.mjs", file: "neg" },
    invalid: { issue: "103", title: "Add sub", gate: "node test.mjs && false", file: "sub" },
    cancelled: { issue: "104", title: "Add abs", gate: "node test.mjs", file: "abs" },
  };
  const verdicts = {};
  for (const s of Object.values(SCENARIOS)) {
    writeFileSync(join(fixture, "issues", `${s.issue}.json`), JSON.stringify({ number: Number(s.issue), title: s.title, body: body(s.title), state: "OPEN", labels: ["factory", "factory:running"], comments: [] }, null, 1));
    const pass = (evidence) => ({ verdict: "pass", criteria: [{ criterion: "stub", evidence, result: "pass" }], findings: [], commit: null, question: null });
    verdicts[s.issue] = {
      impl: { writes: { [`${s.file}.mjs`]: `export const ${s.file} = 1;\n` }, verdict: pass("node test.mjs") },
      qa: { verdict: pass("node test.mjs") },
    };
  }
  writeFileSync(join(fixture, "verdicts.json"), JSON.stringify(verdicts));
  const run = (conclusion, n) => ({ status: "completed", conclusion, workflowName: "CI", url: `https://stub/runs/${n}`, createdAt: "2026-01-01T00:00:00Z" });
  writeFileSync(join(fixture, "runs.json"), JSON.stringify([
    { match: "^Add neg \\(#102\\)$", runs: [run("failure", "red")] },
    { match: "^Add abs \\(#104\\)$", runs: [run("cancelled", "cancelled")] },
  ]));

  // 4. isolated Dagu that reads the DAGs from this checkout (same as selftest.mjs)
  const daguHome = join(root, "dagu"); mkdirSync(join(daguHome, "dags"), { recursive: true });
  const daguPort = await port();
  writeFileSync(join(daguHome, "config.yaml"), `host: 127.0.0.1\nport: ${daguPort}\nauth: {mode: none}\nscheduler: {port: 0}\ncoordinator: {enabled: false}\nfeatures: {unexpectedStopDetection: none}\n`);
  const env = { ...baseEnv, PATH: `${bin}:${process.env.PATH}`, DAGU_HOME: daguHome, DAGU_SKIP_EXAMPLES: "true" };
  const dagu = spawn(DAGU_BIN, ["start-all", "--dagu-home", daguHome, "--config", join(daguHome, "config.yaml"), "--host", "127.0.0.1", "--port", String(daguPort), "--dags", join(FACTORY, "dags")], { detached: true, stdio: "ignore", env });
  procs.push(dagu);
  const api = `http://127.0.0.1:${daguPort}/api/v1`;
  for (let i = 0; i < 30; i++) { try { if ((await fetch(`${api}/dags`)).ok) break; } catch {} await sleep(1000); }
  log("dagu up on", daguPort);

  // 5. one cycle per scenario: PUSH and CLOSE_ISSUE on, the brief from the (stub) GitHub issue
  const runCycle = async (name) => {
    const s = SCENARIOS[name];
    const runId = `selftest-stub-${s.issue}-${Date.now()}`;
    const params = [`ISSUE=${s.issue}`, `PRIMARY=${repo}`, `FACTORY=${FACTORY}`, `T3_HOME=${t3Home}`, `STATE=${join(root, "state")}`, `GATE=${s.gate}`, "PUSH=true", "CLOSE_ISSUE=true"];
    const logFd = openSync(join(root, `cycle-${s.issue}.log`), "a");
    const cycle = spawn(DAGU_BIN, ["start", "--dagu-home", daguHome, "--config", join(daguHome, "config.yaml"), "--run-id", runId, join(FACTORY, "dags", "cycle.yaml"), "--", ...params], { stdio: ["ignore", logFd, logFd], env });
    procs.push(cycle);
    let final;
    for (let i = 0; i < 400; i++) {
      let d; try { d = (await (await fetch(`${api}/dag-runs/cycle/${runId}`)).json()).dagRunDetails; } catch { await sleep(1000); continue; }
      if (["succeeded", "failed", "aborted"].includes(d?.statusLabel)) { final = d; break; }
      await sleep(1000);
    }
    const steps = Object.fromEntries((final?.nodes ?? []).map((n) => [n.step.id, n.statusLabel]));
    log(name, final?.statusLabel ?? "no final status", JSON.stringify(steps));
    return { runId, final, steps };
  };
  const ghCalls = () => (existsSync(join(fixture, "gh-calls.jsonl")) ? readFileSync(join(fixture, "gh-calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).argv) : []);
  const issue = (n) => JSON.parse(readFileSync(join(fixture, "issues", `${n}.json`), "utf8"));
  const subjects = () => rgit("log", "--format=%s", "main").split("\n");
  const checks = {};

  // 5a. delivered: commit with the Factory-Run trailer on the remote, CI green, issue closed with a comment, verify_close passes
  const d = await runCycle("delivered");
  const dTip = rgit("rev-parse", "main");
  const dBody = rgit("log", "-1", "--format=%B", "main");
  checks.delivered_run_succeeded = d.final?.statusLabel === "succeeded";
  checks.delivered_commit_on_remote_with_trailer = rgit("log", "-1", "--format=%s", "main") === "Add mul (#101)" && new RegExp(`^Factory-Run: ${d.runId}$`, "m").test(dBody);
  checks.delivered_ci_step_green = d.steps.ci === "succeeded" && ghCalls().some((a) => a[0] === "run" && a[1] === "list" && a.includes(dTip));
  checks.delivered_issue_closed_with_comment = issue("101").state === "CLOSED" && issue("101").comments.some((c) => c.includes(`Integrated by the factory in ${dTip}`)) &&
    ghCalls().some((a) => a[0] === "issue" && a[1] === "close" && a[2] === "101");
  checks.delivered_verify_close_passes = d.steps.verify_close === "succeeded" && d.steps.close === "succeeded";
  checks.delivered_state_archived = existsSync(join(root, "state", "archive", "101", "done.json"));

  // 5b. CI red: revert commit on the remote, comment on the issue, run failed
  const r = await runCycle("red");
  const rLog = rgit("log", "--format=%s", "main").split("\n");
  checks.red_run_failed_at_ci = r.final?.statusLabel === "failed" && r.steps.ci === "failed" && r.steps.close !== "succeeded";
  checks.red_revert_commit_on_remote = rLog[0] === 'Revert "Add neg (#102)"' && rLog[1] === "Add neg (#102)" && rLog[2] === "Add mul (#101)";
  checks.red_comment_and_issue_open = issue("102").state === "OPEN" && issue("102").comments.some((c) => /CI \(CI\) concluded 'failure'/.test(c) && /reverted/.test(c)) &&
    !ghCalls().some((a) => a[0] === "issue" && a[1] === "close" && a[2] === "102");

  // 5c. validation failure: nothing pushed, nothing closed
  const tipBefore = rgit("rev-parse", "main");
  const v = await runCycle("invalid");
  checks.invalid_validate_failed = v.final?.statusLabel === "failed" && v.steps.validate === "failed" && v.steps.integrate !== "succeeded";
  checks.invalid_nothing_pushed = rgit("rev-parse", "main") === tipBefore && !subjects().some((x) => /#103/.test(x)) &&
    issue("103").state === "OPEN" && !ghCalls().some((a) => a[0] === "run" && a[1] === "list" && /#103/.test(rgit("log", "-1", "--format=%s", a[a.indexOf("--commit") + 1] ?? "HEAD")));

  // 5d. CI cancelled, covered by a later green commit on the remote: no revert (#1070). The later commit is pushed
  // by a clone of the remote as soon as the run's commit appears there (a human or another run in production).
  const beforeCancelled = rgit("rev-parse", "main");
  const later = join(root, "later"); sh("git", ["clone", "-q", remote, later]);
  const watcher = (async () => {
    for (let i = 0; i < 400; i++) {
      if (subjects().includes("Add abs (#104)")) {
        sh("git", ["pull", "-q", "origin", "main"], { cwd: later });
        writeFileSync(join(later, "later.txt"), "later\n"); sh("git", ["add", "-A"], { cwd: later });
        sh("git", ["commit", "-qm", "later commit (#later)"], { cwd: later }); sh("git", ["push", "-q", "origin", "main"], { cwd: later });
        return true;
      }
      await sleep(200);
    }
    return false;
  })();
  const c = await runCycle("cancelled");
  const pushedLater = await watcher;
  const cLog = rgit("log", "--format=%s", `${beforeCancelled}..main`).split("\n");
  const cSha = rgit("log", "-1", "--format=%H", "--fixed-strings", "--grep", "Add abs (#104)", "main");
  const cTip = rgit("rev-parse", "main");
  checks.cancelled_later_commit_pushed = pushedLater && cLog.length === 2 && cLog[0] === "later commit (#later)" && cLog[1] === "Add abs (#104)";
  checks.cancelled_no_revert = !cLog.some((x) => /^Revert/.test(x)) && c.steps.ci === "succeeded";
  checks.cancelled_ci_followed_later_commit = ghCalls().some((a) => a[0] === "run" && a[1] === "list" && a.includes(cSha)) && ghCalls().some((a) => a[0] === "run" && a[1] === "list" && a.includes(cTip));
  // the primary is behind origin once the later commit landed, so verify_close's primary_equals_origin is not asserted here
  checks.cancelled_issue_closed = issue("104").state === "CLOSED";
  log(JSON.stringify(checks));
  ok = Object.values(checks).every(Boolean);
  if (!ok) log("failed:", Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(", "), "init", initSha);
} catch (e) {
  log("error:", e.message);
} finally {
  for (const p of procs) { try { process.kill(-p.pid, "SIGTERM"); } catch { try { p.kill("SIGTERM"); } catch {} } }
  httpServer?.close();
  if (ok && !KEEP && root) rmSync(root, { recursive: true, force: true }); else if (root) log("kept", root);
}
console.log(ok ? "SELFTEST STUB PASS" : "SELFTEST STUB FAIL");
process.exit(ok ? 0 : 1);
