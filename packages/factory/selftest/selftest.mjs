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
import { beginReceipt, endReceipt } from "../src/receipt.mjs";
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

// SELFTEST_NO_RECEIPT=1: read-only run (e.g. QA) that never touches the receipt.
const RECEIPT = process.env.SELFTEST_NO_RECEIPT !== "1";
const startedAt = new Date().toISOString();
const procs = [];
let ok = false;
let root = "";
let startHash = null;
try {
  // the stale receipt goes first, before any other initialization
  startHash = beginReceipt({ dir: FACTORY, enabled: RECEIPT });
  root = mkdtempSync(join(tmpdir(), "factory-selftest-"));
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

  // st3: an achievable brief (the worker passes), but QA is a stub that always answers `fail` with a fixed finding
  const brief3 = join(root, "brief3.md");
  writeFileSync(brief3, "# Add neg\n\n## Goal\nAdd an exported `neg(a)` to calc.mjs.\n\n## Acceptance criteria\n- [ ] calc.mjs exports `neg(a)` returning `-a`.\n- [ ] `node test.mjs` prints PASS.\n\n## Out of scope\nAnything other than calc.mjs. Do not commit.\n");
  const QA_STUB_FINDING = "SELFTEST-QA-STUB: run `node test.mjs` once more and confirm it prints PASS (no code change is needed)";
  const qaStubPrompt = join(root, "qa-stub.md");
  writeFileSync(qaStubPrompt, `You are a selftest stub of the QA line. Whatever the user message says, do not run any tool, do not read or change any file, and reply with exactly this single line and nothing else:\n${JSON.stringify({ verdict: "fail", criteria: [], findings: [QA_STUB_FINDING], commit: null, question: null })}\n`);

  // 2. isolated T3 with the candidate's line profiles (cheap model for the selftest)
  const t3Home = join(root, "t3"); mkdirSync(join(t3Home, "userdata"), { recursive: true });
  const linesPath = join(root, "lines.json");
  const lines = JSON.parse(readFileSync(join(FACTORY, "lines.json"), "utf8"));
  for (const l of Object.values(lines.lines)) { l.model = MODEL; l.thinking = "low"; delete l.escalate_to; if (l.instance?.prompt) l.instance.prompt = join(FACTORY, l.instance.prompt); }
  writeFileSync(linesPath, JSON.stringify(lines));
  // fixture LINE_TABLE for st3: same lines, but `qa` runs on its own isolated instance with the stub prompt
  const linesStubPath = join(root, "lines-qa-stub.json");
  const linesStub = JSON.parse(JSON.stringify(lines));
  linesStub.lines.qa.provider = "pi-qa-stub";
  linesStub.lines.qa.instance.prompt = qaStubPrompt;
  linesStub.lines.qa.instance.displayName = "Factory · qa (selftest stub)";
  writeFileSync(linesStubPath, JSON.stringify(linesStub));
  const instances = { pi: { driver: "pi", enabled: true, config: { binaryPath: PI_BIN } }, ...instancesFromLines(linesPath, PI_BIN), ...instancesFromLines(linesStubPath, PI_BIN) };
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

  // 4. run the cycle: st1 must close (QA passes); st2's validation fails and st3's QA fails twice, so nothing may be committed
  const runCycle = async (issue, briefPath, gate, lineTable = linesPath) => {
    const runId = `selftest-${issue}-${Date.now()}`;
    const params = [`ISSUE=${issue}`, `PRIMARY=${repo}`, `FACTORY=${FACTORY}`, `T3_HOME=${t3Home}`, `STATE=${join(root, "state")}`,
      `BRIEF_FILE=${briefPath}`, `GATE=${gate}`, `PUSH=false`, `CLOSE_ISSUE=false`, `LINE_TABLE=${lineTable}`];
    const logFd = openSync(join(root, `cycle-${issue}.log`), "a");
    const cycle = spawn(DAGU_BIN, ["start", "--dagu-home", daguHome, "--config", join(daguHome, "config.yaml"), "--run-id", runId, join(FACTORY, "dags", "cycle.yaml"), "--", ...params], { stdio: ["ignore", logFd, logFd], env });
    procs.push(cycle);
    let final;
    for (let i = 0; i < 600; i++) {
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
    verify_close_succeeded: r1.step("verify_close") === "succeeded",
    done_json_present: (() => { try { const d = JSON.parse(readFileSync(join(root, "state", "st1", "done.json"), "utf8")); return !!(d.run_id && d.commit && d.timestamp); } catch { return false; } })(),
    pass_without_criteria_downgraded: checkVerdict({ verdict: "pass", findings: [] }).verdict.verdict === "fail",
    failed_validation_blocks_commit: r2.step("validate") === "failed" && r2.step("integrate") !== "succeeded" && log2.length === log1.length &&
      existsSync(wt2) && sh("git", ["rev-list", "--count", "main..HEAD"], { cwd: wt2 }) === "0",
  };
  // st3: the worker passes, the stub QA fails twice; the findings go once to the impl thread and nothing is committed
  const r3 = await runCycle("st3", brief3, "node test.mjs", linesStubPath);
  const log3 = trunkLog();
  const wt3 = join(repo, ".workspace", "worktrees", "issue-st3");
  const stLine = (issue, l) => { try { return JSON.parse(readFileSync(join(root, "state", issue, `${l}.json`), "utf8")).attempts; } catch { return []; } };
  const qa1 = stLine("st1", "qa"), qa3 = stLine("st3", "qa"), impl3 = stLine("st3", "impl");
  const cont3 = impl3.filter((x) => x.continued);
  const findings3 = (() => { try { return readFileSync(join(root, "state", "st3", "qa-findings.md"), "utf8"); } catch { return ""; } })();
  log("st3 qa attempts", JSON.stringify(qa3), "impl attempts", JSON.stringify(impl3));
  Object.assign(checks, {
    qa_passes_on_st1: r1.step("qa") === "succeeded" && qa1.length === 1 && qa1[0].outcome === "pass",
    qa_fails_twice_nothing_committed: r3.final?.statusLabel === "failed" && r3.step("require_pass") === "succeeded" &&
      r3.step("qa") === "failed" && r3.step("validate") !== "succeeded" && r3.step("integrate") !== "succeeded" &&
      qa3.length === 2 && qa3.every((x) => x.outcome === "fail") &&
      cont3.length === 1 && cont3[0].threadId === impl3.filter((x) => !x.continued).at(-1)?.threadId && cont3[0].outcome === "pass" && findings3.includes("SELFTEST-QA-STUB") &&
      log3.length === log2.length && existsSync(wt3) && sh("git", ["rev-list", "--count", "main..HEAD"], { cwd: wt3 }) === "0",
  });
  // 5b. receipt check of the real `validate` step: a factory change without receipt fails with the finding and the gate never runs
  {
    const cyc = readFileSync(join(FACTORY, "dags", "cycle.yaml"), "utf8");
    const m = /^  - id: validate\n[\s\S]*?^    run: \|\n([\s\S]*?)(?=^\S|^  # |^  - id:)/m.exec(cyc);
    const validateBody = (m?.[1] ?? "").split("\n").map((l) => l.replace(/^ {6}/, "")).join("\n");
    const prim = join(root, "receipt-primary"); mkdirSync(join(prim, "packages", "factory"), { recursive: true });
    writeFileSync(join(prim, "README.md"), "x\n"); writeFileSync(join(prim, ".gitignore"), ".workspace/\n");
    sh("git", ["init", "-q", "-b", "main"], { cwd: prim }); sh("git", ["add", "-A"], { cwd: prim });
    sh("git", ["-c", "user.email=selftest@a4s", "-c", "user.name=selftest", "commit", "-qm", "init"], { cwd: prim });
    const wtR = join(prim, ".workspace", "worktrees", "issue-rcpt");
    sh("git", ["worktree", "add", "-q", "-b", "factory/issue-rcpt", wtR, "main"], { cwd: prim });
    mkdirSync(join(wtR, "packages", "factory"), { recursive: true });
    writeFileSync(join(wtR, "packages", "factory", "x.mjs"), "1\n");
    mkdirSync(join(root, "state", "rcpt"), { recursive: true });
    const marker = join(root, "receipt-gate-ran");
    const rr = spawnSync("bash", ["-c", validateBody], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME,
      PRIMARY: prim, FACTORY, T3_HOME: join(root, "t3"), STATE: join(root, "state"), ISSUE: "rcpt", BASE: "main", DAG_RUN_ID: "selftest-rcpt", GATE: `touch ${marker}` } });
    const finding = (() => { try { return JSON.parse(readFileSync(join(root, "state", "rcpt", "step-failure.json"), "utf8")).findings[0]; } catch { return ""; } })();
    Object.assign(checks, { validate_requires_receipt_for_factory_changes: validateBody.length > 0 && rr.status !== 0 && !existsSync(marker) && /^selftest not run on this code: receipt missing/.test(finding) });
  }
  // 5a. notifications (VS2): no thread configured, so the first notification created the inbox and later ones reused it
  const t3cli = (...a) => spawnSync("node", [join(FACTORY, "src", "t3cli.mjs"), ...a], { encoding: "utf8", env: { ...process.env, T3_HOME: t3Home } });
  const inboxId = (() => { try { return JSON.parse(readFileSync(join(root, "state", "inbox.json"), "utf8")).threadId; } catch { return ""; } })();
  const inboxThreads = (() => { try { const o = t3cli("thread", "list", "--json", "--project", repo).stdout; return JSON.parse(o.slice(o.indexOf("["))).filter((t) => t.title === "Bandeja de la fábrica"); } catch { return []; } })();
  const inboxMessages = (() => { try { const o = t3cli("thread", "show", "--json", "--messages", "50", inboxId).stdout; return JSON.parse(o.slice(o.indexOf("{"))).messages.filter((m) => m.role === "user").map((m) => m.text); } catch { return []; } })();
  const run1 = r1.final?.dagRunId ?? "", run2 = r2.final?.dagRunId ?? "";
  const about = (run) => inboxMessages.filter((t) => t.includes(`Run ${run} `));
  log("inbox", inboxId, "threads", inboxThreads.length, "messages", JSON.stringify(inboxMessages));
  Object.assign(checks, {
    inbox_created_once: !!inboxId && inboxThreads.length === 1 && inboxThreads[0].threadId === inboxId,
    st1_one_success_message: about(run1).length === 1 && /evento: success/.test(about(run1)[0]),
    st2_one_failure_message_names_validate: about(run2).length === 1 && /evento: failure/.test(about(run2)[0]) && /Paso fallido: validate/.test(about(run2)[0]),
    notified_recorded: (() => { try { return !!JSON.parse(readFileSync(join(root, "state", "st1", "notified.json"), "utf8"))[`${run1}:success`]; } catch { return false; } })(),
  });
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
  const queued = (n, k = 1) => daguAd("status", "--run-id", `factory-issue-${n}-${k}`, cycleDag).status === 0;
  const admitCli = (n) => spawnSync("node", [join(FACTORY, "src", "admit.mjs"), "--issue", String(n), "--issues-file", issuesFile, "--state", stateAd, "--dagu-home", adHome, "--config", adCfg, "--dag", cycleDag], { encoding: "utf8", env: adEnv }).status;
  // no PRIMARY/FACTORY/T3_HOME/STATE params: admit.yaml must resolve them from the base config
  const adm = daguAd("start", "--run-id", `admit${Date.now()}`, admitDag, "--", `ISSUES_FILE=${issuesFile}`, `TARGET_DAGU_HOME=${adHome}`, `TARGET_DAGU_CONFIG=${adCfg}`);
  log("admit dag ->", adm.status);
  checks.admit_dag_succeeded = adm.status === 0;
  checks.admit_ready_enqueued = queued(7001);
  // the admitted run must be registered under the cycle DAG name, never the parent's `admit`
  const byName = (name, n) => spawnSync(DAGU_BIN, ["status", "--dagu-home", adHome, "--config", adCfg, "--run-id", `factory-issue-${n}-1`, name], { encoding: "utf8", env: adEnv }).status === 0;
  checks.admit_registered_as_cycle = byName("cycle", 7001) && !byName("admit", 7001);
  // admission moved the label ready -> running, so a second admission finds nothing to admit
  const labelsOf = (n) => (JSON.parse(readFileSync(issuesFile, "utf8")).find((i) => i.number === n)?.labels ?? []).map((l) => l.name ?? l);
  checks.admit_moves_label_to_running = labelsOf(7001).includes("factory:running") && !labelsOf(7001).includes("factory:ready");
  checks.admit_again_not_admitted = admitCli(7001) === 20;
  checks.admit_contract_violation_not_admitted = !queued(7003) && admitCli(7003) === 22;
  checks.admit_factory_only_not_admitted = !queued(7002) && admitCli(7002) === 20;
  // an admitted-style run without those params resolves STATE from the base config (BASE=nosuch stops it right after)
  daguAd("start", "--run-id", `cfg${Date.now()}`, cycleDag, "--", "ISSUE=7003", "BASE=nosuch");
  checks.cycle_resolves_base_config = existsSync(join(stateAd, "7003"));
  // 5c. issue state and retries (fixtures, no worker): fail once -> -2; blocked -> needs-human; 3 failures -> needs-human + comment
  const labelsCli = (...a) => spawnSync("node", [join(FACTORY, "src", "labels.mjs"), ...a, "--issues-file", issuesFile], { encoding: "utf8", env: adEnv });
  const seedStation = (n, outcome, question = "", findings = []) => { mkdirSync(join(stateAd, String(n)), { recursive: true }); writeFileSync(join(stateAd, String(n), "impl.json"), JSON.stringify({ attempts: [{ threadId: "t", outcome, question, findings }] })); };
  const commentsOf = (n) => JSON.parse(readFileSync(issuesFile, "utf8")).find((i) => i.number === n)?.comments ?? [];
  const body = "## Goal\nx\n\n## Acceptance criteria\n- [ ] y\n\n## Out of scope\nz\n";
  const fixtures = JSON.parse(readFileSync(issuesFile, "utf8"));
  for (const n of [7101, 7102]) fixtures.push({ number: n, labels: [{ name: "factory:ready" }], body });
  writeFileSync(issuesFile, JSON.stringify(fixtures));
  const failRun = (n, k, steps, seed) => { admitCli(n); if (seed) seed(); return labelsCli("finish", "--issue", String(n), "--state", stateAd, "--run", `factory-issue-${n}-${k}`, "--steps", steps); };
  seedStation(7101, "fail", "", ["SELFTEST-CARRY-FINDING"]);
  failRun(7101, 1, "prepare=succeeded,implement=failed");
  // retry preparation: run the real prepare brief-writing script and read the generated brief.md
  const retryBriefSrc = join(root, "brief-7101.md");
  writeFileSync(retryBriefSrc, "# Retried issue\n\n## Goal\nx\n");
  const prep = spawnSync("bash", [join(FACTORY, "src", "prepare-brief.sh")], { encoding: "utf8", env: { ...adEnv, ISSUE: "7101", PRIMARY: repo, FACTORY, T3_HOME: t3Home, STATE: stateAd, BRIEF_FILE: retryBriefSrc } });
  const carried = (() => { try { return readFileSync(join(stateAd, "7101", "brief.md"), "utf8"); } catch { return ""; } })();
  checks.retry_brief_carries_first_run_findings = prep.status === 0 && carried.startsWith("# Retried issue") && /## Previous run findings/.test(carried) && carried.includes("SELFTEST-CARRY-FINDING") && carried.includes("factory-issue-7101-1") && /Failed step: implement/.test(carried);
  checks.retry_back_to_ready = labelsOf(7101).includes("factory:ready");
  admitCli(7101);
  checks.retry_runs_as_attempt_2 = queued(7101, 2);
  labelsCli("finish", "--issue", "7101", "--state", stateAd, "--run", "factory-issue-7101-2", "--steps", "implement=failed");
  admitCli(7101);
  labelsCli("finish", "--issue", "7101", "--state", stateAd, "--run", "factory-issue-7101-3", "--steps", "implement=failed");
  checks.three_failures_needs_human = labelsOf(7101).includes("factory:needs-human") && queued(7101, 3) && /Outcome: fail/.test(commentsOf(7101).at(-1) ?? "") && /Failed step: implement/.test(commentsOf(7101).at(-1) ?? "");
  labelsCli("move", "--issue", "7101", "--to", "ready");
  checks.human_ready_admits_new_attempt = admitCli(7101) === 0 && queued(7101, 4);
  // seed after admission: admission archives a stale pass/blocked station state
  failRun(7102, 1, "implement=succeeded,require_pass=failed", () => seedStation(7102, "blocked", "which db?"));
  checks.blocked_needs_human = labelsOf(7102).includes("factory:needs-human") && /which db\?/.test(commentsOf(7102).at(-1) ?? "");
  // 5d. circuit breaker: a fixture state with an open breaker makes the next admission enqueue nothing; after `reset` it admits again
  const iss = JSON.parse(readFileSync(issuesFile, "utf8"));
  iss.push({ number: 7201, labels: [{ name: "factory:ready" }], body });
  writeFileSync(issuesFile, JSON.stringify(iss));
  const snapFile = join(root, "breaker-snapshot.json");
  writeFileSync(snapFile, JSON.stringify({ services: { dagu: { reachable: true }, t3: { reachable: true } } }));
  writeFileSync(join(stateAd, "breaker.json"), JSON.stringify({ version: 1, open: true, since: "2020-01-01T00:00:00.000Z", notifiedAt: "2020-01-01T00:00:00.000Z", reasons: [{ kind: "fixture", detail: "open breaker fixture", since: "2020-01-01T00:00:00.000Z" }], resetBy: null, resetAt: null }));
  const admitWithBreaker = () => daguAd("start", "--run-id", `admit-br${Date.now()}`, admitDag, "--", `ISSUES_FILE=${issuesFile}`, `TARGET_DAGU_HOME=${adHome}`, `TARGET_DAGU_CONFIG=${adCfg}`, `BREAKER_SNAPSHOT=${snapFile}`);
  const brState = () => { try { return JSON.parse(readFileSync(join(stateAd, "breaker.json"), "utf8")); } catch { return {}; } };
  const brAdm1 = admitWithBreaker();
  checks.breaker_open_enqueues_nothing = brAdm1.status === 0 && !queued(7201) && labelsOf(7201).includes("factory:ready") && brState().open === true;
  const rs = spawnSync("node", [join(FACTORY, "src", "breaker.mjs"), "reset", "--state", stateAd, "--by", "selftest"], { encoding: "utf8", env: adEnv });
  checks.breaker_reset_records_who = rs.status === 0 && brState().open === false && brState().resetBy === "selftest" && !!brState().resetAt;
  // ci condition: current main with failing CI opens the breaker (and admits nothing); reset closes it
  const ciSnap = join(root, "breaker-ci-snapshot.json");
  writeFileSync(ciSnap, JSON.stringify({ services: { dagu: { reachable: true }, t3: { reachable: true } }, ci: { sha: "c".repeat(40), commitTime: new Date().toISOString(), status: "failure", timeoutMin: 30 } }));
  const ckCi = spawnSync("node", [join(FACTORY, "src", "breaker.mjs"), "check", "--state", stateAd, "--snapshot", ciSnap, "--factory", join(FACTORY, "src")], { encoding: "utf8", env: adEnv });
  checks.breaker_ci_failing_main_opens = ckCi.status === 40 && brState().open === true && brState().reasons.some((r) => r.kind === "ci");
  spawnSync("node", [join(FACTORY, "src", "breaker.mjs"), "reset", "--state", stateAd, "--by", "selftest"], { encoding: "utf8", env: adEnv });
  // limits condition: a fixture attempt with outcome timeout opens the breaker; reset closes it
  // (startedAt is after the previous reset: events before a reset do not count)
  mkdirSync(join(stateAd, "7301"), { recursive: true });
  writeFileSync(join(stateAd, "7301", "attempts.json"), JSON.stringify({ last: 1, streak: 1, parked: false, lastAt: new Date().toISOString() }));
  writeFileSync(join(stateAd, "7301", "impl.json"), JSON.stringify({ attempts: [{ startedAt: Date.now() + 1000, timeoutSec: 60, outcome: "timeout" }] }));
  const ckLim = spawnSync("node", [join(FACTORY, "src", "breaker.mjs"), "check", "--state", stateAd, "--snapshot", snapFile, "--factory", join(FACTORY, "src")], { encoding: "utf8", env: adEnv });
  checks.breaker_limits_timeout_opens = ckLim.status === 40 && brState().open === true && brState().reasons.some((r) => r.kind === "limits" && /#7301 step impl/.test(r.detail));
  spawnSync("node", [join(FACTORY, "src", "breaker.mjs"), "reset", "--state", stateAd, "--by", "selftest"], { encoding: "utf8", env: adEnv });
  rmSync(join(stateAd, "7301"), { recursive: true, force: true });
  const brAdm2 = admitWithBreaker();
  checks.breaker_closed_admits_again = brAdm2.status === 0 && queued(7201) && labelsOf(7201).includes("factory:running");
  log(JSON.stringify(checks));
  ok = Object.values(checks).every(Boolean);
} catch (e) {
  log("error:", e.message);
} finally {
  for (const p of procs) { try { process.kill(-p.pid, "SIGTERM"); } catch { try { p.kill("SIGTERM"); } catch {} } }
  if (ok && !KEEP && root) rmSync(root, { recursive: true, force: true }); else if (root) log("kept", root);
}
try {
  const r = endReceipt({ dir: FACTORY, enabled: RECEIPT, passed: ok, startHash, startedAt, model: MODEL });
  if (RECEIPT && ok && !r.written) { log(`no receipt: ${r.reason}`); ok = false; }
} catch (e) { log("receipt error:", e.message); ok = false; }
console.log(ok ? "SELFTEST PASS" : "SELFTEST FAIL");
process.exit(ok ? 0 : 1);
