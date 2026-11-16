import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const guard = fileURLToPath(new URL("../scripts/role-guard.py", import.meta.url));
const userManager = process.platform === "linux" && spawnSync("systemctl", ["--user", "is-active", "default.target"]).status === 0;

async function until(check: () => boolean, evidence: () => string) {
  // Real pidfds, cgroups and systemd teardown cannot advance on a fake test clock.
  const deadline = Date.now() + 10_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, evidence());
    await setTimeout(25);
  }
}

test("R30 kills detached double forks and late TERM-ignoring descendants on every owner exit", { skip: !userManager, timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "a4s-role-guard-"));
  const workload = join(root, "workload.py");
  writeFileSync(workload, `import os,pathlib,signal,sys,time
assert os.environ['A4S_GUARD_ENV']=='kept'
if os.fork()==0:
    os.setsid()
    if os.fork()!=0: os._exit(0)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    for index in range(16):
        if os.fork()==0:
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            while True: time.sleep(1)
        if index == 1: pathlib.Path(sys.argv[1]+'.forks').write_text('forking')
        time.sleep(0.03)
    while True: time.sleep(1)
while not pathlib.Path(sys.argv[1]+'.forks').exists(): time.sleep(0.01)
pathlib.Path(sys.argv[1]).write_text('ready')
if sys.argv[2]=='exit':
    while not pathlib.Path(sys.argv[1]+'.release').exists(): time.sleep(0.01)
    sys.exit(7)
while True: time.sleep(1)
`);
  try {
    for (const scenario of ["exit", "launcher-killed", "guard-killed", "runtime"]) {
      const directory = join(root, scenario);
      mkdirSync(directory);
      const log = join(directory, "cleanup.json"), ready = join(directory, "ready");
      const launcher = spawn("python3", [guard, "--runtime-seconds", scenario === "runtime" ? "3" : "10", "--log", log, "--", "python3", workload, ready, scenario], {
        stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, A4S_GUARD_ENV: "kept", "npm-invalid-name": "metadata" },
      });
      let evidence = "";
      launcher.stdout.on("data", data => { evidence += data; });
      launcher.stderr.on("data", data => { evidence += data; });
      const exit = once(launcher, "exit");
      let group: string | undefined;
      try {
        await until(() => existsSync(ready) && existsSync(log), () => evidence);
        const record = JSON.parse(readFileSync(log, "utf8"));
        assert.equal(record.launcher, launcher.pid);
        group = join("/sys/fs/cgroup", record.cgroup.split("::")[1]);
        assert.ok(existsSync(group));
        if (scenario === "exit") writeFileSync(`${ready}.release`, "");
        if (scenario === "launcher-killed") launcher.kill("SIGKILL");
        if (scenario === "guard-killed") process.kill(record.guard, "SIGKILL");
        const [code] = await exit;
        if (scenario === "exit") assert.equal(code, 7, evidence);
        else assert.notEqual(code, 0, evidence);
        await until(() => !existsSync(group!), () => `cgroup survived ${scenario}: ${group}\n${evidence}`);
      } finally {
        if (launcher.exitCode === null && launcher.signalCode === null) {
          launcher.kill("SIGKILL");
          await exit;
        }
        if (group) await until(() => !existsSync(group!), () => `guard cleanup failed: ${group}\n${evidence}`);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
