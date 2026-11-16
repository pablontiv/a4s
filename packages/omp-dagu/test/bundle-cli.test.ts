import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/dagu-feature-bundle.ts", import.meta.url));
const stamp = "# dagu-feature-bundle: @a4s/omp-dagu@0.2.0 source=pablontiv/a4s@0123456789012345678901234567890123456789 bootstrap=bootstrap-probe-0.2.0 dagu=2.26.0\nlabels:\n  - dagu-feature-bundle=0.2.0\n";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dagu-bundle-cli-"));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  mkdirSync(join(repo, ".workspace", "dagu", "dags"), { recursive: true });
  mkdirSync(join(repo, ".workspace", "config"), { recursive: true });
  mkdirSync(bin);
  assert.equal(spawnSync("git", ["init", "-b", "main", repo]).status, 0);
  for (const name of ["feature.yaml", "poc.yaml"]) writeFileSync(join(repo, ".workspace", "dagu", "dags", name), stamp);
  writeFileSync(join(bin, "dagu"), "#!/bin/sh\nprintf '2.26.0\\n'\n");
  chmodSync(join(bin, "dagu"), 0o755);
  return {
    root, repo,
    configure(url: string) {
      writeFileSync(join(repo, ".workspace", "config", "dagu.json"), JSON.stringify({ daguUrl: url }));
    },
    async run(args = [repo], cwd = root, preload?: string) {
      try {
        const result = await exec(process.execPath, [
          ...(preload ? ["--import", `data:text/javascript,${encodeURIComponent(preload)}`] : []), cli, ...args,
        ], {
          cwd,
          env: { ...process.env, DAGU_URL: "http://127.0.0.1:1", DAGU_HOME: join(root, "other-station"), PATH: `${bin}:${process.env.PATH ?? ""}` },
        });
        return { ...result, status: 0 };
      } catch (error) {
        const result = error as { stdout: string; stderr: string; code: number };
        return { ...result, status: result.code };
      }
    },
  };
}

async function station(status = 200, payload: unknown = { spec: stamp, dag: { labels: ["dagu-feature-bundle=0.2.0"] } }) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`, requests,
    close: () => promisify(server.close.bind(server))(),
  };
}

test("CLI reads the first repository's station spec, not environment or another repository", async () => {
  const first = fixture();
  const second = fixture();
  const installed = await station();
  const missing = await station(404, { code: "not_found", message: "DAG not found" });
  try {
    first.configure(`${installed.url}/`);
    second.configure(missing.url);
    mkdirSync(join(first.root, "other-station", "dags"), { recursive: true });
    writeFileSync(join(first.root, "other-station", "dags", "reconcile.yaml"), "unstamped\n");
    const result = await first.run([first.repo, second.repo], second.repo);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /feature\.yaml .*version=0\.2\.0 .*compat=ok/);
    assert.match(result.stdout, /poc\.yaml .*version=0\.2\.0 .*compat=ok/);
    assert.ok(result.stdout.includes(`reconcile.yaml path=${installed.url}/api/v1/dags/reconcile/spec version=0.2.0 source=pablontiv/a4s@0123456789012345678901234567890123456789 bootstrap=bootstrap-probe-0.2.0 compat=ok`));
    assert.match(result.stdout, /dagu version="2\.26\.0" required=2\.26\.0 compat=ok/);
    assert.deepEqual(installed.requests, ["/api/v1/dags/reconcile/spec"]);
    assert.deepEqual(missing.requests, []);
    const reversed = await second.run([second.repo, first.repo]);
    assert.equal(reversed.status, 1);
    assert.match(reversed.stdout, /reconcile\.yaml .*stamp=unstamped compat=unstamped/);
    assert.doesNotMatch(reversed.stdout, /compat=unreachable/);
    assert.deepEqual(missing.requests, ["/api/v1/dags/reconcile/spec"]);
  } finally {
    await installed.close();
    await missing.close();
    rmSync(first.root, { recursive: true, force: true });
    rmSync(second.root, { recursive: true, force: true });
  }
});

test("CLI keeps unstamped repository DAGs incompatible", async () => {
  const repo = fixture();
  const installed = await station();
  try {
    repo.configure(installed.url);
    for (const name of ["feature.yaml", "poc.yaml"]) writeFileSync(join(repo.repo, ".workspace", "dagu", "dags", name), "labels:\n");
    const result = await repo.run();
    assert.equal(result.status, 1);
    assert.match(result.stdout, /feature\.yaml .*stamp=unstamped compat=unstamped/);
    assert.match(result.stdout, /poc\.yaml .*stamp=unstamped compat=unstamped/);
    assert.match(result.stdout, /reconcile\.yaml .*compat=ok/);
  } finally {
    await installed.close();
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("CLI fails unreachable for refused transport, non-404 HTTP errors and invalid spec responses", async () => {
  const repo = fixture();
  const refused = await station();
  await refused.close();
  try {
    repo.configure(refused.url);
    const unreachable = await repo.run();
    assert.equal(unreachable.status, 1);
    assert.match(unreachable.stdout, /reconcile\.yaml .*compat=unreachable/);
    assert.doesNotMatch(unreachable.stdout, /reconcile\.yaml .*compat=unstamped/);
    for (const [status, payload] of [[500, {}], [401, {}], [302, {}], [200, {}], [200, { spec: null }]] as const) {
      const invalid = await station(status, payload);
      try {
        repo.configure(invalid.url);
        const result = await repo.run();
        assert.equal(result.status, 1);
        assert.match(result.stdout, /reconcile\.yaml .*compat=unreachable/);
      } finally {
        await invalid.close();
      }
    }
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("CLI defaults to localhost without a config and reports malformed config paths", async () => {
  const repo = fixture();
  try {
    const result = await repo.run([], repo.repo, `
      globalThis.fetch = async url => {
        if (url !== "http://127.0.0.1:8080/api/v1/dags/reconcile/spec") throw new Error("wrong default station: " + url);
        return Response.json({ spec: ${JSON.stringify(stamp)} });
      };
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /reconcile\.yaml path=http:\/\/127\.0\.0\.1:8080\/api\/v1\/dags\/reconcile\/spec .*compat=ok/);
    const file = join(repo.repo, ".workspace", "config", "dagu.json");
    writeFileSync(file, "{");
    const malformed = await repo.run();
    assert.equal(malformed.status, 1);
    assert.ok(malformed.stderr.includes(file), malformed.stderr);
    repo.configure("http://cwd-station:8090");
    const fallback = await repo.run([repo.root], repo.repo, `
      globalThis.fetch = async url => {
        if (url !== "http://cwd-station:8090/api/v1/dags/reconcile/spec") throw new Error("wrong cwd station: " + url);
        return Response.json({ spec: ${JSON.stringify(stamp)} });
      };
    `);
    assert.equal(fallback.status, 1);
    assert.match(fallback.stdout, /reconcile\.yaml path=http:\/\/cwd-station:8090\/api\/v1\/dags\/reconcile\/spec .*compat=ok/);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});
