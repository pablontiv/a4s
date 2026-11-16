import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const role = join(repo, "packages/omp-dagu/scripts/triage-role.py");
const definition = readFileSync(join(repo, ".workspace/dagu/dags/triage-pilot.yaml"), "utf8");
const dagu = process.env.DAGU_BIN;
const userManager = process.platform === "linux" && spawnSync("systemctl", ["--user", "is-active", "default.target"]).status === 0;
const execute = promisify(execFile);

function artifacts() {
  const root = mkdtempSync(join(tmpdir(), "a4s-triage-binding-"));
  chmodSync(root, 0o700);
  const state = join(root, "current", "version-1"), reviewer = join(state, "reviewer"), sessions = join(reviewer, "sessions");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(join(state, "triage"));
  const decision = { poc: "no", behavior: "existing", question: "none", reason: "exercised", run: "current", version: "1" };
  writeFileSync(join(state, "triage", "decision.json"), JSON.stringify(decision));
  writeFileSync(join(reviewer, "decision.json"), JSON.stringify({ ...decision, agree: true }));
  writeFileSync(join(state, "triage-start.json"), '{"at":"2026-11-15T10:00:00Z"}');
  const transcript = join(sessions, "review.jsonl");
  const records = [
    { type: "session", timestamp: "2026-11-15T10:00:01Z" },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "RUN=current VERSION=1\nReview this scope." }] } },
  ];
  const save = () => { writeFileSync(transcript, records.map(value => JSON.stringify(value)).join("\n")); utimesSync(transcript, new Date("2026-11-15T10:00:02Z"), new Date("2026-11-15T10:00:02Z")); };
  save();
  const binding = { session_dir: sessions, session: transcript };
  const saveBinding = () => writeFileSync(join(state, "reviewer-binding.json"), JSON.stringify(binding));
  saveBinding();
  const check = () => spawnSync("python3", [role, "check"], { encoding: "utf8", env: { ...process.env, STATE_ROOT: root, RUN: "current", VERSION: "1" } });
  const change = (part: "triage" | "reviewer", field: string, value: unknown) => {
    const path = join(state, part, "decision.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), [field]: value }));
  };
  return { root, state, sessions, transcript, records, save, binding, saveBinding, check, change };
}

test("last single-line object extraction ignores prose, arrays and multiline objects", () => {
  for (const [input, expected] of [
    ['prose\n{"first":1}\n[2]\n{"last":2}\ntrailer', { last: 2 }],
    ['prose\n{\n"multiline": true\n}\n[]\nnull', null],
  ] as const) {
    const result = spawnSync("python3", [role, "extract"], { encoding: "utf8", input });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout ? JSON.parse(result.stdout) : null, expected);
  }
});

test("run identity cannot escape the private state root through a dot segment", () => {
  for (const run of [".", ".."]) {
    const result = spawnSync("python3", [role, "check"], {
      encoding: "utf8", env: { ...process.env, RUN: run, VERSION: "1", STATE_ROOT: tmpdir() },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid RUN or VERSION/);
  }
});

test("current run+generation reviewer binding accepts one fresh transcript", () => {
  const fixture = artifacts();
  try {
    const result = fixture.check();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.ok(Object.values(JSON.parse(result.stdout)).every(value => value === true));
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

for (const [part, field, value, dimension] of [
  ["triage", "run", "old", "triage_run"], ["triage", "version", "0", "triage_version"],
  ["reviewer", "run", "old", "review_run"], ["reviewer", "version", "0", "review_version"],
  ["reviewer", "agree", false, "agree"], ["reviewer", "poc", "yes", "poc_no"],
] as const) {
  test(`reviewer binding independently rejects ${dimension}`, () => {
    const fixture = artifacts();
    try {
      fixture.change(part, field, value);
      const result = fixture.check(), checks = JSON.parse(result.stdout);
      assert.equal(result.status, 1, result.stderr + result.stdout);
      assert.deepEqual(Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name), [dimension]);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });
}

for (const dimension of ["created_after_triage", "mtime_after_triage", "prompt_run", "prompt_version"] as const) {
  test(`reviewer binding independently rejects stale ${dimension}`, () => {
    const fixture = artifacts();
    try {
      if (dimension === "created_after_triage") fixture.records[0]!.timestamp = "2026-11-15T09:59:59Z";
      if (dimension === "prompt_run") fixture.records[1]!.message!.content[0]!.text = "RUN=old VERSION=1\nReview this scope.";
      if (dimension === "prompt_version") fixture.records[1]!.message!.content[0]!.text = "RUN=current VERSION=0\nReview this scope.";
      fixture.save();
      if (dimension === "mtime_after_triage") utimesSync(fixture.transcript, new Date(0), new Date(0));
      const result = fixture.check(), checks = JSON.parse(result.stdout);
      assert.equal(result.status, 1, result.stderr + result.stdout);
      assert.deepEqual(Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name), [dimension]);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });
}

for (const dimension of ["duplicate transcripts", "recorded transcript", "recorded directory"]) {
  test(`reviewer binding rejects ${dimension}`, () => {
    const fixture = artifacts();
    try {
      if (dimension === "duplicate transcripts") copyFileSync(fixture.transcript, join(fixture.sessions, "duplicate.jsonl"));
      if (dimension === "recorded transcript") fixture.binding.session = join(fixture.sessions, "missing.jsonl");
      if (dimension === "recorded directory") fixture.binding.session_dir = fixture.root;
      fixture.saveBinding();
      const result = fixture.check();
      assert.equal(result.status, 1, result.stderr + result.stdout);
      assert.equal(JSON.parse(result.stdout).transcript_unique, false);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });
}

test("POC=yes bypasses even invalid reviewer artifacts, but not stale triage identity", () => {
  const fixture = artifacts();
  try {
    fixture.change("triage", "poc", "yes");
    rmSync(join(fixture.state, "reviewer"), { recursive: true });
    writeFileSync(join(fixture.state, "reviewer-binding.json"), "invalid JSON");
    assert.equal(fixture.check().status, 0);
    fixture.change("triage", "version", "0");
    assert.equal(fixture.check().status, 1);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("role and parent deadlines leave bounded cleanup time and skipped review still checks POC=yes", () => {
  const source = readFileSync(role, "utf8");
  const max = Number(source.match(/^MAX_TIME = (\d+)$/m)![1]);
  const guard = Number(source.match(/^GUARD_TIME = (\d+)$/m)![1]);
  const parent = Number(definition.match(/timeout_sec: (\d+)/)![1]);
  const child = [...definition.matchAll(/timeout_sec: (\d+)/g)].slice(1).map(match => Number(match[1]));
  assert.ok(max < guard && guard + 1 < child[0]! && child.every(seconds => seconds < parent));
  assert.ok(child.reduce((sum, seconds) => sum + seconds, 0) < parent);
  assert.match(definition, /continue_on:\n      skipped: true/);
  assert.match(source, /"unexpectedStopDetection": "none"/);
  assert.match(source, /"--no-extensions"/);
  assert.doesNotMatch(source, /@a4s\/omp-dagu/);
});

test("Dagu 2.26 triage child fails closed on exit, schema and semantic errors", { skip: !dagu || !userManager, timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "a4s-triage-native-")), bin = join(root, "bin");
  mkdirSync(bin);
  const state = join(root, "state");
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(join(bin, "omp"), `#!/usr/bin/env python3
import datetime,json,os,pathlib,sys
args=sys.argv[1:]
sessions=pathlib.Path(args[args.index('--session-dir')+1])
prompt=args[-1]
reviewer='Independently review' in prompt
case=os.environ['RUN']
if case=='yes' and reviewer: raise RuntimeError('POC=yes must not call a reviewer')
value={'poc':'yes' if case=='yes' else 'no','behavior':'existing','question':'none','reason':'exercised','run':os.environ['RUN'],'version':os.environ['VERSION']}
if reviewer: value['agree']=case!='semantic'
if case=='schema' or (case=='review-schema' and reviewer): value.pop('reason')
records=[{'type':'session','timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat()},{'type':'message','message':{'role':'user','content':prompt}}]
(sessions/'session.jsonl').write_text('\\n'.join(json.dumps(x) for x in records))
(sessions.parent/'arguments.json').write_text(json.dumps(args))
print('launcher prose')
print('{"earlier":"not the decision"}')
if case!='missing-json': print(json.dumps(value))
print('trailing prose')
sys.exit(7 if case=='nonzero' else 0)
`, { mode: 0o755 });
  const child = join(root, "triage-pilot-child.yaml");
  writeFileSync(child, definition.split("---\n")[1]!);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DAGU_")));
  try {
    for (const scenario of ["valid", "yes", "nonzero", "schema", "review-schema", "semantic", "missing-json"]) {
      let status = 0, evidence = "";
      try {
        const result = await execute(dagu!, ["start", "--run-id", scenario, child, "--", `RUN=${scenario}`, "VERSION=1", `REPO=${repo}`, `STATE_ROOT=${state}`, "MODEL=fixture", "SCOPE=exercised behavior"], {
          env: { ...environment, DAGU_HOME: join(root, "dagu"), DAGU_SKIP_EXAMPLES: "true", PATH: `${bin}:${dirname(dagu!)}:${process.env.PATH}` },
          timeout: 20_000, maxBuffer: 4_000_000,
        });
        evidence = result.stdout + result.stderr;
      } catch (error) {
        const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
        if (typeof failure.code !== "number") throw error;
        status = failure.code; evidence = `${failure.stdout}\n${failure.stderr}`;
      }
      if ((status === 0) !== ["valid", "yes"].includes(scenario)) {
        const logs = join(root, "dagu", "logs");
        for (const file of readdirSync(logs, { recursive: true, encoding: "utf8" })) {
          if (file.endsWith(".err")) evidence += `\n${file}:\n${readFileSync(join(logs, file), "utf8")}`;
        }
        const stderr = join(state, scenario, "version-1", "triage", "stderr.txt");
        if (existsSync(stderr)) evidence += `\nrole stderr:\n${readFileSync(stderr, "utf8")}`;
      }
      assert.equal(status === 0, ["valid", "yes"].includes(scenario), `${scenario}\n${evidence}`);
      const result = await execute(dagu!, ["status", "--run-id", scenario, child], { env: { ...environment, DAGU_HOME: join(root, "dagu") } });
      assert.match(result.stdout, ["valid", "yes"].includes(scenario) ? /^Succeeded\b/m : /^Failed\b/m, evidence);
      if (["valid", "yes"].includes(scenario)) {
        const directory = join(state, scenario, "version-1", "triage");
        const args = JSON.parse(readFileSync(join(directory, "arguments.json"), "utf8")) as string[];
        assert.ok(args.includes("--no-extensions"));
        assert.ok(!args.includes("-e"));
        assert.equal(JSON.parse(readFileSync(join(directory, "config.yaml"), "utf8")).features.unexpectedStopDetection, "none");
        assert.equal(JSON.parse(readFileSync(join(directory, "decision.json"), "utf8")).run, scenario);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
