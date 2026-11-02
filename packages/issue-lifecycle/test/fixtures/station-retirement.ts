import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { declareService } from "./service-environment.ts";
import { roleAdmission } from "../role-job-fixtures.ts";
import { readServiceEnvironment } from "@a4s/launcher/service-environment";
import { stationRecovery, type RecoveryDependencies } from "@a4s/launcher/station-recovery";
import { retirementEvidencePath } from "@a4s/launcher/station-retirement";

export function retirementFixture(t: TestContext, dag = "feature") {
  const root = mkdtempSync(join(tmpdir(), "a4s-retirement-"));
  const home = join(root, "station"), primary = join(root, "primary"), run = "abandoned-run";
  mkdirSync(home); mkdirSync(primary);
  const previous = process.env;
  const selected = declareService(home, "http://127.0.0.1:18765");
  process.env = { ...previous, ...selected }; delete process.env.DAGU_PORT;
  t.after(() => { process.env = previous; rmSync(root, { recursive: true, force: true }); });
  execFileSync("git", ["-C", primary, "init", "-q"]);
  execFileSync("git", ["-C", primary, "-c", "user.name=Retirement test", "-c", "user.email=retirement@example.test", "commit", "--allow-empty", "-qm", "initial"]);
  const snapshot = `name: ${dag}\nparams:\n  - PRIMARY: ${JSON.stringify(primary)}\nsteps: []\n`;
  const receipt = roleAdmission(primary, home, run, snapshot);
  receipt.runReceipt.dag = dag;
  receipt.initial.runtimeAndModels.station = { ...readServiceEnvironment(), PATH: "/retained/old-toolchain" };
  const path = join(primary, ".git", "dagu-feature", "runs", run, "receipt.json");
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(receipt));
  const requests: string[] = [], output: unknown[] = [];
  t.mock.method(console, "log", (value: unknown) => output.push(value));
  const request = (status = "failed", changes: Record<string, unknown> = {}): typeof fetch => async (input, options) => {
    if (options?.method && options.method !== "GET") throw new Error("retirement must never mutate native state");
    requests.push(String(input));
    return Response.json(String(input).endsWith("/spec") ? { spec: snapshot } : {
      dagRunDetails: { name: dag, dagRunId: run, statusLabel: status, nodes: [], ...changes },
    });
  };
  const retire = (status = "failed", dependencies: RecoveryDependencies = {}, reason = "Operator abandons this run; preserve all retained evidence") =>
    stationRecovery(["retire", "--primary", primary, "--run", run, "--reason", reason], {
      fetch: request(status), lock: async (_path, body) => body(),
      restore: async () => { throw new Error("retirement must not restore/verify a cached engine"); },
      spawn: () => { throw new Error("retirement must never spawn native/GitHub mutations"); }, ...dependencies,
    });
  return { root, home, primary, run, dag, path, snapshot, receipt, selected, requests, output, request, retire,
    evidencePath: retirementEvidencePath(path),
    evidence: () => JSON.parse(readFileSync(retirementEvidencePath(path), "utf8")) };
}
