import { stationEnvironment } from "../fixtures/service-environment.ts";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "yaml";

const packageDir = fileURLToPath(new URL("../../", import.meta.url));
const skillDir = join(packageDir, "skills", "issue-execution");
function bootstrap(): { steps: Array<{ id: string; run?: string }> } {
  return parse(readFileSync(join(skillDir, "dagu-feature-bootstrap.yaml"), "utf8"));
}

test("bootstrap detect fails with the missing release executable's path", () => {
  const root = mkdtempSync(join(tmpdir(), "a4s-detect-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    for (const tool of ["git", "gh", "jq", "curl", "dagu"]) {
      writeFileSync(join(bin, tool), "#!/bin/sh\nexit 0\n");
      chmodSync(join(bin, tool), 0o755);
    }
    const missing = join(root, "missing-a4s");
    const result = spawnSync("bash", ["-c", bootstrap().steps.find(step => step.id === "detect")!.run!], {
      encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, A4S_BIN: missing },
    });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(`bootstrap detect: required command not found: ${missing}`), result.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bootstrap detect rejects a protected run-spec route even if queue readiness passes", async () => {
  const root = mkdtempSync(join(tmpdir(), "a4s-detect-auth-"));
  const requests: string[] = [];
  let status = 401;
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    assert.equal(request.headers.authorization, undefined);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(status === 200 ? JSON.stringify({ spec: "steps: []" }) : "authentication required");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const bin = join(root, "bin");
    mkdirSync(bin);
    const scripts = {
      git: '#!/bin/sh\nprintf "%s\\n" "$PRIMARY"\n',
      gh: '#!/bin/sh\ncase "$*" in *nameWithOwner*) echo fixture/repo;; *"repo view"*) echo repo;; esac\n',
      dagu: "#!/bin/sh\nexit 0\n",
      a4s: `#!/bin/sh\nif [ "$1" = service-environment ]; then exec '${process.execPath}' --import '${import.meta.resolve("tsx")}' '${join(packageDir, "src/cli.ts")}' "$@"; fi\nexit 0\n`,
    };
    for (const [tool, script] of Object.entries(scripts)) {
      writeFileSync(join(bin, tool), script);
      chmodSync(join(bin, tool), 0o755);
    }
    const env = stationEnvironment({ ...process.env, PATH: `${bin}:${process.env.PATH}`, PRIMARY: root, A4S_BIN: join(bin, "a4s"), DAGU_HOME: root, DAGU_PORT: String(address.port), DAG_RUN_ID: "bootstrap fixture", DAGU_OUTPUT_FILE: join(root, "outputs") });
    const before = readdirSync(root).sort();
    const result = await promisify(execFile)("bash", ["-c", bootstrap().steps.find(step => step.id === "detect")!.run!], {
      env,
    }).then(() => assert.fail("protected run-spec route accepted"), error => ({ code: error.code, stderr: String(error.stderr) }));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /401/);
    assert.match(result.stderr, /bootstrap detect: unauthenticated loopback Dagu run-spec API is not reachable/);
    assert.ok(result.stderr.includes(`${root}/config.yaml`));
    assert.match(result.stderr, /auth.mode: none and coordinator.enabled: true/);
    assert.match(result.stderr, /station safe activation policy and retry bootstrap/);
    assert.deepEqual(requests, ["GET /api/v1/dag-runs/dagu-feature-bootstrap/bootstrap%20fixture/spec"]);
    assert.deepEqual(readdirSync(root).sort(), before);
    status = 200;
    const probe = bootstrap().steps.find(step => step.id === "detect")!.run!.split("base=${BASE_BRANCH:")[0]!;
    await promisify(execFile)("bash", ["-c", probe], {
      env,
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[1], requests[0]);
    assert.deepEqual(readdirSync(root).sort(), before);
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});
